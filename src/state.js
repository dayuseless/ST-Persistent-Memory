/**
 * 记忆状态管理器 (v0.1.43)
 * 严格落实 state_revision 状态修订号、L0 三态 PATCH 语义、真正原子回滚事务、统一ACL判定层介入、数据准入流水线、世界书升格溯源、知情集合隔离、世界书解耦、现场状态时光机解耦 (src/scene.js) 与数据迁移/导入导出解耦 (src/migration.js)
 */

import { MODULE_NAME, EXTENSION_VERSION, DEFAULT_SETTINGS, DEFAULT_STATE, MEMORY_STATUS, MEMORY_LIFECYCLE, MEMORY_TYPES, MEMORY_SCOPE } from './config.js';
import { syncEnsureLocalEmbedding, reindexMemories } from './semantic.js';
import { getContextParticipants, validateMemoryAcl, normalizeAndValidateMemory, checkAclEscalation, recordAclAudit, canRecipientAccessMemory } from './acl.js';
import {
    sanitizeLorebookRef,
    getActiveWorldBookInfo,
    syncMemoryDeltaToWorldInfo,
    promoteMemoryToWorldInfo
} from './lorebook.js';
import {
    pushSceneSnapshot,
    rollbackScene,
    restoreSceneSnapshot,
    getSceneHistory,
    updateScene
} from './scene.js';
import {
    sanitizeMemoryId,
    migrateMemoryItems,
    migrateLegacyState,
    exportMemoryDataPackage,
    importMemoryDataPackage
} from './migration.js';

export {
    getContextParticipants,
    validateMemoryAcl,
    normalizeAndValidateMemory,
    checkAclEscalation,
    recordAclAudit,
    canRecipientAccessMemory,
    sanitizeLorebookRef,
    getActiveWorldBookInfo,
    syncMemoryDeltaToWorldInfo,
    promoteMemoryToWorldInfo,
    pushSceneSnapshot,
    rollbackScene,
    restoreSceneSnapshot,
    getSceneHistory,
    updateScene,
    sanitizeMemoryId,
    migrateMemoryItems,
    migrateLegacyState,
    exportMemoryDataPackage,
    importMemoryDataPackage
};

let stateCache = null;
const stateCacheMap = new Map();
let currentLoadedChatId = null;
const stateChangeListeners = new Set();
let isBatchUpdating = false;

function getContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

export function getCurrentChatId(c) {
    if (!c) return 'default';
    return String(c.chatId || (c.characterId !== undefined ? `char_${c.characterId}` : 'default'));
}

export function clearStateCache() {
    stateCache = null;
    stateCacheMap.clear();
    currentLoadedChatId = null;
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
 * 将当前缓存写入聊天元数据。调用方负责处理批处理状态。
 */
function persistCurrentStateInternal() {
    const c = getContext();
    const chatId = getCurrentChatId(c);
    const metadata = c?.chatMetadata ?? c?.chat_metadata;
    if (!stateCache) return false;

    // 每次实际落盘增加修订版本号。
    stateCache.state_revision = (stateCache.state_revision || 0) + 1;

    if (metadata) {
        metadata[MODULE_NAME] = stateCache;
        if (typeof c?.saveMetadata === 'function') {
            try { c.saveMetadata(); } catch {}
        } else if (typeof c?.saveMetadataDebounced === 'function') {
            try { c.saveMetadataDebounced(); } catch {}
        }
    }

    // 双重落盘保险：将会话快照同步备份至本地存储，防止未及时落盘导致编辑丢失
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('ST_PM_STATE_BACKUP_' + chatId, JSON.stringify(stateCache));
        }
    } catch {}

    stateCacheMap.set(chatId, stateCache);
    currentLoadedChatId = chatId;

    notifyChange();
    return true;
}

/**
 * 事务式批量更新包装器 (具备完整内存快照与异常回滚能力)
 * 在事务块执行期间暂停单独持久化；若执行过程中发生任何异常，完整恢复先前快照，严禁落盘半修改状态。
 */
export function batchUpdate(fn) {
    if (isBatchUpdating) {
        return fn();
    }
    isBatchUpdating = true;
    const c = getContext();
    const activeChatId = getCurrentChatId(c);
    // 事务开始前保留完整内存状态快照 (深拷贝)
    const snapshot = stateCache ? JSON.parse(JSON.stringify(stateCache)) : null;
    try {
        const result = fn();
        // 仅在全部操作执行成功后才统一落盘
        // 这里不能调用 saveCurrentState()：它会在批处理标志为 true 时正确地拒绝嵌套保存。
        persistCurrentStateInternal();
        return result;
    } catch (err) {
        // 异常回滚内存状态，阻止脏数据持久化
        console.error(`[${MODULE_NAME}] [Transaction Rollback] 批量更新发生异常，执行状态完整回滚:`, err);
        if (snapshot) {
            stateCache = snapshot;
            stateCacheMap.set(activeChatId, stateCache);
            currentLoadedChatId = activeChatId;
            notifyChange();
        }
        throw err;
    } finally {
        isBatchUpdating = false;
    }
}

let settingsCache = null;
let hostSaveSettingsFn = null;

function getExtSettingsObject() {
    const c = getContext();
    return c?.extensionSettings ?? c?.extension_settings ?? window?.extension_settings ?? null;
}

/**
 * P1-04 修复：针对 localStorage 备份执行敏感凭据脱敏过滤
 * 严禁将用户 API Key 以明文形式备份至浏览器共享本地存储中
 */
function getSanitizedSettingsForBackup(settings) {
    if (!settings || typeof settings !== 'object') return {};
    const safe = Object.assign({}, settings);
    delete safe.customApiKey;
    delete safe.embeddingApiKey;
    return safe;
}

/**
 * 调用宿主原生持久化方法，确保真正即时落盘
 */
async function invokeHostSaveSettings() {
    if (typeof hostSaveSettingsFn === 'function') {
        try {
            await hostSaveSettingsFn();
            return true;
        } catch {}
    }
    const c = getContext();
    if (typeof c?.saveSettings === 'function') {
        try {
            await c.saveSettings();
            return true;
        } catch {}
    }
    try {
        if (typeof window !== 'undefined') {
            const mod = await import('/script.js');
            if (typeof mod?.saveSettings === 'function') {
                hostSaveSettingsFn = mod.saveSettings;
                await hostSaveSettingsFn();
                return true;
            }
        }
    } catch {}
    if (typeof c?.saveSettingsDebounced === 'function') {
        try {
            c.saveSettingsDebounced();
            return true;
        } catch {}
    }
    return false;
}

export function getSettings() {
    const extSettings = getExtSettingsObject();

    let restored = null;
    try {
        if (typeof localStorage !== 'undefined') {
            const raw = localStorage.getItem('ST_PM_SETTINGS_BACKUP');
            if (raw) {
                restored = JSON.parse(raw);
                if (restored && (restored.customApiKey || restored.embeddingApiKey)) {
                    delete restored.customApiKey;
                    delete restored.embeddingApiKey;
                    localStorage.setItem('ST_PM_SETTINGS_BACKUP', JSON.stringify(restored));
                }
            }
        }
    } catch {}

    // 1. 优先从 SillyTavern 官方 extensionSettings 载入与维护
    if (extSettings) {
        if (!extSettings[MODULE_NAME]) {
            extSettings[MODULE_NAME] = Object.assign({}, DEFAULT_SETTINGS, restored || {});
        } else {
            // 确保旧版本配置缺省的默认值被全量补齐 (如 mode)
            for (const [key, val] of Object.entries(DEFAULT_SETTINGS)) {
                if (extSettings[MODULE_NAME][key] === undefined) {
                    extSettings[MODULE_NAME][key] = (restored && restored[key] !== undefined) ? restored[key] : val;
                }
            }
            // 防御保护：若 localStorage 备份中存在用户自定义的 Token 预算等关键配置，优先恢复生效
            if (restored) {
                if (restored.maxSceneTokens !== undefined && extSettings[MODULE_NAME].maxSceneTokens === DEFAULT_SETTINGS.maxSceneTokens && restored.maxSceneTokens !== DEFAULT_SETTINGS.maxSceneTokens) {
                    extSettings[MODULE_NAME].maxSceneTokens = restored.maxSceneTokens;
                }
                if (restored.maxTotalMemoryTokens !== undefined && extSettings[MODULE_NAME].maxTotalMemoryTokens === DEFAULT_SETTINGS.maxTotalMemoryTokens && restored.maxTotalMemoryTokens !== DEFAULT_SETTINGS.maxTotalMemoryTokens) {
                    extSettings[MODULE_NAME].maxTotalMemoryTokens = restored.maxTotalMemoryTokens;
                }
            }
        }
        settingsCache = extSettings[MODULE_NAME];
        return settingsCache;
    }

    // 2. 运行环境尚未完全就绪时的持久化兜底
    if (!settingsCache) {
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
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('ST_PM_SETTINGS_BACKUP', JSON.stringify(getSanitizedSettingsForBackup(settings)));
        }
    } catch {}

    try {
        window.__persistentMemory?.injectNow?.();
    } catch {}
}

/**
 * 立即持久化配置 (双重保险：宿主主配置即时落盘 + 本地安全脱敏备份)
 */
export function saveSettingsImmediately() {
    const c = getContext();
    const settings = getSettings();
    try {
        const extSettings = getExtSettingsObject();
        if (extSettings) {
            extSettings[MODULE_NAME] = settings;
        }
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('ST_PM_SETTINGS_BACKUP', JSON.stringify(getSanitizedSettingsForBackup(settings)));
        }
        
        invokeHostSaveSettings();

        try {
            window.__persistentMemory?.injectNow?.();
        } catch {}
        return true;
    } catch (e) {
        console.error(`[${MODULE_NAME}] 立即保存配置失败:`, e);
        return false;
    }
}

/**
 * 初始化或加载当前聊天的记忆状态 (支持 Schema 平滑迁移与本地容灾备份)
 */
export function loadCurrentState() {
    const c = getContext();
    const chatId = getCurrentChatId(c);
    const metadata = c?.chatMetadata ?? c?.chat_metadata;

    if (!metadata) {
        stateCache = JSON.parse(JSON.stringify(DEFAULT_STATE));
        stateCacheMap.set(chatId, stateCache);
        currentLoadedChatId = chatId;
        return stateCache;
    }

    if (!metadata[MODULE_NAME]) {
        metadata[MODULE_NAME] = JSON.parse(JSON.stringify(DEFAULT_STATE));
    }

    stateCache = migrateLegacyState(metadata[MODULE_NAME], DEFAULT_STATE, c);
    stateCacheMap.set(chatId, stateCache);
    currentLoadedChatId = chatId;
    notifyChange();
    return stateCache;
}

export function saveCurrentState() {
    if (isBatchUpdating) {
        return; // 事务进行中，由 batchUpdate 统一在结尾原子落盘
    }
    persistCurrentStateInternal();
}

export function getState() {
    const c = getContext();
    const activeChatId = getCurrentChatId(c);
    if (!stateCache || currentLoadedChatId !== activeChatId) {
        if (stateCacheMap.has(activeChatId)) {
            stateCache = stateCacheMap.get(activeChatId);
            currentLoadedChatId = activeChatId;
            return stateCache;
        }
        return loadCurrentState();
    }
    return stateCache;
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

function getRecipientsForScope(scope, character, knownBy) {
    if (scope === MEMORY_SCOPE.CHARACTER) {
        return character ? [character] : [];
    }
    if (scope === MEMORY_SCOPE.SHARED) {
        return Array.isArray(knownBy) ? knownBy : [];
    }
    return null; // world 对所有主体可见
}

/**
 * 保守去重与认知演化保护
 */
export function addMemory(item, options = {}) {
    if (!item || typeof item !== 'object') return null;
    const s = getState();
    const c = options.context || getContext();

    // 统一数据准入判定层执行格式规范化与权威参与者 ACL 核验 (v0.1.28)
    const norm = normalizeAndValidateMemory(item, {
        participants: options.participants !== undefined ? options.participants : getContextParticipants(c, s),
        source: options.source || 'add_memory',
        context: c,
        maxContentLen: options.maxContentLen,
        bypassAcl: options.bypassAcl
    });

    if (!norm.valid) {
        console.warn(`[${MODULE_NAME}] [Fail-Closed] 记忆数据未能通过准入校验: ${norm.reason}`);
        return null;
    }

    const candidate = norm.memory;
    let targetScope = candidate.scope;
    let targetChar = candidate.character;
    let knownBy = candidate.known_by;
    const content = candidate.content;
    const targetType = candidate.type;

    // 规则 C (P1-03 核心)：越权提权防线——若既有记忆库中已存在语义吻合的私有/共享条目，严禁通过新输出扩大既有知识范围
    for (const existing of s.memories) {
        if (existing.lifecycle === MEMORY_LIFECYCLE.COMPLETED ||
            existing.lifecycle === MEMORY_LIFECYCLE.SUPERSEDED ||
            existing.lifecycle === MEMORY_LIFECYCLE.REFUTED) {
            continue;
        }
        const sim = calculateTextSimilarity(existing.content, content);
        if (sim >= 0.70) {
            const escCheck = checkAclEscalation(existing, { scope: targetScope, character: targetChar, known_by: knownBy });
            if (escCheck.violated) {
                console.warn(`[${MODULE_NAME}] [Visibility Escalation Guard] 拦截模型扩大已有受限条目 (ID: ${existing.id}) 的可见范围，强制继承既有 ACL`);
                targetScope = escCheck.inheritedAcl.scope;
                targetChar = escCheck.inheritedAcl.character || '';
                knownBy = escCheck.inheritedAcl.known_by ? [...escCheck.inheritedAcl.known_by] : [];
                recordAclAudit(s, 'scope_escalation_blocked', { existingId: existing.id, attemptedScope: candidate.scope, inheritedScope: targetScope });
                break;
            }
        }
    }

    const newKeys = Array.isArray(item.trigger_keys)
        ? item.trigger_keys.filter(k => typeof k === 'string').map(k => k.trim()).filter(Boolean)
        : [];

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

            // 保留条目初始创建楼层，仅刷新最后活跃楼层
            const currentFloor = Number.isInteger(item.floor) ? item.floor : (Number.isInteger(existing.last_activated_floor) ? existing.last_activated_floor : (existing.floor || 0));
            existing.last_activated_floor = currentFloor;
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
        lorebook_ref: sanitizeLorebookRef(item.lorebook_ref),
        floor: item.floor || 0,
        last_activated_floor: item.floor || 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };

    try {
        syncEnsureLocalEmbedding(newItem);
    } catch {}

    s.memories.push(newItem);
    saveCurrentState();
    return newItem;
}

export function updateMemory(id, patch) {
    if (!patch || typeof patch !== 'object') return null;
    const s = getState();
    const idx = s.memories.findIndex(m => m.id === id);
    if (idx === -1) return null;

    const current = s.memories[idx];
    const updated = { ...current };

    if (typeof patch.content === 'string') {
        const trimmed = patch.content.trim().slice(0, 150);
        if (trimmed) {
            updated.content = trimmed;
        }
    }

    if (Array.isArray(patch.trigger_keys)) {
        updated.trigger_keys = patch.trigger_keys
            .filter(k => typeof k === 'string' && k.trim())
            .map(k => k.trim());
    }

    if (patch.type) {
        const VALID_TYPES = new Set(Object.values(MEMORY_TYPES));
        if (VALID_TYPES.has(patch.type)) {
            updated.type = patch.type;
        }
    }

    if (patch.status) {
        const VALID_STATUSES = new Set(Object.values(MEMORY_STATUS));
        if (VALID_STATUSES.has(patch.status)) {
            updated.status = patch.status;
        }
    }

    if (patch.lifecycle) {
        const VALID_LIFECYCLES = new Set(Object.values(MEMORY_LIFECYCLE));
        if (VALID_LIFECYCLES.has(patch.lifecycle)) {
            updated.lifecycle = patch.lifecycle;
        }
    }

    if (patch.lorebook_ref !== undefined) {
        updated.lorebook_ref = sanitizeLorebookRef(patch.lorebook_ref);
    }

    if (patch.synced_to_world_info !== undefined) {
        updated.synced_to_world_info = Boolean(patch.synced_to_world_info);
    }

    if (patch.synced_at !== undefined) {
        updated.synced_at = typeof patch.synced_at === 'string' ? patch.synced_at : null;
    }

    if (patch.content !== undefined || patch.trigger_keys !== undefined || patch.type !== undefined || patch.lorebook_ref !== undefined) {
        try {
            syncEnsureLocalEmbedding(updated);
        } catch {}
    }

    updated.updated_at = new Date().toISOString();
    s.memories[idx] = updated;
    saveCurrentState();
    return updated;
}

/**
 * 导出记忆与现场数据对象 (供备份与跨会话迁移)
 */
export function exportMemoryData() {
    return exportMemoryDataPackage(getState(), getContext());
}

/**
 * 导入并合并记忆数据
 * 支持策略：'merge' (合并去重) | 'replace' (全量覆盖)
 */
export function importMemoryData(data, strategy = 'merge') {
    return importMemoryDataPackage(data, strategy, getState(), batchUpdate, getContext());
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
 * 清理终态记忆 (完成已结项、已迭代或已证伪条目的垃圾回收，保护 active 活跃与常驻记忆)
 */
export function purgeArchivedMemories() {
    return batchUpdate(() => {
        const s = getState();
        const before = s.memories.length;
        s.memories = s.memories.filter(m => {
            if (m.status === MEMORY_STATUS.PINNED) return true;
            // 严格基于生命周期判定终态，严禁误删仅处于 status=archived 检索休眠但事实仍有效的条目
            const isTerminal = m.lifecycle === MEMORY_LIFECYCLE.COMPLETED ||
                               m.lifecycle === MEMORY_LIFECYCLE.SUPERSEDED ||
                               m.lifecycle === MEMORY_LIFECYCLE.REFUTED;
            return !isTerminal;
        });
        const removed = before - s.memories.length;
        return { success: true, removed, remaining: s.memories.length };
    });
}

/**
 * 记忆长周期衰减与自动沉睡巡检引擎 (Inactivity Dormancy Engine)
 * 当某些细节记忆经历多轮对话 (autoSleepTurns) 从未被上下文提及或激活，
 * 自动将其置为 MEMORY_STATUS.ARCHIVED (沉睡休眠)，退出日常活跃池。
 */
export function applyInactivitySleep(currentTurn, overrideSettings = null) {
    const settings = overrideSettings || getSettings();
    if (settings.autoSleepEnabled === false) return { sleptCount: 0 };

    const sleepTurns = Math.max(5, Number(settings.autoSleepTurns) || 20);
    const s = getState();
    let sleptCount = 0;

    for (const mem of s.memories) {
        // 仅处理处于 active 生命周期且 status 为 triggered 的非常驻条目
        if (mem.lifecycle === MEMORY_LIFECYCLE.ACTIVE && mem.status === MEMORY_STATUS.TRIGGERED) {
            const lastActive = Number.isInteger(mem.last_activated_floor)
                ? mem.last_activated_floor
                : (Number.isInteger(mem.floor) ? mem.floor : 0);
            if (currentTurn - lastActive >= sleepTurns) {
                mem.status = MEMORY_STATUS.ARCHIVED;
                mem.updated_at = new Date().toISOString();
                sleptCount++;
                console.log(`[${MODULE_NAME}] [Auto-Sleep] 记忆 [${mem.id}] 超过 ${sleepTurns} 轮未命中 (最后活跃: 楼层 ${lastActive}, 当前: 楼层 ${currentTurn})，已自动转入沉睡休眠`);
            }
        }
    }

    if (sleptCount > 0) {
        saveCurrentState();
    }
    return { sleptCount };
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

export function cycleMemoryType(id) {
    const s = getState();
    const item = s.memories.find(m => m.id === id);
    if (!item) return;

    const types = [MEMORY_TYPES.FACT, MEMORY_TYPES.STATEMENT, MEMORY_TYPES.INFERENCE, MEMORY_TYPES.TODO];
    const currentIdx = types.indexOf(item.type);
    const nextIdx = currentIdx === -1 ? 0 : (currentIdx + 1) % types.length;
    item.type = types[nextIdx];
    item.updated_at = new Date().toISOString();

    saveCurrentState();
}

/**
 * 重新为所有记忆建立向量索引 (支持强行重建与增量更新)
 */
export async function reindexAllMemories(force = false, onProgress = null) {
    const s = getState();
    const settings = getSettings();
    if (force) {
        for (const m of s.memories) {
            m.embedding = null;
            m.embedding_hash = null;
            m.embedding_provider = null;
        }
    }
    const result = await reindexMemories(s.memories, settings, onProgress);
    if (result.updated > 0) {
        saveCurrentState();
    }
    return result;
}


