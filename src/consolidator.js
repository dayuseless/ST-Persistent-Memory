/**
 * ST-Persistent-Memory - 长程记忆高阶归并引擎 (Consolidator Engine)
 * 职责：
 * 1. 扫描与筛选符合权限边界约束的候选记忆分组 (严格同 scope/同角色/同知情者)
 * 2. 调度 LLM 执行宏观提炼概括 (一句话浓缩长期事实，生成 supersedes 映射)
 * 3. 严格校验归并结果 Schema 与 ACL 权限边界，防跨组拼凑、越权提权与幽灵替代
 * 4. 原子批量落盘：将旧细节置为 superseded，入库全新宏观事实
 *
 * @version 0.1.39
 */

import { MODULE_NAME, MEMORY_TYPES, MEMORY_STATUS, MEMORY_LIFECYCLE, MEMORY_SCOPE } from './config.js';
import { getState, getSettings, addMemory, setMemoryLifecycle, batchUpdate } from './state.js';
import { getContextParticipants, validateMemoryAcl } from './acl.js';
import { executeDigestRequest } from './api.js';
import { cleanAndParseJson, unwrapJsonPayload } from './parser.js';
import { validateConsolidatedPayload, sanitizeTriggerKeys } from './schema.js';
import { buildConsolidationPrompt } from './prompt.js';
import { getChatTurnCount, getChatIdentifier } from './extractor.js';

export { validateConsolidatedPayload, buildConsolidationPrompt };

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

        const prompt = buildConsolidationPrompt({ groupsPromptText });

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
