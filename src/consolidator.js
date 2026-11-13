/**
 * ST-Persistent-Memory - 长程记忆高阶归并引擎 (Consolidator Engine)
 * 职责：
 * 1. 扫描与筛选符合权限边界约束的候选记忆分组 (严格同 scope/同角色/同知情者)
 * 2. 调度 LLM 执行宏观提炼概括 (一句话浓缩长期事实，生成 supersedes 映射)
 * 3. 严格校验归并结果 Schema 与 ACL 权限边界，防跨组拼凑、越权提权与幽灵替代
 * 4. 原子批量落盘：将旧细节置为 superseded，入库全新宏观事实
 *
 * @version 0.1.35
 */

import { MODULE_NAME, MEMORY_TYPES, MEMORY_STATUS, MEMORY_LIFECYCLE, MEMORY_SCOPE } from './config.js';
import { getState, getSettings, addMemory, setMemoryLifecycle, batchUpdate } from './state.js';
import { getContextParticipants, validateMemoryAcl } from './acl.js';
import { executeDigestRequest } from './api.js';
import { cleanAndParseJson, unwrapJsonPayload, getChatTurnCount, getChatIdentifier, sanitizeTriggerKeys } from './extractor.js';

function getContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

/**
 * 筛选并构建可供宏观归并的记忆候选分组
 * 约束：仅活跃、非常驻且处于同一权限边界（同一 scope、同一归属角色/知情者）的分组方可合并
 */
export function buildConsolidationCandidateGroups(memories) {
    if (!Array.isArray(memories)) return [];

    const activeList = memories.filter(m =>
        m && m.lifecycle === MEMORY_LIFECYCLE.ACTIVE && m.status === MEMORY_STATUS.TRIGGERED
    );

    const groupMap = new Map();

    for (const mem of activeList) {
        let groupKey = '';
        if (mem.scope === MEMORY_SCOPE.WORLD) {
            groupKey = 'world';
        } else if (mem.scope === MEMORY_SCOPE.CHARACTER) {
            groupKey = `character:${mem.character || 'unknown'}`;
        } else if (mem.scope === MEMORY_SCOPE.SHARED) {
            const known = Array.isArray(mem.known_by) ? mem.known_by.slice().sort().join('|') : (mem.character || 'unknown');
            groupKey = `shared:${known}`;
        } else {
            continue;
        }

        if (!groupMap.has(groupKey)) {
            groupMap.set(groupKey, {
                key: groupKey,
                scope: mem.scope,
                character: mem.character || '',
                known_by: Array.isArray(mem.known_by) ? [...mem.known_by] : (mem.character ? [mem.character] : []),
                items: []
            });
        }
        groupMap.get(groupKey).items.push(mem);
    }

    // 仅保留候选数量 >= 2 的分组 (单条无归并必要)
    return Array.from(groupMap.values()).filter(g => g.items.length >= 2);
}

/**
 * 校验模型归并产出的 Schema 与权限边界 (Fail-Closed 拒绝越权与跨组拼凑)
 */
export function validateConsolidatedPayload(raw, currentMemories = [], allowedParticipants = null) {
    const target = unwrapJsonPayload(raw);
    if (!target || typeof target !== 'object' || !Array.isArray(target.consolidated)) {
        return null;
    }

    const memMap = new Map((Array.isArray(currentMemories) ? currentMemories : []).map(m => [m.id, m]));
    const VALID_TYPES = new Set(Object.values(MEMORY_TYPES));
    const VALID_SCOPES = new Set(Object.values(MEMORY_SCOPE));

    const trustedParticipants = allowedParticipants instanceof Set
        ? allowedParticipants
        : (Array.isArray(allowedParticipants) ? new Set(allowedParticipants) : null);

    const validConsolidated = [];

    for (const item of target.consolidated) {
        if (!item || typeof item !== 'object') continue;
        const content = typeof item.content === 'string' ? item.content.trim().slice(0, 100) : '';
        if (!content) continue;

        const type = VALID_TYPES.has(item.type) ? item.type : MEMORY_TYPES.FACT;
        const supersedes = Array.isArray(item.supersedes)
            ? Array.from(new Set(item.supersedes.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim())))
            : [];

        // 归并必须替代至少 2 条既有记忆
        if (supersedes.length < 2) {
            console.warn(`[${MODULE_NAME}] [Consolidate 拦截] 条目 supersedes 少于 2 条记忆，拒绝归并`);
            continue;
        }

        // 检查所有被替代的源条目是否存在且同属于一个权限分组
        const sourceMems = supersedes.map(id => memMap.get(id)).filter(Boolean);
        if (sourceMems.length !== supersedes.length) {
            console.warn(`[${MODULE_NAME}] [Consolidate 拦截] supersedes 包含不存在的记忆 ID，拒绝归并`);
            continue;
        }

        // 严禁归并已结项或常驻条目
        const hasInvalidSource = sourceMems.some(m => m.lifecycle !== MEMORY_LIFECYCLE.ACTIVE || m.status === MEMORY_STATUS.PINNED);
        if (hasInvalidSource) {
            console.warn(`[${MODULE_NAME}] [Consolidate 拦截] 被替代记忆中包含非 active 或常驻条目，拒绝归并`);
            continue;
        }

        // 核心权限边界不变式：源记忆必须全部具备完全相同的知情范围
        const baseScope = sourceMems[0].scope;
        const baseChar = sourceMems[0].character || '';
        const baseKnown = Array.isArray(sourceMems[0].known_by) ? sourceMems[0].known_by.slice().sort().join('|') : '';

        const scopeMismatch = sourceMems.some(m => {
            const mKnown = Array.isArray(m.known_by) ? m.known_by.slice().sort().join('|') : '';
            return m.scope !== baseScope || (m.character || '') !== baseChar || mKnown !== baseKnown;
        });

        if (scopeMismatch) {
            console.warn(`[${MODULE_NAME}] [Consolidate 拦截] 严禁跨越不同权限/角色的记忆进行拼凑归并，拒绝入库`);
            continue;
        }

        // 新条目必须继承源分组的 scope 与权限，严禁越权提权
        const targetScope = VALID_SCOPES.has(item.scope) ? item.scope : baseScope;
        if (targetScope !== baseScope) {
            console.warn(`[${MODULE_NAME}] [Consolidate 拦截] 归并产生的新记忆试图修改知情范围 (${targetScope} != ${baseScope})，拒绝提权`);
            continue;
        }

        let targetChar = baseChar;
        let targetKnown = Array.isArray(sourceMems[0].known_by) ? [...sourceMems[0].known_by] : [];

        // 验证参与者可信性 (调用统一 ACL 判定层)
        const aclRes = validateMemoryAcl({
            scope: targetScope,
            character: targetChar,
            known_by: targetKnown
        }, trustedParticipants);

        if (!aclRes.allowed) {
            console.warn(`[${MODULE_NAME}] [Consolidate 拦截] ${aclRes.reason}`);
            continue;
        }

        validConsolidated.push({
            content,
            type,
            scope: targetScope,
            character: targetChar,
            known_by: targetKnown,
            trigger_keys: sanitizeTriggerKeys(item.trigger_keys),
            supersedes: supersedes
        });
    }

    return validConsolidated.length > 0 ? { consolidated: validConsolidated } : null;
}

let isConsolidating = false;

export function isMemoryConsolidationRunning() {
    return isConsolidating;
}

/**
 * 触发长程记忆高阶归并
 */
export async function triggerMemoryConsolidation(force = false) {
    const c = getContext();
    const settings = getSettings();
    if (!c || !settings.enabled) return { success: false, reason: '插件未启用' };
    if (isConsolidating) return { success: false, reason: '归并任务进行中' };

    const startChatId = getChatIdentifier(c);
    if (!startChatId) return { success: false, reason: '无法获取有效会话标识' };

    const state = getState();
    const candidateGroups = buildConsolidationCandidateGroups(state.memories);
    const totalCandidates = candidateGroups.reduce((acc, g) => acc + g.items.length, 0);

    const threshold = Math.max(5, Number(settings.consolidateThreshold) || 10);
    if (!force && totalCandidates < threshold) {
        return { success: false, reason: `当前候选记忆 ${totalCandidates} 条未达归并阈值 (${threshold})` };
    }

    if (candidateGroups.length === 0) {
        return { success: false, reason: '暂无可归并的记忆分组' };
    }

    isConsolidating = true;
    console.log(`[${MODULE_NAME}] [Consolidate] 启动高阶记忆归并 (会话: ${startChatId}, 共 ${candidateGroups.length} 个候选分组, ${totalCandidates} 条候选细节)...`);

    try {
        let groupsPromptText = '';
        candidateGroups.slice(0, 3).forEach((g, idx) => {
            groupsPromptText += `\n【分组 ${idx + 1}】(知情范围: ${g.scope}, 关联角色: ${g.character || '公共'}, 知情者: ${g.known_by.join(', ') || '全员'})\n`;
            g.items.slice(0, 6).forEach(m => {
                groupsPromptText += `- (ID: ${m.id}) [${m.type}] ${m.content}\n`;
            });
        });

        const prompt = `你是一个严谨的角色扮演剧情记忆长程归并专家。
你的任务是将多条零散、细节性或已被新进展涵盖的历史事件，归纳浓缩为高阶、宏观的概括性长期事实记忆。

### 核心归并守则：
1. 【严格同组内归并】：只能在同一个【分组】内部归并记忆，绝不可跨越分组组合。新记忆必须保留该分组完全相同的 scope、character 与 known_by。
2. 【宏观浓缩】：保留剧情关键因果与长期结果（如“双方在黑石林爆发激战并两败俱伤，最终撤回营地休整”），略去动作琐屑。每条归并事实必须在一句话内精炼表达（≤80字）。
3. 【指明被替代条目 (supersedes)】：每条新归并必须在 supersedes 数组中明确列出被其涵盖替代的旧记忆 ID（至少 2 个旧 ID）。这些旧记忆将被标为 superseded (已被迭代)，从而退出日常提示词注入。
4. 【无合适浓缩时输出空数组】：若某分组内条目各自独立、互不相关或无法概括，不要强行凑合，consolidated 输出空数组 []。

待归并的记忆分组：
${groupsPromptText}

请直接输出且只输出一个合法的 JSON 纯文本对象（不要 markdown 标记，不要多余解释），格式如下：
{
  "consolidated": [
    {
      "content": "归纳后的一句话宏观事实（≤80字）",
      "type": "fact",
      "scope": "与原分组一致",
      "character": "与原分组一致",
      "known_by": ["与原分组一致"],
      "trigger_keys": ["核心词1", "核心词2"],
      "supersedes": ["旧ID1", "旧ID2"]
    }
  ]
}`;

        const response = await executeDigestRequest(c, prompt, settings);
        if (!response) {
            return { success: false, reason: '模型未返回有效归并结果' };
        }

        // 会话一致性检查
        const finishChatId = getChatIdentifier(c);
        if (finishChatId !== startChatId) {
            console.warn(`[${MODULE_NAME}] [会话隔离拦截] 检测到用户在归并期间切换了会话 (${startChatId} -> ${finishChatId})，已安全丢弃！`);
            return { success: false, reason: '归并期间会话发生切换，已丢弃' };
        }

        const raw = cleanAndParseJson(response);
        const latestState = getState();
        const participants = getContextParticipants(c, latestState);
        const validated = validateConsolidatedPayload(raw, latestState.memories, participants);

        if (!validated || !Array.isArray(validated.consolidated) || validated.consolidated.length === 0) {
            console.log(`[${MODULE_NAME}] [Consolidate] 经校验无可应用的高阶归并项 (情境各自独立或未通过安全核验)`);
            return { success: true, count: 0, superseded: 0 };
        }

        const currentTurn = getChatTurnCount(c?.chat);

        return batchUpdate(() => {
            let newCount = 0;
            let supersededCount = 0;

            for (const item of validated.consolidated) {
                // 1. 先将所有被替代的旧记忆置为 superseded，使其脱离 active 状态
                for (const oldId of item.supersedes) {
                    setMemoryLifecycle(oldId, MEMORY_LIFECYCLE.SUPERSEDED);
                    supersededCount++;
                }

                // 2. 随后入库全新的宏观概括记忆 (此时旧条目已脱离 active，绝不会与新条目发生错误的同库相似冲突融合)
                // 必须显式携带当前轮次，防止新归并条目被误判为 0 楼层而立即沉睡
                const added = addMemory({
                    type: item.type,
                    content: item.content,
                    scope: item.scope,
                    character: item.character,
                    known_by: item.known_by,
                    trigger_keys: item.trigger_keys,
                    status: MEMORY_STATUS.TRIGGERED,
                    floor: currentTurn,
                    last_activated_floor: currentTurn
                });

                if (added) {
                    newCount++;
                }
            }

            console.log(`[${MODULE_NAME}] [Consolidate] 记忆高阶归并原子提交：新增 ${newCount} 条宏观事实，归档/替代 ${supersededCount} 条历史琐碎条目`);
            return { success: true, count: newCount, superseded: supersededCount };
        });
    } catch (err) {
        console.error(`[${MODULE_NAME}] [Consolidate] 记忆归并异常:`, err);
        return { success: false, error: err.message || String(err) };
    } finally {
        isConsolidating = false;
    }
}
