/**
 * 记忆状态管理器 (v0.1.12)
 * 严格落实 state_revision 状态修订号、L0 三态 PATCH 语义、真正原子回滚事务、严格知情集合隔离、行内编辑与高阶归并演进
 */

import { MODULE_NAME, EXTENSION_VERSION, DEFAULT_SETTINGS, DEFAULT_STATE, MEMORY_STATUS, MEMORY_LIFECYCLE, MEMORY_TYPES, MEMORY_SCOPE } from './config.js';
import { syncEnsureLocalEmbedding, reindexMemories } from './semantic.js';

let stateCache = null;
const stateChangeListeners = new Set();
/**
 * 校验并规范化世界书关联结构 (lorebook_ref)
 * 防止对象注入、原型污染与非安全字段
 */
export function sanitizeLorebookRef(rawLb) {
    if (!rawLb || typeof rawLb !== 'object') return null;
    const entryName = typeof rawLb.entry_name === 'string' ? rawLb.entry_name.trim().slice(0, 80) : '';
    const bookName = typeof rawLb.book === 'string' ? rawLb.book.trim().slice(0, 80) : '';
    let uidVal = null;
    if (Number.isInteger(rawLb.entry_uid)) {
        uidVal = rawLb.entry_uid;
    } else if (rawLb.entry_uid !== null && rawLb.entry_uid !== undefined && !isNaN(Number(rawLb.entry_uid))) {
        uidVal = Number(rawLb.entry_uid);
    }
    if (!entryName && uidVal === null) return null;
    return {
        book: bookName,
        entry_uid: uidVal,
        entry_name: entryName
    };
}

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
 * 将当前缓存写入聊天元数据。调用方负责处理批处理状态。
 */
function persistCurrentStateInternal() {
    const c = getContext();
    const metadata = c?.chatMetadata ?? c?.chat_metadata;
    if (!stateCache) return false;

    // 每次实际落盘增加修订版本号。
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
            notifyChange();
        }
        throw err;
    } finally {
        isBatchUpdating = false;
    }
}

let settingsCache = null;

function getExtSettingsObject() {
    const c = getContext();
    return c?.extensionSettings ?? c?.extension_settings ?? window.extension_settings ?? null;
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

export function getSettings() {
    const extSettings = getExtSettingsObject();

    // 1. 优先从 SillyTavern 官方 extensionSettings 载入与维护
    if (extSettings) {
        if (!extSettings[MODULE_NAME]) {
            let restored = null;
            try {
                const raw = localStorage.getItem('ST_PM_SETTINGS_BACKUP');
                if (raw) {
                    restored = JSON.parse(raw);
                    // 清理旧版本可能遗留的明文 Key
                    if (restored && (restored.customApiKey || restored.embeddingApiKey)) {
                        delete restored.customApiKey;
                        delete restored.embeddingApiKey;
                        localStorage.setItem('ST_PM_SETTINGS_BACKUP', JSON.stringify(restored));
                    }
                }
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
            if (raw) {
                restored = JSON.parse(raw);
                if (restored && (restored.customApiKey || restored.embeddingApiKey)) {
                    delete restored.customApiKey;
                    delete restored.embeddingApiKey;
                    localStorage.setItem('ST_PM_SETTINGS_BACKUP', JSON.stringify(restored));
                }
            }
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
        localStorage.setItem('ST_PM_SETTINGS_BACKUP', JSON.stringify(getSanitizedSettingsForBackup(settings)));
    } catch {}

    try {
        window.__persistentMemory?.injectNow?.();
    } catch {}
}

/**
 * 立即持久化配置 (双重保险：酒馆主配置落盘 + 本地安全脱敏备份)
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
        localStorage.setItem('ST_PM_SETTINGS_BACKUP', JSON.stringify(getSanitizedSettingsForBackup(settings)));
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

    const isLegacyVersion = !stored.version || stored.version < 3;
    const defaultParticipants = [c?.name1, c?.name2].filter(Boolean);
    if (defaultParticipants.length === 0) {
        defaultParticipants.push('User', 'Character');
    }

    let migratedCount = 0;
    let upgradedCount = 0;
    let dormantCount = 0;

    const VALID_TYPES = new Set(Object.values(MEMORY_TYPES));
    const VALID_SCOPES = new Set(Object.values(MEMORY_SCOPE));

    // 防御性过滤：滤除 null、非对象、无有效 content 的损坏记忆条目，防止迁移中断崩溃
    const rawMemories = (Array.isArray(stored.memories) ? stored.memories : []).filter(
        m => m && typeof m === 'object' && typeof m.content === 'string' && m.content.trim().length > 0
    );

    const migratedMemories = rawMemories.map(m => {
        migratedCount++;

        // 严格类型校验与白名单归一化，杜绝存储型属性注入
        const type = VALID_TYPES.has(m.type) ? m.type : MEMORY_TYPES.FACT;

        let scope = m.scope;
        if (scope && !VALID_SCOPES.has(scope)) {
            scope = null;
        }

        let char = (typeof m.character === 'string' && m.character.trim()) ? m.character.trim() : '';
        let knownBy = Array.isArray(m.known_by)
            ? m.known_by.filter(k => typeof k === 'string' && k.trim()).map(k => k.trim())
            : null;

        if (!scope) {
            upgradedCount++;
            // 审计修复：对于旧版未显式指定 scope 的记忆，遵循保守封闭原则，归属于当前角色 private (CHARACTER)，
            // 严禁擅自升级为 [name1, name2] 双向共享秘密，防止知情范围无故膨胀
            scope = MEMORY_SCOPE.CHARACTER;
            char = char || (c?.name2 || 'Character');
            knownBy = [char];
        } else if (scope === MEMORY_SCOPE.CHARACTER) {
            char = char || (c?.name2 || 'Character');
            knownBy = [char];
        } else if (scope === MEMORY_SCOPE.SHARED) {
            if (!knownBy || knownBy.length === 0) {
                knownBy = char ? [char] : [];
            }
            if (knownBy.length === 0) {
                dormantCount++;
            }
        } else {
            // WORLD
            knownBy = [];
        }

        const lorebookRef = sanitizeLorebookRef(m.lorebook_ref);

        return {
            ...m,
            id: sanitizeId(m.id),
            type: type,
            scope: scope,
            character: char,
            known_by: knownBy,
            lorebook_ref: lorebookRef,
            synced_to_world_info: Boolean(m.synced_to_world_info),
            synced_at: typeof m.synced_at === 'string' ? m.synced_at : null,
            // P1 修复旧记忆迁移语义：旧版无 lifecycle 的 archived 项仅代表检索休眠，绝不擅自篡改为 completed
            lifecycle: m.lifecycle || MEMORY_LIFECYCLE.ACTIVE
        };
    });

    if (isLegacyVersion && migratedCount > 0) {
        console.log(`[${MODULE_NAME}] [Migration Report] 旧版本记忆数据平滑升级完成：共载入 ${migratedCount} 条 (自动补齐知情范围 ${upgradedCount} 条, 知情者待补休眠 ${dormantCount} 条)`);
    }

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
        last_digest_summary: stored.last_digest_summary || '尚未执行提炼',
        // 错误状态属于可观测性数据，重载聊天后仍应保留。
        last_sync_error: stored.last_sync_error && typeof stored.last_sync_error === 'object'
            ? {
                time: typeof stored.last_sync_error.time === 'string' ? stored.last_sync_error.time : '',
                error: typeof stored.last_sync_error.error === 'string' ? stored.last_sync_error.error : '',
                rawSnippet: typeof stored.last_sync_error.rawSnippet === 'string' ? stored.last_sync_error.rawSnippet : '',
                truncated: Boolean(stored.last_sync_error.truncated)
            }
            : null,
        last_digest_error: typeof stored.last_digest_error === 'string' ? stored.last_digest_error : null
    };

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
export function addMemory(item) {
    if (!item || typeof item !== 'object') return null;
    const s = getState();
    if (typeof item.content !== 'string') return null;
    // P2-04 修复：单条记忆硬长度上限保护，防止超长内容挤占上下文
    const content = item.content.trim().slice(0, 150);
    if (!content) return null;

    const validTypes = new Set(Object.values(MEMORY_TYPES));
    const validScopes = new Set(Object.values(MEMORY_SCOPE));

    const targetType = item.type || MEMORY_TYPES.FACT;
    if (!validTypes.has(targetType)) {
        console.warn(`[${MODULE_NAME}] [Fail-Closed] 拦截非法记忆类型 "${targetType}"，拒绝入库`);
        return null;
    }

    let targetChar = typeof item.character === 'string' ? item.character.trim() : '';

    let knownBy = Array.isArray(item.known_by) && item.known_by.length > 0
        ? Array.from(new Set(item.known_by.filter(k => typeof k === 'string').map(k => k.trim()).filter(Boolean)))
        : (targetChar ? [targetChar] : []);

    let targetScope;
    if (item.scope) {
        targetScope = item.scope;
    } else if (targetChar) {
        targetScope = MEMORY_SCOPE.CHARACTER;
    } else if (knownBy.length > 0) {
        targetScope = MEMORY_SCOPE.SHARED;
    } else {
        targetScope = MEMORY_SCOPE.WORLD;
    }

    // P1-03 修复：结构与权限合法性约束 (防提示词注入扩大知情范围)
    // 规则 A：若绑定了特定角色私有属性，绝不允许直接当成 world 公共世界常识
    if (targetScope === MEMORY_SCOPE.WORLD && targetChar) {
        targetScope = MEMORY_SCOPE.CHARACTER;
    }
    // 规则 B：若限定了特定知情者名单，绝不允许声称为 world 公开常识
    if (targetScope === MEMORY_SCOPE.WORLD && knownBy.length > 0) {
        targetScope = MEMORY_SCOPE.SHARED;
    }

    if (!validScopes.has(targetScope)) {
        console.warn(`[${MODULE_NAME}] [Fail-Closed] 拦截非法记忆知情范围 "${targetScope}"，拒绝入库`);
        return null;
    }

    // P0 Fail-Closed: 角色私知 (character) 必须具备非空角色归属
    if (targetScope === MEMORY_SCOPE.CHARACTER && !targetChar) {
        console.warn(`[${MODULE_NAME}] [Fail-Closed] 拦截角色私有记忆：缺少明确角色归属，拒绝入库`);
        return null;
    }

    // P1 Fail-Closed: 现场共知 (shared) 必须具备至少一个知情者 (known_by 或 character)，严禁作为公共记忆入库
    if (targetScope === MEMORY_SCOPE.SHARED && knownBy.length === 0) {
        console.warn(`[${MODULE_NAME}] [Fail-Closed] 拦截共享记忆：缺少知情者集合 (known_by / character)，拒绝入库`);
        return null;
    }

    // character 私知的知情者由所属角色唯一决定，避免留下相互矛盾的 ACL。
    if (targetScope === MEMORY_SCOPE.CHARACTER) {
        knownBy = [targetChar];
    }

    const SCOPE_RANK = {
        [MEMORY_SCOPE.CHARACTER]: 1, // 私密
        [MEMORY_SCOPE.SHARED]: 2,    // 现场共享
        [MEMORY_SCOPE.WORLD]: 3      // 全域公共
    };

    // 规则 C (P1-03 核心)：越权提权防线——若既有记忆库中已存在语义吻合的私有/共享条目，严禁模型通过新输出将既有知识越权提升为更高范围
    for (const existing of s.memories) {
        if (existing.lifecycle === MEMORY_LIFECYCLE.COMPLETED ||
            existing.lifecycle === MEMORY_LIFECYCLE.SUPERSEDED ||
            existing.lifecycle === MEMORY_LIFECYCLE.REFUTED) {
            continue;
        }
        const sim = calculateTextSimilarity(existing.content, content);
        if (sim >= 0.70) {
            const existingRank = SCOPE_RANK[existing.scope] || 1;
            const newRank = SCOPE_RANK[targetScope] || 1;
            const existingRecipients = getRecipientsForScope(existing.scope, existing.character || '', existing.known_by);
            const incomingRecipients = getRecipientsForScope(targetScope, targetChar, knownBy);
            const expandsRecipients = existingRecipients !== null && (
                incomingRecipients === null || incomingRecipients.some(name => !existingRecipients.includes(name))
            );

            // scope 与知情者集合都是权限边界。即使 scope 仍为 shared，新增一个知情者也属于越权。
            if (newRank > existingRank || expandsRecipients) {
                console.warn(`[${MODULE_NAME}] [Visibility Escalation Guard] 拦截模型扩大已有受限条目 (ID: ${existing.id}) 的可见范围，强制继承既有 ACL`);
                targetScope = existing.scope;
                targetChar = existing.character || '';
                knownBy = existingRecipients ? [...existingRecipients] : [];
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

            existing.floor = item.floor || existing.floor;
            existing.last_activated_floor = item.floor || existing.last_activated_floor || existing.floor;
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
    const s = getState();
    const c = getContext();
    return {
        plugin: MODULE_NAME,
        version: EXTENSION_VERSION,
        exported_at: new Date().toISOString(),
        character_name: c?.name2 || 'Character',
        chat_id: c?.chatId || '',
        scene: JSON.parse(JSON.stringify(s.scene || {})),
        memories: JSON.parse(JSON.stringify(s.memories || []))
    };
}

/**
 * 导入并合并记忆数据
 * 支持策略：'merge' (合并去重) | 'replace' (全量覆盖)
 */
export function importMemoryData(data, strategy = 'merge') {
    if (!data || typeof data !== 'object') {
        throw new Error('无效的导入数据：根对象不存在');
    }
    if (!Array.isArray(data.memories)) {
        throw new Error('无效的导入数据：缺失 memories 列表');
    }

    const c = getContext();
    const VALID_TYPES = new Set(Object.values(MEMORY_TYPES));
    const VALID_SCOPES = new Set(Object.values(MEMORY_SCOPE));
    const VALID_LIFECYCLES = new Set(Object.values(MEMORY_LIFECYCLE));
    const VALID_STATUSES = new Set(Object.values(MEMORY_STATUS));

    const sanitizeId = (id) => {
        if (typeof id === 'string' && /^[a-zA-Z0-9_\-\.]+$/.test(id.trim())) {
            return id.trim();
        }
        return 'mem-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6);
    };

    // 严格清洗与归一化导入条目
    const validMemories = data.memories
        .filter(m => m && typeof m === 'object' && typeof m.content === 'string' && m.content.trim().length > 0)
        .map(m => {
            const content = m.content.trim().slice(0, 150);
            const type = VALID_TYPES.has(m.type) ? m.type : MEMORY_TYPES.FACT;
            const scope = VALID_SCOPES.has(m.scope) ? m.scope : MEMORY_SCOPE.CHARACTER;
            const lifecycle = VALID_LIFECYCLES.has(m.lifecycle) ? m.lifecycle : MEMORY_LIFECYCLE.ACTIVE;
            const status = VALID_STATUSES.has(m.status) ? m.status : MEMORY_STATUS.TRIGGERED;
            const character = typeof m.character === 'string' && m.character.trim() ? m.character.trim() : (c?.name2 || 'Character');
            let knownBy = Array.isArray(m.known_by)
                ? m.known_by.filter(k => typeof k === 'string' && k.trim()).map(k => k.trim())
                : [character];
            if (scope === MEMORY_SCOPE.CHARACTER) {
                knownBy = [character];
            } else if (scope === MEMORY_SCOPE.WORLD) {
                knownBy = [];
            }
            const triggerKeys = Array.isArray(m.trigger_keys)
                ? m.trigger_keys.filter(k => typeof k === 'string' && k.trim()).map(k => k.trim())
                : [];

            return {
                id: sanitizeId(m.id),
                content,
                type,
                status,
                lifecycle,
                scope,
                character,
                known_by: knownBy,
                lorebook_ref: sanitizeLorebookRef(m.lorebook_ref),
                synced_to_world_info: Boolean(m.synced_to_world_info),
                synced_at: typeof m.synced_at === 'string' ? m.synced_at : null,
                trigger_keys: triggerKeys,
                floor: Number(m.floor) || 0,
                created_at: m.created_at || new Date().toISOString(),
                updated_at: new Date().toISOString()
            };
        });

    return batchUpdate(() => {
        const s = getState();
        let importedCount = 0;

        if (strategy === 'replace') {
            for (const item of validMemories) {
                try { syncEnsureLocalEmbedding(item); } catch {}
            }
            s.memories = validMemories;
            importedCount = validMemories.length;
            if (data.scene && typeof data.scene === 'object' && !Array.isArray(data.scene)) {
                s.scene = { ...s.scene, ...data.scene };
            }
        } else {
            // merge: 按内容与 ID 进行保守去重
            const existingIds = new Set(s.memories.map(m => m.id));
            const existingContents = new Set(s.memories.map(m => m.content.trim().toLowerCase()));

            for (const item of validMemories) {
                if (existingContents.has(item.content.trim().toLowerCase())) {
                    continue; // 相同文本条目自动跳过
                }
                if (existingIds.has(item.id)) {
                    item.id = 'mem-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6);
                }
                try { syncEnsureLocalEmbedding(item); } catch {}
                s.memories.push(item);
                existingIds.add(item.id);
                existingContents.add(item.content.trim().toLowerCase());
                importedCount++;
            }
            if (data.scene && typeof data.scene === 'object' && (!s.scene.location || s.scene.location === '现场未知')) {
                s.scene = { ...s.scene, ...data.scene };
            }
        }

        return { success: true, count: importedCount, total: s.memories.length };
    });
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

/**
 * 获取当前会话生效的世界书信息（单会话作用域，不跨会话）
 * 检索优先级:
 *   1. 当前聊天绑定的专属世界书 (c.chatMetadata.world_info)
 *   2. 当前角色绑定的主世界书 (char.data.extensions.world)
 *   3. 当前角色内置的卡片世界书 (char.data.character_book)
 * 
 * @returns {Promise<{ bookName: string, source: string, entries: Array<{ uid: number, comment: string, keys: string[], content: string }> } | null>}
 */
export async function getActiveWorldBookInfo() {
    const c = getContext();
    if (!c) return null;

    let bookName = null;
    const metadata = c?.chatMetadata ?? c?.chat_metadata;
    if (metadata && typeof metadata === 'object' && metadata['world_info']) {
        bookName = metadata['world_info'];
    }

    if (!bookName && c.characters && c.characterId !== undefined) {
        const char = c.characters[c.characterId];
        bookName = char?.data?.extensions?.world || char?.data?.world_info || null;
    }

    // 检查角色卡内置世界书 (Embedded Character Book)
    if (!bookName && c.characters && c.characterId !== undefined) {
        const char = c.characters[c.characterId];
        const charBook = char?.data?.character_book;
        if (charBook && Array.isArray(charBook.entries)) {
            return {
                bookName: charBook.name || `${char?.name || 'Character'} Built-in Lore`,
                source: 'character_embedded',
                entries: charBook.entries
                    .filter(e => e && !e.disable)
                    .map(e => ({
                        uid: e.uid ?? e.id ?? 0,
                        comment: String(e.comment || e.name || '').trim(),
                        keys: Array.isArray(e.keys || e.key) ? (e.keys || e.key) : [],
                        content: String(e.content || '').slice(0, 300)
                    }))
            };
        }
    }

    if (!bookName) return null;

    try {
        let data = null;
        if (typeof c.loadWorldInfo === 'function') {
            data = await c.loadWorldInfo(bookName);
        } else if (typeof window !== 'undefined' && typeof window.loadWorldInfo === 'function') {
            data = await window.loadWorldInfo(bookName);
        }

        if (!data || !data.entries) {
            return { bookName, source: 'chat_or_char', entries: [] };
        }

        const entries = Object.values(data.entries)
            .filter(e => e && !e.disable)
            .map(e => ({
                uid: Number(e.uid),
                comment: String(e.comment || '').trim(),
                keys: Array.isArray(e.key || e.keys) ? (e.key || e.keys) : [],
                content: String(e.content || '').slice(0, 300)
            }));

        return { bookName, source: 'chat_or_char', entries };
    } catch (e) {
        console.warn(`[${MODULE_NAME}] 读取当前会话世界书 "${bookName}" 失败:`, e);
        return { bookName, source: 'chat_or_char', entries: [] };
    }
}

/**
 * 将某条动态记忆的事实差量安全同步写回至关联的世界书条目中 (Write-Back Hook)
 * @param {string} memId - 记忆 ID
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] - 是否仅计算差量预览而不实际写入
 * @param {boolean} [options.markCompleted=false] - 成功写回后是否自动将该记忆置为 completed 履约
 * @param {string} [options.customDelta] - 自定义追加正文 (默认使用 mem.content)
 * @returns {Promise<{success: boolean, reason?: string, alreadySynced?: boolean, dryRun?: boolean, preview?: object, bookName?: string, entryName?: string, entryUid?: number}>}
 */
export async function syncMemoryDeltaToWorldInfo(memId, options = {}) {
    const c = getContext();
    if (!c) {
        return { success: false, reason: '未找到 SillyTavern 运行上下文' };
    }

    const s = getState();
    const mem = s.memories.find(m => m.id === memId);
    if (!mem) {
        return { success: false, reason: '指定的记忆条目不存在' };
    }

    if (!mem.lorebook_ref || !mem.lorebook_ref.entry_name) {
        return { success: false, reason: '该记忆未关联任何世界书条目' };
    }

    const targetEntryName = mem.lorebook_ref.entry_name.trim();
    const targetEntryUid = (mem.lorebook_ref.entry_uid !== undefined && mem.lorebook_ref.entry_uid !== null)
        ? Number(mem.lorebook_ref.entry_uid)
        : null;

    // 获取目标世界书文件名与类型
    let targetBookName = mem.lorebook_ref.file_name || null;
    let isEmbedded = false;

    if (!targetBookName) {
        const activeInfo = await getActiveWorldBookInfo();
        if (activeInfo) {
            targetBookName = activeInfo.bookName;
            isEmbedded = activeInfo.source === 'character_embedded';
        }
    }

    if (isEmbedded) {
        return { success: false, reason: '当前生效的世界书为角色卡内置设定 (Embedded Character Book)，属于只读卡片资源，暂不支持外部直接反写。' };
    }

    if (!targetBookName) {
        return { success: false, reason: '无法确定目标世界书文件名称，请检查当前会话是否已绑定世界书。' };
    }

    // 加载目标世界书文件
    let data = null;
    try {
        if (typeof c.loadWorldInfo === 'function') {
            data = await c.loadWorldInfo(targetBookName);
        } else if (typeof window !== 'undefined' && typeof window.loadWorldInfo === 'function') {
            data = await window.loadWorldInfo(targetBookName);
        }
    } catch (e) {
        return { success: false, reason: `加载世界书 "${targetBookName}" 异常: ${e.message}` };
    }

    if (!data || !data.entries || typeof data.entries !== 'object') {
        return { success: false, reason: `世界书 "${targetBookName}" 未包含有效的条目数据` };
    }

    // 检索目标条目：优先按 UID，次选按 comment (条目名) 或 key (触发词)
    let targetEntry = null;
    if (targetEntryUid !== null && data.entries[targetEntryUid]) {
        targetEntry = data.entries[targetEntryUid];
    }

    if (!targetEntry) {
        for (const entry of Object.values(data.entries)) {
            if (!entry) continue;
            const comment = String(entry.comment || '').trim();
            const keys = Array.isArray(entry.key || entry.keys) ? (entry.key || entry.keys) : [];
            if (comment === targetEntryName || keys.includes(targetEntryName)) {
                targetEntry = entry;
                break;
            }
        }
    }

    if (!targetEntry) {
        return { success: false, reason: `在世界书 "${targetBookName}" 中未找到名称或关键词为 "${targetEntryName}" 的条目` };
    }

    const deltaContent = (options.customDelta || mem.content || '').trim();
    if (!deltaContent) {
        return { success: false, reason: '要追加的事实差量为空' };
    }

    const currentContent = String(targetEntry.content || '');

    // 幂等防重检查：如果条目中已经包含了这段事实，避免重复追加
    if (currentContent.includes(deltaContent)) {
        return {
            success: false,
            alreadySynced: true,
            reason: `世界书条目【${targetEntry.comment || targetEntryName}】已包含此条记忆内容，无需重复写入`
        };
    }

    const stamp = new Date().toISOString().split('T')[0];
    const appendedText = `\n\n[持续事实更新 ${stamp}] ${deltaContent}`;
    const newContent = currentContent ? (currentContent + appendedText) : appendedText.trim();

    // 预览模式 (Dry Run)
    if (options.dryRun) {
        return {
            success: true,
            dryRun: true,
            preview: {
                bookName: targetBookName,
                entryUid: targetEntry.uid,
                entryName: targetEntry.comment || targetEntryName,
                originalContent: currentContent,
                appendedText: appendedText.trim(),
                newContent: newContent
            }
        };
    }

    // 实际执行写入提交
    try {
        targetEntry.content = newContent;

        if (typeof c.saveWorldInfo === 'function') {
            await c.saveWorldInfo(targetBookName, data, true);
        } else if (typeof window !== 'undefined' && typeof window.saveWorldInfo === 'function') {
            await window.saveWorldInfo(targetBookName, data, true);
        } else {
            return { success: false, reason: '当前环境中未找到 saveWorldInfo 接口' };
        }

        // 刷新酒馆原生世界书编辑器（若当前打开）
        if (typeof c.reloadWorldInfoEditor === 'function') {
            try { c.reloadWorldInfoEditor(); } catch {}
        }

        // 更新记忆的同步状态与关联元数据
        batchUpdate(() => {
            mem.synced_to_world_info = true;
            mem.synced_at = new Date().toISOString();
            if (options.markCompleted) {
                mem.lifecycle = MEMORY_LIFECYCLE.COMPLETED;
            }
            if (!mem.lorebook_ref.file_name) {
                mem.lorebook_ref.file_name = targetBookName;
            }
            if (mem.lorebook_ref.entry_uid === null || mem.lorebook_ref.entry_uid === undefined) {
                mem.lorebook_ref.entry_uid = targetEntry.uid;
            }
        });

        return {
            success: true,
            bookName: targetBookName,
            entryUid: targetEntry.uid,
            entryName: targetEntry.comment || targetEntryName
        };
    } catch (e) {
        console.error(`[${MODULE_NAME}] 同步写回世界书失败:`, e);
        return { success: false, reason: `写回世界书文件失败: ${e.message}` };
    }
}
