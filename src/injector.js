/**
 * 注入引擎 (v0.1.2)
 * 严格落实：真实 Token 预算核算、L0 优先权扣减、全条目原子截断（不腰斩句子）、Presence Routing 知情范围分流与生命周期过滤
 */

import { INJECT_KEY, MEMORY_STATUS, MEMORY_LIFECYCLE, MEMORY_SCOPE, MEMORY_TYPES } from './config.js';
import { getState, getSettings } from './state.js';

function getContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

/**
 * 真实 Token 消耗保守估算函数
 * 兼顾中日韩 (CJK) 字符与英文单词的 Tokenizer 行为
 */
export function estimateTokens(text) {
    if (!text || typeof text !== 'string') return 0;
    // CJK 字符：平均 1 字符 ≈ 1~1.2 Token
    const cjkMatches = text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u30ff]/g);
    const cjkCount = cjkMatches ? cjkMatches.length : 0;

    // 非 CJK 文本：以单词或 ~3.5 字符估算 1 Token
    const nonCjkText = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u30ff]/g, '');
    const words = nonCjkText.trim().split(/\s+/).filter(Boolean).length;
    const nonCjkTokens = Math.ceil(Math.max(words * 1.3, nonCjkText.length / 3.5));

    return Math.max(1, cjkCount + nonCjkTokens);
}

/**
 * 格式化记忆前缀
 */
function getMemoryPrefix(m) {
    if (m.type === MEMORY_TYPES.STATEMENT) return '明确约定/言行';
    if (m.type === MEMORY_TYPES.INFERENCE) return '心境/主观认知';
    if (m.type === MEMORY_TYPES.TODO) return '意图/伏笔';
    return '事实';
}

/**
 * 组装并注入当前上下文记忆 (带严格 Token 预算与原子化防撑爆截断)
 */
export function buildAndInjectMemoryPrompt() {
    const c = getContext();
    const settings = getSettings();

    if (!c || !settings.enabled) {
        c?.setExtensionPrompt?.(INJECT_KEY, '', settings.injectionPosition, settings.injectionDepth);
        return '';
    }

    const state = getState();
    const scene = state.scene;
    const memories = state.memories || [];

    // 1. 确定当前在场角色 (Presence 基础)
    const currentChid = c.this_chid;
    const charName = c.characters?.[currentChid]?.name || '角色';
    const userName = c.name1 || 'User';

    let inScene = Array.isArray(scene.in_scene_characters) && scene.in_scene_characters.length > 0
        ? scene.in_scene_characters
        : [charName, userName];

    // 2. 组装 L0 现场快照 (享有绝对最高注入优先权)
    const hasScene = scene.location || scene.action || scene.tension || scene.unresolved;
    const sceneLines = [];
    if (hasScene) {
        sceneLines.push('[当前情境快照 (Scene State)]');
        if (scene.location) sceneLines.push(`- 地点环境: ${scene.location}${scene.time ? ` (${scene.time})` : ''}`);
        if (scene.action) sceneLines.push(`- 正在进行: ${scene.action}`);
        if (scene.tension) sceneLines.push(`- 即时气氛: ${scene.tension}`);
        if (scene.unresolved) sceneLines.push(`- 即时悬念/待决: ${scene.unresolved}`);
        sceneLines.push(`- 在场角色: ${inScene.join('、')}`);
    }

    // 3. 计算预算与 L0 优先扣减 (P1-6: 落实真实 Token 预算)
    const maxTotalTokens = Math.max(100, Number(settings.maxTotalMemoryTokens) || 450);
    const sceneBlockText = sceneLines.join('\n');
    const sceneTokenCost = sceneLines.length > 0 ? estimateTokens(sceneBlockText) : 0;

    let remainingTokens = Math.max(0, maxTotalTokens - sceneTokenCost);

    // 4. 扫描近期对话上下文以进行触发词匹配打分
    const recentChat = Array.isArray(c.chat) ? c.chat.slice(-5) : [];
    const scanCorpus = recentChat.map(m => m.mes || '').join('\n').toLowerCase();

    const pinnedCandidates = [];
    const triggeredCandidates = [];

    for (const mem of memories) {
        // 规则 A：生命周期过滤——已完成、已被取代、已被证伪的条目绝不主动注入
        if (mem.lifecycle && mem.lifecycle !== MEMORY_LIFECYCLE.ACTIVE) {
            continue;
        }

        // 规则 B：归档状态绝不主动注入
        if (mem.status === MEMORY_STATUS.ARCHIVED) {
            continue;
        }

        // 规则 C：Presence Routing 与 Scope 知情范围判定
        const scope = mem.scope || (mem.character ? MEMORY_SCOPE.CHARACTER : MEMORY_SCOPE.SHARED);

        if (scope === MEMORY_SCOPE.CHARACTER) {
            // 私密记忆：绑定的特定角色不在场时休眠
            if (mem.character && !inScene.includes(mem.character)) {
                continue;
            }
        } else if (scope === MEMORY_SCOPE.SHARED) {
            // 现场共知：若明确关联了某不在场角色，且当前在场者无人能认领该记忆，则休眠
            if (mem.character && !inScene.includes(mem.character) && !inScene.includes(userName)) {
                continue;
            }
        }
        // scope === MEMORY_SCOPE.WORLD: 世界公共常识，不受在场人员限制

        const prefix = getMemoryPrefix(mem);
        const formattedLine = `- [${prefix}] ${mem.content}`;
        const itemTokens = estimateTokens(formattedLine);

        // 常驻项 (Pinned)
        if (mem.status === MEMORY_STATUS.PINNED) {
            pinnedCandidates.push({ mem, line: formattedLine, tokens: itemTokens });
            continue;
        }

        // 条件激活项 (Triggered)
        if (mem.status === MEMORY_STATUS.TRIGGERED) {
            const keys = Array.isArray(mem.trigger_keys) ? mem.trigger_keys : [];
            if (keys.length === 0) {
                // 无特定触发词的记忆给予保底权重
                triggeredCandidates.push({ mem, score: 1, line: formattedLine, tokens: itemTokens });
            } else {
                let hitScore = 0;
                for (const k of keys) {
                    if (k && scanCorpus.includes(String(k).toLowerCase())) {
                        hitScore += 2;
                    }
                }
                if (hitScore > 0) {
                    triggeredCandidates.push({ mem, score: hitScore, line: formattedLine, tokens: itemTokens });
                }
            }
        }
    }

    // 5. 常驻项装载 (在 remainingTokens 限制下原子载入，按时间倒序)
    const maxPinned = Math.max(1, Number(settings.maxPinnedCount) || 5);
    const selectedPinnedLines = [];

    pinnedCandidates.sort((a, b) => new Date(b.mem.updated_at || 0) - new Date(a.mem.updated_at || 0));

    for (const item of pinnedCandidates) {
        if (selectedPinnedLines.length >= maxPinned) break;
        if (remainingTokens >= item.tokens) {
            selectedPinnedLines.push(item.line);
            remainingTokens -= item.tokens;
        }
    }

    // 6. 激活项装载 (按相关度打分降序，在剩余 remainingTokens 下原子装载，遇满即停，严禁腰斩单条记忆)
    const maxTriggered = Math.max(1, Number(settings.maxTriggeredCount) || 5);
    const selectedTriggeredLines = [];

    triggeredCandidates.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return new Date(b.mem.updated_at || 0) - new Date(a.mem.updated_at || 0);
    });

    for (const item of triggeredCandidates) {
        if (selectedTriggeredLines.length >= maxTriggered) break;
        if (remainingTokens >= item.tokens) {
            selectedTriggeredLines.push(item.line);
            remainingTokens -= item.tokens;
        } else {
            // 预算已满，原子截断，不再塞入不完整的后文
            break;
        }
    }

    // 7. 组装记忆条目文本
    const memLines = [];
    const allSelectedMemLines = [...selectedPinnedLines, ...selectedTriggeredLines];
    if (allSelectedMemLines.length > 0) {
        memLines.push('[相关认知与关键记忆 (Active Memories)]');
        memLines.push(...allSelectedMemLines);
    }

    // 8. 组合成最终注入块
    if (sceneLines.length === 0 && memLines.length === 0) {
        c.setExtensionPrompt?.(INJECT_KEY, '', settings.injectionPosition, settings.injectionDepth);
        return '';
    }

    const fullPromptBlock = [
        '### 持续情境与记忆核心 (Persistent Memory)',
        ...sceneLines,
        ...memLines,
        '──────────────────────────────────────────'
    ].join('\n');

    // 9. 执行注入
    c.setExtensionPrompt?.(
        INJECT_KEY,
        fullPromptBlock,
        settings.injectionPosition ?? 1,
        settings.injectionDepth ?? 2,
        false,
        0
    );

    if (settings.logVerbose) {
        console.log(`[${INJECT_KEY}] 预算控制：已注入 L0 快照 (~${sceneTokenCost} tok) + ${selectedPinnedLines.length} 条常驻 + ${selectedTriggeredLines.length} 条激活记忆，结余预算 ~${remainingTokens} tok`);
    }

    return fullPromptBlock;
}
