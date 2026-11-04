/**
 * 记忆状态管理器 (v0.1.5)
 * 严格落实 state_revision 状态修订号、L0 三态 PATCH 语义、事务式批量更新与严格知情集合隔离
 */

import { MODULE_NAME, DEFAULT_SETTINGS, DEFAULT_STATE, MEMORY_STATUS, MEMORY_LIFECYCLE, MEMORY_TYPES, MEMORY_SCOPE } from './config.js';

let stateCache = null;
const stateChangeListeners = new Set();
let isBatchUpdating = false;

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

/**
 * 事务式批量更新包装器 (P1 修复：提炼结果原子提交)
 * 在事务块执行期间暂停单独持久化与 revision 乱序递增，在结尾统一执行单次落盘
 */
export function batchUpdate(fn) {
    if (isBatchUpdating) {
        return fn();
    }
    isBatchUpdating = true;
    try {
        const result = fn();
        return result;
    } finally {
        isBatchUpdating = false;
        saveCurrentState();
    }
}

let settingsCache = null;

function getExtSettingsObject() {
    const c = getContext();
    return c?.extensionSettings ?? c?.extension_settings ?? window.extension_settings ?? null;
}

export function getSettings() {
    const extSettings = getExtSettingsObject();

    // 1. 优先从 SillyTavern 官方 extensionSettings 载入与维护
    if (extSettings) {
        if (!extSettings[MODULE_NAME]) {
            let restored = null;
            try {
                const raw = localStorage.getItem('ST_PM_SETTINGS_BACKUP');
                if (raw) restored = JSON.parse(raw);
            } catch {}
            extSettings[MODULE_NAME] = Object.assign({}, DEFAULT_SETTINGS, restored || {});
        } else {
            // 确保旧版本配置缺省的默认值被全量补齐 (如 mode)
            for (const [key, val] of Object.entries(DEFAULT_SETTINGS)) {
                if (extSettings[MODULE_NAME][key] === undefined) {
                    extSettings[MODULE_NAME][key] = val;
                }
            }
        }
        settingsCache = extSettings[MODULE_NAME];
        return settingsCache;
    }

    // 2. 运行环境尚未完全就绪时的持久化兜底
    if (!settingsCache) {
        let restored = null;
        try {
            const raw = localStorage.getItem('ST_PM_SETTINGS_BACKUP');
            if (raw) restored = JSON.parse(raw);
        } catch {}
        settingsCache = Object.assign({}, DEFAULT_SETTINGS, restored || {});
    }
    return settingsCache;
}

export function updateSettings(patch) {
    const settings = getSettings();
    Object.assign(settings, patch);

    if (settingsCache && settingsCache !== settings) {
        Object.assign(settingsCache, patch);
    }

    const extSettings = getExtSettingsObject();
    if (extSettings) {
        extSettings[MODULE_NAME] = settings;
    }

    const c = getContext();
    c?.saveSettingsDebounced?.();

    try {
        localStorage.setItem('ST_PM_SETTINGS_BACKUP', JSON.stringify(settings));
    } catch {}
}

/**
 * 立即持久化配置 (双重保险：酒馆主配置落盘 + 本地持久化备份)
 */
export function saveSettingsImmediately() {
    const c = getContext();
    const settings = getSettings();
    try {
        const extSettings = getExtSettingsObject();
        if (extSettings) {
            extSettings[MODULE_NAME] = settings;
        }
        if (typeof c?.saveSettings === 'function') {
            c.saveSettings();
        } else if (typeof c?.saveSettingsDebounced === 'function') {
            c.saveSettingsDebounced();
        }
        localStorage.setItem('ST_PM_SETTINGS_BACKUP', JSON.stringify(settings));
        return true;
    } catch (e) {
        console.error(`[${MODULE_NAME}] 立即保存配置失败:`, e);
        return false;
    }
}

/**
 * 初始化或加载当前聊天的记忆状态 (支持 Schema 平滑迁移)
 */
export function loadCurrentState() {
    const c = getContext();
    const metadata = c?.chatMetadata ?? c?.chat_metadata;

    if (!metadata) {
        stateCache = JSON.parse(JSON.stringify(DEFAULT_STATE));
        return stateCache;
    }

    if (!metadata[MODULE_NAME]) {
        metadata[MODULE_NAME] = JSON.parse(JSON.stringify(DEFAULT_STATE));
    }

    const stored = metadata[MODULE_NAME];
    const rawScene = stored.scene || {};

    const sanitizeId = (id) => {
        if (typeof id === 'string' && /^[a-zA-Z0-9_\-\.]+$/.test(id.trim())) {
            return id.trim();
        }
        return 'mem-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6);
    };

    const migratedMemories = (Array.isArray(stored.memories) ? stored.memories : []).map(m => {
        const scope = m.scope || (m.character ? MEMORY_SCOPE.CHARACTER : MEMORY_SCOPE.SHARED);
        const knownBy = Array.isArray(m.known_by)
            ? m.known_by.filter(Boolean)
            : (m.character ? [m.character] : []);

        return {
            ...m,
            id: sanitizeId(m.id),
            scope: scope,
            known_by: knownBy,
            // P1 修复旧记忆迁移语义：旧版无 lifecycle 的 archived 项仅代表检索休眠，绝不擅自篡改为 completed
            lifecycle: m.lifecycle || MEMORY_LIFECYCLE.ACTIVE
        };
    });

    stateCache = {
        version: 3,
        state_revision: Number(stored.state_revision) || 0,
        scene: {
            scene_id: typeof rawScene.scene_id === 'string' && rawScene.scene_id.trim() ? rawScene.scene_id.trim() : 'scene_init',
            location: typeof rawScene.location === 'string' ? rawScene.location : '',
            time: typeof rawScene.time === 'string' ? rawScene.time : '',
            action: typeof rawScene.action === 'string' ? rawScene.action : '',
            tension: typeof rawScene.tension === 'string' ? rawScene.tension : '',
            unresolved: typeof rawScene.unresolved === 'string' ? rawScene.unresolved : '',
            // P0: 严格区分三态：若提供数组 (包括 []) 精确保留，若为 undefined 或 null 严格保持 undefined 未知
            in_scene_characters: Array.isArray(rawScene.in_scene_characters)
                ? rawScene.in_scene_characters.filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean)
                : undefined,
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
    if (isBatchUpdating) {
        return; // 事务进行中，由 batchUpdate 统一在结尾原子落盘
    }
    const c = getContext();
    const metadata = c?.chatMetadata ?? c?.chat_metadata;
    if (!stateCache) return;

    // 每次实际落盘增加修订版本号
    stateCache.state_revision = (stateCache.state_revision || 0) + 1;

    if (metadata) {
        metadata[MODULE_NAME] = stateCache;
        if (typeof c?.saveMetadataDebounced === 'function') {
            c.saveMetadataDebounced();
        } else if (typeof c?.saveMetadata === 'function') {
            c.saveMetadata();
        }
    }

    notifyChange();
}

export function getState() {
    if (!stateCache) {
        return loadCurrentState();
    }
    return stateCache;
}

/**
 * P0-2 修复：严格落实 L0 现场快照的三态 PATCH 语义
 * 
 * 1. 字段为 undefined: 未提供更新 -> 严格继承旧值 (保留)
 * 2. 字段为 null 或空字符串 "": 显式要求清空 -> 清空旧值
 * 3. 字段为非空字符串: 提供了有效新值 -> 覆盖旧值 (非字符串直接拒绝，防 [object Object] 污染)
 * 4. 角色数组: 若显式提供数组 (包括 []) -> 按新数组覆盖；若为 null -> 重置为 undefined 未知；若为 undefined -> 保留旧值
 */
export function updateScene(scenePatch) {
    if (!scenePatch || typeof scenePatch !== 'object') return;
    const s = getState();
    const cur = s.scene;

    const resolveField = (newVal, oldVal) => {
        if (newVal === undefined) return oldVal; // 继承
        if (newVal === null || newVal === '') return ''; // 显式清空
        if (typeof newVal !== 'string') return oldVal; // 防污染：拒绝非字符串对象
        return newVal.trim(); // 覆盖
    };

    const newLocation = resolveField(scenePatch.location, cur.location);
    const newTime = resolveField(scenePatch.time, cur.time);
    const newAction = resolveField(scenePatch.action, cur.action);
    const newTension = resolveField(scenePatch.tension, cur.tension);
    const newUnresolved = resolveField(scenePatch.unresolved, cur.unresolved);

    // 角色数组三态处理
    let newChars = cur.in_scene_characters;
    if (Array.isArray(scenePatch.in_scene_characters)) {
        newChars = Array.from(new Set(scenePatch.in_scene_characters.filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean)));
    } else if (scenePatch.in_scene_characters === null) {
        newChars = undefined; // 显式重置为未知
    }

    // scene_id 独立机制：支持显式切换，或地点迁移时自动更迭
    let newSceneId = cur.scene_id;
    if (typeof scenePatch.scene_id === 'string' && scenePatch.scene_id.trim()) {
        newSceneId = scenePatch.scene_id.trim();
    } else if (newLocation && cur.location && newLocation !== cur.location) {
        newSceneId = 'scene_' + Date.now().toString(36);
    }

    s.scene = {
        scene_id: newSceneId,
        location: newLocation,
        time: newTime,
        action: newAction,
        tension: newTension,
        unresolved: newUnresolved,
        in_scene_characters: newChars,
        updated_at: new Date().toISOString()
    };

    saveCurrentState();
}

/**
 * 归一化双文本相似度 [0.0, 1.0]
 */
function calculateTextSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    if (str1 === str2) return 1.0;
    const s1 = String(str1).toLowerCase().replace(/\s+/g, '');
    const s2 = String(str2).toLowerCase().replace(/\s+/g, '');
    if (s1 === s2) return 1.0;

    // 包含关系加权 (严格夹紧在 1.0 以内)
    if (s1.includes(s2) || s2.includes(s1)) {
        const ratio = Math.min(s1.length, s2.length) / Math.max(s1.length, s2.length);
        return Math.min(1.0, ratio * 0.7 + 0.25);
    }

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

function hasNegationWord(text) {
    if (!text || typeof text !== 'string') return false;
    const s = text.toLowerCase();
    // P2 改进：英文单词边界精准匹配 (避免 notable, nobody, normal 等误判)
    if (/\b(not|never|no|deny|denies|denied|refuse|refuses|refused|cannot|can't|won't|don't|didn't|isn't|aren't)\b/i.test(s)) {
        return true;
    }
    // 中文：排除常见非否定虚词“不仅”、“不只”、“不断”等，匹配真正否定动词/形容词组合
    const cleanedZh = s.replace(/不仅|不只|不单|不断|不愧|不懈|无微不至|无所不在|无论/g, '');
    const zhNegationRegex = /(?:[不没未非别无莫弗])[\u4e00-\u9fa5]/;
    return zhNegationRegex.test(cleanedZh);
}

function areSetsEqual(arr1, arr2) {
    const s1 = new Set(Array.isArray(arr1) ? arr1 : []);
    const s2 = new Set(Array.isArray(arr2) ? arr2 : []);
    if (s1.size !== s2.size) return false;
    for (const item of s1) {
        if (!s2.has(item)) return false;
    }
    return true;
}

/**
 * 保守去重与认知演化保护
 */
export function addMemory(item) {
    if (!item || typeof item !== 'object') return null;
    const s = getState();
    if (typeof item.content !== 'string') return null;
    const content = item.content.trim();
    if (!content) return null;

    const validTypes = new Set(Object.values(MEMORY_TYPES));
    const validScopes = new Set(Object.values(MEMORY_SCOPE));

    const targetType = item.type || MEMORY_TYPES.FACT;
    if (!validTypes.has(targetType)) {
        console.warn(`[${MODULE_NAME}] [Fail-Closed] 拦截非法记忆类型 "${targetType}"，拒绝入库`);
        return null;
    }

    // P1 修复：未指定特定知情者时默认归类为 world (世界公共事实)，防止快捷添加普通记忆被 Fail-Closed 误杀
    let targetScope;
    if (item.scope) {
        targetScope = item.scope;
    } else if (item.character) {
        targetScope = MEMORY_SCOPE.CHARACTER;
    } else if (Array.isArray(item.known_by) && item.known_by.length > 0) {
        targetScope = MEMORY_SCOPE.SHARED;
    } else {
        targetScope = MEMORY_SCOPE.WORLD;
    }

    if (!validScopes.has(targetScope)) {
        console.warn(`[${MODULE_NAME}] [Fail-Closed] 拦截非法记忆知情范围 "${targetScope}"，拒绝入库`);
        return null;
    }

    const targetChar = typeof item.character === 'string' ? item.character.trim() : '';

    // P0 Fail-Closed: 角色私知 (character) 必须具备非空角色归属
    if (targetScope === MEMORY_SCOPE.CHARACTER && !targetChar) {
        console.warn(`[${MODULE_NAME}] [Fail-Closed] 拦截角色私有记忆：缺少明确角色归属，拒绝入库`);
        return null;
    }

    const newKeys = Array.isArray(item.trigger_keys)
        ? item.trigger_keys.filter(k => typeof k === 'string').map(k => k.trim()).filter(Boolean)
        : [];

    const knownBy = Array.isArray(item.known_by) && item.known_by.length > 0
        ? Array.from(new Set(item.known_by.filter(k => typeof k === 'string').map(k => k.trim()).filter(Boolean)))
        : (targetChar ? [targetChar] : []);

    // P1 Fail-Closed: 现场共知 (shared) 必须具备至少一个知情者 (known_by 或 character)，严禁作为公共记忆入库
    if (targetScope === MEMORY_SCOPE.SHARED && knownBy.length === 0) {
        console.warn(`[${MODULE_NAME}] [Fail-Closed] 拦截共享记忆：缺少知情者集合 (known_by / character)，拒绝入库`);
        return null;
    }

    const itemHasNegation = hasNegationWord(content);

    // 尝试寻找完全等价或极度吻合的条目进行融合
    for (const existing of s.memories) {
        // 规则 1：类型不一致绝对不合并
        if (existing.type !== targetType) continue;

        // 规则 2：知情范围或目标角色不一致绝对不合并 (防串戏)
        if (existing.scope !== targetScope || (existing.character || '') !== targetChar) {
            continue;
        }

        // 规则 2.1 (P1 修复)：对于 shared 共享记忆，双方知情者集合必须完全等价才允许合并！
        // 绝不因为甲知道某事、乙也知道某事，就粗暴合并为甲乙共同经历！
        if (targetScope === MEMORY_SCOPE.SHARED) {
            if (!areSetsEqual(existing.known_by, knownBy)) {
                continue;
            }
        }

        // 规则 3：否定立场对立绝对不合并
        if (itemHasNegation !== hasNegationWord(existing.content)) continue;

        // 规则 4：已完成 (completed)、已被取代 (superseded) 或已被证伪 (refuted) 绝不参与合并或复活
        if (existing.lifecycle === MEMORY_LIFECYCLE.COMPLETED ||
            existing.lifecycle === MEMORY_LIFECYCLE.SUPERSEDED ||
            existing.lifecycle === MEMORY_LIFECYCLE.REFUTED) {
            continue;
        }

        // 规则 5：主观推断 (Inference) 绝不轻易合并，保护认知演变时间线
        const threshold = targetType === MEMORY_TYPES.INFERENCE ? 0.94 : 0.86;
        const similarity = calculateTextSimilarity(existing.content, content);

        if (similarity >= threshold) {
            existing.trigger_keys = Array.from(new Set([...(existing.trigger_keys || []), ...newKeys]));

            if (content.length > existing.content.length && content.includes(existing.content)) {
                existing.content = content;
            }

            existing.floor = item.floor || existing.floor;
            existing.updated_at = new Date().toISOString();

            saveCurrentState();
            console.log(`[${MODULE_NAME}] [保守融合] 匹配到高度吻合条目，融合触发词: "${existing.content}"`);
            return existing;
        }
    }

    // 创建全新独立条目
    const newItem = {
        id: 'mem-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6),
        type: targetType,
        content: content,
        trigger_keys: newKeys,
        status: item.status || MEMORY_STATUS.TRIGGERED,
        lifecycle: item.lifecycle || MEMORY_LIFECYCLE.ACTIVE,
        character: targetChar,
        scope: targetScope,
        known_by: knownBy,
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
 * 显式更新条目生命周期状态 (completed / superseded / refuted)
 */
export function setMemoryLifecycle(id, newLifecycle) {
    const validLifecycles = new Set(Object.values(MEMORY_LIFECYCLE));
    if (!validLifecycles.has(newLifecycle)) return;

    updateMemory(id, {
        lifecycle: newLifecycle,
        status: newLifecycle === MEMORY_LIFECYCLE.ACTIVE ? MEMORY_STATUS.TRIGGERED : MEMORY_STATUS.ARCHIVED
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
        // 若手动将记忆置为常驻，且其当前处于非 active 状态，自动唤醒为 active，防止出现“已常驻却被生命周期拦截不注入”的误解
        if (item.lifecycle && item.lifecycle !== MEMORY_LIFECYCLE.ACTIVE) {
            item.lifecycle = MEMORY_LIFECYCLE.ACTIVE;
        }
    }

    saveCurrentState();
}
