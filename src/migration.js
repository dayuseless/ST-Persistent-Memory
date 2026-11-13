/**
 * ST-Persistent-Memory - 数据迁移与导入导出服务 (Data Migration & Portability Service, v0.1.34)
 * 职责：
 * 1. 跨版本 Schema 迁移与平滑升级 (migrateLegacyState, migrateMemoryItems)
 * 2. 外部记忆/场景数据包导出与脱敏规范化 (exportMemoryData)
 * 3. 外部记忆/场景数据包导入、ACL 准入过滤与合并/替换策略执行 (importMemoryData)
 */

import { MODULE_NAME, EXTENSION_VERSION, MEMORY_STATUS, MEMORY_LIFECYCLE, MEMORY_TYPES, MEMORY_SCOPE } from './config.js';
import { syncEnsureLocalEmbedding } from './semantic.js';
import { getContextParticipants, normalizeAndValidateMemory, recordAclAudit } from './acl.js';
import { sanitizeLorebookRef } from './lorebook.js';

function getContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

/**
 * 校验并规范化记忆 ID
 */
export function sanitizeMemoryId(id) {
    if (typeof id === 'string' && /^[a-zA-Z0-9_\-\.]+$/.test(id.trim())) {
        return id.trim();
    }
    return 'mem-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6);
}

/**
 * 记忆列表平滑迁移与规范化 (旧版本兼容处理)
 * 包含：严格类型校验、知情范围保守封闭升级、L0 属性防御、生命周期修复
 *
 * @param {Array} rawMemories 原始记忆数组
 * @param {Object} context 上下文对象 (SillyTavern context)
 * @returns {{ migratedMemories: Array, stats: { total: number, upgraded: number, dormant: number } }}
 */
export function migrateMemoryItems(rawMemories, context = null) {
    const c = context || getContext();
    const VALID_TYPES = new Set(Object.values(MEMORY_TYPES));
    const VALID_SCOPES = new Set(Object.values(MEMORY_SCOPE));

    let migratedCount = 0;
    let upgradedCount = 0;
    let dormantCount = 0;

    const safeList = (Array.isArray(rawMemories) ? rawMemories : []).filter(
        m => m && typeof m === 'object' && typeof m.content === 'string' && m.content.trim().length > 0
    );

    const migratedMemories = safeList.map(m => {
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
            id: sanitizeMemoryId(m.id),
            type: type,
            scope: scope,
            character: char,
            known_by: knownBy,
            lorebook_ref: lorebookRef,
            synced_to_world_info: Boolean(m.synced_to_world_info),
            synced_at: typeof m.synced_at === 'string' ? m.synced_at : null,
            // P1 修复旧记忆迁移语义：旧版无 lifecycle 的 archived 项仅代表检索休眠，绝不擅自篡改为 completed
            lifecycle: m.lifecycle || MEMORY_LIFECYCLE.ACTIVE,
            last_activated_floor: Number.isInteger(m.last_activated_floor) ? m.last_activated_floor : (Number.isInteger(m.floor) ? m.floor : 0)
        };
    });

    return {
        migratedMemories,
        stats: {
            total: migratedCount,
            upgraded: upgradedCount,
            dormant: dormantCount
        }
    };
}

/**
 * 完整聊天持久化状态的 Schema 迁移与初始化规范化
 *
 * @param {Object} stored 存储在 metadata[MODULE_NAME] 中的原始对象
 * @param {Object} defaultState 默认状态模板
 * @param {Object} context 上下文对象
 * @returns {Object} 规范化后的 stateCache
 */
export function migrateLegacyState(stored, defaultState, context = null) {
    const c = context || getContext();
    if (!stored || typeof stored !== 'object') {
        return JSON.parse(JSON.stringify(defaultState));
    }

    const rawScene = stored.scene || {};
    const isLegacyVersion = !stored.version || stored.version < 3;

    const { migratedMemories, stats } = migrateMemoryItems(stored.memories, c);

    if (isLegacyVersion && stats.total > 0) {
        console.log(`[${MODULE_NAME}] [Migration Report] 旧版本记忆数据平滑升级完成：共载入 ${stats.total} 条 (自动补齐知情范围 ${stats.upgraded} 条, 知情者待补休眠 ${stats.dormant} 条)`);
    }

    return {
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
        scene_history: Array.isArray(stored.scene_history)
            ? stored.scene_history.filter(item => item && item.scene && typeof item.scene === 'object').slice(-10)
            : [],
        memories: migratedMemories,
        turn_count: Number(stored.turn_count) || 0,
        last_digest_floor: Number(stored.last_digest_floor) || 0,
        last_digest_time: stored.last_digest_time || '',
        last_digest_summary: stored.last_digest_summary || '尚未执行提炼',
        // 错误状态属于可观测性数据，重载聊天后仍应保留
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
}

/**
 * 导出记忆与现场数据对象 (供备份与跨会话迁移)
 *
 * @param {Object} state 当前完整状态
 * @param {Object} context 上下文对象
 * @returns {Object} 导出数据包
 */
export function exportMemoryDataPackage(state, context = null) {
    const s = state || {};
    const c = context || getContext();
    return {
        plugin: MODULE_NAME,
        version: EXTENSION_VERSION,
        exported_at: new Date().toISOString(),
        character_name: c?.name2 || 'Character',
        chat_id: c?.chatId || '',
        scene: JSON.parse(JSON.stringify(s.scene || {})),
        scene_history: JSON.parse(JSON.stringify(s.scene_history || [])),
        memories: JSON.parse(JSON.stringify(s.memories || []))
    };
}

/**
 * 导入并合并记忆数据
 * 支持策略：'merge' (合并去重) | 'replace' (全量覆盖)
 *
 * @param {Object} data 待导入的数据包
 * @param {string} strategy 'merge' | 'replace'
 * @param {Object} state 当前状态对象
 * @param {Function} batchUpdateFn 批量更新执行器
 * @param {Object} context 上下文对象
 * @returns {Object} 导入统计与结果
 */
export function importMemoryDataPackage(data, strategy = 'merge', state, batchUpdateFn, context = null) {
    if (!data || typeof data !== 'object') {
        throw new Error('无效的导入数据：根对象不存在');
    }
    if (!Array.isArray(data.memories)) {
        throw new Error('无效的导入数据：缺失 memories 列表');
    }

    const c = context || getContext();

    // 统一数据准入判定层执行格式规范化与权威参与者 ACL 核验 (v0.1.28)
    const participants = getContextParticipants(c, state);
    let aclRejectedCount = 0;
    let skippedCount = 0;
    const validMemories = [];

    for (const m of data.memories) {
        const norm = normalizeAndValidateMemory(m, {
            participants,
            source: 'backup_import',
            context: c
        });

        if (!norm.valid) {
            if (norm.aclRejected) {
                console.warn(`[${MODULE_NAME}] [Import ACL 拦截] ${norm.reason} (内容: "${(m?.content || '').slice(0, 30)}")`);
                aclRejectedCount++;
                try {
                    if (state) recordAclAudit(state, 'import_acl_rejected', { content: m?.content?.slice(0, 30), reason: norm.reason });
                } catch {}
            } else {
                skippedCount++;
            }
            continue;
        }

        validMemories.push(norm.memory);
    }

    const runImport = () => {
        const s = state;
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
            if (Array.isArray(data.scene_history)) {
                s.scene_history = data.scene_history.filter(h => h && h.scene).slice(-10);
            }
        } else {
            // merge: 按内容与 ID 进行保守去重
            const existingIds = new Set(s.memories.map(m => m.id));
            const existingContents = new Set(s.memories.map(m => m.content.trim().toLowerCase()));

            for (const item of validMemories) {
                if (existingContents.has(item.content.trim().toLowerCase())) {
                    skippedCount++;
                    continue; // 相同文本条目自动跳过
                }
                if (existingIds.has(item.id)) {
                    item.id = sanitizeMemoryId(null);
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
            if (Array.isArray(data.scene_history) && (!s.scene_history || s.scene_history.length === 0)) {
                s.scene_history = data.scene_history.filter(h => h && h.scene).slice(-10);
            }
        }

        return {
            success: true,
            count: importedCount,
            imported: importedCount,
            total: s.memories.length,
            skipped: skippedCount,
            aclRejected: aclRejectedCount
        };
    };

    if (typeof batchUpdateFn === 'function') {
        return batchUpdateFn(runImport);
    }
    return runImport();
}
