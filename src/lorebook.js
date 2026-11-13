/**
 * ST-Persistent-Memory - 世界书关联、协同与外部设定呈现服务 (Lorebook / World Info Integration, v0.1.34)
 *
 * 核心权责：
 * 1. 架构解耦：将世界书设定解析、事实差量写回 (Write-Back) 与词条升格 (Promote) 从状态持久化引擎中彻底剥离。
 * 2. 结构安全：规范化 lorebook_ref 结构，严格免疫原型污染、对象注入与非法字段破坏 (sanitizeLorebookRef)。
 * 3. 动态协同：安全解析当前单会话作用域世界书 (聊天绑定专属、角色主世界书、角色内置卡片世界书) (getActiveWorldBookInfo)。
 * 4. 事实差量写回：将动态记忆差量安全追加到既有世界书条目中，支持幂等防重、格式化日期戳与 Dry-Run 预览 (syncMemoryDeltaToWorldInfo)。
 * 5. 词条一键升格：将长期记忆升格为独立静态词条，强制携带原始知情范围/知情者溯源标记，并记录 ACL 审计事件 (promoteMemoryToWorldInfo)。
 */

import { MODULE_NAME, MEMORY_SCOPE, MEMORY_LIFECYCLE } from './config.js';
import { getState, batchUpdate } from './state.js';
import { recordAclAudit } from './acl.js';

function getContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

/**
 * 校验并规范化世界书关联结构 (lorebook_ref)
 * 防止对象注入、原型污染与非安全字段，记录升格溯源 (P2-01)
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

    const res = {
        book: bookName,
        entry_uid: uidVal,
        entry_name: entryName
    };
    if (rawLb.file_name && typeof rawLb.file_name === 'string') {
        res.file_name = rawLb.file_name.trim().slice(0, 80);
    }
    if (rawLb.promoted_from_scope && typeof rawLb.promoted_from_scope === 'string') {
        res.promoted_from_scope = rawLb.promoted_from_scope.trim();
    }
    if (rawLb.original_character && typeof rawLb.original_character === 'string') {
        res.original_character = rawLb.original_character.trim();
    }
    if (Array.isArray(rawLb.original_known_by)) {
        res.original_known_by = rawLb.original_known_by
            .filter(k => typeof k === 'string' && k.trim())
            .map(k => k.trim());
    }
    return res;
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

/**
 * 将某条动态记忆一键升格为世界书独立新词条 (Promote to Lorebook Entry)
 * @param {string} memId - 记忆 ID
 * @param {object} [options]
 * @param {string} [options.bookName] - 目标世界书文件名 (默认自动使用当前绑定的世界书)
 * @param {string} [options.entryName] - 词条名称 (默认截取记忆正文或已有标题)
 * @param {string[]} [options.keys] - 触发关键词 (默认继承记忆的 trigger_keys)
 * @param {string} [options.content] - 词条正文内容 (默认使用记忆完整 content)
 * @param {boolean} [options.markCompleted=true] - 升格后是否将记忆生命周期标记为 completed 履约
 * @returns {Promise<{success: boolean, reason?: string, bookName?: string, entryName?: string, entryUid?: number, content?: string}>}
 */
export async function promoteMemoryToWorldInfo(memId, options = {}) {
    const c = getContext();
    if (!c) {
        return { success: false, reason: '未找到 SillyTavern 运行上下文' };
    }

    const s = getState();
    const mem = s.memories.find(m => m.id === memId);
    if (!mem) {
        return { success: false, reason: '指定的记忆条目不存在' };
    }

    // 确定目标世界书名称
    let targetBookName = (options.bookName || mem.lorebook_ref?.file_name || '').trim();
    let isEmbedded = false;

    if (!targetBookName) {
        const activeInfo = await getActiveWorldBookInfo();
        if (activeInfo) {
            targetBookName = activeInfo.bookName;
            isEmbedded = activeInfo.source === 'character_embedded';
        }
    }

    if (isEmbedded) {
        return { success: false, reason: '当前生效的世界书为角色卡内置设定 (Embedded Character Book)，属于只读卡片资源，无法直接新建词条。请先在酒馆中绑定可编辑的外部世界书。' };
    }

    if (!targetBookName) {
        return { success: false, reason: '未指定目标世界书，且当前会话未绑定可用的世界书文件。' };
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

    if (!data) {
        data = { entries: {} };
    }
    if (!data.entries || typeof data.entries !== 'object') {
        data.entries = {};
    }

    // 分配新 UID (查找现有数值 UID 最大值 + 1，增强边界健壮性)
    const existingUids = Object.keys(data.entries).map(k => Number(k)).filter(n => Number.isInteger(n) && n >= 0);
    const newUid = existingUids.length > 0 ? Math.max(...existingUids) + 1 : 0;

    // 确定词条名称、触发词与正文
    const entryName = (options.entryName || (mem.content ? mem.content.slice(0, 16).trim() : '新设定词条')).trim();
    let entryKeys = [];
    if (Array.isArray(options.keys) && options.keys.length > 0) {
        entryKeys = options.keys.map(k => String(k).trim()).filter(Boolean);
    } else if (Array.isArray(mem.trigger_keys) && mem.trigger_keys.length > 0) {
        entryKeys = mem.trigger_keys.map(k => String(k).trim()).filter(Boolean);
    }
    if (entryKeys.length === 0) {
        entryKeys = [entryName];
    }

    const entryContent = (options.content || mem.content || '').trim();
    if (!entryContent) {
        return { success: false, reason: '词条设定正文不能为空' };
    }

    // 溯源与知情范围标注 (P2 加固：受限记忆升格世界书显式记录原始范围，供全员常驻审计)
    const scopeProvenance = mem.scope === MEMORY_SCOPE.CHARACTER
        ? `[持续记忆·私密(${mem.character || '角色'})]`
        : (mem.scope === MEMORY_SCOPE.SHARED ? `[持续记忆·机密(知情:${(mem.known_by || []).join(',')})]` : '');
    const commentWithProvenance = scopeProvenance ? `${entryName} ${scopeProvenance}` : entryName;

    // 构建符合酒馆规范的世界书 Entry 对象
    const newEntry = {
        uid: newUid,
        key: entryKeys,
        keysecondary: [],
        comment: commentWithProvenance,
        content: entryContent,
        constant: false,
        selective: true,
        order: 100,
        position: 0,
        disable: false,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: false,
        probability: 100,
        useProbability: true,
        depth: 4,
        group: ""
    };

    data.entries[newUid] = newEntry;

    // 执行保存写入
    try {
        if (typeof c.saveWorldInfo === 'function') {
            await c.saveWorldInfo(targetBookName, data, true);
        } else if (typeof window !== 'undefined' && typeof window.saveWorldInfo === 'function') {
            await window.saveWorldInfo(targetBookName, data, true);
        } else {
            return { success: false, reason: '当前环境中未找到 saveWorldInfo 接口' };
        }

        if (typeof c.reloadWorldInfoEditor === 'function') {
            try { c.reloadWorldInfoEditor(); } catch {}
        }

        // 更新记忆的关联世界书状态、溯源与生命周期 (P2-01: 完整保留原始知情范围与知情者追溯)
        batchUpdate(() => {
            mem.lorebook_ref = {
                entry_uid: newUid,
                entry_name: entryName,
                file_name: targetBookName,
                book: targetBookName,
                promoted_from_scope: mem.scope || null,
                original_character: mem.character || null,
                original_known_by: Array.isArray(mem.known_by) ? [...mem.known_by] : []
            };
            mem.synced_to_world_info = true;
            mem.synced_at = new Date().toISOString();
            if (options.markCompleted !== false) {
                mem.lifecycle = MEMORY_LIFECYCLE.COMPLETED;
            }
            recordAclAudit(s, 'promote_world_info', {
                memId: mem.id,
                entryUid: newUid,
                targetBook: targetBookName,
                fromScope: mem.scope,
                character: mem.character || null,
                knownBy: mem.known_by || []
            });
        });

        console.log(`[${MODULE_NAME}] [Lorebook] 记忆 [${mem.id}] 成功升格为世界书【${targetBookName}】新词条 (UID: ${newUid}, 名称: "${entryName}")`);

        return {
            success: true,
            bookName: targetBookName,
            entryUid: newUid,
            entryName: entryName,
            content: entryContent
        };
    } catch (e) {
        console.error(`[${MODULE_NAME}] 升格世界书新词条保存失败:`, e);
        return { success: false, reason: `保存世界书文件失败: ${e.message}` };
    }
}
