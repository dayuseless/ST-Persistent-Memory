/**
 * 持续记忆数据模式校验与防线准入网关 (Schema Validation & Defense Gate, v0.1.43)
 * 职责：
 * 1. 结构完整性校验与拒绝型门禁拦截 (validateExtractedPayload)
 * 2. 宏观长程归并产物 Schema 与 ACL 边界守卫 (validateConsolidatedPayload)
 * 3. 终态流转约束 (MODEL_ALLOWED_LIFECYCLES: 严禁模型擅自将已结项记忆激活为 active)
 * 4. 触发词合法性与停用词过滤 (sanitizeTriggerKeys)
 */

import { MODULE_NAME, MEMORY_TYPES, MEMORY_STATUS, MEMORY_LIFECYCLE, MEMORY_SCOPE } from './config.js';
import { unwrapJsonPayload } from './parser.js';
import { getContextParticipants, validateMemoryAcl, normalizeAndValidateMemory } from './acl.js';
import { getSettings, getState } from './state.js';

function getContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

// 针对模型提炼接口，只允许流转至终态 (P1 修复：严禁模型将已完结记忆重新激活为 active)
export const MODEL_ALLOWED_LIFECYCLES = new Set([
    MEMORY_LIFECYCLE.COMPLETED,
    MEMORY_LIFECYCLE.SUPERSEDED,
    MEMORY_LIFECYCLE.REFUTED
]);

/**
 * 清洗并过滤低质触发词
 */
export function sanitizeTriggerKeys(keys) {
    if (!Array.isArray(keys)) return [];
    const stopWords = new Set(['你', '我', '他', '她', '它', '我们', '你们', '他们', '这个', '那个', '是', '在', '有', '说', '想', '看', '去', '来', '做', '事情', '东西', '什么', '怎么', '然后', '但是']);
    return keys
        .map(k => String(k || '').trim())
        .filter(k => k.length >= 2 && k.length <= 15 && !stopWords.has(k))
        .slice(0, 5);
}

/**
 * P0-4 修复：建立严格的“拒绝型” Schema 验证拦截器
 * 核心原则：结构缺失全拒，类型未知单拒，严禁把未知类型静默降级为 fact
 */
export function validateExtractedPayload(raw, currentMemories = [], allowedParticipants = null) {
    // 根节点必须是纯对象
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
    }

    const target = unwrapJsonPayload(raw);

    // 权威可信参与者名单解析
    const trustedParticipants = allowedParticipants instanceof Set
        ? allowedParticipants
        : (Array.isArray(allowedParticipants)
            ? new Set(allowedParticipants.filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean))
            : (typeof getContext === 'function' ? getContextParticipants(getContext(), getState?.()) : null));

    // 必须至少包含有效 scene 或 new_memories 或 lifecycle_updates 之一，否则拒绝整个 payload
    const hasScene = target.scene && typeof target.scene === 'object' && !Array.isArray(target.scene);
    const hasMemories = Array.isArray(target.new_memories);
    const hasUpdates = Array.isArray(target.lifecycle_updates) || Array.isArray(target.resolved_memory_ids);

    if (!hasScene && !hasMemories && !hasUpdates) {
        console.warn(`[${MODULE_NAME}] [Schema 拦截] Payload 缺少核心结构 (scene / new_memories / lifecycle_updates)，整包拒绝`);
        return null;
    }

    const validated = {
        scene: null,
        new_memories: [],
        lifecycle_updates: []
    };

    // 1. 校验 scene 结构 (支持显式清空语义: 允许空字符串和空数组)
    const curSettings = typeof getSettings === 'function' ? getSettings() : {};
    const maxSceneTok = Math.max(50, Number(curSettings?.maxSceneTokens) || 150);
    const maxTotalTok = Math.max(100, Number(curSettings?.maxTotalMemoryTokens) || 450);

    // 动态放宽净化截断上限，支持用户调高预算后保留更详尽生动的现场描述
    const maxActionLen = Math.max(150, Math.min(800, Math.floor(maxSceneTok * 1.6)));
    const maxLocLen = Math.max(80, Math.min(300, Math.floor(maxSceneTok * 0.8)));
    const maxUnresLen = Math.max(120, Math.min(400, Math.floor(maxSceneTok * 1.0)));
    const maxTensionLen = Math.max(80, Math.min(300, Math.floor(maxSceneTok * 0.8)));
    const maxMemContentLen = Math.max(100, Math.min(400, Math.floor(maxTotalTok / 3)));
    const maxNewMemoriesAllowed = Math.max(5, Math.min(15, Math.floor(maxTotalTok / 80)));

    if (hasScene) {
        const sc = target.scene;
        validated.scene = {};

        const sanitizeString = (val, maxLen) => {
            if (val === undefined) return undefined;
            if (val === null || val === '') return '';
            // P1 工程加固：严禁隐式转换对象为字符串 (防止产生 [object Object])
            if (typeof val !== 'string') {
                console.warn(`[${MODULE_NAME}] [Schema 拦截] 字段值非纯字符串，拒绝隐式转换:`, val);
                return undefined;
            }
            return val.trim().slice(0, maxLen);
        };

        if (sc.scene_id !== undefined) validated.scene.scene_id = sanitizeString(sc.scene_id, 40);
        if (sc.location !== undefined) validated.scene.location = sanitizeString(sc.location, maxLocLen);
        if (sc.time !== undefined) validated.scene.time = sanitizeString(sc.time, 60);
        if (sc.action !== undefined) validated.scene.action = sanitizeString(sc.action, maxActionLen);
        if (sc.tension !== undefined) validated.scene.tension = sanitizeString(sc.tension, maxTensionLen);
        if (sc.unresolved !== undefined) validated.scene.unresolved = sanitizeString(sc.unresolved, maxUnresLen);

        if (Array.isArray(sc.in_scene_characters)) {
            validated.scene.in_scene_characters = sc.in_scene_characters
                .filter(x => typeof x === 'string')
                .map(x => x.trim().slice(0, 30))
                .filter(Boolean)
                .slice(0, 10);
        } else if (sc.in_scene_characters === null) {
            validated.scene.in_scene_characters = null; // P1 修复：严格保留 null 语义，允许状态机将现场重置为未知
        }
    }

    // 2. 校验 new_memories 数组 (统一数据准入判定层 Fail-Closed 核验：非法类型直接丢弃，严禁降级为 fact)
    if (hasMemories) {
        for (const item of target.new_memories) {
            if (!item || typeof item !== 'object') continue;

            const norm = normalizeAndValidateMemory(item, {
                participants: trustedParticipants,
                source: 'ai_extraction',
                maxContentLen: maxMemContentLen,
                context: typeof getContext === 'function' ? getContext() : null
            });

            if (!norm.valid) {
                if (norm.aclRejected) {
                    console.warn(`[${MODULE_NAME}] [ACL 拦截] ${norm.reason}`);
                } else {
                    console.warn(`[${MODULE_NAME}] [Schema 拦截] ${norm.reason}`);
                }
                continue;
            }

            validated.new_memories.push(norm.memory);

            // 单次提炼吸收上限根据预算动态弹性扩展 (5~15条)
            if (validated.new_memories.length >= maxNewMemoriesAllowed) break;
        }
    }

    // 3. 校验 lifecycle_updates (确认 ID 真实存在于当前记忆库中)
    const existingIds = new Set(currentMemories.map(m => m.id));

    if (Array.isArray(target.lifecycle_updates)) {
        for (const up of target.lifecycle_updates) {
            if (!up || typeof up !== 'object') continue;
            const id = String(up.id || '').trim();
            if (!existingIds.has(id)) {
                console.warn(`[${MODULE_NAME}] [Schema 拦截] 待更新记忆 ID "${id}" 不存在，丢弃`);
                continue;
            }
            // P1 修复：模型提炼仅允许流转至终态 (completed, superseded, refuted)，严禁模型擅自将已结项重新激活为 active
            if (!MODEL_ALLOWED_LIFECYCLES.has(up.lifecycle)) {
                console.warn(`[${MODULE_NAME}] [Schema 拦截] 模型尝试将记忆 ID "${id}" 流转至非终态状态 "${up.lifecycle}"，拒绝`);
                continue;
            }

            validated.lifecycle_updates.push({
                id: id,
                lifecycle: up.lifecycle
            });
        }
    } else if (Array.isArray(target.resolved_memory_ids)) {
        // 向后兼容旧格式
        for (const id of target.resolved_memory_ids) {
            const trimmed = String(id || '').trim();
            if (existingIds.has(trimmed)) {
                validated.lifecycle_updates.push({
                    id: trimmed,
                    lifecycle: MEMORY_LIFECYCLE.COMPLETED
                });
            }
        }
    }

    return validated;
}

/**
 * 校验模型归并产出的 Schema 与权限边界 (Fail-Closed 拒绝越权与跨组拼凑)
 */
export function validateConsolidatedPayload(raw, currentMemories = [], allowedParticipants = null) {
    const target = unwrapJsonPayload(raw);
    if (!target || typeof target !== 'object' || !Array.isArray(target.consolidated)) {
        return null;
    }

    const memMap = new Map((Array.isArray(currentMemories) ? currentMemories : []).map(m => [m.id, m]));
    const VALID_TYPES = new Set(Object.values(MEMORY_TYPES));
    const VALID_SCOPES = new Set(Object.values(MEMORY_SCOPE));

    let trustedParticipants = allowedParticipants instanceof Set
        ? allowedParticipants
        : (Array.isArray(allowedParticipants) ? new Set(allowedParticipants) : null);

    if (!trustedParticipants) {
        const c = typeof getContext === 'function' ? getContext() : (typeof window !== 'undefined' ? window.SillyTavern?.getContext?.() : null);
        if (c) {
            trustedParticipants = getContextParticipants(c);
        }
    }

    const validConsolidated = [];

    for (const item of target.consolidated) {
        if (!item || typeof item !== 'object') continue;
        const content = typeof item.content === 'string' ? item.content.trim().slice(0, 100) : '';
        if (!content) continue;

        // P2 规范化：非法类型 Fail-Closed 严禁静默降级为 fact
        if (item.type && !VALID_TYPES.has(item.type)) {
            console.warn(`[${MODULE_NAME}] [Consolidate 拦截] 归并记忆类型 "${item.type}" 非法，拒绝入库`);
            continue;
        }
        const type = item.type || MEMORY_TYPES.FACT;
        const supersedes = Array.isArray(item.supersedes)
            ? Array.from(new Set(item.supersedes.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim())))
            : [];

        // 归并必须替代至少 2 条既有记忆
        if (supersedes.length < 2) {
            console.warn(`[${MODULE_NAME}] [Consolidate 拦截] 条目 supersedes 少于 2 条记忆，拒绝归并`);
            continue;
        }

        // 检查所有被替代的源条目是否存在且同属于一个权限分组
        const sourceMems = supersedes.map(id => memMap.get(id)).filter(Boolean);
        if (sourceMems.length !== supersedes.length) {
            console.warn(`[${MODULE_NAME}] [Consolidate 拦截] supersedes 包含不存在的记忆 ID，拒绝归并`);
            continue;
        }

        // 严禁归并已结项或常驻条目
        const hasInvalidSource = sourceMems.some(m => m.lifecycle !== MEMORY_LIFECYCLE.ACTIVE || m.status === MEMORY_STATUS.PINNED);
        if (hasInvalidSource) {
            console.warn(`[${MODULE_NAME}] [Consolidate 拦截] 被替代记忆中包含非 active 或常驻条目，拒绝归并`);
            continue;
        }

        // 核心权限边界不变式：源记忆必须全部具备完全相同的知情范围
        const baseScope = sourceMems[0].scope;
        const baseChar = sourceMems[0].character || '';
        const baseKnown = Array.isArray(sourceMems[0].known_by) ? sourceMems[0].known_by.slice().sort().join('|') : '';

        const scopeMismatch = sourceMems.some(m => {
            const mKnown = Array.isArray(m.known_by) ? m.known_by.slice().sort().join('|') : '';
            return m.scope !== baseScope || (m.character || '') !== baseChar || mKnown !== baseKnown;
        });

        if (scopeMismatch) {
            console.warn(`[${MODULE_NAME}] [Consolidate 拦截] 严禁跨越不同权限/角色的记忆进行拼凑归并，拒绝入库`);
            continue;
        }

        // 新条目必须继承源分组的 scope 与权限，严禁越权提权
        const targetScope = VALID_SCOPES.has(item.scope) ? item.scope : baseScope;
        if (targetScope !== baseScope) {
            console.warn(`[${MODULE_NAME}] [Consolidate 拦截] 归并产生的新记忆试图修改知情范围 (${targetScope} != ${baseScope})，拒绝提权`);
            continue;
        }

        let targetChar = baseChar;
        let targetKnown = Array.isArray(sourceMems[0].known_by) ? [...sourceMems[0].known_by] : [];

        // 验证参与者可信性 (调用统一 ACL 判定层)
        // P2 强化：若无法取得可信参与者名单，受限范围记忆 (CHARACTER / SHARED) Fail-Closed 严禁归并入库
        if (!trustedParticipants && (targetScope === MEMORY_SCOPE.CHARACTER || targetScope === MEMORY_SCOPE.SHARED)) {
            console.warn(`[${MODULE_NAME}] [Consolidate 拦截] 缺失权威参与者名单，拒绝受限范围 (${targetScope}) 记忆归并`);
            continue;
        }

        const aclRes = validateMemoryAcl({
            scope: targetScope,
            character: targetChar,
            known_by: targetKnown
        }, trustedParticipants);

        if (!aclRes.allowed) {
            console.warn(`[${MODULE_NAME}] [Consolidate 拦截] ${aclRes.reason}`);
            continue;
        }

        validConsolidated.push({
            content,
            type,
            scope: targetScope,
            character: targetChar,
            known_by: targetKnown,
            trigger_keys: sanitizeTriggerKeys(item.trigger_keys),
            supersedes: supersedes
        });
    }

    return validConsolidated.length > 0 ? { consolidated: validConsolidated } : null;
}
