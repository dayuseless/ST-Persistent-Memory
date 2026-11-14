/**
 * ST-Persistent-Memory - 聊天框原生快捷斜杠指令 (Slash Commands, v0.1.43)
 * 
 * 核心职责：
 * 1. 消除频繁切出 HUD 面板的交互阻力，支持用户直接在聊天输入框以自然快捷指令操作记忆系统。
 * 2. 核心支持指令：
 *    - /remember [内容] : 快速记录一条记忆 (支持 --pinned, --type, --scope, --char 等参数)
 *    - /scene [地点/剧情] : 快速更新或纠正当前 L0 现场快照
 *    - /inspect : 一键呼出即时注入透视镜 (Live Inspector)
 *    - /digest : 立即在后台触发一次记忆提炼
 *    - /forget [关键词/ID] : 快速将某条记忆设为证伪 (refuted) 或归档
 */

import { MODULE_NAME, MEMORY_TYPES, MEMORY_STATUS, MEMORY_SCOPE, MEMORY_LIFECYCLE } from './config.js';
import { addMemory, updateScene, getState, updateMemory, saveCurrentState } from './state.js';
import { showInjectionInspectorModal } from './ui/modal.js';
import { triggerAsyncDigest } from './extractor.js';
import { GAMEPLAY_PRESETS, applyGameplayPreset } from './ui/common.js';

/**
 * 解析用户输入的命令行参数与标志位
 * @param {string} rawText 
 * @returns {{ positional: string, flags: object }}
 */
export function parseCommandArgs(rawText) {
    if (!rawText || typeof rawText !== 'string') {
        return { positional: '', flags: {} };
    }

    const tokens = rawText.trim().split(/\s+/);
    const flags = {};
    const positionalTokens = [];

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === '--all') {
            flags.all = true;
        } else if (t === '--pinned' || t === '-p') {
            flags.pinned = true;
        } else if (t === '--type' || t === '-t') {
            if (i + 1 < tokens.length) flags.type = tokens[++i];
        } else if (t === '--scope' || t === '-s') {
            if (i + 1 < tokens.length) flags.scope = tokens[++i];
        } else if (t === '--character' || t === '--char' || t === '-c') {
            if (i + 1 < tokens.length) flags.character = tokens[++i];
        } else if (t === '--location' || t === '-l') {
            if (i + 1 < tokens.length) flags.location = tokens[++i];
        } else if (t === '--action' || t === '-a') {
            if (i + 1 < tokens.length) flags.action = tokens[++i];
        } else if (t === '--time') {
            if (i + 1 < tokens.length) flags.time = tokens[++i];
        } else if (t === '--keys' || t === '-k') {
            if (i + 1 < tokens.length) flags.keys = tokens[++i];
        } else {
            positionalTokens.push(t);
        }
    }

    return {
        positional: positionalTokens.join(' ').trim(),
        flags
    };
}

/**
 * 执行 /remember 指令
 * @param {string} argsText 
 * @param {object} [namedArgs={}] 
 * @returns {string} 提示文本
 */
export function executeRememberCommand(argsText = '', namedArgs = {}) {
    const parsed = parseCommandArgs(argsText);
    const content = (parsed.positional || namedArgs.content || '').trim();

    if (!content) {
        const help = '[持续记忆] 请提供记忆内容。用法: /remember [--pinned] [--type fact|statement|inference|todo] 内容';
        window.toastr?.warning?.(help, '持续记忆');
        return help;
    }

    const isPinned = Boolean(namedArgs.pinned ?? parsed.flags.pinned ?? false);
    const rawType = String(namedArgs.type || parsed.flags.type || 'fact').toLowerCase();
    const VALID_TYPES = new Set(Object.values(MEMORY_TYPES));
    const targetType = VALID_TYPES.has(rawType) ? rawType : MEMORY_TYPES.FACT;

    const rawScope = String(namedArgs.scope || parsed.flags.scope || 'world').toLowerCase();
    const VALID_SCOPES = new Set(Object.values(MEMORY_SCOPE));
    const targetScope = VALID_SCOPES.has(rawScope) ? rawScope : MEMORY_SCOPE.WORLD;

    const character = namedArgs.character || parsed.flags.character || undefined;
    const rawKeys = namedArgs.keys || parsed.flags.keys || '';
    const triggerKeys = rawKeys ? rawKeys.split(/[,，]/).map(k => k.trim()).filter(Boolean) : [];

    const result = addMemory({
        content,
        type: targetType,
        status: isPinned ? MEMORY_STATUS.PINNED : MEMORY_STATUS.TRIGGERED,
        scope: targetScope,
        character,
        trigger_keys: triggerKeys
    });

    if (result) {
        const typeLabel = targetType === 'fact' ? '客观事实' : (targetType === 'statement' ? '言行约定' : (targetType === 'inference' ? '推测心境' : '即时待办'));
        const statusLabel = isPinned ? '常驻置顶' : '动态激活';
        const msg = `[持续记忆] 已成功收录${statusLabel}: "${content}" (${typeLabel})`;
        window.toastr?.success?.(msg, '持续记忆');
        return msg;
    } else {
        const err = '[持续记忆] 记忆添加未能通过准入校验，请检查角色权限与知情者设定';
        window.toastr?.warning?.(err, '持续记忆');
        return err;
    }
}

/**
 * 执行 /scene 指令
 * @param {string} argsText 
 * @param {object} [namedArgs={}] 
 * @returns {string} 提示文本
 */
export function executeSceneCommand(argsText = '', namedArgs = {}) {
    const parsed = parseCommandArgs(argsText);
    let location = namedArgs.location || parsed.flags.location;
    let action = namedArgs.action || parsed.flags.action;
    let time = namedArgs.time || parsed.flags.time;

    // 若未显式传入 --location 或 --action，将纯文本智能赋予 location 或 action
    if (!location && !action && parsed.positional) {
        location = parsed.positional;
    } else if (location && !action && parsed.positional) {
        action = parsed.positional;
    }

    if (!location && !action && !time) {
        const help = '[持续记忆] 请提供现场内容。用法: /scene [--location 地点] [--action 动作] [--time 时间] [地点描述]';
        window.toastr?.warning?.(help, '持续记忆');
        return help;
    }

    const patch = {};
    if (location !== undefined) patch.location = location;
    if (action !== undefined) patch.action = action;
    if (time !== undefined) patch.time = time;

    updateScene(patch);

    const parts = [];
    if (location) parts.push(`地点="${location}"`);
    if (action) parts.push(`动作="${action}"`);
    if (time) parts.push(`时间="${time}"`);

    const msg = `[持续记忆] 现场快照已更新: ${parts.join(', ')}`;
    window.toastr?.success?.(msg, '持续记忆');
    return msg;
}

/**
 * 执行 /inspect 指令
 * @returns {string}
 */
export function executeInspectCommand() {
    showInjectionInspectorModal();
    const msg = '[持续记忆] 即时注入透视镜已弹出';
    window.toastr?.info?.(msg, '持续记忆');
    return msg;
}

/**
 * 执行 /digest 指令
 * @returns {string}
 */
export function executeDigestCommand() {
    triggerAsyncDigest(true);
    const msg = '[持续记忆] 已在后台发起即时提炼...';
    window.toastr?.info?.(msg, '持续记忆');
    return msg;
}

/**
 * 执行 /forget 指令
 * @param {string} argsText 
 * @param {object} [namedArgs={}] 
 * @returns {string}
 */
export function executeForgetCommand(argsText = '', namedArgs = {}) {
    const parsed = parseCommandArgs(argsText);
    const target = (parsed.positional || namedArgs.id || namedArgs.keyword || '').trim();

    if (!target) {
        const help = '[持续记忆] 请提供要证伪或移除的记忆ID或关键词。用法: /forget [--all] <记忆ID或关键词>';
        window.toastr?.warning?.(help, '持续记忆');
        return help;
    }

    const s = getState();
    const lowerTarget = target.toLowerCase();
    const isAll = Boolean(parsed.flags.all || namedArgs.all);

    if (isAll) {
        const matches = s.memories.filter(m => m.id === target || (m.content && m.content.toLowerCase().includes(lowerTarget)));
        if (matches.length === 0) {
            const notFound = `[持续记忆] 未找到匹配 "${target}" 的记忆条目`;
            window.toastr?.warning?.(notFound, '持续记忆');
            return notFound;
        }
        for (const m of matches) {
            updateMemory(m.id, {
                lifecycle: MEMORY_LIFECYCLE.REFUTED,
                status: MEMORY_STATUS.ARCHIVED
            });
        }
        saveCurrentState();
        const msg = `[持续记忆] 已批量将 ${matches.length} 条匹配记忆标记为已证伪并归档 ("${target}")`;
        window.toastr?.success?.(msg, '持续记忆');
        return msg;
    }

    const match = s.memories.find(m => m.id === target || (m.content && m.content.toLowerCase().includes(lowerTarget)));

    if (!match) {
        const notFound = `[持续记忆] 未找到匹配 "${target}" 的记忆条目`;
        window.toastr?.warning?.(notFound, '持续记忆');
        return notFound;
    }

    updateMemory(match.id, {
        lifecycle: MEMORY_LIFECYCLE.REFUTED,
        status: MEMORY_STATUS.ARCHIVED
    });
    saveCurrentState();

    const msg = `[持续记忆] 记忆已标记为已证伪并归档: "${match.content}"`;
    window.toastr?.success?.(msg, '持续记忆');
    return msg;
}

/**
 * 执行 /preset 指令
 * @param {string} argsText 
 * @param {object} [namedArgs={}] 
 * @returns {string}
 */
export function executePresetCommand(argsText = '', namedArgs = {}) {
    const parsed = parseCommandArgs(argsText);
    const rawTarget = (parsed.positional || namedArgs.preset || namedArgs.name || '').trim().toLowerCase();

    // 智能别名映射
    const ALIASES = {
        'romance': 'romance',
        '纯爱': 'romance',
        '恋爱': 'romance',
        '情感': 'romance',
        'fantasy': 'fantasy_ttrpg',
        'fantasy_ttrpg': 'fantasy_ttrpg',
        'ttrpg': 'fantasy_ttrpg',
        '西幻': 'fantasy_ttrpg',
        '跑团': 'fantasy_ttrpg',
        '奇幻': 'fantasy_ttrpg',
        'ensemble': 'ensemble_drama',
        'ensemble_drama': 'ensemble_drama',
        'drama': 'ensemble_drama',
        '群像': 'ensemble_drama',
        '修罗场': 'ensemble_drama',
        'mystery': 'mystery_detective',
        'mystery_detective': 'mystery_detective',
        'detective': 'mystery_detective',
        '推理': 'mystery_detective',
        '悬疑': 'mystery_detective'
    };

    const targetId = ALIASES[rawTarget];

    if (!targetId || !GAMEPLAY_PRESETS[targetId]) {
        const available = Object.values(GAMEPLAY_PRESETS).map(gp => `• ${gp.id} (${gp.name}): ${gp.desc}`).join('\n');
        const help = `[持续记忆] 可用玩法流派预设:\n${available}\n用法: /preset <romance|fantasy|ensemble|mystery>`;
        if (typeof window !== 'undefined') {
            window.toastr?.info?.('请指定玩法预设名称，如 /preset romance', '持续记忆');
        }
        return help;
    }

    const preset = GAMEPLAY_PRESETS[targetId];
    applyGameplayPreset(targetId);
    const msg = `[持续记忆] 已成功切换至【${preset.name}】玩法预设！(${preset.desc})`;
    return msg;
}

/**
 * 原生斜杠指令清单定义
 */
export const SLASH_COMMAND_DEFINITIONS = [
    {
        name: 'remember',
        aliases: ['pm-remember', 'pm-add', 'pm'],
        helpString: '快速向持续记忆添加一条新记忆。用法: /remember [--pinned] [--type fact|statement|inference|todo] 内容',
        callback: (named, unnamed) => {
            const raw = Array.isArray(unnamed) ? unnamed.join(' ') : String(unnamed || '');
            return executeRememberCommand(raw, named);
        }
    },
    {
        name: 'scene',
        aliases: ['pm-scene'],
        helpString: '快速更新或纠偏当前 L0 现场快照。用法: /scene [--location 地点] [--action 动作] [--time 时间] [地点描述]',
        callback: (named, unnamed) => {
            const raw = Array.isArray(unnamed) ? unnamed.join(' ') : String(unnamed || '');
            return executeSceneCommand(raw, named);
        }
    },
    {
        name: 'inspect',
        aliases: ['pm-inspect'],
        helpString: '打开持续记忆即时注入透视镜 (查看实际提示词与记忆得分)',
        callback: () => executeInspectCommand()
    },
    {
        name: 'digest',
        aliases: ['pm-digest'],
        helpString: '立即触发一次持续记忆后台提炼',
        callback: () => executeDigestCommand()
    },
    {
        name: 'forget',
        aliases: ['pm-forget'],
        helpString: '将某条记忆快速标记为已证伪并归档。用法: /forget [--all] <关键词或ID>',
        callback: (named, unnamed) => {
            const raw = Array.isArray(unnamed) ? unnamed.join(' ') : String(unnamed || '');
            return executeForgetCommand(raw, named);
        }
    },
    {
        name: 'preset',
        aliases: ['pm-preset'],
        helpString: '一键套用玩法流派预设。用法: /preset <romance|fantasy|ensemble|mystery|list>',
        callback: (named, unnamed) => {
            const raw = Array.isArray(unnamed) ? unnamed.join(' ') : String(unnamed || '');
            return executePresetCommand(raw, named);
        }
    }
];

/**
 * 注册原生斜杠指令至 SillyTavern
 * @param {object} [customParser=null] - 可选自定义解析器 (用于测试或兼容环境)
 * @param {object} [customCommandClass=null] - 可选自定义 Command 类 (用于测试或兼容环境)
 * @returns {Promise<boolean>}
 */
export async function registerSlashCommands(customParser = null, customCommandClass = null) {
    let parser = customParser;
    let commandClass = customCommandClass;

    if (!parser || !commandClass) {
        if (typeof window !== 'undefined') {
            try {
                if (window.SlashCommandParser && window.SlashCommand) {
                    parser = window.SlashCommandParser;
                    commandClass = window.SlashCommand;
                } else {
                    const parserMod = await import('/scripts/slash-commands/SlashCommandParser.js');
                    const cmdMod = await import('/scripts/slash-commands/SlashCommand.js');
                    parser = parserMod.SlashCommandParser;
                    commandClass = cmdMod.SlashCommand;
                }
            } catch (err) {
                // 环境无原生 SlashCommand 支持
                return false;
            }
        }
    }

    if (!parser || typeof parser.addCommandObject !== 'function') {
        return false;
    }

    for (const def of SLASH_COMMAND_DEFINITIONS) {
        try {
            const cmdObj = typeof commandClass?.fromProps === 'function'
                ? commandClass.fromProps(def)
                : def;
            parser.addCommandObject(cmdObj);
        } catch (e) {
            console.warn(`[${MODULE_NAME}] 注册斜杠指令 [${def.name}] 失败:`, e);
        }
    }

    console.log(`[${MODULE_NAME}] [Commands] 成功注册 6 大原生斜杠指令 (/remember, /scene, /inspect, /digest, /forget, /preset)`);
    return true;
}
