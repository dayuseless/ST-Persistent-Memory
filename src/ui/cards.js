/**
 * ST-Persistent-Memory - 记忆卡片视图渲染器 (Memory Card Renderer)
 * 职责：
 * 1. 单张记忆卡片 HTML 模板组装与渲染 (renderMemoryCard)
 * 2. 状态、类型、知情范围与生命周期语义化徽章呈现
 * 3. 严格限定 type 枚举白名单，防御存储型 HTML 属性注入/XSS
 * 4. 世界书设定关联标签、写入同步按钮与升格词条入口
 * 5. 行内原位即时编辑表单骨架与字符限制控制
 *
 * @version 0.1.41
 */

import { MEMORY_STATUS, MEMORY_LIFECYCLE, MEMORY_SCOPE } from '../config.js';
import { escapeHtml } from './common.js';

/**
 * 渲染单个记忆卡片
 */
export function renderMemoryCard(mem, selectedMemoryIds = new Set()) {
    if (!mem || typeof mem !== 'object') return '';

    const selectedSet = (selectedMemoryIds instanceof Set) ? selectedMemoryIds : new Set();

    let statusClass = 'pm-chip-triggered';
    let statusIcon = '<i class="fa-solid fa-bolt"></i> 动态触发';
    if (mem.status === MEMORY_STATUS.PINNED) {
        statusClass = 'pm-chip-pinned';
        statusIcon = '<i class="fa-solid fa-thumbtack"></i> 常驻置顶';
    } else if (mem.status === MEMORY_STATUS.ARCHIVED) {
        statusClass = 'pm-chip-archived';
        statusIcon = '<i class="fa-solid fa-box-archive"></i> 归档休眠';
    }

    let scopeClass = 'pm-scope-world';
    let scopeLabel = '🌐 公共';
    if (mem.scope === MEMORY_SCOPE.CHARACTER) {
        scopeClass = 'pm-scope-char';
        scopeLabel = `👤 私密 (${escapeHtml(mem.character || '角色')})`;
    } else if (mem.scope === MEMORY_SCOPE.SHARED) {
        scopeClass = 'pm-scope-shared';
        const knownStr = Array.isArray(mem.known_by) && mem.known_by.length > 0 ? mem.known_by.join(', ') : '全员';
        scopeLabel = `👥 共享 (${escapeHtml(knownStr)})`;
    }

    let lifecycleBadge = '';
    if (mem.lifecycle === MEMORY_LIFECYCLE.COMPLETED) {
        lifecycleBadge = '<span class="pm-lifecycle-badge pm-life-completed"><i class="fa-solid fa-check"></i> 履约</span>';
    } else if (mem.lifecycle === MEMORY_LIFECYCLE.SUPERSEDED) {
        lifecycleBadge = '<span class="pm-lifecycle-badge pm-life-superseded"><i class="fa-solid fa-rotate"></i> 迭代</span>';
    } else if (mem.lifecycle === MEMORY_LIFECYCLE.REFUTED) {
        lifecycleBadge = '<span class="pm-lifecycle-badge pm-life-refuted"><i class="fa-solid fa-xmark"></i> 证伪</span>';
    }

    const keysHtml = (mem.trigger_keys || []).map(k => `<span class="pm-key-pill">${escapeHtml(k)}</span>`).join('');

    let typeIcon = 'fa-file-lines';
    let typeName = '事实';
    // 审计修复：严格限制 curType 仅能取预定义枚举，防御存储型 HTML 属性注入/XSS
    const VALID_TYPES = new Set(['fact', 'statement', 'inference', 'todo']);
    const curType = VALID_TYPES.has(mem.type) ? mem.type : 'fact';
    if (curType === 'statement') {
        typeIcon = 'fa-comment-dots';
        typeName = '约定';
    } else if (curType === 'inference') {
        typeIcon = 'fa-lightbulb';
        typeName = '推断';
    } else if (curType === 'todo') {
        typeIcon = 'fa-clipboard-check';
        typeName = '待办';
    }

    const isSelected = selectedSet.has(mem.id);

    return `
        <div class="pm-card ${isSelected ? 'pm-card-selected' : ''}" data-id="${escapeHtml(mem.id)}">
            <div class="pm-card-top">
                <input type="checkbox" class="pm-card-select-cb" data-id="${escapeHtml(mem.id)}" ${isSelected ? 'checked' : ''} title="选择此项进行批量操作">
                <button class="pm-status-chip ${statusClass}" title="点击切换：常驻 / 触发 / 归档" data-action="cycle">
                    ${statusIcon}
                </button>
                <button class="pm-type-badge pm-type-${curType}" title="点击切换类型：事实 (fact) / 约定 (statement) / 推断 (inference) / 待办 (todo)" data-action="cycle-type">
                    <i class="fa-solid ${typeIcon}"></i> ${typeName}
                </button>
                <span class="pm-scope-badge ${scopeClass}">${scopeLabel}</span>
                ${lifecycleBadge}
                <div class="pm-card-actions">
                    <button class="pm-edit-btn" title="编辑记忆内容与触发词" data-action="edit"><i class="fa-solid fa-pen-to-square"></i></button>
                    <button class="pm-del-btn" title="删除此条记忆" data-action="delete"><i class="fa-solid fa-trash-can"></i></button>
                </div>
            </div>
            <div class="pm-card-content" data-role="view-content">${escapeHtml(mem.content)}</div>
            <div class="pm-card-bottom-row" style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px;">
                ${keysHtml ? `<div class="pm-card-keys" data-role="view-keys">${keysHtml}</div>` : '<div></div>'}
                <div style="display: flex; align-items: center; gap: 4px; flex-wrap: wrap;">
                    ${mem.lorebook_ref && mem.lorebook_ref.entry_name ? `
                        <span class="pm-lorebook-tag" title="关联世界书: ${escapeHtml(mem.lorebook_ref.file_name || mem.lorebook_ref.book || '')} [UID: ${escapeHtml(String(mem.lorebook_ref.entry_uid ?? ''))}]">
                            <i class="fa-solid fa-book-atlas"></i> ${escapeHtml(mem.lorebook_ref.entry_name)}
                        </span>
                        <button class="pm-sync-lore-btn ${mem.synced_to_world_info ? 'pm-synced' : ''}" data-action="sync-lore" title="${mem.synced_to_world_info ? '已同步写入世界书设定，点击可再次同步' : '点击将此条动态事实安全同步追加至世界书设定'}">
                            <i class="fa-solid ${mem.synced_to_world_info ? 'fa-check-double' : 'fa-file-arrow-up'}"></i> ${mem.synced_to_world_info ? '已入册' : '写入设定'}
                        </button>
                    ` : `
                        <button class="pm-promote-lore-btn" data-action="promote-lore" title="将此条动态事实一键升格为世界书独立新词条 (永久常驻设定)">
                            <i class="fa-solid fa-crown"></i> 升格词条
                        </button>
                    `}
                    ${Array.isArray(mem.embedding) && mem.embedding.length > 0 ? `<span class="pm-embedding-tag" title="已缓存 ${mem.embedding.length} 维密集语义向量 (${escapeHtml(mem.embedding_provider || 'local')})"><i class="fa-solid fa-brain"></i></span>` : ''}
                </div>
            </div>
            <!-- 行内即时编辑表单 (默认隐藏) -->
            <div class="pm-card-edit-box" data-role="edit-box" style="display: none; margin-top: 8px;">
                <textarea class="pm-input pm-edit-content-input" rows="2" maxlength="150" placeholder="记忆正文 (上限150字)" style="width: 100%; box-sizing: border-box; font-size: 13px; margin-bottom: 6px; resize: vertical; line-height: 1.4;">${escapeHtml(mem.content)}</textarea>
                <input type="text" class="pm-input pm-edit-keys-input" placeholder="触发关键词 (逗号分隔，如: 约定, 礼物)" value="${escapeHtml((mem.trigger_keys || []).join(', '))}" style="width: 100%; box-sizing: border-box; font-size: 12px; margin-bottom: 6px;">
                <input type="text" class="pm-input pm-edit-lore-input" placeholder="关联世界书条目 (可选，如: 断钢圣剑)" value="${escapeHtml(mem.lorebook_ref?.entry_name || '')}" style="width: 100%; box-sizing: border-box; font-size: 12px; margin-bottom: 8px;">
                <div style="display: flex; gap: 6px; justify-content: flex-end;">
                    <button class="pm-btn-primary pm-edit-save-btn" data-action="save-edit" style="width: auto; padding: 4px 12px; font-size: 12px; background: #059669; border-color: #047857;"><i class="fa-solid fa-check"></i> 保存</button>
                    <button class="pm-btn-secondary pm-edit-cancel-btn" data-action="cancel-edit" style="padding: 4px 10px; font-size: 12px;"><i class="fa-solid fa-xmark"></i> 取消</button>
                </div>
            </div>
        </div>
    `;
}
