/**
 * ST-Persistent-Memory - 提炼落盘与伴随协议流水线 (Data Ingestion & Application Pipeline)
 * 职责：
 * 1. 同步伴随记忆标签解析与正文剥离 (extractAndApplySyncTag)
 * 2. 提炼候选活跃记忆场景化过滤 (filterMemoriesForDigest)
 * 3. 提炼/伴随结构化数据原子写回与生命周期流转 (applyExtractedData)
 *
 * @version 0.1.43
 */

import { MODULE_NAME, MEMORY_LIFECYCLE, MEMORY_SCOPE } from './config.js';
import { getState, updateScene, addMemory, setMemoryLifecycle, saveCurrentState, batchUpdate } from './state.js';
import { getContextParticipants } from './acl.js';
import { cleanAndParseJson } from './parser.js';
import { validateExtractedPayload } from './schema.js';
import { SYNC_TAG_REGEX } from './prompt.js';

function getContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

/**
 * 仅返回与当前场景有关的活跃记忆，供提炼请求发送。
 * 已知场景（包括显式空场景）优先于近期发言者；只有场景未知时才使用近期对话作为保守回退。
 */
export function filterMemoriesForDigest(memories, {
    sceneParticipants,
    conversationParticipants = [],
    fallbackParticipants = []
} = {}) {
    const participants = Array.isArray(sceneParticipants)
        ? sceneParticipants
        : [...conversationParticipants, ...fallbackParticipants];
    const activeChars = new Set(participants.filter(Boolean));

    return (Array.isArray(memories) ? memories : []).filter(memory => {
        if (memory.lifecycle !== MEMORY_LIFECYCLE.ACTIVE) return false;
        if (memory.scope === MEMORY_SCOPE.WORLD) return true;
        if (memory.scope === MEMORY_SCOPE.CHARACTER) {
            return Boolean(memory.character && activeChars.has(memory.character));
        }
        if (memory.scope === MEMORY_SCOPE.SHARED) {
            const knownList = Array.isArray(memory.known_by)
                ? memory.known_by
                : (memory.character ? [memory.character] : []);
            return knownList.some(name => activeChars.has(name));
        }
        return false;
    });
}

/**
 * 将解析出的数据更新到底层状态库
 */
export function applyExtractedData(payload, floor = 0) {
    if (!payload || typeof payload !== 'object') return '无有效更新';

    return batchUpdate(() => {
        let sceneUpdated = false;
        let addedCount = 0;
        let updatedCount = 0;

        // 1. PATCH 语义更新现场快照 (精准区分继承与清空)
        if (payload.scene && typeof payload.scene === 'object') {
            updateScene(payload.scene, '模型提炼');
            sceneUpdated = true;
        }

        // 2. 显式生命周期流转 (completed / superseded / refuted)
        if (Array.isArray(payload.lifecycle_updates)) {
            for (const up of payload.lifecycle_updates) {
                if (up && up.id && up.lifecycle) {
                    setMemoryLifecycle(up.id, up.lifecycle);
                    updatedCount++;
                }
            }
        }

        // 3. 追加新记忆（通过 addMemory 自动触发防幻觉与保守融合）
        if (Array.isArray(payload.new_memories)) {
            for (const m of payload.new_memories) {
                if (m && m.content) {
                    const added = addMemory({
                        type: m.type,
                        content: m.content,
                        trigger_keys: m.trigger_keys,
                        status: m.status,
                        character: m.character,
                        scope: m.scope,
                        known_by: m.known_by,
                        lorebook_ref: m.lorebook_ref,
                        floor: floor
                    });
                    if (added) addedCount++;
                }
            }
        }

        const parts = [];
        if (sceneUpdated) parts.push('快照更新');
        if (addedCount > 0) parts.push(`沉淀 ${addedCount} 条记忆`);
        if (updatedCount > 0) parts.push(`流转 ${updatedCount} 条状态`);
        if (parts.length === 0) parts.push('情境稳定，无新记忆沉淀');

        return parts.join(' | ');
    });
}

/**
 * 同步伴随标签解析与正文剥离
 */
export function extractAndApplySyncTag(rawText) {
    if (!rawText || typeof rawText !== 'string') return rawText;

    const match = rawText.match(SYNC_TAG_REGEX);
    if (!match) return rawText;

    const jsonStr = match[1].trim();
    const cleanText = rawText.replace(SYNC_TAG_REGEX, '').trim();

    const state = getState();
    const participants = getContextParticipants(getContext(), state);
    const rawPayload = cleanAndParseJson(jsonStr);
    const payload = validateExtractedPayload(rawPayload, state.memories || [], participants);

    if (payload) {
        const summary = applyExtractedData(payload);
        state.last_sync_error = null;
        console.log(`[${MODULE_NAME}] [Sync] 伴生标签通过验证并成功入库: ${summary}`);
        window.toastr?.success?.(summary, '伴随标签提炼入库');
    } else {
        // P2-05 修复：标签校验失败绝不静默丢弃，留存错误日志并提供 HUD 可观测性
        const failReason = !rawPayload ? 'JSON 解析失败 (标签格式畸形)' : 'Schema 校验未通过 (缺少必要核心字段或类型非法)';
        console.warn(`[${MODULE_NAME}] [Sync] 伴生标签验证失败: ${failReason}`, jsonStr.slice(0, 160));
        const MAX_SYNC_ERROR_RAW_CHARS = 4000;
        state.last_sync_error = {
            time: new Date().toLocaleTimeString(),
            error: failReason,
            // 保留足够完整的原始标签用于排错，同时使用明确上限避免聊天元数据无限增长。
            rawSnippet: jsonStr.slice(0, MAX_SYNC_ERROR_RAW_CHARS),
            truncated: jsonStr.length > MAX_SYNC_ERROR_RAW_CHARS
        };
        saveCurrentState();
        window.toastr?.warning?.(`伴随记忆标签未通过验证: ${failReason} (已记录至状态面板，可展开查看)`, '伴随标签异常');
    }

    return cleanText;
}
