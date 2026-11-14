/**
 * 注入引擎 (v0.1.43)
 * 严格落实：
 * 1. P0 统一 ACL 准出端 (Egress) 访问控制与 POV 知情范围路由
 * 2. P1-01 角色级知情范围严格路由 (生成主体 POV 与现场角色集合严格解耦)
 * 3. P2-01 L0 现场快照时间字段 (scene.time) 纳入与三态存在判定
 * 4. P2-02 真实 Token 预算全开销扣除 (包含韩文 Hangul 估算与 Sync 协议开销扣除)
 * 5. Fail-Closed 拒绝优先与知情者隔离防线
 */

import { MODULE_NAME, INJECT_KEY, MEMORY_STATUS, MEMORY_LIFECYCLE, MEMORY_SCOPE, MEMORY_TYPES, INJECTION_TEMPLATES } from './config.js';
import { getState, getSettings, saveCurrentState } from './state.js';
import { buildQueryContext, calculateHybridMemoryScore } from './semantic.js';
import { canRecipientAccessMemory } from './acl.js';

function getContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

/**
 * P1-01 核心函数：判定当前生成请求的接收主体 (Generating Recipient / POV)
 * 区分群聊特定回复角色、单聊专属角色与未知/旁白主体
 */
export function getGeneratingEntity(c) {
    if (!c) return null;
    // 1. 群聊或单聊中由 characterId / this_chid 指定的当前生成角色 (characterId 优先，支持数字与字符串索引)
    const chid = (c.characterId !== undefined && c.characterId !== null)
        ? c.characterId
        : c.this_chid;
    if (chid !== undefined && chid !== null && Array.isArray(c.characters)) {
        const char = c.characters[chid] || c.characters[Number(chid)];
        if (char && char.name) return char.name;
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

export const PROMPT_HEADER = '### 持续情境与记忆核心 (Persistent Memory)';
export const PROMPT_DIVIDER = '──────────────────────────────────────────';
export const MEMORY_SECTION_HEADER = '[相关认知与关键记忆 (Active Memories)]';
// 当用户把总预算设得低于完整协议所需开销时，保留可解析的最小协议而不挤占总预算。
export const COMPACT_SYNC_PROTOCOL_TEXT = '[状态更新协议] 有更新时在回复末尾附 `<!--PERSISTENT_MEMORY {合法JSON}-->`；无更新不输出标签。';

/**
 * 获取提示词注入模板外壳与结构标签
 */
export function getTemplateEnvelope(template = 'standard') {
    if (template === INJECTION_TEMPLATES.XML) {
        return {
            header: '<persistent_memory>',
            sceneHeader: '<scene_state>',
            sceneFooter: '</scene_state>',
            memSectionHeader: '<active_memories>',
            memSectionFooter: '</active_memories>',
            footer: '</persistent_memory>',
            divider: ''
        };
    }
    if (template === INJECTION_TEMPLATES.ENGLISH) {
        return {
            header: '### Persistent Memory (Context & State)',
            sceneHeader: '[Current Scene State]',
            sceneFooter: '',
            memSectionHeader: '[Active Memories & Key Lore]',
            memSectionFooter: '',
            footer: '',
            divider: '──────────────────────────────────────────'
        };
    }
    if (template === INJECTION_TEMPLATES.COMPACT) {
        return {
            header: '### 持续记忆',
            sceneHeader: '',
            sceneFooter: '',
            memSectionHeader: '[关键记忆]',
            memSectionFooter: '',
            footer: '',
            divider: '---'
        };
    }
    return {
        header: PROMPT_HEADER,
        sceneHeader: '[当前情境快照 (Scene State)]',
        sceneFooter: '',
        memSectionHeader: MEMORY_SECTION_HEADER,
        memSectionFooter: '',
        footer: '',
        divider: PROMPT_DIVIDER
    };
}

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
export function getMemoryPrefix(m, template = 'standard') {
    if (template === INJECTION_TEMPLATES.ENGLISH) {
        if (m.type === MEMORY_TYPES.STATEMENT) return 'Statement/Promise';
        if (m.type === MEMORY_TYPES.INFERENCE) return 'Mindset/Inference';
        if (m.type === MEMORY_TYPES.TODO) return 'Intent/Goal';
        return 'Fact';
    }
    if (m.type === MEMORY_TYPES.STATEMENT) return '明确约定/言行';
    if (m.type === MEMORY_TYPES.INFERENCE) return '心境/主观认知';
    if (m.type === MEMORY_TYPES.TODO) return '意图/伏笔';
    return '事实';
}

/**
 * 格式化单条记忆文本
 */
export function formatMemoryLine(mem, prefix, loreTag, extraWarning, template = 'standard') {
    if (template === INJECTION_TEMPLATES.XML) {
        const loreAttr = (mem.lorebook_ref?.entry_name) ? ` lorebook="${mem.lorebook_ref.entry_name}"` : '';
        const scopeAttr = mem.scope ? ` scope="${mem.scope}"` : '';
        const warnText = extraWarning ? ` [CONFIDENTIAL]` : '';
        return `  <memory type="${mem.type || 'fact'}"${scopeAttr}${loreAttr}>${mem.content}${warnText}</memory>`;
    }
    if (template === INJECTION_TEMPLATES.COMPACT) {
        return `• [${prefix}] ${mem.content}${extraWarning}`;
    }
    return `- [${prefix}]${loreTag} ${mem.content}${extraWarning}`;
}

/**
 * 组装情境快照行列表
 */
export function assembleSceneLines(location, time, action, tension, unresolved, inScene, template = 'standard') {
    if (template === INJECTION_TEMPLATES.XML) {
        const lines = ['<scene_state>'];
        if (location) lines.push(`  <location>${location}</location>`);
        if (time) lines.push(`  <time>${time}</time>`);
        if (action) lines.push(`  <action>${action}</action>`);
        if (tension) lines.push(`  <tension>${tension}</tension>`);
        if (unresolved) lines.push(`  <unresolved>${unresolved}</unresolved>`);
        if (inScene !== undefined) {
            lines.push(`  <characters>${inScene.length > 0 ? inScene.join(', ') : 'none'}</characters>`);
        }
        lines.push('</scene_state>');
        return lines;
    }
    if (template === INJECTION_TEMPLATES.ENGLISH) {
        const lines = ['[Current Scene State]'];
        if (location) lines.push(`- Location: ${location}`);
        if (time) lines.push(`- Time/Weather: ${time}`);
        if (action) lines.push(`- Current Action: ${action}`);
        if (tension) lines.push(`- Tension/Mood: ${tension}`);
        if (unresolved) lines.push(`- Unresolved/Focus: ${unresolved}`);
        if (inScene !== undefined) {
            lines.push(`- Characters Present: ${inScene.length > 0 ? inScene.join(', ') : '(None)'}`);
        }
        return lines;
    }
    if (template === INJECTION_TEMPLATES.COMPACT) {
        const parts = [];
        if (location) parts.push(`地点: ${location}`);
        if (time) parts.push(`时间: ${time}`);
        if (action) parts.push(`动作: ${action}`);
        if (tension) parts.push(`氛围: ${tension}`);
        if (unresolved) parts.push(`悬念: ${unresolved}`);
        if (inScene !== undefined) {
            parts.push(`在场: ${inScene.length > 0 ? inScene.join('、') : '无'}`);
        }
        return parts.length > 0 ? [`[现场] ${parts.join(' | ')}`] : [];
    }
    const lines = ['[当前情境快照 (Scene State)]'];
    if (location) lines.push(`- 地点环境: ${location}`);
    if (time) lines.push(`- 时间/天气: ${time}`);
    if (action) lines.push(`- 正在进行: ${action}`);
    if (tension) lines.push(`- 即时气氛: ${tension}`);
    if (unresolved) lines.push(`- 即时悬念/待决: ${unresolved}`);
    if (inScene !== undefined) {
        lines.push(`- 在场角色: ${inScene.length > 0 ? inScene.join('、') : '（现场无人在场）'}`);
    }
    return lines;
}

let lastInjectionSnapshot = null;

/**
 * 获取最近一轮真实提示词注入快照与归因诊断数据 (Prompt & Memory Inspection Snapshot)
 * @param {boolean} [forceRefresh=false] - 是否按当前最新上下文与状态强制执行一次实时 dryRun 重新测算
 * @returns {object|null}
 */
export function getLastInjectionSnapshot(forceRefresh = false) {
    if (forceRefresh || !lastInjectionSnapshot) {
        buildAndInjectMemoryPrompt({ dryRun: true });
    }
    return lastInjectionSnapshot;
}

/**
 * 组装并注入当前上下文记忆 (带严格 Token 预算与原子化防撑爆截断)
 * @param {object} [options={}]
 * @param {boolean} [options.dryRun=false] - 是否仅执行测算与快照记录而不真正向 SillyTavern 注入
 */
export function buildAndInjectMemoryPrompt(options = {}) {
    const isDryRun = Boolean(options && options.dryRun);
    const c = getContext();
    const settings = getSettings();

    const position = Number(settings.injectionPosition !== undefined ? settings.injectionPosition : 1);
    const depth = Number(settings.injectionDepth !== undefined ? settings.injectionDepth : 2);

    if (!c || !settings.enabled) {
        if (!isDryRun) {
            c?.setExtensionPrompt?.(INJECT_KEY, '', position, depth);
        }
        lastInjectionSnapshot = {
            timestamp: new Date().toISOString(),
            chatId: c?.chatId || 'default',
            dryRun: isDryRun,
            enabled: false,
            reason: !c ? '未检测到 SillyTavern 会话上下文' : '持续记忆全局总开关未开启',
            totalInjectedTokens: 0,
            fullPromptBlock: '',
            recalledMemories: [],
            suppressedMemories: []
        };
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

    // 若处于群聊且存在群组禁言/禁用成员列表 (disabled_members)，在场名单中自动剔除已静音/禁用的角色
    if (Array.isArray(inScene) && inScene.length > 0 && c?.groupId && Array.isArray(c?.groups)) {
        const activeGroup = c.groups.find(g => String(g.id) === String(c.groupId));
        if (activeGroup && Array.isArray(activeGroup.disabled_members) && activeGroup.disabled_members.length > 0) {
            const disabledSet = new Set(activeGroup.disabled_members.map(m => String(m).trim().toLowerCase()));
            const disabledNames = new Set();
            if (Array.isArray(c.characters)) {
                c.characters.forEach(ch => {
                    const av = String(ch?.avatar || '').trim().toLowerCase();
                    const nm = String(ch?.name || '').trim().toLowerCase();
                    if (disabledSet.has(av) || disabledSet.has(nm) || ch?.disabled || ch?.is_disabled) {
                        disabledNames.add(nm);
                    }
                });
            }
            activeGroup.disabled_members.forEach(m => disabledNames.add(String(m).trim().toLowerCase()));

            inScene = inScene.filter(name => !disabledNames.has(String(name).trim().toLowerCase()));
        }
    }

    // 2. 组装 L0 现场快照并落实硬预算 (扣减全部固定模板与协议开销)
    const template = settings.injectionTemplate || INJECTION_TEMPLATES.STANDARD;
    const envelope = getTemplateEnvelope(template);

    const maxSceneTokens = Math.max(50, Number(settings.maxSceneTokens) || 150);
    const maxTotalTokens = Math.max(100, Number(settings.maxTotalMemoryTokens) || 450);

    // 所有固定文本都按实际内容计入预算。完整协议放不下时改用紧凑协议；仍放不下则停止本次 sync 注入。
    const fixedTokenCost = (protocol = '') => estimateTokens([envelope.header, protocol, envelope.divider, envelope.footer].filter(Boolean).join('\n')) + 4;
    let syncProtocol = '';
    if (settings.mode === 'sync') {
        if (fixedTokenCost(SYNC_PROTOCOL_TEXT) <= maxTotalTokens) {
            syncProtocol = SYNC_PROTOCOL_TEXT;
        } else if (fixedTokenCost(COMPACT_SYNC_PROTOCOL_TEXT) <= maxTotalTokens) {
            syncProtocol = COMPACT_SYNC_PROTOCOL_TEXT;
            console.warn(`[${MODULE_NAME}] [Injector] 总预算不足以容纳完整 Sync 协议，已使用紧凑协议并停用可选记忆内容`);
        } else {
            console.warn(`[${MODULE_NAME}] [Injector] 总预算不足以容纳最小 Sync 协议，本轮不注入提示词`);
        }
    }

    const totalFixedOverhead = fixedTokenCost(syncProtocol);
    const maxAvailableForContent = syncProtocol || settings.mode !== 'sync'
        ? Math.max(0, maxTotalTokens - totalFixedOverhead)
        : 0;
    const effectiveMaxSceneTokens = Math.min(maxSceneTokens, maxAvailableForContent);

    // P2-01 修复：将 scene.time 明确纳入现场快照存在判断，并纠正 in_scene_characters 长度判定
    const hasScene = Boolean(scene.time || scene.location || scene.action || scene.tension || scene.unresolved || Array.isArray(scene.in_scene_characters));
    let sceneLines = [];

    const sceneCheckHeader = envelope.sceneHeader || envelope.header;
    if (hasScene && maxAvailableForContent >= estimateTokens(sceneCheckHeader)) {
        let curLoc = typeof scene.location === 'string' ? scene.location : '';
        let curTime = typeof scene.time === 'string' ? scene.time : '';
        let curAct = typeof scene.action === 'string' ? scene.action : '';
        let curTen = typeof scene.tension === 'string' ? scene.tension : '';
        let curUnres = typeof scene.unresolved === 'string' ? scene.unresolved : '';
        let curChars = inScene;

        sceneLines = assembleSceneLines(curLoc, curTime, curAct, curTen, curUnres, curChars, template);

        // P1 落实 L0 硬预算约束 (逐级降级与压缩)
        // 阶段 1：超出预算时，裁减未决悬念
        if (estimateTokens(sceneLines.join('\n')) > effectiveMaxSceneTokens && curUnres) {
            curUnres = '';
            sceneLines = assembleSceneLines(curLoc, curTime, curAct, curTen, curUnres, curChars, template);
        }

        // 阶段 2：仍超出时，裁减即时气氛
        if (estimateTokens(sceneLines.join('\n')) > effectiveMaxSceneTokens && curTen) {
            curTen = '';
            sceneLines = assembleSceneLines(curLoc, curTime, curAct, curTen, curUnres, curChars, template);
        }

        // 阶段 3：仍超出时，压缩动作描述
        while (estimateTokens(sceneLines.join('\n')) > effectiveMaxSceneTokens && curAct.length > 15) {
            curAct = curAct.slice(0, Math.floor(curAct.length * 0.75)).trim() + '...';
            sceneLines = assembleSceneLines(curLoc, curTime, curAct, curTen, curUnres, curChars, template);
        }

        // 阶段 4：仍超出时，压缩地点并收缩角色列表
        while (estimateTokens(sceneLines.join('\n')) > effectiveMaxSceneTokens && curLoc.length > 15) {
            curLoc = curLoc.slice(0, Math.floor(curLoc.length * 0.75)).trim() + '...';
            sceneLines = assembleSceneLines(curLoc, curTime, curAct, curTen, curUnres, curChars, template);
        }

        if (estimateTokens(sceneLines.join('\n')) > effectiveMaxSceneTokens && curChars && curChars.length > 3) {
            curChars = curChars.slice(0, 3);
            sceneLines = assembleSceneLines(curLoc, curTime, curAct, curTen, curUnres, curChars, template);
        }

        // 阶段 5：硬性截断兜底 (保证估算绝对不超过 effectiveMaxSceneTokens)
        while (estimateTokens(sceneLines.join('\n')) > effectiveMaxSceneTokens && sceneLines.length > 1) {
            sceneLines.pop();
        }
    }

    // 3. 计算剩余记忆预算 (扣减 L0 实际消耗与模板全开销)
    const sceneTokenCost = sceneLines.length > 0 ? estimateTokens(sceneLines.join('\n')) : 0;
    let remainingTokens = Math.max(0, maxAvailableForContent - sceneTokenCost);
    const memorySectionHeaderTokens = estimateTokens(envelope.memSectionHeader);
    let memorySectionReserved = false;

    // 4. 构建现场语义查询与扫描上下文 (结合近期对话与现场焦点)
    const queryContext = buildQueryContext(c, scene, settings);

    // P1-01 核心修复：确定当前生成请求的接收主体 (Generating Entity / POV)
    const generatingEntity = getGeneratingEntity(c);

    const pinnedCandidates = [];
    const triggeredCandidates = [];
    const suppressedCandidates = [];
    const VALID_SCOPES = new Set(Object.values(MEMORY_SCOPE));
    const currentTurn = (options && Number.isInteger(options.currentTurn))
        ? options.currentTurn
        : (Array.isArray(c?.chat) ? (c.chat.filter(m => !m.is_user).length || c.chat.length) : 0);

    for (const mem of memories) {
        // 规则 A：生命周期过滤——已完成、已被取代、已被证伪的条目绝不主动注入
        if (mem.lifecycle && mem.lifecycle !== MEMORY_LIFECYCLE.ACTIVE) {
            const lcLabel = mem.lifecycle === 'completed' ? '已办结' : (mem.lifecycle === 'superseded' ? '已迭代' : (mem.lifecycle === 'refuted' ? '已证伪' : mem.lifecycle));
            suppressedCandidates.push({ mem, reason: `生命周期非活跃 (${lcLabel})`, score: 0 });
            continue;
        }

        // 规则 B：归档状态绝不常规注入 (除非处于活跃生命周期且启用沉睡唤醒)
        const isArchived = mem.status === MEMORY_STATUS.ARCHIVED || mem.status === 'dormant';
        const allowDormantRecall = settings.autoSleepEnabled !== false && isArchived && (!mem.lifecycle || mem.lifecycle === MEMORY_LIFECYCLE.ACTIVE);
        if (isArchived && !allowDormantRecall) {
            suppressedCandidates.push({ mem, reason: '处于归档休眠状态 (未开启沉睡唤醒)', score: 0 });
            continue;
        }

        // 规则 C (P0 解耦收敛)：统一由 ACL 判定层裁决当前生成接收主体 (POV) 是否有权获知该条记忆
        const access = canRecipientAccessMemory(mem, generatingEntity, inScene, {
            userName: c?.name1 || '',
            requireInScene: true
        });

        if (!access.allowed) {
            suppressedCandidates.push({ mem, reason: `权限隔离: ${access.reason || '当前主体无权获知'}`, score: 0 });
            continue;
        }

        const extraWarning = access.extraWarning || '';

        const prefix = getMemoryPrefix(mem, template);
        const loreTag = (mem.lorebook_ref && typeof mem.lorebook_ref === 'object' && mem.lorebook_ref.entry_name)
            ? (template === INJECTION_TEMPLATES.ENGLISH ? ` [Lore: ${mem.lorebook_ref.entry_name}]` : ` [世界书关联: ${mem.lorebook_ref.entry_name}]`)
            : '';
        const formattedLine = formatMemoryLine(mem, prefix, loreTag, extraWarning, template);
        const itemTokens = estimateTokens(formattedLine);

        // 常驻项 (Pinned)
        if (mem.status === MEMORY_STATUS.PINNED || mem.is_pinned === true) {
            pinnedCandidates.push({ mem, line: formattedLine, tokens: itemTokens, extraWarning });
            continue;
        }

        // 条件激活项 (Triggered) 与 沉睡记忆联想唤醒 (Dormant Recall)
        if (mem.status === MEMORY_STATUS.TRIGGERED || allowDormantRecall) {
            const score = calculateHybridMemoryScore(mem, queryContext, settings);
            // 沉睡记忆需要更高的相关性门槛才被联想唤醒 (防止被低分杂音惊醒，支持自定义微调)
            const configuredWakeThreshold = Number(settings.autoSleepWakeThreshold);
            const wakeThreshold = (!isNaN(configuredWakeThreshold) && configuredWakeThreshold > 0)
                ? configuredWakeThreshold
                : 0.60;
            const minScore = isArchived ? wakeThreshold : 0;
            if (score > minScore) {
                triggeredCandidates.push({ mem, score, line: formattedLine, tokens: itemTokens, wasArchived: isArchived, extraWarning });
            } else {
                suppressedCandidates.push({
                    mem,
                    reason: isArchived
                        ? `沉睡记忆得分 (${score.toFixed(2)}) 未达唤醒门槛 (${wakeThreshold.toFixed(2)})`
                        : `相关度得分 (${score.toFixed(2)}) 低于激活门槛`,
                    score
                });
            }
        } else {
            suppressedCandidates.push({
                mem,
                reason: `非检索状态 (${mem.status || '未设定'})`,
                score: 0
            });
        }
    }

    // 5. 常驻项装载 (在 remainingTokens 限制下原子载入，按时间倒序)
    // 动态弹性上限：若用户上调了总预算，自动弹性扩容常驻容量 (5~15条)，充分利用 Token 空间
    const configuredMaxPinned = Number(settings.maxPinnedCount);
    const autoScaledPinned = Math.min(15, Math.max(5, Math.floor(maxTotalTokens / 80)));
    const maxPinned = (!isNaN(configuredMaxPinned) && configuredMaxPinned > 5)
        ? configuredMaxPinned
        : Math.max(configuredMaxPinned || 5, autoScaledPinned);
    const selectedPinnedItems = [];

    pinnedCandidates.sort((a, b) => new Date(b.mem.updated_at || 0) - new Date(a.mem.updated_at || 0));

    for (const item of pinnedCandidates) {
        if (selectedPinnedItems.length >= maxPinned) {
            suppressedCandidates.push({ mem: item.mem, reason: `超出常驻记忆条数上限 (已达 ${maxPinned} 条)`, score: 1.0 });
            continue;
        }
        const requiredTokens = item.tokens + (memorySectionReserved ? 0 : memorySectionHeaderTokens);
        if (remainingTokens >= requiredTokens) {
            selectedPinnedItems.push(item);
            remainingTokens -= requiredTokens;
            memorySectionReserved = true;
        } else {
            suppressedCandidates.push({ mem: item.mem, reason: `Token 预算不足截断 (需 ${requiredTokens} tok, 结余 ${remainingTokens} tok)`, score: 1.0 });
        }
    }
    const selectedPinnedLines = selectedPinnedItems.map(item => item.line);

    // 6. 激活项装载 (按相关度打分降序，在剩余 remainingTokens 下原子装载，遇满即停，严禁腰斩单条记忆)
    // 动态弹性上限：若用户上调总 Token 预算至 800~2000，自动弹性扩容激活容量 (5~30条)，杜绝因硬编码5条导致预算闲置
    const configuredMaxTriggered = Number(settings.maxTriggeredCount);
    const autoScaledTriggered = Math.min(30, Math.max(5, Math.floor(maxTotalTokens / 45)));
    const maxTriggered = (!isNaN(configuredMaxTriggered) && configuredMaxTriggered > 5)
        ? configuredMaxTriggered
        : Math.max(configuredMaxTriggered || 5, autoScaledTriggered);
    const selectedTriggeredItems = [];
    let hasMemoryStateMutated = false;

    triggeredCandidates.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return new Date(b.mem.updated_at || 0) - new Date(a.mem.updated_at || 0);
    });

    for (const item of triggeredCandidates) {
        if (selectedTriggeredItems.length >= maxTriggered) {
            suppressedCandidates.push({ mem: item.mem, reason: `超出动态激活条数上限 (已达 ${maxTriggered} 条)`, score: item.score });
            continue;
        }
        const requiredTokens = item.tokens + (memorySectionReserved ? 0 : memorySectionHeaderTokens);
        if (remainingTokens >= requiredTokens) {
            selectedTriggeredItems.push(item);
            remainingTokens -= requiredTokens;
            memorySectionReserved = true;

            // 活跃度刷新与沉睡唤醒 (Wake Up)
            if (item.wasArchived) {
                if (!isDryRun) {
                    item.mem.status = MEMORY_STATUS.TRIGGERED;
                    item.mem.last_woken_floor = currentTurn;
                    hasMemoryStateMutated = true;
                }
                console.log(`[${MODULE_NAME}] [Wake-Up] 沉睡记忆 [${item.mem.id}] 被高匹配度重新唤醒: "${item.mem.content}"`);
            }
            if (currentTurn > 0 && item.mem.last_activated_floor !== currentTurn) {
                if (!isDryRun) {
                    item.mem.last_activated_floor = currentTurn;
                    hasMemoryStateMutated = true;
                }
            }
        } else {
            suppressedCandidates.push({ mem: item.mem, reason: `Token 预算已满截断 (需 ${requiredTokens} tok, 结余 ${remainingTokens} tok)`, score: item.score });
        }
    }
    const selectedTriggeredLines = selectedTriggeredItems.map(item => item.line);

    if (hasMemoryStateMutated && !isDryRun) {
        saveCurrentState();
    }

    // 7. 组装记忆条目文本
    const memLines = [];
    const allSelectedMemLines = [...selectedPinnedLines, ...selectedTriggeredLines];
    if (allSelectedMemLines.length > 0) {
        if (envelope.memSectionHeader) memLines.push(envelope.memSectionHeader);
        memLines.push(...allSelectedMemLines);
        if (envelope.memSectionFooter) memLines.push(envelope.memSectionFooter);
    }

    // 8. 组合成最终注入块 (若处于伴随标签模式，需附带输出协议)
    if (sceneLines.length === 0 && memLines.length === 0 && !syncProtocol) {
        if (!isDryRun) {
            c.setExtensionPrompt?.(INJECT_KEY, '', position, depth);
        }
        lastInjectionSnapshot = {
            timestamp: new Date().toISOString(),
            chatId: c?.chatId || 'default',
            dryRun: isDryRun,
            generatingEntity: generatingEntity || (c?.name2 || '未知'),
            inSceneCharacters: Array.isArray(inScene) ? inScene : [],
            mode: settings.mode,
            positionText: position === 0 ? 'System Prompt' : `In-Chat @ 深度 ${depth}`,
            position,
            depth,
            template,
            maxTotalTokens,
            maxSceneTokens,
            sceneTokenCost: 0,
            totalInjectedTokens: 0,
            budgetRemaining: maxAvailableForContent,
            fullPromptBlock: '',
            syncProtocolIncluded: false,
            sceneSnapshot: {
                location: scene.location || '',
                time: scene.time || '',
                action: scene.action || '',
                tension: scene.tension || '',
                unresolved: scene.unresolved || '',
                lines: []
            },
            recalledMemories: [],
            suppressedMemories: suppressedCandidates.map(item => ({
                id: item.mem?.id || '',
                content: item.mem?.content || '',
                type: item.mem?.type || '',
                scope: item.mem?.scope || '',
                character: item.mem?.character || '',
                reason: item.reason,
                score: typeof item.score === 'number' ? item.score : 0
            }))
        };
        return '';
    }

    const promptParts = [envelope.header];
    if (sceneLines.length > 0) promptParts.push(...sceneLines);
    if (memLines.length > 0) promptParts.push(...memLines);

    if (syncProtocol) {
        promptParts.push(syncProtocol);
    }
    if (envelope.footer) {
        promptParts.push(envelope.footer);
    }
    if (envelope.divider) {
        promptParts.push(envelope.divider);
    }

    const fullPromptBlock = promptParts.join('\n');

    // 9. 执行注入 (非 dryRun 模式下真正提交给 SillyTavern)
    if (!isDryRun) {
        c.setExtensionPrompt?.(
            INJECT_KEY,
            fullPromptBlock,
            position,
            depth,
            false,
            0
        );
    }

    // 10. 记录全量注入透视快照 (Prompt & Memory Inspection Snapshot)
    lastInjectionSnapshot = {
        timestamp: new Date().toISOString(),
        chatId: c?.chatId || 'default',
        dryRun: isDryRun,
        generatingEntity: generatingEntity || (c?.name2 || '未知'),
        inSceneCharacters: Array.isArray(inScene) ? inScene : [],
        mode: settings.mode,
        positionText: position === 0 ? 'System Prompt' : `In-Chat @ 深度 ${depth}`,
        position,
        depth,
        template,
        maxTotalTokens,
        maxSceneTokens,
        sceneTokenCost,
        totalInjectedTokens: estimateTokens(fullPromptBlock),
        budgetRemaining: remainingTokens,
        fullPromptBlock,
        syncProtocolIncluded: Boolean(syncProtocol),
        sceneSnapshot: {
            location: scene.location || '',
            time: scene.time || '',
            action: scene.action || '',
            tension: scene.tension || '',
            unresolved: scene.unresolved || '',
            lines: sceneLines
        },
        recalledMemories: [
            ...selectedPinnedItems.map(item => ({
                id: item.mem.id,
                content: item.mem.content,
                type: item.mem.type,
                scope: item.mem.scope,
                character: item.mem.character,
                known_by: item.mem.known_by,
                status: item.mem.status,
                tokens: item.tokens,
                extraWarning: item.extraWarning || '',
                reason: '常驻置顶 (Pinned)',
                score: 1.0
            })),
            ...selectedTriggeredItems.map(item => ({
                id: item.mem.id,
                content: item.mem.content,
                type: item.mem.type,
                scope: item.mem.scope,
                character: item.mem.character,
                known_by: item.mem.known_by,
                status: item.mem.status,
                tokens: item.tokens,
                extraWarning: item.extraWarning || '',
                reason: item.wasArchived ? '沉睡唤醒 (Wake-Up)' : '动态匹配激活 (Triggered)',
                score: item.score
            }))
        ],
        suppressedMemories: suppressedCandidates.map(item => ({
            id: item.mem?.id || '',
            content: item.mem?.content || '',
            type: item.mem?.type || '',
            scope: item.mem?.scope || '',
            character: item.mem?.character || '',
            reason: item.reason,
            score: typeof item.score === 'number' ? item.score : 0
        }))
    };

    if (!isDryRun) {
        console.log(`[${MODULE_NAME}] [Injector] 成功注入提示词 (模式: ${settings.mode}, 位置: ${position === 0 ? 'System Prompt' : 'In-Chat @ 深度 ' + depth}, 长度: ${fullPromptBlock.length} 字符, 伴随协议: ${syncProtocol ? '已包含' : '未开启'})`);

        if (settings.logVerbose) {
            console.log(`[${INJECT_KEY}] 预算控制：注入 L0 快照 (~${sceneTokenCost} tok, 硬上限 ${maxSceneTokens}) + ${selectedPinnedLines.length} 条常驻 + ${selectedTriggeredLines.length} 条激活记忆，结余预算 ~${remainingTokens} tok`);
        }
    }

    return fullPromptBlock;
}
