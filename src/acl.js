/**
 * 持续记忆访问控制与统一数据准入判定层 (Unified ACL & Ingestion Gate, v0.1.28)
 *
 * 核心设计纪律：
 * 1. 权责解耦：AI 负责提出记忆变更建议，ACL 负责验证变更合法性，状态引擎负责执行状态落盘。
 * 2. 来源与可信度解耦：数据来源 (AI提炼 / 历史回溯 / 备份导入 / 手工录入 / 长程归并) 不等于数据可信度。
 *    所有外部与内部数据统一经由本模块执行：格式规范化 -> 结构合法性校验 -> 权威参与者 ACL 校验 -> 越权提权防线。
 * 3. 严格 Fail-Closed：校验未通过坚决拒绝入库，受限私密与共享记忆绝不静默降级为 world 公共记忆。
 */

import { MODULE_NAME, MEMORY_TYPES, MEMORY_STATUS, MEMORY_LIFECYCLE, MEMORY_SCOPE } from './config.js';

const VALID_TYPES = new Set(Object.values(MEMORY_TYPES));
const VALID_SCOPES = new Set(Object.values(MEMORY_SCOPE));
const VALID_LIFECYCLES = new Set(Object.values(MEMORY_LIFECYCLE));
const VALID_STATUSES = new Set(Object.values(MEMORY_STATUS));

/**
 * P1-01: 计算当前会话的权威可信参与者名单 (Authoritative Participants Whitelist)
 * 1. 单聊模式：严格仅认可玩家 (name1) 与当前激活角色 (name2 或 characters[characterId])，排除角色库其他无关角色。
 * 2. 群聊模式：严格基于 c.groupId 索引 c.groups[groupId].members 解析参战角色，排除未入群角色。
 * 3. 严禁将模型生成的现场名单 (state.scene.in_scene_characters) 纳入授权凭证！
 */
export function getContextParticipants(c, state = null) {
    const participants = new Set();
    if (!c) return participants;

    // 1. 玩家身份 (User)
    if (c.name1 && typeof c.name1 === 'string' && c.name1.trim()) {
        participants.add(c.name1.trim());
    }

    // 2. 检查是否为群聊 (Group Chat)
    const isGroupChat = Boolean(c.groupId);
    if (isGroupChat && Array.isArray(c.groups)) {
        const activeGroup = c.groups.find(g => String(g.id) === String(c.groupId));
        if (activeGroup && Array.isArray(activeGroup.members)) {
            const memberSet = new Set(activeGroup.members.map(m => String(m).trim().toLowerCase()));
            if (Array.isArray(c.characters)) {
                c.characters.forEach(ch => {
                    if (ch && typeof ch.name === 'string' && ch.name.trim()) {
                        const avatarName = String(ch.avatar || '').trim().toLowerCase();
                        const charName = ch.name.trim().toLowerCase();
                        if (memberSet.has(avatarName) || memberSet.has(charName)) {
                            participants.add(ch.name.trim());
                        }
                    }
                });
            }
            activeGroup.members.forEach(m => {
                if (typeof m === 'string' && m.trim() && !m.includes('.')) {
                    participants.add(m.trim());
                }
            });
        }
    } else {
        // 3. 单聊模式 (1-on-1 Chat):
        if (c.name2 && typeof c.name2 === 'string' && c.name2.trim()) {
            participants.add(c.name2.trim());
        } else if (Array.isArray(c.characters) && c.characterId !== undefined && c.characters[c.characterId]) {
            const activeChar = c.characters[c.characterId];
            if (activeChar && typeof activeChar.name === 'string' && activeChar.name.trim()) {
                participants.add(activeChar.name.trim());
            }
        }
    }

    // 兜底保护：若环境仅有单一角色对象且未标明 name2/characterId
    if (participants.size <= 1 && Array.isArray(c.characters) && c.characters.length === 1) {
        const onlyChar = c.characters[0];
        if (onlyChar?.name && typeof onlyChar.name === 'string' && onlyChar.name.trim()) {
            participants.add(onlyChar.name.trim());
        }
    }

    return participants;
}

/**
 * 统一 ACL 判定层：检验条目的知情范围与参与者权限 (Validate Memory ACL)
 * @param {object} candidate - 包含 { scope, character, known_by } 的候选对象
 * @param {Set<string>|null} participants - 权威可信参与者名单
 * @param {object} [options]
 * @returns {{ allowed: boolean, reason?: string, code: string, normalizedScope: string, normalizedCharacter: string, normalizedKnownBy: string[] }}
 */
export function validateMemoryAcl(candidate, participants = null, options = {}) {
    if (!candidate || typeof candidate !== 'object') {
        return { allowed: false, reason: '候选条目无效', code: 'INVALID_OBJECT' };
    }

    let scope = candidate.scope;
    if (!VALID_SCOPES.has(scope)) {
        return { allowed: false, reason: `非法或未知的知情范围 "${scope}"`, code: 'INVALID_SCOPE' };
    }

    const char = typeof candidate.character === 'string' ? candidate.character.trim() : '';
    let knownBy = Array.isArray(candidate.known_by)
        ? candidate.known_by.filter(k => typeof k === 'string' && k.trim()).map(k => k.trim())
        : (char ? [char] : []);

    // 结构权限合法性约束：带有角色或知情者限制的信息，严禁声称为 world 公共常识
    if (scope === MEMORY_SCOPE.WORLD && char) {
        scope = MEMORY_SCOPE.CHARACTER;
    }
    if (scope === MEMORY_SCOPE.WORLD && knownBy.length > 0) {
        scope = MEMORY_SCOPE.SHARED;
    }

    // Fail-Closed: 角色私知必须有归属角色
    if (scope === MEMORY_SCOPE.CHARACTER) {
        if (!char) {
            return { allowed: false, reason: '角色私密记忆缺少明确归属角色', code: 'MISSING_CHARACTER' };
        }
        knownBy = [char];
    }

    // Fail-Closed: 现场共知必须有至少一个非空知情者
    if (scope === MEMORY_SCOPE.SHARED) {
        if (knownBy.length === 0) {
            return { allowed: false, reason: '共享机密记忆缺少明确知情者集合 (known_by)', code: 'EMPTY_KNOWN_BY' };
        }
    }

    if (scope === MEMORY_SCOPE.WORLD) {
        knownBy = [];
    }

    // 权威可信参与者边界核验
    if (participants !== null && participants !== undefined) {
        if (participants.size === 0) {
            // 名单为空时，受限范围记忆全部 Fail-Closed 拒绝
            if (scope === MEMORY_SCOPE.CHARACTER || scope === MEMORY_SCOPE.SHARED) {
                return {
                    allowed: false,
                    reason: `当前会话可信参与者名单为空，受限范围记忆 (${scope}) 无法核验授权归属`,
                    code: 'EMPTY_PARTICIPANTS'
                };
            }
        } else {
            // 1. 角色私密记忆：归属角色必须属于实际参战者
            if (scope === MEMORY_SCOPE.CHARACTER && !participants.has(char)) {
                return {
                    allowed: false,
                    reason: `私密记忆归属角色 "${char}" 超出当前会话实际参与者名单`,
                    code: 'UNAUTHORIZED_CHAR'
                };
            }
            // 2. 共享机密记忆：known_by 中所有知情者必须全部属于实际参战者
            if (scope === MEMORY_SCOPE.SHARED) {
                const unauthorized = knownBy.filter(k => !participants.has(k));
                if (unauthorized.length > 0) {
                    return {
                        allowed: false,
                        reason: `共享机密知情者 "${unauthorized.join(', ')}" 超出当前会话实际参与者名单`,
                        code: 'UNAUTHORIZED_KNOWN_BY',
                        unauthorized
                    };
                }
            }
        }
    }

    return {
        allowed: true,
        code: 'OK',
        normalizedScope: scope,
        normalizedCharacter: char,
        normalizedKnownBy: knownBy
    };
}

/**
 * 统一数据规范化与合法性验证入口 (Unified Normalization & Ingestion Pipeline)
 * 无论数据来自 AI提炼、备份导入、历史回溯、长程归并还是人工录入，全链路经此门禁
 *
 * 流水线：
 * 外部数据 -> 格式规范化 -> 结构合法性校验 -> 权限 ACL 校验 -> 纯净记忆对象
 *
 * @param {object} raw - 原始记忆数据
 * @param {object} [options]
 * @param {Set<string>|null} [options.participants] - 权威可信参与者名单
 * @param {string} [options.source='unknown'] - 数据来源标识 (ai_extraction | backup_import | manual_user | consolidation | migration)
 * @param {number} [options.maxContentLen=150] - 最大允许内容字数
 * @param {object} [options.context] - SillyTavern 运行上下文
 * @returns {{ valid: boolean, memory: object|null, reason?: string, aclRejected?: boolean }}
 */
export function normalizeAndValidateMemory(raw, options = {}) {
    if (!raw || typeof raw !== 'object') {
        return { valid: false, memory: null, reason: '数据根节点不是有效对象' };
    }

    // 1. 内容校验与截断
    if (typeof raw.content !== 'string' || !raw.content.trim()) {
        return { valid: false, memory: null, reason: '记忆正文为空或非字符串' };
    }
    const maxLen = Number(options.maxContentLen) || 150;
    const content = raw.content.trim().slice(0, maxLen);
    if (!content) {
        return { valid: false, memory: null, reason: '记忆正文修剪后为空' };
    }

    // 2. 类型白名单校验 (Fail-Closed: 未知类型直接拒绝，严禁静默降级为 fact)
    if (raw.type && !VALID_TYPES.has(raw.type)) {
        return { valid: false, memory: null, reason: `记忆类型 "${raw.type}" 非法，拒绝入库` };
    }
    const type = VALID_TYPES.has(raw.type) ? raw.type : MEMORY_TYPES.FACT;

    // 3. 知情范围初步解析
    const rawScope = raw.scope || (raw.character ? MEMORY_SCOPE.CHARACTER : (Array.isArray(raw.known_by) && raw.known_by.length > 0 ? MEMORY_SCOPE.SHARED : MEMORY_SCOPE.WORLD));
    if (!VALID_SCOPES.has(rawScope)) {
        return { valid: false, memory: null, reason: `记忆知情范围 "${raw.scope}" 非法，拒绝入库` };
    }

    const c = options.context || (typeof window !== 'undefined' ? window.SillyTavern?.getContext?.() : null);
    const char = typeof raw.character === 'string' && raw.character.trim()
        ? raw.character.trim().slice(0, 30)
        : (rawScope === MEMORY_SCOPE.CHARACTER ? (c?.name2 || 'Character') : '');

    let rawKnownBy = Array.isArray(raw.known_by)
        ? raw.known_by.filter(k => typeof k === 'string' && k.trim()).map(k => k.trim().slice(0, 30))
        : (char ? [char] : []);

    // 4. 执行统一权限判定层 ACL 校验
    const participants = options.participants !== undefined
        ? options.participants
        : getContextParticipants(c);

    const aclResult = validateMemoryAcl({
        scope: rawScope,
        character: char,
        known_by: rawKnownBy,
        content
    }, participants, options);

    if (!aclResult.allowed) {
        return {
            valid: false,
            memory: null,
            reason: aclResult.reason,
            aclRejected: true,
            code: aclResult.code
        };
    }

    // 5. 规范化生命周期与状态
    const lifecycle = VALID_LIFECYCLES.has(raw.lifecycle) ? raw.lifecycle : MEMORY_LIFECYCLE.ACTIVE;
    const status = raw.status === MEMORY_STATUS.PINNED ? MEMORY_STATUS.PINNED : (VALID_STATUSES.has(raw.status) ? raw.status : MEMORY_STATUS.TRIGGERED);

    // 6. 规范化触发词
    const triggerKeys = Array.isArray(raw.trigger_keys)
        ? Array.from(new Set(raw.trigger_keys.filter(k => typeof k === 'string' && k.trim()).map(k => k.trim().slice(0, 30))))
        : [];

    // 7. 规范化世界书关联结构 (lorebook_ref)
    let lorebookRef = null;
    if (raw.lorebook_ref && typeof raw.lorebook_ref === 'object') {
        const lb = raw.lorebook_ref;
        const entryName = typeof lb.entry_name === 'string' ? lb.entry_name.trim().slice(0, 80) : '';
        const bookName = typeof lb.book === 'string' ? lb.book.trim().slice(0, 80) : (typeof lb.file_name === 'string' ? lb.file_name.trim().slice(0, 80) : '');
        let uidVal = null;
        if (Number.isInteger(lb.entry_uid)) {
            uidVal = lb.entry_uid;
        } else if (lb.entry_uid !== null && lb.entry_uid !== undefined && !isNaN(Number(lb.entry_uid))) {
            uidVal = Number(lb.entry_uid);
        }
        if (entryName || uidVal !== null) {
            lorebookRef = {
                book: bookName,
                file_name: bookName,
                entry_uid: uidVal,
                entry_name: entryName,
                promoted_from_scope: typeof lb.promoted_from_scope === 'string' ? lb.promoted_from_scope.trim() : undefined,
                original_character: typeof lb.original_character === 'string' ? lb.original_character.trim() : undefined,
                original_known_by: Array.isArray(lb.original_known_by) ? lb.original_known_by.filter(k => typeof k === 'string').map(k => k.trim()) : undefined
            };
        }
    }

    const sanitizeId = (id) => {
        if (typeof id === 'string' && /^[a-zA-Z0-9_\-\.]+$/.test(id.trim())) {
            return id.trim();
        }
        return 'mem-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6);
    };

    const currentFloor = Number(raw.floor) || 0;
    const lastActivatedFloor = Number.isInteger(raw.last_activated_floor) ? raw.last_activated_floor : currentFloor;

    const normalized = {
        id: sanitizeId(raw.id),
        content,
        type,
        status,
        lifecycle,
        scope: aclResult.normalizedScope,
        character: aclResult.normalizedCharacter,
        known_by: aclResult.normalizedKnownBy,
        lorebook_ref: lorebookRef,
        synced_to_world_info: Boolean(raw.synced_to_world_info),
        synced_at: typeof raw.synced_at === 'string' ? raw.synced_at : null,
        trigger_keys: triggerKeys,
        floor: currentFloor,
        last_activated_floor: lastActivatedFloor,
        created_at: raw.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString()
    };

    return {
        valid: true,
        memory: normalized
    };
}

/**
 * 越权提权防线 (Scope Escalation Guard)
 * 当相似或已有条目发生合并更新时，严禁单方面扩大已知知情范围或转移私知
 *
 * @param {object} existing - 既有记忆条目
 * @param {object} incoming - 试图更新或融合的候选新条目
 * @returns {{ allowed: boolean, inheritedAcl: object, violated: boolean, reason?: string }}
 */
export function checkAclEscalation(existing, incoming) {
    if (!existing || !incoming) {
        return { allowed: true, inheritedAcl: {}, violated: false };
    }

    const SCOPE_RANK = {
        [MEMORY_SCOPE.CHARACTER]: 1, // 最严格：仅当前角色
        [MEMORY_SCOPE.SHARED]: 2,    // 次严格：明确在场知情者
        [MEMORY_SCOPE.WORLD]: 3      // 最公开：全员通用常识
    };

    const existScope = existing.scope || MEMORY_SCOPE.CHARACTER;
    const incomScope = incoming.scope || existScope;

    const existRank = SCOPE_RANK[existScope] || 1;
    const incomRank = SCOPE_RANK[incomScope] || 1;

    // 1. 禁止向更公开的范围提升 (例如 character -> world, shared -> world)
    if (incomRank > existRank) {
        console.warn(`[${MODULE_NAME}] [ACL Escalation Guard] 拦截模型扩大已有条目 (${existing.id}) 的可见范围 (${existScope} -> ${incomScope})，强制继承既有 ACL`);
        return {
            allowed: false,
            violated: true,
            reason: `禁止提升知情范围等级 (${existScope} -> ${incomScope})`,
            inheritedAcl: {
                scope: existScope,
                character: existing.character,
                known_by: Array.isArray(existing.known_by) ? [...existing.known_by] : [existing.character].filter(Boolean)
            }
        };
    }

    // 2. 禁止扩大 shared 记忆的 known_by 集合
    if (existScope === MEMORY_SCOPE.SHARED && incomScope === MEMORY_SCOPE.SHARED) {
        const existSet = new Set((existing.known_by || []).map(k => k.trim()));
        const incomingKnown = incoming.known_by || [];
        const expanded = incomingKnown.filter(k => typeof k === 'string' && k.trim() && !existSet.has(k.trim()));
        if (expanded.length > 0) {
            console.warn(`[${MODULE_NAME}] [ACL Escalation Guard] 拦截模型尝试向共享条目 (${existing.id}) 擅自扩充知情者 [${expanded.join(', ')}]，强制保持原知情集合`);
            return {
                allowed: false,
                violated: true,
                reason: `禁止擅自向共享机密扩充知情者 [${expanded.join(', ')}]`,
                inheritedAcl: {
                    scope: existScope,
                    character: existing.character,
                    known_by: Array.isArray(existing.known_by) ? [...existing.known_by] : []
                }
            };
        }
    }

    // 3. 禁止转移 character 私密归属
    if (existScope === MEMORY_SCOPE.CHARACTER && incomScope === MEMORY_SCOPE.CHARACTER) {
        if (existing.character && incoming.character && existing.character.trim() !== incoming.character.trim()) {
            console.warn(`[${MODULE_NAME}] [ACL Escalation Guard] 拦截模型尝试将私密记忆归属从 "${existing.character}" 转移给 "${incoming.character}"，强制保留原归属`);
            return {
                allowed: false,
                violated: true,
                reason: `禁止转移私密记忆所有者 (${existing.character} -> ${incoming.character})`,
                inheritedAcl: {
                    scope: existScope,
                    character: existing.character,
                    known_by: [existing.character]
                }
            };
        }
    }

    return {
        allowed: true,
        violated: false,
        inheritedAcl: {
            scope: existScope,
            character: existing.character,
            known_by: Array.isArray(existing.known_by) ? [...existing.known_by] : [existing.character].filter(Boolean)
        }
    };
}

/**
 * 权限变更审计追踪 (Permission Mutation Audit Trail)
 * 在系统状态中维系环形审计队列，留存关键权限流转凭据 (如世界书升格、越权拦截)
 *
 * @param {object} state - 记忆系统全局状态
 * @param {string} action - 操作动作 (promote_world_info | scope_escalation_blocked | import_acl_rejected | manual_add)
 * @param {object} details - 审计细节
 */
export function recordAclAudit(state, action, details = {}) {
    if (!state || typeof state !== 'object') return;
    if (!Array.isArray(state.acl_audit_log)) {
        state.acl_audit_log = [];
    }

    state.acl_audit_log.push({
        timestamp: new Date().toISOString(),
        action: String(action || 'unknown'),
        details: JSON.parse(JSON.stringify(details || {}))
    });

    // 环形队列：保留最近 30 条关键权限审计事件
    if (state.acl_audit_log.length > 30) {
        state.acl_audit_log.shift();
    }
}
