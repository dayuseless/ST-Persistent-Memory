/**
 * ST-Persistent-Memory - 世界书关联模态对话框交互服务 (Lorebook Modals)
 * 职责：
 * 1. 同步记忆事实差量至既有世界书条目确认框 (showSyncLoreModal)
 * 2. 升格记忆为世界书独立新条目配置框 (showPromoteLoreModal)
 * 3. 私密/共享记忆权限范围变更预警与防越权二次确认 (Escalation Guard)
 *
 * @version 0.1.41
 */

import { MEMORY_SCOPE } from '../config.js';
import { escapeHtml } from './common.js';

/**
 * 弹出记忆差量写回世界书条目的确认预览对话框
 */
export function showSyncLoreModal(preview, onConfirm) {
    if (typeof document === 'undefined') return;

    // 清理已有模态框
    document.querySelectorAll('#pm-lore-sync-modal').forEach(el => el.remove());

    const modalHtml = `
        <div class="pm-modal-backdrop" id="pm-lore-sync-modal">
            <div class="pm-modal-card">
                <div class="pm-modal-header">
                    <span style="font-weight: 700; color: #0284c7; font-size: 13px; display: flex; align-items: center; gap: 6px;">
                        <i class="fa-solid fa-book-atlas"></i> 同步事实至世界书设定 (Write-Back)
                    </span>
                    <button class="pm-modal-close" id="pm-lore-modal-close" style="background: none; border: none; font-size: 18px; cursor: pointer; color: #94a3b8; line-height: 1;">&times;</button>
                </div>
                <div class="pm-modal-body" style="padding: 10px 0;">
                    <div style="font-size: 12px; color: #334155; margin-bottom: 8px;">
                        目标设定：<b style="color: #0284c7;">${escapeHtml(preview.entryName)}</b> 
                        <span style="color: #64748b; font-size: 11px;">(世界书: ${escapeHtml(preview.bookName)}${preview.entryUid !== undefined && preview.entryUid !== null ? `, UID: ${preview.entryUid}` : ''})</span>
                    </div>
                    <div style="font-size: 11px; color: #64748b; margin-bottom: 4px;">将追加以下动态事实差量至该条目正文末尾：</div>
                    <div class="pm-diff-preview" style="background: #f8fafc; border: 1px solid #e2e8f0; border-left: 3px solid #0284c7; padding: 8px; border-radius: 4px; font-size: 11px; color: #334155; max-height: 110px; overflow-y: auto; white-space: pre-wrap; font-family: monospace;">${escapeHtml(preview.appendedText)}</div>
                    <div style="margin-top: 10px;">
                        <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: #334155; cursor: pointer;">
                            <input type="checkbox" id="pm-sync-mark-completed" checked>
                            <span>同步后将本记忆标记为<b>【履约/办结】</b>(不再重复作为动态记忆注入)</span>
                        </label>
                    </div>
                </div>
                <div class="pm-modal-footer" style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px;">
                    <button class="pm-btn-secondary" id="pm-lore-modal-cancel" style="padding: 4px 12px; font-size: 12px;">取消</button>
                    <button class="pm-btn-primary" id="pm-lore-modal-confirm" style="padding: 4px 14px; font-size: 12px; background: #0284c7; border-color: #0369a1;"><i class="fa-solid fa-file-arrow-up"></i> 确认写回</button>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    const modalEl = document.getElementById('pm-lore-sync-modal');

    const closeModal = () => modalEl?.remove();

    modalEl.querySelector('#pm-lore-modal-close')?.addEventListener('click', closeModal);
    modalEl.querySelector('#pm-lore-modal-cancel')?.addEventListener('click', closeModal);

    modalEl.querySelector('#pm-lore-modal-confirm')?.addEventListener('click', () => {
        const markCompleted = Boolean(modalEl.querySelector('#pm-sync-mark-completed')?.checked);
        closeModal();
        if (typeof onConfirm === 'function') {
            onConfirm(markCompleted);
        }
    });
}

/**
 * 弹出记忆一键升格为世界书独立新词条的配置对话框
 * P2-01: 对受限范围 (私密/现场机密) 记忆增加显式权限变更预警与二次确认
 */
export function showPromoteLoreModal(mem, activeBookName, onConfirm) {
    if (typeof document === 'undefined') return;

    // 清理已有模态框
    document.querySelectorAll('#pm-lore-promote-modal').forEach(el => el.remove());

    const defaultTitle = (mem.content || '').slice(0, 16).trim() || '新设定词条';
    const defaultKeys = (mem.trigger_keys || []).join(', ') || defaultTitle;
    const isRestrictedScope = mem.scope === MEMORY_SCOPE.CHARACTER || mem.scope === MEMORY_SCOPE.SHARED;

    const scopeWarningHtml = isRestrictedScope ? `
        <div class="pm-alert-warning" id="pm-promote-acl-warning" style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; padding: 8px 10px; margin-bottom: 10px; font-size: 11px; color: #92400e; display: flex; align-items: flex-start; gap: 6px;">
            <i class="fa-solid fa-triangle-exclamation" style="font-size: 14px; margin-top: 1px; color: #d97706; flex-shrink: 0;"></i>
            <div>
                <b>权限范围变更预警：</b>该条记忆原为<b>【${mem.scope === MEMORY_SCOPE.CHARACTER ? `角色私密 (${escapeHtml(mem.character || '未知')})` : `现场机密 (知情: ${escapeHtml((mem.known_by || []).join(', '))})`}】</b>。
                升格为世界书独立条目后，将作为静态知识对绑定该世界书的所有会话与角色开放常驻，知情权限将实质性扩大。
            </div>
        </div>
    ` : '';

    const escalationCheckboxHtml = isRestrictedScope ? `
        <div style="margin-top: 8px; background: #fff7ed; border: 1px dashed #fdba74; border-radius: 4px; padding: 6px 8px;">
            <label style="display: flex; align-items: flex-start; gap: 6px; font-size: 11px; color: #9a3412; cursor: pointer;">
                <input type="checkbox" id="pm-promote-confirm-acl-escalation">
                <span><b>安全确认：</b>我已知悉此条记忆原属受限机密，确认升格为公开/全员常驻世界书条目并承担知情范围扩大后果。</span>
            </label>
        </div>
    ` : '';

    const modalHtml = `
        <div class="pm-modal-backdrop" id="pm-lore-promote-modal">
            <div class="pm-modal-card">
                <div class="pm-modal-header">
                    <span style="font-weight: 700; color: #b45309; font-size: 13px; display: flex; align-items: center; gap: 6px;">
                        <i class="fa-solid fa-crown" style="color: #f59e0b;"></i> 升格记忆为世界书独立新词条
                    </span>
                    <button class="pm-modal-close" id="pm-promote-modal-close" style="background: none; border: none; font-size: 18px; cursor: pointer; color: #94a3b8; line-height: 1;">&times;</button>
                </div>
                <div class="pm-modal-body" style="padding: 10px 0;">
                    ${scopeWarningHtml}
                    <div class="pm-input-row" style="margin-bottom: 8px;">
                        <label class="pm-input-label" style="font-size: 11px; font-weight: 600; color: #334155;">目标世界书名称：</label>
                        <input type="text" id="pm-promote-target-book" class="pm-input" value="${escapeHtml(activeBookName || '')}" placeholder="输入或确认世界书名称 (留空将自动匹配当前角色绑定的世界书)" style="width: 100%; box-sizing: border-box; font-size: 12px;">
                    </div>
                    <div class="pm-grid-2col" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;">
                        <div class="pm-input-row">
                            <label class="pm-input-label" style="font-size: 11px; font-weight: 600; color: #334155;">新词条标题 (Comment)：</label>
                            <input type="text" id="pm-promote-entry-name" class="pm-input" value="${escapeHtml(defaultTitle)}" placeholder="例如：霜之哀伤" style="width: 100%; box-sizing: border-box; font-size: 12px;">
                        </div>
                        <div class="pm-input-row">
                            <label class="pm-input-label" style="font-size: 11px; font-weight: 600; color: #334155;">触发关键词 (Keys，逗号分隔)：</label>
                            <input type="text" id="pm-promote-entry-keys" class="pm-input" value="${escapeHtml(defaultKeys)}" placeholder="例如：霜之哀伤, 符文剑" style="width: 100%; box-sizing: border-box; font-size: 12px;">
                        </div>
                    </div>
                    <div class="pm-input-row" style="margin-bottom: 8px;">
                        <label class="pm-input-label" style="font-size: 11px; font-weight: 600; color: #334155;">词条设定正文 (Content)：</label>
                        <textarea id="pm-promote-entry-content" class="pm-input" rows="3" style="width: 100%; box-sizing: border-box; font-size: 12px; resize: vertical; line-height: 1.4;">${escapeHtml(mem.content || '')}</textarea>
                    </div>
                    <div style="margin-top: 10px;">
                        <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: #334155; cursor: pointer;">
                            <input type="checkbox" id="pm-promote-mark-completed" checked>
                            <span>升格后将本记忆标记为<b>【履约/办结】</b>(转化为静态世界书设定常驻，不再重复作为动态记忆抽取)</span>
                        </label>
                    </div>
                    ${escalationCheckboxHtml}
                </div>
                <div class="pm-modal-footer" style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px;">
                    <button class="pm-btn-secondary" id="pm-promote-modal-cancel" style="padding: 4px 12px; font-size: 12px;">取消</button>
                    <button class="pm-btn-primary" id="pm-promote-modal-confirm" style="padding: 4px 14px; font-size: 12px; background: #b45309; border-color: #92400e;"><i class="fa-solid fa-crown"></i> 确认升格</button>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    const modalEl = document.getElementById('pm-lore-promote-modal');

    const closeModal = () => modalEl?.remove();

    modalEl.querySelector('#pm-promote-modal-close')?.addEventListener('click', closeModal);
    modalEl.querySelector('#pm-promote-modal-cancel')?.addEventListener('click', closeModal);

    modalEl.querySelector('#pm-promote-modal-confirm')?.addEventListener('click', () => {
        if (isRestrictedScope) {
            const confirmedAcl = Boolean(modalEl.querySelector('#pm-promote-confirm-acl-escalation')?.checked);
            if (!confirmedAcl) {
                window.toastr?.warning?.('此记忆属于受限机密，升格世界书前请先勾选确认授权知情范围扩大。', '持续记忆安全提示');
                return;
            }
        }

        const bookName = modalEl.querySelector('#pm-promote-target-book')?.value?.trim();
        const entryName = modalEl.querySelector('#pm-promote-entry-name')?.value?.trim() || defaultTitle;
        const rawKeys = modalEl.querySelector('#pm-promote-entry-keys')?.value || '';
        const keys = rawKeys.split(/[,，]/).map(k => k.trim()).filter(Boolean);
        const content = modalEl.querySelector('#pm-promote-entry-content')?.value?.trim() || mem.content;
        const markCompleted = Boolean(modalEl.querySelector('#pm-promote-mark-completed')?.checked);

        closeModal();
        if (typeof onConfirm === 'function') {
            onConfirm({ bookName, entryName, keys, content, markCompleted });
        }
    });
}
