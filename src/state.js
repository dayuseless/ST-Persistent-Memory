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
        last_digest_floor: Number(stored.last_digest_floor) || 0,
        last_digest_time: stored.last_digest_time || '',
        last_digest_summary: stored.last_digest_summary || '尚未执行提炼'
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
 * 计算两段中文/英文短文本的简单相似度 (基于双字符集交并比)
 */
function calculateTextSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    if (str1 === str2) return 1;
    const s1 = String(str1).toLowerCase().replace(/\s+/g, '');
    const s2 = String(str2).toLowerCase().replace(/\s+/g, '');
    if (s1 === s2) return 1;

    // 包含关系加权
    if (s1.includes(s2) || s2.includes(s1)) {
        return Math.min(s1.length, s2.length) / Math.max(s1.length, s2.length) + 0.3;
    }

    // Bigram 集合
    const set1 = new Set();
    for (let i = 0; i < s1.length - 1; i++) set1.add(s1.slice(i, i + 2));
    const set2 = new Set();
    for (let i = 0; i < s2.length - 1; i++) set2.add(s2.slice(i, i + 2));

    if (set1.size === 0 || set2.size === 0) return 0;

    let intersection = 0;
    for (const item of set1) {
        if (set2.has(item)) intersection++;
    }

    return (2 * intersection) / (set1.size + set2.size);
}

/**
 * 智能添加/合并记忆条目（具备去重、触发词融合与防膨胀机制）
 */
export function addMemory(item) {
    const s = getState();
    const content = String(item.content || '').trim();
    if (!content) return null;

    const newKeys = Array.isArray(item.trigger_keys) ? item.trigger_keys.map(k => String(k).trim()).filter(Boolean) : [];

    // 检查是否存在高相似度的已有记忆进行智能合并
    for (const existing of s.memories) {
        // 同类型且高相似度
        const similarity = calculateTextSimilarity(existing.content, content);
        if (similarity >= 0.72) {
            // 合并触发词
            const mergedKeys = Array.from(new Set([...(existing.trigger_keys || []), ...newKeys]));
            existing.trigger_keys = mergedKeys;

            // 若新内容更详尽，采用更详尽的文本
            if (content.length > existing.content.length && content.includes(existing.content)) {
                existing.content = content;
            }

            // 如果已有条目是归档态，且新剧情重新提及，唤醒为触发态
            if (existing.status === MEMORY_STATUS.ARCHIVED) {
                existing.status = MEMORY_STATUS.TRIGGERED;
            }

            existing.floor = item.floor || existing.floor;
            existing.updated_at = new Date().toISOString();

            saveCurrentState();
            console.log(`[${MODULE_NAME}] [去重合并] 命中相似记忆，已融合触发词与状态: "${existing.content}"`);
            return existing;
        }
    }

    // 创建全新记忆
    const newItem = {
        id: 'mem-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6),
        type: item.type || 'fact',
        content: content,
        trigger_keys: newKeys,
        status: item.status || MEMORY_STATUS.TRIGGERED,
        character: item.character || '',
        floor: item.floor || 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };

    s.memories.push(newItem);
    saveCurrentState();
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
            ...patch,
            updated_at: new Date().toISOString()
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
 * 归档指定记忆
 */
export function archiveMemory(id) {
    updateMemory(id, { status: MEMORY_STATUS.ARCHIVED });
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
