/**
 * ST-Persistent-Memory - 模态对话框交互服务 (Modals & Dialogs)
 * 职责：
 * 1. 同步记忆事实差量至既有世界书条目确认框 (showSyncLoreModal)
 * 2. 升格记忆为世界书独立新条目配置框 (showPromoteLoreModal)
 * 3. 私密/共享记忆权限范围变更预警与防越权二次确认 (Escalation Guard)
 * 4. 详细与高级参数设置模态面板 (showAdvancedSettingsModal，支持详细调优与一键恢复默认)
 *
 * @version 0.1.42
 */

import { MEMORY_SCOPE, DEFAULT_SETTINGS } from '../config.js';
import { getSettings, updateSettings, saveSettingsImmediately, reindexAllMemories } from '../state.js';
import { testEmbeddingApiConnection } from '../semantic.js';
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

/**
 * 弹出详细与高级参数设置模态面板
 * 用于在“傻瓜式”默认托管之外，提供精细化的底层指标调整，并支持一键重置为官方推荐默认值
 */
export function showAdvancedSettingsModal(options = {}) {
    if (typeof document === 'undefined') return;

    // 清理已有模态框
    document.querySelectorAll('#pm-advanced-settings-modal').forEach(el => el.remove());

    const settings = getSettings();

    const modalHtml = `
        <div class="pm-modal-backdrop" id="pm-advanced-settings-modal" style="z-index: 9999999;">
            <div class="pm-modal-card" style="width: 94%; max-width: 680px; max-height: 88vh; display: flex; flex-direction: column; padding: 16px 20px; box-sizing: border-box; background: #ffffff; border-radius: 10px; border: 1px solid #cbd5e1; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.25);">
                <div class="pm-modal-header" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e2e8f0; padding-bottom: 10px;">
                    <span style="font-weight: 700; color: #0f172a; font-size: 14px; display: flex; align-items: center; gap: 8px;">
                        <i class="fa-solid fa-sliders" style="color: #2563eb;"></i> 详细与高级参数设置 (详细模式)
                    </span>
                    <button class="pm-modal-close" id="pm-adv-modal-close" style="background: none; border: none; font-size: 22px; cursor: pointer; color: #94a3b8; line-height: 1;" title="关闭">&times;</button>
                </div>

                <div class="pm-modal-body" style="overflow-y: auto; flex: 1; padding: 12px 2px; margin: 4px 0;">
                    <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 6px; padding: 8px 12px; margin-bottom: 12px; font-size: 11px; color: #1e40af; line-height: 1.4;">
                        💡 <b>傻瓜式默认设想</b>：平时使用无需改动，系统默认已调优至黄金状态。若有特殊需求（如超长文本、自定义注入深度、特定模型 XML 模板、高阶语义权重），可在此微调底层指标。
                    </div>

                    <!-- 模块 1：提炼运行模式与节律编排 -->
                    <div class="pm-section-card pm-mb-8" style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px;">
                        <div style="font-weight: 600; font-size: 12px; color: #0f172a; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
                            <i class="fa-solid fa-bolt" style="color: #f59e0b;"></i> 提炼运行模式与自适应节律
                        </div>
                        <div class="pm-input-row pm-mb-8">
                            <label class="pm-input-label">运行模式：</label>
                            <div class="pm-toggle-group">
                                <label class="pm-radio-label">
                                    <input type="radio" name="pm-adv-mode" value="async" ${settings.mode === 'async' ? 'checked' : ''}>
                                    <span>异步后台 (独立提炼)</span>
                                </label>
                                <label class="pm-radio-label">
                                    <input type="radio" name="pm-adv-mode" value="sync" ${settings.mode === 'sync' ? 'checked' : ''}>
                                    <span>伴随标签 (零额外请求)</span>
                                </label>
                            </div>
                        </div>
                        <div class="pm-grid-2col pm-mb-8">
                            <div class="pm-input-row">
                                <label class="pm-input-label">提炼频率 (每 N 轮):</label>
                                <input type="number" id="pm-adv-freq" class="pm-input" min="1" max="20" value="${settings.asyncFrequency || 3}">
                            </div>
                            <div class="pm-input-row">
                                <label class="pm-input-label">历史回溯 (条数):</label>
                                <input type="number" id="pm-adv-slice" class="pm-input" min="2" max="15" value="${settings.digestSliceCount || 6}">
                            </div>
                        </div>
                        <div class="pm-grid-2col">
                            <div class="pm-input-row">
                                <label class="pm-input-label">智能增量提炼节律：</label>
                                <select id="pm-adv-adaptive-cadence" class="pm-input" style="cursor: pointer;">
                                    <option value="1" ${settings.adaptiveCadenceEnabled !== false ? 'selected' : ''}>启用 (寒暄短句延迟以节约API)</option>
                                    <option value="0" ${settings.adaptiveCadenceEnabled === false ? 'selected' : ''}>停用 (按固定轮数强制触发)</option>
                                </select>
                            </div>
                            <div class="pm-input-row">
                                <label class="pm-input-label">剧情增量门槛 (字数):</label>
                                <input type="number" id="pm-adv-adaptive-min-chars" class="pm-input" min="20" max="500" value="${settings.adaptiveCadenceMinChars || 60}">
                            </div>
                        </div>
                    </div>

                    <!-- 模块 2：Token 硬预算与配额保护 -->
                    <div class="pm-section-card pm-mb-8" style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px;">
                        <div style="font-weight: 600; font-size: 12px; color: #0f172a; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
                            <i class="fa-solid fa-coins" style="color: #10b981;"></i> Token 硬预算与配额保护
                        </div>
                        <div class="pm-grid-2col pm-mb-8">
                            <div class="pm-input-row">
                                <label class="pm-input-label">现场快照上限 (Tok):</label>
                                <input type="number" id="pm-adv-scene-tokens" class="pm-input" min="50" max="800" value="${settings.maxSceneTokens || 150}">
                            </div>
                            <div class="pm-input-row">
                                <label class="pm-input-label">记忆总 Token 预算:</label>
                                <input type="number" id="pm-adv-tokens" class="pm-input" min="150" max="2500" value="${settings.maxTotalMemoryTokens || 450}">
                            </div>
                        </div>
                        <div class="pm-grid-2col">
                            <div class="pm-input-row">
                                <label class="pm-input-label">常驻记忆上限 (条):</label>
                                <input type="number" id="pm-adv-max-pinned" class="pm-input" min="1" max="15" value="${settings.maxPinnedCount || 5}">
                            </div>
                            <div class="pm-input-row">
                                <label class="pm-input-label">激活记忆上限 (条):</label>
                                <input type="number" id="pm-adv-max-triggered" class="pm-input" min="1" max="30" value="${settings.maxTriggeredCount || 5}">
                            </div>
                        </div>
                    </div>

                    <!-- 模块 3：提示词注入位置与格式模板 -->
                    <div class="pm-section-card pm-mb-8" style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px;">
                        <div style="font-weight: 600; font-size: 12px; color: #0f172a; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
                            <i class="fa-solid fa-syringe" style="color: #6366f1;"></i> 提示词注入位置与格式模板
                        </div>
                        <div class="pm-grid-2col pm-mb-8">
                            <div class="pm-input-row">
                                <label class="pm-input-label">注入位置：</label>
                                <select id="pm-adv-inject-pos" class="pm-input" style="cursor: pointer;">
                                    <option value="1" ${(settings.injectionPosition ?? 1) == 1 ? 'selected' : ''}>对话内 (In-Chat @ 深度)</option>
                                    <option value="0" ${(settings.injectionPosition ?? 1) == 0 ? 'selected' : ''}>系统主提示词 (System Prompt)</option>
                                </select>
                            </div>
                            <div class="pm-input-row">
                                <label class="pm-input-label">对话注入深度 (Depth):</label>
                                <input type="number" id="pm-adv-inject-depth" class="pm-input" min="0" max="20" value="${settings.injectionDepth ?? 2}">
                            </div>
                        </div>
                        <div class="pm-input-row">
                            <label class="pm-input-label">提示词注入格式模板：</label>
                            <select id="pm-adv-inject-template" class="pm-input" style="cursor: pointer;">
                                <option value="standard" ${settings.injectionTemplate === 'standard' || !settings.injectionTemplate ? 'selected' : ''}>🇨🇳 标准中文 (默认，通用RP)</option>
                                <option value="xml" ${settings.injectionTemplate === 'xml' ? 'selected' : ''}>🏷️ 结构化 XML (推荐 Claude 3.5 / GPT-4o)</option>
                                <option value="english" ${settings.injectionTemplate === 'english' ? 'selected' : ''}>🇬🇧 英文原生 English (推荐英文角色卡)</option>
                                <option value="compact" ${settings.injectionTemplate === 'compact' ? 'selected' : ''}>⚡ 极简紧凑 Compact (极致节省 Token)</option>
                            </select>
                        </div>
                    </div>

                    <!-- 模块 4：语义检索与混合向量基建 -->
                    <div class="pm-section-card pm-mb-8" style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                            <span style="font-weight: 600; font-size: 12px; color: #0f172a; display: flex; align-items: center; gap: 6px;">
                                <i class="fa-solid fa-brain" style="color: #8b5cf6;"></i> 语义检索与混合向量 (Hybrid Search)
                            </span>
                            <div class="pm-switch">
                                <input type="checkbox" id="pm-adv-semantic-enabled" ${settings.semanticRetrievalEnabled !== false ? 'checked' : ''}>
                                <span class="pm-slider"></span>
                            </div>
                        </div>
                        <div id="pm-adv-semantic-body" style="${settings.semanticRetrievalEnabled !== false ? 'display: block;' : 'display: none;'}">
                            <div class="pm-grid-2col pm-mb-8">
                                <div class="pm-input-row">
                                    <label class="pm-input-label">向量计算引擎：</label>
                                    <select id="pm-adv-embedding-provider" class="pm-input" style="cursor: pointer;">
                                        <option value="local" ${(settings.embeddingProvider || 'local') === 'local' ? 'selected' : ''}>内置轻量向量引擎 (零依赖/全离线/秒级)</option>
                                        <option value="custom_api" ${settings.embeddingProvider === 'custom_api' ? 'selected' : ''}>外部 OpenAI 兼容端点 (/embeddings)</option>
                                    </select>
                                </div>
                                <div class="pm-input-row">
                                    <label class="pm-input-label">相似度激活门槛 (<span id="pm-adv-val-threshold">${Number(settings.semanticThreshold ?? 0.25).toFixed(2)}</span>):</label>
                                    <input type="range" id="pm-adv-semantic-threshold" min="0.10" max="0.90" step="0.05" value="${settings.semanticThreshold ?? 0.25}" style="width: 100%; cursor: pointer;">
                                </div>
                            </div>
                            <div class="pm-grid-2col pm-mb-8">
                                <div class="pm-input-row">
                                    <label class="pm-input-label">语义/词法打分权重 (<span id="pm-adv-val-weight">${Math.round((settings.semanticWeight ?? 0.60) * 100)}% 语义 + ${Math.round((1 - (settings.semanticWeight ?? 0.60)) * 100)}% 词法</span>):</label>
                                    <input type="range" id="pm-adv-semantic-weight" min="0.0" max="1.0" step="0.05" value="${settings.semanticWeight ?? 0.60}" style="width: 100%; cursor: pointer;">
                                </div>
                                <div class="pm-input-row" style="display: flex; align-items: flex-end;">
                                    <button type="button" id="pm-adv-reindex-btn" class="pm-btn-secondary" style="width: 100%; padding: 6px 10px; font-size: 11px;">
                                        <i class="fa-solid fa-arrows-rotate"></i> 重新索引全库向量
                                    </button>
                                </div>
                            </div>
                            <div id="pm-adv-embedding-api-box" style="${settings.embeddingProvider === 'custom_api' ? 'display: block;' : 'display: none;'} border-top: 1px dashed #cbd5e1; padding-top: 8px;">
                                <div class="pm-input-row">
                                    <label class="pm-input-label">Embedding Base URL:</label>
                                    <input type="text" id="pm-adv-embedding-url" class="pm-input" value="${escapeHtml(settings.embeddingApiUrl || '')}" placeholder="留空沿用提炼端点，或填写 https://api.openai.com/v1">
                                </div>
                                <div class="pm-grid-2col pm-mb-8">
                                    <div class="pm-input-row">
                                        <label class="pm-input-label">Embedding API Key:</label>
                                        <input type="password" id="pm-adv-embedding-key" class="pm-input" value="${escapeHtml(settings.embeddingApiKey || '')}" placeholder="留空沿用提炼密钥">
                                    </div>
                                    <div class="pm-input-row">
                                        <label class="pm-input-label">向量模型名称:</label>
                                        <input type="text" id="pm-adv-embedding-model" class="pm-input" value="${escapeHtml(settings.embeddingModel || 'text-embedding-3-small')}" placeholder="text-embedding-3-small">
                                    </div>
                                </div>
                                <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                                    <button type="button" id="pm-adv-test-emb-btn" class="pm-btn-test"><i class="fa-solid fa-plug"></i> 测试向量连接</button>
                                    <button type="button" id="pm-adv-inherit-emb-btn" class="pm-btn-test"><i class="fa-solid fa-copy"></i> 继承提炼 API 配置</button>
                                    <span id="pm-adv-emb-status" style="font-size: 11px; font-weight: 500;"></span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- 模块 5：长程演进与生命周期管理 -->
                    <div class="pm-section-card pm-mb-8" style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px;">
                        <div style="font-weight: 600; font-size: 12px; color: #0f172a; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
                            <i class="fa-solid fa-boxes-packing" style="color: #0284c7;"></i> 长程演进与休眠生命周期
                        </div>
                        <div class="pm-grid-2col pm-mb-8">
                            <div class="pm-input-row">
                                <label class="pm-input-label">长程宏观自动归并：</label>
                                <select id="pm-adv-auto-consolidate" class="pm-input" style="cursor: pointer;">
                                    <option value="1" ${settings.autoConsolidate !== false ? 'selected' : ''}>启用 (达到阈值后台自动压缩)</option>
                                    <option value="0" ${settings.autoConsolidate === false ? 'selected' : ''}>停用 (仅允许手动触发)</option>
                                </select>
                            </div>
                            <div class="pm-input-row">
                                <label class="pm-input-label">归并触发阈值 (条数):</label>
                                <input type="number" id="pm-adv-consolidate-threshold" class="pm-input" min="5" max="50" value="${settings.consolidateThreshold || 10}">
                            </div>
                        </div>
                        <div class="pm-grid-2col">
                            <div class="pm-input-row">
                                <label class="pm-input-label">闲置记忆自动沉睡：</label>
                                <select id="pm-adv-auto-sleep" class="pm-input" style="cursor: pointer;">
                                    <option value="1" ${settings.autoSleepEnabled !== false ? 'selected' : ''}>启用 (超期未提及自动休眠)</option>
                                    <option value="0" ${settings.autoSleepEnabled === false ? 'selected' : ''}>停用 (始终保持活跃)</option>
                                </select>
                            </div>
                            <div class="pm-input-row">
                                <label class="pm-input-label">沉睡未命中轮数：</label>
                                <input type="number" id="pm-adv-auto-sleep-turns" class="pm-input" min="5" max="100" value="${settings.autoSleepTurns || 20}">
                            </div>
                        </div>
                    </div>

                    <!-- 模块 6：世界书会话内协同 -->
                    <div class="pm-section-card" style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                            <span style="font-weight: 600; font-size: 12px; color: #0f172a; display: flex; align-items: center; gap: 6px;">
                                <i class="fa-solid fa-book-atlas" style="color: #0284c7;"></i> 世界书深度协同与参考
                            </span>
                            <div class="pm-switch">
                                <input type="checkbox" id="pm-adv-worldbook-enabled" ${settings.worldBookIntegrationEnabled !== false ? 'checked' : ''}>
                                <span class="pm-slider"></span>
                            </div>
                        </div>
                        <div id="pm-adv-worldbook-body" style="${settings.worldBookIntegrationEnabled !== false ? 'display: block;' : 'display: none;'}">
                            <div class="pm-grid-2col">
                                <div class="pm-input-row" style="margin-bottom: 0;">
                                    <label class="pm-switch-wrapper">
                                        <span style="font-size: 12px; color: #334155; font-weight: 600;">提炼时参考世界书条目：</span>
                                        <div class="pm-switch" style="margin-left: 8px;">
                                            <input type="checkbox" id="pm-adv-worldbook-context" ${settings.worldBookContextToExtractor !== false ? 'checked' : ''}>
                                            <span class="pm-slider"></span>
                                        </div>
                                    </label>
                                </div>
                                <div class="pm-input-row" style="margin-bottom: 0;">
                                    <label class="pm-input-label">世界书条目加权 (<span id="pm-adv-val-boost">${Number(settings.worldBookBoostScore ?? 0.35).toFixed(2)}</span>):</label>
                                    <input type="range" id="pm-adv-worldbook-boost" min="0.0" max="1.0" step="0.05" value="${settings.worldBookBoostScore ?? 0.35}" style="width: 100%; cursor: pointer;">
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="pm-modal-footer" style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #e2e8f0; padding-top: 12px; margin-top: 4px;">
                    <button type="button" class="pm-btn-secondary" id="pm-adv-restore-btn" style="padding: 6px 12px; font-size: 12px; color: #b45309; border-color: #fde68a; background: #fffbeb;" title="将本面板全部参数重置为官方推荐默认值（保持您的 API 设置）">
                        <i class="fa-solid fa-rotate-left"></i> 恢复推荐默认值
                    </button>
                    <div style="display: flex; gap: 8px;">
                        <button type="button" class="pm-btn-secondary" id="pm-adv-cancel-btn" style="padding: 6px 14px; font-size: 12px;">取消</button>
                        <button type="button" class="pm-btn-primary" id="pm-adv-save-btn" style="padding: 6px 16px; font-size: 12px; background: #059669; border-color: #047857;">
                            <i class="fa-solid fa-check"></i> 保存并应用详细设置
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    const modalEl = document.getElementById('pm-advanced-settings-modal');
    if (!modalEl) return;

    const closeModal = () => {
        modalEl.remove();
        if (typeof options.onClose === 'function') options.onClose();
    };

    modalEl.querySelector('#pm-adv-modal-close')?.addEventListener('click', closeModal);
    modalEl.querySelector('#pm-adv-cancel-btn')?.addEventListener('click', closeModal);

    // 点击背景遮罩关闭
    modalEl.addEventListener('click', (e) => {
        if (e.target === modalEl) closeModal();
    });

    // 滑块联动展示
    modalEl.querySelector('#pm-adv-semantic-threshold')?.addEventListener('input', (e) => {
        const valSpan = modalEl.querySelector('#pm-adv-val-threshold');
        if (valSpan) valSpan.textContent = Number(e.target.value).toFixed(2);
    });

    modalEl.querySelector('#pm-adv-semantic-weight')?.addEventListener('input', (e) => {
        const valSpan = modalEl.querySelector('#pm-adv-val-weight');
        const sem = Math.round(Number(e.target.value) * 100);
        const lex = 100 - sem;
        if (valSpan) valSpan.textContent = `${sem}% 语义 + ${lex}% 词法`;
    });

    modalEl.querySelector('#pm-adv-worldbook-boost')?.addEventListener('input', (e) => {
        const valSpan = modalEl.querySelector('#pm-adv-val-boost');
        if (valSpan) valSpan.textContent = Number(e.target.value).toFixed(2);
    });

    // 语义检索开关与 Provider 联动
    modalEl.querySelector('#pm-adv-semantic-enabled')?.addEventListener('change', (e) => {
        const body = modalEl.querySelector('#pm-adv-semantic-body');
        if (body) body.style.display = e.target.checked ? 'block' : 'none';
    });

    modalEl.querySelector('#pm-adv-embedding-provider')?.addEventListener('change', (e) => {
        const box = modalEl.querySelector('#pm-adv-embedding-api-box');
        if (box) box.style.display = e.target.value === 'custom_api' ? 'block' : 'none';
    });

    // 世界书开关联动
    modalEl.querySelector('#pm-adv-worldbook-enabled')?.addEventListener('change', (e) => {
        const body = modalEl.querySelector('#pm-adv-worldbook-body');
        if (body) body.style.display = e.target.checked ? 'block' : 'none';
    });

    // 测试 Embedding API 连接
    modalEl.querySelector('#pm-adv-test-emb-btn')?.addEventListener('click', async () => {
        const statusEl = modalEl.querySelector('#pm-adv-emb-status');
        const url = modalEl.querySelector('#pm-adv-embedding-url')?.value?.trim() || getSettings().customApiUrl;
        const key = modalEl.querySelector('#pm-adv-embedding-key')?.value?.trim() || getSettings().customApiKey;
        const model = modalEl.querySelector('#pm-adv-embedding-model')?.value?.trim() || 'text-embedding-3-small';

        if (statusEl) {
            statusEl.style.color = '#0284c7';
            statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 测试向量 API 连接中...';
        }

        const res = await testEmbeddingApiConnection({ url, key, model });
        if (statusEl) {
            if (res.ok) {
                statusEl.style.color = '#16a34a';
                statusEl.innerHTML = `<i class="fa-solid fa-check"></i> ${escapeHtml(res.message)}`;
            } else {
                statusEl.style.color = '#dc2626';
                statusEl.innerHTML = `<i class="fa-solid fa-xmark"></i> ${escapeHtml(res.message)}`;
            }
        }
    });

    // 继承提炼 API
    modalEl.querySelector('#pm-adv-inherit-emb-btn')?.addEventListener('click', () => {
        const cur = getSettings();
        const urlInput = modalEl.querySelector('#pm-adv-embedding-url');
        const keyInput = modalEl.querySelector('#pm-adv-embedding-key');
        if (urlInput) urlInput.value = cur.customApiUrl || '';
        if (keyInput) keyInput.value = cur.customApiKey || '';
        window.toastr?.info?.('已同步提炼 API Base URL 与密钥至向量配置', '持续记忆');
    });

    // 重新索引全库向量
    modalEl.querySelector('#pm-adv-reindex-btn')?.addEventListener('click', () => {
        const count = reindexAllMemories();
        window.toastr?.success?.(`已标记 ${count} 条记忆待重新计算密集向量`, '持续记忆');
    });

    // 一键恢复推荐默认值
    modalEl.querySelector('#pm-adv-restore-btn')?.addEventListener('click', () => {
        const setVal = (sel, val) => {
            const el = modalEl.querySelector(sel);
            if (el) el.value = val;
        };
        const setChecked = (sel, val) => {
            const el = modalEl.querySelector(sel);
            if (el) el.checked = Boolean(val);
        };

        const modeRadios = modalEl.querySelectorAll('input[name="pm-adv-mode"]');
        modeRadios.forEach(r => { r.checked = (r.value === DEFAULT_SETTINGS.mode); });

        setVal('#pm-adv-freq', DEFAULT_SETTINGS.asyncFrequency);
        setVal('#pm-adv-slice', DEFAULT_SETTINGS.digestSliceCount);
        setVal('#pm-adv-adaptive-cadence', DEFAULT_SETTINGS.adaptiveCadenceEnabled ? '1' : '0');
        setVal('#pm-adv-adaptive-min-chars', DEFAULT_SETTINGS.adaptiveCadenceMinChars);

        setVal('#pm-adv-scene-tokens', DEFAULT_SETTINGS.maxSceneTokens);
        setVal('#pm-adv-tokens', DEFAULT_SETTINGS.maxTotalMemoryTokens);
        setVal('#pm-adv-max-pinned', DEFAULT_SETTINGS.maxPinnedCount);
        setVal('#pm-adv-max-triggered', DEFAULT_SETTINGS.maxTriggeredCount);

        setVal('#pm-adv-inject-pos', String(DEFAULT_SETTINGS.injectionPosition));
        setVal('#pm-adv-inject-depth', DEFAULT_SETTINGS.injectionDepth);
        setVal('#pm-adv-inject-template', DEFAULT_SETTINGS.injectionTemplate);

        setChecked('#pm-adv-semantic-enabled', DEFAULT_SETTINGS.semanticRetrievalEnabled);
        setVal('#pm-adv-embedding-provider', DEFAULT_SETTINGS.embeddingProvider);
        setVal('#pm-adv-semantic-threshold', DEFAULT_SETTINGS.semanticThreshold);
        setVal('#pm-adv-semantic-weight', DEFAULT_SETTINGS.semanticWeight);

        setVal('#pm-adv-auto-consolidate', DEFAULT_SETTINGS.autoConsolidate ? '1' : '0');
        setVal('#pm-adv-consolidate-threshold', DEFAULT_SETTINGS.consolidateThreshold);
        setVal('#pm-adv-auto-sleep', DEFAULT_SETTINGS.autoSleepEnabled ? '1' : '0');
        setVal('#pm-adv-auto-sleep-turns', DEFAULT_SETTINGS.autoSleepTurns);

        setChecked('#pm-adv-worldbook-enabled', DEFAULT_SETTINGS.worldBookIntegrationEnabled);
        setChecked('#pm-adv-worldbook-context', DEFAULT_SETTINGS.worldBookContextToExtractor);
        setVal('#pm-adv-worldbook-boost', DEFAULT_SETTINGS.worldBookBoostScore);

        const thSpan = modalEl.querySelector('#pm-adv-val-threshold');
        if (thSpan) thSpan.textContent = Number(DEFAULT_SETTINGS.semanticThreshold).toFixed(2);
        const wSpan = modalEl.querySelector('#pm-adv-val-weight');
        if (wSpan) wSpan.textContent = `${Math.round(DEFAULT_SETTINGS.semanticWeight * 100)}% 语义 + ${Math.round((1 - DEFAULT_SETTINGS.semanticWeight) * 100)}% 词法`;
        const bSpan = modalEl.querySelector('#pm-adv-val-boost');
        if (bSpan) bSpan.textContent = Number(DEFAULT_SETTINGS.worldBookBoostScore).toFixed(2);

        window.toastr?.info?.('已填入官方推荐最佳实践参数，点击【保存并应用】即可生效。', '持续记忆');
    });

    // 保存并应用详细设置
    modalEl.querySelector('#pm-adv-save-btn')?.addEventListener('click', () => {
        const mode = modalEl.querySelector('input[name="pm-adv-mode"]:checked')?.value || 'async';
        const asyncFrequency = Math.max(1, parseInt(modalEl.querySelector('#pm-adv-freq')?.value) || 3);
        const digestSliceCount = Math.max(2, Math.min(15, parseInt(modalEl.querySelector('#pm-adv-slice')?.value) || 6));
        const adaptiveCadenceEnabled = (modalEl.querySelector('#pm-adv-adaptive-cadence')?.value ?? '1') === '1';
        const adaptiveCadenceMinChars = Math.max(20, Math.min(500, parseInt(modalEl.querySelector('#pm-adv-adaptive-min-chars')?.value) || 60));

        const maxSceneTokens = Math.max(50, Math.min(800, parseInt(modalEl.querySelector('#pm-adv-scene-tokens')?.value) || 150));
        const maxTotalMemoryTokens = Math.max(150, Math.min(2500, parseInt(modalEl.querySelector('#pm-adv-tokens')?.value) || 450));
        const maxPinnedCount = Math.max(1, Math.min(15, parseInt(modalEl.querySelector('#pm-adv-max-pinned')?.value) || 5));
        const maxTriggeredCount = Math.max(1, Math.min(30, parseInt(modalEl.querySelector('#pm-adv-max-triggered')?.value) || 5));

        const rawPos = parseInt(modalEl.querySelector('#pm-adv-inject-pos')?.value);
        const injectionPosition = !isNaN(rawPos) ? rawPos : 1;
        const rawDep = parseInt(modalEl.querySelector('#pm-adv-inject-depth')?.value);
        const injectionDepth = !isNaN(rawDep) ? Math.max(0, Math.min(20, rawDep)) : 2;
        const injectionTemplate = modalEl.querySelector('#pm-adv-inject-template')?.value || 'standard';

        const semanticRetrievalEnabled = modalEl.querySelector('#pm-adv-semantic-enabled')?.checked ?? true;
        const embeddingProvider = modalEl.querySelector('#pm-adv-embedding-provider')?.value || 'local';
        const rawSemThresh = parseFloat(modalEl.querySelector('#pm-adv-semantic-threshold')?.value);
        const semanticThreshold = !isNaN(rawSemThresh) ? rawSemThresh : 0.25;
        const rawSemWeight = parseFloat(modalEl.querySelector('#pm-adv-semantic-weight')?.value);
        const semanticWeight = !isNaN(rawSemWeight) ? rawSemWeight : 0.60;
        const embeddingApiUrl = modalEl.querySelector('#pm-adv-embedding-url')?.value?.trim() || '';
        const embeddingApiKey = modalEl.querySelector('#pm-adv-embedding-key')?.value?.trim() || '';
        const embeddingModel = modalEl.querySelector('#pm-adv-embedding-model')?.value?.trim() || 'text-embedding-3-small';

        const autoConsolidate = (modalEl.querySelector('#pm-adv-auto-consolidate')?.value ?? '1') === '1';
        const rawConsolidateThreshold = parseInt(modalEl.querySelector('#pm-adv-consolidate-threshold')?.value);
        const consolidateThreshold = !isNaN(rawConsolidateThreshold) ? Math.max(5, Math.min(50, rawConsolidateThreshold)) : 10;
        const autoSleepEnabled = (modalEl.querySelector('#pm-adv-auto-sleep')?.value ?? '1') === '1';
        const rawSleepTurns = parseInt(modalEl.querySelector('#pm-adv-auto-sleep-turns')?.value);
        const autoSleepTurns = !isNaN(rawSleepTurns) ? Math.max(5, Math.min(100, rawSleepTurns)) : 20;

        const worldBookIntegrationEnabled = modalEl.querySelector('#pm-adv-worldbook-enabled')?.checked ?? true;
        const worldBookContextToExtractor = modalEl.querySelector('#pm-adv-worldbook-context')?.checked ?? true;
        const rawWbBoost = parseFloat(modalEl.querySelector('#pm-adv-worldbook-boost')?.value);
        const worldBookBoostScore = !isNaN(rawWbBoost) ? rawWbBoost : 0.35;

        updateSettings({
            mode,
            asyncFrequency,
            digestSliceCount,
            adaptiveCadenceEnabled,
            adaptiveCadenceMinChars,
            maxSceneTokens,
            maxTotalMemoryTokens,
            maxPinnedCount,
            maxTriggeredCount,
            injectionPosition,
            injectionDepth,
            injectionTemplate,
            semanticRetrievalEnabled,
            embeddingProvider,
            semanticThreshold,
            semanticWeight,
            embeddingApiUrl,
            embeddingApiKey,
            embeddingModel,
            autoConsolidate,
            consolidateThreshold,
            autoSleepEnabled,
            autoSleepTurns,
            worldBookIntegrationEnabled,
            worldBookContextToExtractor,
            worldBookBoostScore
        });

        const ok = saveSettingsImmediately();
        closeModal();

        if (typeof options.onSave === 'function') {
            options.onSave();
        }

        if (ok) {
            window.toastr?.success?.('详细高级参数已保存并立即生效！', '持续记忆');
        } else {
            window.toastr?.error?.('保存配置失败，请检查浏览器控制台', '持续记忆');
        }
    });
}
