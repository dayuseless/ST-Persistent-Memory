/**
 * 注入引擎：负责在发送前匹配、过滤并打包注入 Prompt
 */

import { INJECT_KEY, MEMORY_STATUS } from './config.js';
import { getState, getSettings } from './state.js';

function getContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

/**
 * 组装并注入当前上下文记忆
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

    // 2. 组装 L0 现场快照
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

    // 3. 扫描近几轮消息与当前输入，进行触发词匹配
    const recentChat = Array.isArray(c.chat) ? c.chat.slice(-3) : [];
    const scanCorpus = recentChat.map(m => m.mes || '').join('\n').toLowerCase();

    const activeMemories = [];
    for (const mem of memories) {
        // 归档项绝不主动注入
        if (mem.status === MEMORY_STATUS.ARCHIVED) continue;

        // 如果记忆绑定了特定角色，且该角色不在场，则休眠
        if (mem.character && !inScene.includes(mem.character)) {
            continue;
        }

        // 常驻项 (Pinned)：100% 注入
        if (mem.status === MEMORY_STATUS.PINNED) {
            activeMemories.push(mem);
            continue;
        }

        // 条件激活项 (Triggered)：进行关键词命中检查
        if (mem.status === MEMORY_STATUS.TRIGGERED) {
            const keys = Array.isArray(mem.trigger_keys) ? mem.trigger_keys : [];
            if (keys.length === 0) {
                // 没有指定触发词但被标为 triggered 的，默认作为近效记忆纳入
                activeMemories.push(mem);
            } else {
                const hit = keys.some(k => k && scanCorpus.includes(String(k).toLowerCase()));
                if (hit) {
                    activeMemories.push(mem);
                }
            }
        }
    }

    // 4. 组装记忆条目
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

    // 5. 组合成最终注入块
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

    // 6. 执行注入
    // injectionPosition: 1 = IN_CHAT, 0 = IN_PROMPT
    // injectionDepth: 默认 2 (紧贴最新上下文)
    c.setExtensionPrompt?.(
        INJECT_KEY,
        fullPromptBlock,
        settings.injectionPosition ?? 1,
        settings.injectionDepth ?? 2,
        false,
        0
    );

    if (settings.logVerbose) {
        console.log(`[${INJECT_KEY}] 已注入 ${activeMemories.length} 条激活记忆，快照状态: ${hasScene ? '已装载' : '空'}`);
    }

    return fullPromptBlock;
}
