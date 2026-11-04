/**
 * 注入引擎 (v0.1.5)
 * 严格落实：L0 独立硬预算上限 (maxSceneTokens)、模板固定开销扣除、Fail-Closed 私有/共享记忆防护、Scope 白名单校验、Presence 严格三态语义与 known_by 知情者分流
 */

import { INJECT_KEY, MEMORY_STATUS, MEMORY_LIFECYCLE, MEMORY_SCOPE, MEMORY_TYPES } from './config.js';
import { getState, getSettings } from './state.js';

function getContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

/**
 * 真实 Token 消耗保守估算函数 (Heuristic Token Estimation)
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
 * 组装情境快照行列表
 */
function assembleSceneLines(location, time, action, tension, unresolved, inScene) {
    const lines = ['[当前情境快照 (Scene State)]'];
    if (location) lines.push(`- 地点环境: ${location}${time ? ` (${time})` : ''}`);
    if (action) lines.push(`- 正在进行: ${action}`);
    if (tension) lines.push(`- 即时气氛: ${tension}`);
    if (unresolved) lines.push(`- 即时悬念/待决: ${unresolved}`);
    if (inScene !== undefined) {
        lines.push(`- 在场角色: ${inScene.length > 0 ? inScene.join('、') : '（现场无人在场）'}`);
    }
    return lines;
}

/**
 * 组装并注入当前上下文记忆 (带严格 Token 预算与原子化防撑爆截断)
 */
export function buildAndInjectMemoryPrompt() {
    const c = getContext();
    const settings = getSettings();

    const position = Number(settings.injectionPosition !== undefined ? settings.injectionPosition : 1);
    const depth = Number(settings.injectionDepth !== undefined ? settings.injectionDepth : 2);

    if (!c || !settings.enabled) {
        c?.setExtensionPrompt?.(INJECT_KEY, '', position, depth);
        return '';
    }

    const state = getState();
    const scene = state.scene || {};
    const memories = state.memories || [];

    // 1. 确定当前在场角色 (P0: 严格区分 undefined 未知与 [] 显式无人)
    const currentChid = c.this_chid;
    const charName = c.characters?.[currentChid]?.name || '角色';
    const userName = c.name1 || 'User';

    let inScene;
    if (scene.in_scene_characters === undefined) {
        inScene = [charName, userName];
    } else if (Array.isArray(scene.in_scene_characters)) {
        inScene = scene.in_scene_characters;
    } else {
        inScene = [charName, userName];
    }

    // 2. 组装 L0 现场快照并落实硬预算 (maxSceneTokens)
    const maxSceneTokens = Math.max(50, Number(settings.maxSceneTokens) || 150);
    const maxTotalTokens = Math.max(100, Number(settings.maxTotalMemoryTokens) || 450);
    const TEMPLATE_OVERHEAD_TOKENS = 25; // 标题与分隔线等模板固定开销

    const hasScene = scene.location || scene.action || scene.tension || scene.unresolved || (Array.isArray(scene.in_scene_characters) && scene.in_scene_characters.length === 0);
    let sceneLines = [];

    if (hasScene) {
        let curLoc = typeof scene.location === 'string' ? scene.location : '';
        let curTime = typeof scene.time === 'string' ? scene.time : '';
        let curAct = typeof scene.action === 'string' ? scene.action : '';
        let curTen = typeof scene.tension === 'string' ? scene.tension : '';
        let curUnres = typeof scene.unresolved === 'string' ? scene.unresolved : '';
        let curChars = inScene;

        sceneLines = assembleSceneLines(curLoc, curTime, curAct, curTen, curUnres, curChars);

        // P1 落实 L0 硬预算约束 (逐级降级与压缩)
        // 阶段 1：超出预算时，裁减未决悬念
        if (estimateTokens(sceneLines.join('\n')) > maxSceneTokens && curUnres) {
            curUnres = '';
            sceneLines = assembleSceneLines(curLoc, curTime, curAct, curTen, curUnres, curChars);
        }

        // 阶段 2：仍超出时，裁减即时气氛
        if (estimateTokens(sceneLines.join('\n')) > maxSceneTokens && curTen) {
            curTen = '';
            sceneLines = assembleSceneLines(curLoc, curTime, curAct, curTen, curUnres, curChars);
        }

        // 阶段 3：仍超出时，压缩动作描述
        while (estimateTokens(sceneLines.join('\n')) > maxSceneTokens && curAct.length > 15) {
            curAct = curAct.slice(0, Math.floor(curAct.length * 0.75)).trim() + '...';
            sceneLines = assembleSceneLines(curLoc, curTime, curAct, curTen, curUnres, curChars);
        }

        // 阶段 4：仍超出时，压缩地点并收缩角色列表
        while (estimateTokens(sceneLines.join('\n')) > maxSceneTokens && curLoc.length > 15) {
            curLoc = curLoc.slice(0, Math.floor(curLoc.length * 0.75)).trim() + '...';
            sceneLines = assembleSceneLines(curLoc, curTime, curAct, curTen, curUnres, curChars);
        }

        if (estimateTokens(sceneLines.join('\n')) > maxSceneTokens && curChars && curChars.length > 3) {
            curChars = curChars.slice(0, 3);
            sceneLines = assembleSceneLines(curLoc, curTime, curAct, curTen, curUnres, curChars);
        }

        // 阶段 5：硬性截断兜底 (保证估算绝对不超过 maxSceneTokens)
        while (estimateTokens(sceneLines.join('\n')) > maxSceneTokens && sceneLines.length > 1) {
            sceneLines.pop();
        }
    }

    // 3. 计算剩余记忆预算 (扣减 L0 实际消耗与模板固定开销)
    const sceneTokenCost = sceneLines.length > 0 ? estimateTokens(sceneLines.join('\n')) : 0;
    let remainingTokens = Math.max(0, maxTotalTokens - sceneTokenCost - (sceneLines.length > 0 ? TEMPLATE_OVERHEAD_TOKENS : 0));

    // 4. 扫描近期对话上下文以进行触发词匹配打分
    const recentChat = Array.isArray(c.chat) ? c.chat.slice(-5) : [];
    const scanCorpus = recentChat.map(m => m.mes || '').join('\n').toLowerCase();

    const pinnedCandidates = [];
    const triggeredCandidates = [];
    const VALID_SCOPES = new Set(Object.values(MEMORY_SCOPE));

    for (const mem of memories) {
        // 规则 A：生命周期过滤——已完成、已被取代、已被证伪的条目绝不主动注入
        if (mem.lifecycle && mem.lifecycle !== MEMORY_LIFECYCLE.ACTIVE) {
            continue;
        }

        // 规则 B：归档状态绝不主动注入
        if (mem.status === MEMORY_STATUS.ARCHIVED) {
            continue;
        }

        // 规则 C：Scope 白名单与知情范围判定
        const scope = mem.scope || (mem.character ? MEMORY_SCOPE.CHARACTER : MEMORY_SCOPE.SHARED);

        // P0 校验：未知 scope 严格拒绝，绝不默认当成 world 公开常识
        if (!VALID_SCOPES.has(scope)) {
            continue;
        }

        if (scope === MEMORY_SCOPE.CHARACTER) {
            // P0 Fail-Closed: 角色私密记忆必须具备明确归属，且该角色必须当前在场；缺角色或不在场一律不注入
            if (!mem.character || !inScene.includes(mem.character)) {
                continue;
            }
        } else if (scope === MEMORY_SCOPE.SHARED) {
            // P1 Fail-Closed: 现场共知必须具备明确知情者集合
            const knownList = Array.isArray(mem.known_by) && mem.known_by.length > 0
                ? mem.known_by
                : (mem.character ? [mem.character] : []);

            if (knownList.length === 0) {
                // 没有任何知情者信息的共享记忆绝不作为公共常识注入，执行休眠
                continue;
            }

            const hasWitnessInScene = knownList.some(k => inScene.includes(k));
            if (!hasWitnessInScene) {
                continue; // 现场没有任何知情角色，进入休眠
            }
        }
        // scope === MEMORY_SCOPE.WORLD: 世界公共常识，不受在场角色限制

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
            // 预算已满，整条截断，不再塞入不完整的后文
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

    // 8. 组合成最终注入块 (若处于伴随标签模式，需附带输出协议)
    const position = Number(settings.injectionPosition !== undefined ? settings.injectionPosition : 1);
    const depth = Number(settings.injectionDepth !== undefined ? settings.injectionDepth : 2);

    if (sceneLines.length === 0 && memLines.length === 0 && settings.mode !== 'sync') {
        c.setExtensionPrompt?.(INJECT_KEY, '', position, depth);
        return '';
    }

    const promptParts = ['### 持续情境与记忆核心 (Persistent Memory)'];
    if (sceneLines.length > 0) promptParts.push(...sceneLines);
    if (memLines.length > 0) promptParts.push(...memLines);

    if (settings.mode === 'sync') {
        promptParts.push(
            '',
            '[伴随记忆与情境更新协议 (Sync Protocol)]',
            '若本轮对话产生了新的地点环境变更、关键动作进展、约定承诺或重要事实，请在回复文本的最末尾（必须独占一行）附带隐藏的状态更新标签：',
            '<!--PERSISTENT_MEMORY',
            '{',
            '  "scene": { "location": "当前地点", "time": "时段/天气", "action": "正在进行的动作", "tension": "心理氛围", "unresolved": "即时冲突焦点", "in_scene_characters": ["在场角色1", "在场角色2"] },',
            '  "new_memories": [',
            '    { "content": "客观事实描述", "type": "fact|statement|inference|todo", "scope": "world|shared|character", "character": null, "known_by": ["知情角色名"], "trigger_keys": ["触发词1", "触发词2"] }',
            '  ],',
            '  "lifecycle_updates": [',
            '    { "id": "已履约或已推翻旧记忆的ID", "lifecycle": "completed|superseded|refuted" }',
            '  ],',
            '  "summary": "本次更新一句话摘要"',
            '}',
            '-->',
            '（若无新事实发生，则无需附带任何标签，直接正常回复即可。前端会自动截获隐藏此标签，用户界面完全不可见。）'
        );
    }
    promptParts.push('──────────────────────────────────────────');

    const fullPromptBlock = promptParts.join('\n');

    // 9. 执行注入
    c.setExtensionPrompt?.(
        INJECT_KEY,
        fullPromptBlock,
        position,
        depth,
        false,
        0
    );

    console.log(`[${MODULE_NAME}] [Injector] 成功注入提示词 (模式: ${settings.mode}, 位置: ${position === 0 ? 'System Prompt' : 'In-Chat @ 深度 ' + depth}, 长度: ${fullPromptBlock.length} 字符, 伴随协议: ${settings.mode === 'sync' ? '已包含' : '未开启'})`);

    if (settings.logVerbose) {
        console.log(`[${INJECT_KEY}] 预算控制：注入 L0 快照 (~${sceneTokenCost} tok, 硬上限 ${maxSceneTokens}) + ${selectedPinnedLines.length} 条常驻 + ${selectedTriggeredLines.length} 条激活记忆，结余预算 ~${remainingTokens} tok`);
    }

    return fullPromptBlock;
}
