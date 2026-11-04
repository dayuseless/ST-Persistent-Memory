/**
 * 注入引擎 (v0.1.1)
 * 落实 Token 预算约束、L0 优先权、常驻上限与按相关度排序截断
 */

import { INJECT_KEY, MEMORY_STATUS } from './config.js';
import { getState, getSettings } from './state.js';

function getContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

/**
 * 组装并注入当前上下文记忆 (带严格 Token 预算与防撑爆逻辑)
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

    // 1. 确定当前在场角色
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

    // 3. 扫描近几轮消息与当前输入，进行触发词匹配与相关度打分
    const recentChat = Array.isArray(c.chat) ? c.chat.slice(-3) : [];
    const scanCorpus = recentChat.map(m => m.mes || '').join('\n').toLowerCase();

    const pinnedCandidates = [];
    const triggeredCandidates = [];

    for (const mem of memories) {
        // 归档或已完成项绝不主动注入
        if (mem.status === MEMORY_STATUS.ARCHIVED) continue;

        // 如果记忆绑定了特定角色，且该角色不在场，则休眠
        if (mem.character && !inScene.includes(mem.character)) {
            continue;
        }

        // 常驻项 (Pinned)
        if (mem.status === MEMORY_STATUS.PINNED) {
            pinnedCandidates.push(mem);
            continue;
        }

        // 条件激活项 (Triggered)：计算关键词命中频次作为得分
        if (mem.status === MEMORY_STATUS.TRIGGERED) {
            const keys = Array.isArray(mem.trigger_keys) ? mem.trigger_keys : [];
            if (keys.length === 0) {
                // 无特定触发词的临时记忆给予基础权重
                triggeredCandidates.push({ mem, score: 1 });
            } else {
                let hitScore = 0;
                for (const k of keys) {
                    if (k && scanCorpus.includes(String(k).toLowerCase())) {
                        hitScore += 2;
                    }
                }
                if (hitScore > 0) {
                    triggeredCandidates.push({ mem, score: hitScore });
                }
            }
        }
    }

    // 4. P1-6 落实预算：常驻限额 + 激活按相关度排序截断 (绝不中途腰斩单句话)
    const maxPinned = Math.max(1, settings.maxPinnedCount || 5);
    const maxTriggered = Math.max(1, settings.maxTriggeredCount || 5);

    // 常驻项按更新时间倒序，取前 N 条
    const selectedPinned = pinnedCandidates
        .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
        .slice(0, maxPinned);

    // 激活项按命中得分降序，取前 N 条
    const selectedTriggered = triggeredCandidates
        .sort((a, b) => b.score - a.score)
        .slice(0, maxTriggered)
        .map(item => item.mem);

    const activeMemories = [...selectedPinned, ...selectedTriggered];

    // 5. 组装记忆条目
    const memLines = [];
    if (activeMemories.length > 0) {
        memLines.push('[相关认知与关键记忆 (Active Memories)]');
        for (const m of activeMemories) {
            let prefix = '事实';
            if (m.type === 'statement') prefix = '明确约定/言行';
            if (m.type === 'inference') prefix = '心境/主观认知';
            if (m.type === 'todo') prefix = '意图/伏笔';

            memLines.push(`- [${prefix}] ${m.content}`);
        }
    }

    // 6. 组合成最终注入块
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

    // 7. 执行注入
    c.setExtensionPrompt?.(
        INJECT_KEY,
        fullPromptBlock,
        settings.injectionPosition ?? 1,
        settings.injectionDepth ?? 2,
        false,
        0
    );

    if (settings.logVerbose) {
        console.log(`[${INJECT_KEY}] 预算控制：已注入 ${selectedPinned.length} 条常驻 + ${selectedTriggered.length} 条激活记忆`);
    }

    return fullPromptBlock;
}
