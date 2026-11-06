/**
 * 注入引擎 (v0.1.8)
 * 严格落实：
 * 1. P1-01 角色级知情范围严格路由 (生成主体 POV 与现场角色集合严格解耦)
 * 2. P2-01 L0 现场快照时间字段 (scene.time) 纳入与三态存在判定
 * 3. P2-02 真实 Token 预算全开销扣除 (包含韩文 Hangul 估算与 Sync 协议开销扣除)
 * 4. Fail-Closed 拒绝优先与知情者隔离防线
 */

import { MODULE_NAME, INJECT_KEY, MEMORY_STATUS, MEMORY_LIFECYCLE, MEMORY_SCOPE, MEMORY_TYPES } from './config.js';
import { getState, getSettings } from './state.js';

function getContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

/**
 * P1-01 核心函数：判定当前生成请求的接收主体 (Generating Recipient / POV)
 * 区分群聊特定回复角色、单聊专属角色与未知/旁白主体
 */
export function getGeneratingEntity(c) {
    if (!c) return null;
    // 1. 群聊或单聊中由 this_chid / characterId 指定的当前生成角色
    if (typeof c.characterId === 'number' && Array.isArray(c.characters) && c.characters[c.characterId]) {
        return c.characters[c.characterId].name || null;
    }
    // 2. 单聊常规 fallback (无 groupId 时的对方角色名)
    if (!c.groupId && c.name2) {
        return c.name2;
    }
    return null;
}

/**
 * 伴随模式状态更新协议文本定义
 */
export const SYNC_PROTOCOL_TEXT = [
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
].join('\n');

/**
 * 真实 Token 消耗保守估算函数 (Heuristic Token Estimation)
 * P2-02 修复：扩展 CJK 字符集，将韩文音节 (Hangul Syllables: \uac00-\ud7af) 与谚文字母 (\u1100-\u11ff, \u3130-\u318f) 全面纳入
 */
export function estimateTokens(text) {
    if (!text || typeof text !== 'string') return 0;
    // CJK 字符：涵盖汉字 (常用、扩展A)、日文假名、韩文音节与谚文字母
    const cjkMatches = text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/g);
    const cjkCount = cjkMatches ? cjkMatches.length : 0;

    // 非 CJK 文本：以单词或 ~3.5 字符估算 1 Token
    const nonCjkText = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/g, '');
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

    // 2. 组装 L0 现场快照并落实硬预算 (扣减全部固定模板与协议开销)
    const maxSceneTokens = Math.max(50, Number(settings.maxSceneTokens) || 150);
    const maxTotalTokens = Math.max(100, Number(settings.maxTotalMemoryTokens) || 450);

    // P2-02 修复：总预算必须全量扣减包含标题、分隔线与伴随协议在内的全部模板固定开销
    const BASE_TEMPLATE_OVERHEAD_TOKENS = 35; // 标题与分隔线等模板开销
    const syncProtocolCost = settings.mode === 'sync' ? estimateTokens(SYNC_PROTOCOL_TEXT) : 0;
    const totalFixedOverhead = BASE_TEMPLATE_OVERHEAD_TOKENS + syncProtocolCost;

    const maxAvailableForContent = Math.max(50, maxTotalTokens - totalFixedOverhead);
    const effectiveMaxSceneTokens = Math.min(maxSceneTokens, Math.max(50, Math.floor(maxAvailableForContent * 0.5)));

    // P2-01 修复：将 scene.time 明确纳入现场快照存在判断，并纠正 in_scene_characters 长度判定
    const hasScene = Boolean(scene.time || scene.location || scene.action || scene.tension || scene.unresolved || (Array.isArray(scene.in_scene_characters) && scene.in_scene_characters.length > 0));
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
        if (estimateTokens(sceneLines.join('\n')) > effectiveMaxSceneTokens && curUnres) {
            curUnres = '';
            sceneLines = assembleSceneLines(curLoc, curTime, curAct, curTen, curUnres, curChars);
        }

        // 阶段 2：仍超出时，裁减即时气氛
        if (estimateTokens(sceneLines.join('\n')) > effectiveMaxSceneTokens && curTen) {
            curTen = '';
            sceneLines = assembleSceneLines(curLoc, curTime, curAct, curTen, curUnres, curChars);
        }

        // 阶段 3：仍超出时，压缩动作描述
        while (estimateTokens(sceneLines.join('\n')) > effectiveMaxSceneTokens && curAct.length > 15) {
            curAct = curAct.slice(0, Math.floor(curAct.length * 0.75)).trim() + '...';
            sceneLines = assembleSceneLines(curLoc, curTime, curAct, curTen, curUnres, curChars);
        }

        // 阶段 4：仍超出时，压缩地点并收缩角色列表
        while (estimateTokens(sceneLines.join('\n')) > effectiveMaxSceneTokens && curLoc.length > 15) {
            curLoc = curLoc.slice(0, Math.floor(curLoc.length * 0.75)).trim() + '...';
            sceneLines = assembleSceneLines(curLoc, curTime, curAct, curTen, curUnres, curChars);
        }

        if (estimateTokens(sceneLines.join('\n')) > effectiveMaxSceneTokens && curChars && curChars.length > 3) {
            curChars = curChars.slice(0, 3);
            sceneLines = assembleSceneLines(curLoc, curTime, curAct, curTen, curUnres, curChars);
        }

        // 阶段 5：硬性截断兜底 (保证估算绝对不超过 effectiveMaxSceneTokens)
        while (estimateTokens(sceneLines.join('\n')) > effectiveMaxSceneTokens && sceneLines.length > 1) {
            sceneLines.pop();
        }
    }

    // 3. 计算剩余记忆预算 (扣减 L0 实际消耗与模板全开销)
    const sceneTokenCost = sceneLines.length > 0 ? estimateTokens(sceneLines.join('\n')) : 0;
    let remainingTokens = Math.max(0, maxAvailableForContent - sceneTokenCost);

    // 4. 扫描近期对话上下文以进行触发词匹配打分
    const recentChat = Array.isArray(c.chat) ? c.chat.slice(-5) : [];
    const scanCorpus = recentChat.map(m => m.mes || '').join('\n').toLowerCase();

    // P1-01 核心修复：确定当前生成请求的接收主体 (Generating Entity / POV)
    const generatingEntity = getGeneratingEntity(c);

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

        let extraWarning = '';

        if (scope === MEMORY_SCOPE.CHARACTER) {
            // P1-01 修复：角色私密记忆仅允许路由给该角色自身生成的上下文！
            // 若当前生成主体无法确定（如旁白/未知），或当前生成角色并非记忆归属者，一律严格拒绝注入！
            if (!generatingEntity || mem.character !== generatingEntity) {
                continue;
            }
            // 现场物理在场核验：该角色当下必须在场
            if (!inScene.includes(generatingEntity)) {
                continue;
            }
        } else if (scope === MEMORY_SCOPE.SHARED) {
            const knownList = Array.isArray(mem.known_by) && mem.known_by.length > 0
                ? mem.known_by
                : (mem.character ? [mem.character] : []);

            if (knownList.length === 0) {
                continue; // 缺知情者信息，进入休眠
            }

            // P1-01 修复：当前生成角色必须本身在知情者列表 (known_by) 中！
            // 严禁因为现场“存在一个知情者”而将秘密注入其他不知情角色的生成上下文！
            if (!generatingEntity || !knownList.includes(generatingEntity)) {
                continue;
            }

            // 现场物理在场核验：知情角色当下必须在场
            if (!inScene.includes(generatingEntity)) {
                continue;
            }

            // 机密边界强化：若现场存在不知情角色，添加保密提示，防止当前角色失言穿帮
            const outsidersInScene = inScene.filter(k => k && k !== c.name1 && !knownList.includes(k));
            if (outsidersInScene.length > 0) {
                extraWarning = ` [保密提示: 现场存在不知情者 ${outsidersInScene.join(', ')}，当前角色切勿透露此秘密]`;
            }
        }
        // scope === MEMORY_SCOPE.WORLD: 世界公共常识，允许任何角色接收

        const prefix = getMemoryPrefix(mem);
        const formattedLine = `- [${prefix}] ${mem.content}${extraWarning}`;
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
    if (sceneLines.length === 0 && memLines.length === 0 && settings.mode !== 'sync') {
        c.setExtensionPrompt?.(INJECT_KEY, '', position, depth);
        return '';
    }

    const promptParts = ['### 持续情境与记忆核心 (Persistent Memory)'];
    if (sceneLines.length > 0) promptParts.push(...sceneLines);
    if (memLines.length > 0) promptParts.push(...memLines);

    if (settings.mode === 'sync') {
        promptParts.push(SYNC_PROTOCOL_TEXT);
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
