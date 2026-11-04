/**
 * 记忆状态管理器 (v0.1.1)
 * 严格落实数据完整性、生命周期分流、PATCH 更新与保守去重
 */

import { MODULE_NAME, DEFAULT_SETTINGS, DEFAULT_STATE, MEMORY_STATUS, MEMORY_LIFECYCLE, MEMORY_TYPES } from './config.js';

let stateCache = null;
const stateChangeListeners = new Set();

function getContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

function notifyChange() {
    for (const listener of stateChangeListeners) {
        try {
            listener(stateCache);
        } catch (e) {
            console.error(`[${MODULE_NAME}] State change listener error:`, e);
        }
    }
}

export function onStateChange(fn) {
    stateChangeListeners.add(fn);
    return () => stateChangeListeners.delete(fn);
}

export function getSettings() {
    const c = getContext();
    if (!c?.extension_settings) return { ...DEFAULT_SETTINGS };
    if (!c.extension_settings[MODULE_NAME]) {
        c.extension_settings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    return c.extension_settings[MODULE_NAME];
}

export function updateSettings(patch) {
    const settings = getSettings();
    Object.assign(settings, patch);
    const c = getContext();
    c?.saveSettingsDebounced?.();
    notifyChange();
}

/**
 * 初始化或加载当前聊天的记忆状态 (支持 Schema v1 -> v2 平滑迁移)
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

    const stored = metadata[MODULE_NAME];

    // Schema v1 -> v2 迁移
    const rawScene = stored.scene || {};
    const migratedMemories = (Array.isArray(stored.memories) ? stored.memories : []).map(m => ({
        ...m,
        lifecycle: m.lifecycle || (m.status === MEMORY_STATUS.ARCHIVED ? MEMORY_LIFECYCLE.COMPLETED : MEMORY_LIFECYCLE.ACTIVE)
    }));

    stateCache = {
        version: 2,
        scene: {
            scene_id: rawScene.scene_id || 'scene_0',
            location: rawScene.location || '',
            time: rawScene.time || '',
            action: rawScene.action || '',
            tension: rawScene.tension || '',
            unresolved: rawScene.unresolved || '',
            in_scene_characters: Array.isArray(rawScene.in_scene_characters) ? rawScene.in_scene_characters : [],
            updated_at: rawScene.updated_at || new Date().toISOString()
        },
        memories: migratedMemories,
        turn_count: Number(stored.turn_count) || 0,
        last_digest_floor: Number(stored.last_digest_floor) || 0,
        last_digest_time: stored.last_digest_time || '',
        last_digest_summary: stored.last_digest_summary || '尚未执行提炼'
    };

    notifyChange();
    return stateCache;
}

export function saveCurrentState() {
    const c = getContext();
    if (!c?.chat_metadata || !stateCache) return;

    c.chat_metadata[MODULE_NAME] = stateCache;
    c.saveMetadata?.();
    notifyChange();
}

export function getState() {
    if (!stateCache) {
        return loadCurrentState();
    }
    return stateCache;
}

/**
 * P0-2 修复：严格遵循 PATCH 语义更新现场快照 (Scene State)
 * 规则：字段缺失或为 undefined 时保留旧值；提供非空新值才覆盖；记录 scene_id 与更新时间
 */
export function updateScene(scenePatch) {
    if (!scenePatch || typeof scenePatch !== 'object') return;
    const s = getState();
    const cur = s.scene;

    // 判断地点是否发生重大改变，若换地点则生成新 scene_id
    const newLocation = typeof scenePatch.location === 'string' && scenePatch.location.trim() ? scenePatch.location.trim() : null;
    let newSceneId = cur.scene_id;
    if (newLocation && cur.location && newLocation !== cur.location) {
        newSceneId = 'scene_' + Date.now().toString(36);
    }

    // 在场角色处理：新值存在且非空则覆盖，否则保留
    let newChars = cur.in_scene_characters;
    if (Array.isArray(scenePatch.in_scene_characters) && scenePatch.in_scene_characters.length > 0) {
        newChars = Array.from(new Set(scenePatch.in_scene_characters.map(x => String(x).trim()).filter(Boolean)));
    }

    s.scene = {
        scene_id: newSceneId,
        location: newLocation !== null ? newLocation : cur.location,
        time: typeof scenePatch.time === 'string' && scenePatch.time.trim() ? scenePatch.time.trim() : cur.time,
        action: typeof scenePatch.action === 'string' && scenePatch.action.trim() ? scenePatch.action.trim() : cur.action,
        tension: typeof scenePatch.tension === 'string' && scenePatch.tension.trim() ? scenePatch.tension.trim() : cur.tension,
        unresolved: typeof scenePatch.unresolved === 'string' && scenePatch.unresolved.trim() ? scenePatch.unresolved.trim() : cur.unresolved,
        in_scene_characters: newChars,
        updated_at: new Date().toISOString()
    };

    saveCurrentState();
}

/**
 * P0-3 修复：归一化双文本相似度 [0, 1]，修正数学越界问题
 */
function calculateTextSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    if (str1 === str2) return 1.0;
    const s1 = String(str1).toLowerCase().replace(/\s+/g, '');
    const s2 = String(str2).toLowerCase().replace(/\s+/g, '');
    if (s1 === s2) return 1.0;

    // 包含关系加权 (严格限制在 1.0 以内)
    if (s1.includes(s2) || s2.includes(s1)) {
        const ratio = Math.min(s1.length, s2.length) / Math.max(s1.length, s2.length);
        return Math.min(1.0, ratio * 0.7 + 0.25);
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

    const dice = (2 * intersection) / (set1.size + set2.size);
    return Math.max(0.0, Math.min(1.0, dice));
}

/**
 * 否定词判定：包含否定含义的陈述不能与肯定陈述合并
 */
function hasNegationWord(text) {
    const negations = ['不', '没', '未', '非', '别', '无', 'not', 'never', 'no', 'deny', 'refuse'];
    const s = String(text).toLowerCase();
    return negations.some(w => s.includes(w));
}

/**
 * P0-3 修复：保守去重与认知演化保护
 * 1. 严格检查类型一致性 (同类型才考虑合并)
 * 2. 否定词冲突时严禁合并
 * 3. 主观推断 (Inference) 绝不轻易合并（保护认知演进过程：信任 -> 怀疑 -> 确认 -> 原谅）
 * 4. 已完成/已被取代的记忆绝不自动复活
 * 5. 无法确定为同一事件时，宁可保留两条，绝不错误合并
 */
export function addMemory(item) {
    const s = getState();
    const content = String(item.content || '').trim();
    if (!content) return null;

    const targetType = item.type || MEMORY_TYPES.FACT;
    const newKeys = Array.isArray(item.trigger_keys) ? item.trigger_keys.map(k => String(k).trim()).filter(Boolean) : [];
    const itemHasNegation = hasNegationWord(content);

    // 尝试寻找完全等价或极度相似的条目
    for (const existing of s.memories) {
        // 规则 1：类型不一致绝对不合并
        if (existing.type !== targetType) continue;

        // 规则 2：如果有一方包含否定词而另一方没有，存在立场对立可能，严禁合并
        if (itemHasNegation !== hasNegationWord(existing.content)) continue;

        // 规则 3：已完成或已取代的记忆不参与自动合并/复活
        if (existing.lifecycle === MEMORY_LIFECYCLE.COMPLETED || existing.lifecycle === MEMORY_LIFECYCLE.SUPERSEDED) {
            continue;
        }

        // 规则 4：主观推断 (Inference) 代表心境随时间演进，只有文字极其完全一致 (>=0.92) 才去重，否则保留时间线
        const threshold = targetType === MEMORY_TYPES.INFERENCE ? 0.92 : 0.85;
        const similarity = calculateTextSimilarity(existing.content, content);

        if (similarity >= threshold) {
            // 合并触发词
            const mergedKeys = Array.from(new Set([...(existing.trigger_keys || []), ...newKeys]));
            existing.trigger_keys = mergedKeys;

            // 若新陈述更完整，更新内容
            if (content.length > existing.content.length && content.includes(existing.content)) {
                existing.content = content;
            }

            existing.floor = item.floor || existing.floor;
            existing.updated_at = new Date().toISOString();

            saveCurrentState();
            console.log(`[${MODULE_NAME}] [去重融合] 匹配到高度吻合条目，融合触发词: "${existing.content}"`);
            return existing;
        }
    }

    // 创建全新记忆
    const newItem = {
        id: 'mem-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6),
        type: targetType,
        content: content,
        trigger_keys: newKeys,
        status: item.status || MEMORY_STATUS.TRIGGERED,
        lifecycle: MEMORY_LIFECYCLE.ACTIVE,
        character: item.character || '',
        floor: item.floor || 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };

    s.memories.push(newItem);
    saveCurrentState();
    return newItem;
}

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

export function deleteMemory(id) {
    const s = getState();
    const initialLen = s.memories.length;
    s.memories = s.memories.filter(m => m.id !== id);
    if (s.memories.length !== initialLen) {
        saveCurrentState();
    }
}

/**
 * P1-7 修复：归档与生命周期状态解耦
 */
export function archiveMemory(id, lifecycleReason = MEMORY_LIFECYCLE.COMPLETED) {
    updateMemory(id, {
        status: MEMORY_STATUS.ARCHIVED,
        lifecycle: lifecycleReason
    });
}

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
