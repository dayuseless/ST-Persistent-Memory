/**
 * 记忆状态管理器：负责与 SillyTavern 的 chat_metadata 及 extension_settings 交互
 */

import { MODULE_NAME, DEFAULT_SETTINGS, DEFAULT_STATE, MEMORY_STATUS } from './config.js';

let stateCache = null;
const stateChangeListeners = new Set();

/** 获取 SillyTavern 上下文 */
function getContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

/** 触发监听器更新 UI */
function notifyChange() {
    for (const listener of stateChangeListeners) {
        try {
            listener(stateCache);
        } catch (e) {
            console.error(`[${MODULE_NAME}] State change listener error:`, e);
        }
    }
}

/**
 * 注册状态变动监听器 (用于 UI 实时重绘)
 */
export function onStateChange(fn) {
    stateChangeListeners.add(fn);
    return () => stateChangeListeners.delete(fn);
}

/**
 * 获取全局设置
 */
export function getSettings() {
    const c = getContext();
    if (!c?.extension_settings) return { ...DEFAULT_SETTINGS };
    if (!c.extension_settings[MODULE_NAME]) {
        c.extension_settings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    return c.extension_settings[MODULE_NAME];
}

/**
 * 更新全局设置
 */
export function updateSettings(patch) {
    const settings = getSettings();
    Object.assign(settings, patch);
    const c = getContext();
    c?.saveSettingsDebounced?.();
    notifyChange();
}

/**
 * 初始化或加载当前聊天的记忆状态
 */
export function loadCurrentState() {
    const c = getContext();
    const metadata = c?.chat_metadata;

    if (!metadata) {
        stateCache = JSON.parse(JSON.stringify(DEFAULT_STATE));
        return stateCache;
    }

    if (!metadata[MODULE_NAME]) {
        metadata[MODULE_NAME] = JSON.parse(JSON.stringify(DEFAULT_STATE));
    }

    // 结构兜底
    const stored = metadata[MODULE_NAME];
    stateCache = {
        version: stored.version || 1,
        scene: {
            ...DEFAULT_STATE.scene,
            ...(stored.scene || {})
        },
        memories: Array.isArray(stored.memories) ? stored.memories : [],
        turn_count: Number(stored.turn_count) || 0,
        last_digest_floor: Number(stored.last_digest_floor) || 0
    };

    notifyChange();
    return stateCache;
}

/**
 * 将状态同步落盘到 chat_metadata
 */
export function saveCurrentState() {
    const c = getContext();
    if (!c?.chat_metadata || !stateCache) return;

    c.chat_metadata[MODULE_NAME] = stateCache;
    c.saveMetadata?.();
    notifyChange();
}

/**
 * 获取当前记忆状态
 */
export function getState() {
    if (!stateCache) {
        return loadCurrentState();
    }
    return stateCache;
}

/**
 * 更新现场快照 (Scene State)
 */
export function updateScene(scenePatch) {
    const s = getState();
    s.scene = {
        ...s.scene,
        ...scenePatch
    };
    saveCurrentState();
}

/**
 * 添加一条记忆条目
 */
export function addMemory(item) {
    const s = getState();
    const newItem = {
        id: 'mem-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6),
        type: item.type || 'fact',
        content: String(item.content || '').trim(),
        trigger_keys: Array.isArray(item.trigger_keys) ? item.trigger_keys : [],
        status: item.status || MEMORY_STATUS.TRIGGERED,
        character: item.character || '',
        floor: item.floor || 0,
        created_at: new Date().toISOString()
    };

    if (newItem.content) {
        s.memories.push(newItem);
        saveCurrentState();
    }
    return newItem;
}

/**
 * 更新指定记忆条目
 */
export function updateMemory(id, patch) {
    const s = getState();
    const idx = s.memories.findIndex(m => m.id === id);
    if (idx !== -1) {
        s.memories[idx] = {
            ...s.memories[idx],
            ...patch
        };
        saveCurrentState();
    }
}

/**
 * 删除指定记忆
 */
export function deleteMemory(id) {
    const s = getState();
    const initialLen = s.memories.length;
    s.memories = s.memories.filter(m => m.id !== id);
    if (s.memories.length !== initialLen) {
        saveCurrentState();
    }
}

/**
 * 快速循环切换状态: 📌 Pinned -> ⚡ Triggered -> 💤 Archived -> 📌 Pinned
 */
export function cycleMemoryStatus(id) {
    const s = getState();
    const item = s.memories.find(m => m.id === id);
    if (!item) return;

    if (item.status === MEMORY_STATUS.PINNED) {
        item.status = MEMORY_STATUS.TRIGGERED;
    } else if (item.status === MEMORY_STATUS.TRIGGERED) {
        item.status = MEMORY_STATUS.ARCHIVED;
    } else {
        item.status = MEMORY_STATUS.PINNED;
    }

    saveCurrentState();
}
