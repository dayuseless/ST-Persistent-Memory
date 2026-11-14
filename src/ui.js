/**
 * UI 管理器 (v0.1.43)：原生扩展抽屉集成、屏幕快捷悬浮按钮（支持自由拖拽与持久化）与 HUD 侧边控制台
 * 全面升级：傻瓜式与详细式双模式架构（默认傻瓜全托管，详细参数弹窗微调）、UI组件化解耦、统一ACL判定层介入、行内即时编辑、记忆数据独立导出/导入迁移、世界书升格安全确认
 */

import { MODULE_NAME, MEMORY_STATUS, MEMORY_LIFECYCLE, MEMORY_SCOPE } from './config.js';
import { getState, getSettings, updateSettings, saveSettingsImmediately, updateScene, addMemory, updateMemory, deleteMemory, purgeArchivedMemories, cycleMemoryStatus, cycleMemoryType, exportMemoryData, importMemoryData, reindexAllMemories, onStateChange, getActiveWorldBookInfo, syncMemoryDeltaToWorldInfo, promoteMemoryToWorldInfo, batchUpdate, rollbackScene, restoreSceneSnapshot, getSceneHistory, getContextParticipants, getMemoryLineage } from './state.js';
import { triggerAsyncDigest, triggerMemoryConsolidation, testCustomApiConnection, triggerBacklogDigest, abortBacklogDigest, isBacklogDigestRunning } from './extractor.js';
import { testEmbeddingApiConnection } from './semantic.js';

import { API_PRESETS, GAMEPLAY_PRESETS, applyApiPreset, applyGameplayPreset, getContext, escapeHtml, estimateTokens, restoreRecommendedDefaults } from './ui/common.js';
import { renderMemoryCard } from './ui/cards.js';
import { showSyncLoreModal, showPromoteLoreModal, showAdvancedSettingsModal, showInjectionInspectorModal, showMemoryLineageModal, showHistoricalSliceModal } from './ui/modal.js';
import { getLastInjectionSnapshot } from './injector.js';
import { createFloatingButton, resetBubblePosition, setBubbleState, getBubbleState } from './ui/bubble.js';
import { createNativeExtensionDrawer, registerExtensionsMenuEntry, renderNativeDrawerContent, importSillyTavernApiConfig } from './ui/drawer.js';
import {
    registerSlashCommands,
    executeRememberCommand,
    executeSceneCommand,
    executeInspectCommand,
    executeDigestCommand,
    executeForgetCommand,
    executePresetCommand,
    parseCommandArgs,
    SLASH_COMMAND_DEFINITIONS
} from './commands.js';

let panelEl = null;
let currentTab = 'memories'; // 'memories' | 'scene' | 'settings'
let memoryFilter = 'active'; // 'active' | 'archived' | 'all'
let lorebookFilter = '';    // '' (全部) | '__unlinked__' (未关联) | '<entry_name>'
let memorySearchQuery = ''; // 实时搜索过滤关键字
let selectedMemoryIds = new Set(); // 批量操作选中的记忆 ID 集合
let isSceneHistoryOpen = false; // 现场快照时光机历史面板展开状态

/**
 * 初始化 UI 并绑定事件
 */
function initUI() {
    createPanelDOM();
    createFloatingButton(() => togglePanel());
    createNativeExtensionDrawer((show) => togglePanel(show), () => renderPanelContent());
    registerExtensionsMenuEntry((show) => togglePanel(show));

    // 针对酒馆模板异步延迟生成，进行多轮对齐挂载
    setTimeout(() => {
        createNativeExtensionDrawer((show) => togglePanel(show), () => renderPanelContent());
        registerExtensionsMenuEntry((show) => togglePanel(show));
    }, 500);
    setTimeout(() => {
        createNativeExtensionDrawer((show) => togglePanel(show), () => renderPanelContent());
        registerExtensionsMenuEntry((show) => togglePanel(show));
    }, 2000);

    onStateChange(() => {
        renderPanelContent();
        renderNativeDrawerContent((show) => togglePanel(show), () => renderPanelContent());
    });
}

/**
 * 创建主抽屉 HUD 控制台 DOM (带导航 Tab)
 */
function createPanelDOM() {
    if (document.getElementById('pm-drawer-panel')) {
        panelEl = document.getElementById('pm-drawer-panel');
        return;
    }

    panelEl = document.createElement('div');
    panelEl.id = 'pm-drawer-panel';
    panelEl.className = 'pm-panel-container';
    panelEl.innerHTML = `
        <div class="pm-panel-header">
            <div class="pm-title-group">
                <i class="fa-solid fa-brain pm-title-icon"></i>
                <span class="pm-title-text">持续记忆控制台</span>
                <div class="pm-header-stats" id="pm-header-badges">
                    <!-- 动态状态徽标 -->
                </div>
            </div>
            <div class="pm-header-actions">
                <button id="pm-open-inspector-btn" class="pm-btn-icon" title="即时注入透视镜 (查看当前轮次实际注入给 AI 的完整提示词与记忆得分)"><i class="fa-solid fa-eye"></i></button>
                <button id="pm-manual-digest-btn" class="pm-btn-icon" title="立即触发后台提炼"><i class="fa-solid fa-bolt"></i></button>
                <button id="pm-close-btn" class="pm-btn-icon" title="关闭"><i class="fa-solid fa-xmark"></i></button>
            </div>
        </div>
        <div class="pm-tab-bar" id="pm-tab-bar">
            <button class="pm-tab-btn ${currentTab === 'memories' ? 'pm-active' : ''}" data-tab="memories">
                <i class="fa-solid fa-layer-group"></i> 记忆流
            </button>
            <button class="pm-tab-btn ${currentTab === 'scene' ? 'pm-active' : ''}" data-tab="scene">
                <i class="fa-solid fa-compass"></i> 现场快照
            </button>
            <button class="pm-tab-btn ${currentTab === 'settings' ? 'pm-active' : ''}" data-tab="settings">
                <i class="fa-solid fa-sliders"></i> 设置与 API
            </button>
        </div>
        <div class="pm-panel-body" id="pm-panel-body">
            <!-- 动态渲染 Tab 视图 -->
        </div>
    `;

    document.body.appendChild(panelEl);

    // 绑定 Tab 切换事件
    panelEl.querySelector('#pm-tab-bar')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.pm-tab-btn');
        if (!btn) return;
        const tab = btn.getAttribute('data-tab');
        if (tab && tab !== currentTab) {
            currentTab = tab;
            panelEl.querySelectorAll('.pm-tab-btn').forEach(b => {
                b.classList.toggle('pm-active', b.getAttribute('data-tab') === currentTab);
            });
            renderPanelContent();
        }
    });

    panelEl.querySelector('#pm-close-btn')?.addEventListener('click', () => togglePanel(false));
    panelEl.querySelector('#pm-manual-digest-btn')?.addEventListener('click', async () => {
        const btn = panelEl.querySelector('#pm-manual-digest-btn');
        btn.classList.add('pm-spinning');
        window.toastr?.info?.('后台提炼任务已启动...', '持续记忆');
        try {
            const res = await triggerAsyncDigest(true);
            renderPanelContent();
            renderNativeDrawerContent();
            if (res?.success) {
                window.toastr?.success?.(res.summary || '提炼完成', '持续记忆');
            } else {
                window.toastr?.warning?.(res?.error || '提炼未产生有效更新', '持续记忆');
            }
        } finally {
            btn.classList.remove('pm-spinning');
        }
    });
}

/**
 * 切换主抽屉面板显隐
 */
function togglePanel(show) {
    if (!panelEl) return;
    const shouldShow = show !== undefined ? show : !panelEl.classList.contains('pm-show');
    if (shouldShow) {
        panelEl.classList.add('pm-show');
        renderPanelContent();
    } else {
        panelEl.classList.remove('pm-show');
    }
}

/**
 * 渲染主抽屉面板内部组件
 */
function renderPanelContent() {
    const body = document.getElementById('pm-panel-body');
    if (!body) return;

    try {
        const c = getContext();
        const state = getState();
        const settings = getSettings();
        const scene = state.scene || {};
        const memories = state.memories || [];

    // 更新顶部 Header 状态胶囊
    const badgesEl = document.getElementById('pm-header-badges');
    if (badgesEl) {
        badgesEl.innerHTML = `
            <span class="pm-hero-pill">rev.<b>${state.state_revision || 0}</b></span>
            <span class="pm-hero-pill"><b>${memories.length}</b> 条</span>
        `;
    }

    const isTerminal = m => m.lifecycle && m.lifecycle !== MEMORY_LIFECYCLE.ACTIVE;
    const isDormant = m => m.status === MEMORY_STATUS.ARCHIVED && (!m.lifecycle || m.lifecycle === MEMORY_LIFECYCLE.ACTIVE);
    const isTerminalOrArchived = m => m.status === MEMORY_STATUS.ARCHIVED || isTerminal(m);

    const activeCount = memories.filter(m => !isTerminalOrArchived(m)).length;
    const dormantCount = memories.filter(isDormant).length;
    const terminalCount = memories.filter(isTerminal).length;
    const archivedOrTerminalCount = memories.filter(isTerminalOrArchived).length;
    const pinnedCount = memories.filter(m => m.status === MEMORY_STATUS.PINNED).length;
    const triggeredCount = memories.filter(m => m.status === MEMORY_STATUS.TRIGGERED && m.lifecycle === MEMORY_LIFECYCLE.ACTIVE).length;

    // 统计世界书条目分布
    const uniqueLorebookEntries = Array.from(new Set(
        memories
            .filter(m => m.lorebook_ref && m.lorebook_ref.entry_name)
            .map(m => m.lorebook_ref.entry_name.trim())
    )).filter(Boolean).sort();
    const unlinkedCount = memories.filter(m => !m.lorebook_ref || !m.lorebook_ref.entry_name).length;

    // 根据当前筛选状态选择要渲染的卡片列表 (结合生命周期、世界书关联与实时搜索)
    const filteredMemories = memories.filter(m => {
        if (memoryFilter === 'active' && isTerminalOrArchived(m)) return false;
        if (memoryFilter === 'dormant' && !isDormant(m)) return false;
        if (memoryFilter === 'archived' && !isTerminal(m)) return false;

        if (lorebookFilter === '__unlinked__') {
            if (m.lorebook_ref && m.lorebook_ref.entry_name) return false;
        } else if (lorebookFilter) {
            if (!m.lorebook_ref || m.lorebook_ref.entry_name !== lorebookFilter) return false;
        }

        if (memorySearchQuery) {
            const kw = memorySearchQuery.toLowerCase();
            const matchContent = m.content && m.content.toLowerCase().includes(kw);
            const matchChar = m.character && m.character.toLowerCase().includes(kw);
            const matchKeys = Array.isArray(m.trigger_keys) && m.trigger_keys.some(k => k.toLowerCase().includes(kw));
            const matchLb = m.lorebook_ref && m.lorebook_ref.entry_name && m.lorebook_ref.entry_name.toLowerCase().includes(kw);
            if (!matchContent && !matchChar && !matchKeys && !matchLb) return false;
        }

        return true;
    });

    // 粗估活跃记忆的 Token 占用
    let activeTokenEstimate = 0;
    memories.filter(m => !isTerminalOrArchived(m)).forEach(m => {
        activeTokenEstimate += estimateTokens(m.content) + 12;
    });

    let tabHtml = '';

    // ─────────────────────────────────────────────────────────────────────────
    // TAB 1: 记忆流 (Memories)
    // ─────────────────────────────────────────────────────────────────────────
    if (currentTab === 'memories') {
        const currentFloor = Array.isArray(c?.chat) ? c.chat.length : (state.last_floor || 0);
        const isAllSelected = filteredMemories.length > 0 && filteredMemories.every(m => selectedMemoryIds.has(m.id));
        const memCardsHtml = filteredMemories.length > 0
            ? filteredMemories.map(m => renderMemoryCard(m, selectedMemoryIds, currentFloor)).join('')
            : `<div class="pm-empty-hint"><i class="fa-solid fa-box-open" style="font-size: 24px; margin-bottom: 6px; display: block; opacity: 0.5;"></i>${memorySearchQuery ? `未找到包含 “${escapeHtml(memorySearchQuery)}” 的相关记忆` : (lorebookFilter ? `设定【${escapeHtml(lorebookFilter === '__unlinked__' ? '未关联' : lorebookFilter)}】下暂无匹配记忆` : (memoryFilter === 'dormant' ? '暂无沉睡休眠中的记忆' : (memoryFilter === 'archived' ? '暂无结项或历史归档记忆' : (memoryFilter === 'active' ? '暂无活跃记忆' : '记忆库暂无条目'))))}</div>`;

        tabHtml = `
            <!-- 统计数据横幅 (大号清晰数字) -->
            <div class="pm-stats-banner">
                <div class="pm-stat-box">
                    <span class="pm-stat-label"><i class="fa-solid fa-thumbtack"></i> 常驻记忆</span>
                    <span class="pm-stat-value pm-text-amber">${pinnedCount} <span style="font-size: 11px; font-weight: 500; color: #64748b;">/ ${settings.maxPinnedCount || 5}</span></span>
                </div>
                <div class="pm-stat-box">
                    <span class="pm-stat-label"><i class="fa-solid fa-bolt"></i> 动态触发</span>
                    <span class="pm-stat-value pm-text-emerald">${triggeredCount} <span style="font-size: 11px; font-weight: 500; color: #64748b;">/ ${settings.maxTriggeredCount || 5}</span></span>
                </div>
                <div class="pm-stat-box" id="pm-stat-token-inspect" style="cursor: pointer;" title="点击打开即时注入透视镜 (查看完整 Prompt 与各条记忆得分细则)">
                    <span class="pm-stat-label"><i class="fa-solid fa-gauge-high"></i> 估算占用 (点击透视)</span>
                    <span class="pm-stat-value pm-text-sky">~${activeTokenEstimate} <span style="font-size: 11px; font-weight: 500; color: #64748b;">/ ${settings.maxTotalMemoryTokens || 450}T</span></span>
                </div>
            </div>

            <!-- P0 实时搜索框与批量管理条 -->
            <div class="pm-search-wrap pm-mb-8">
                <div class="pm-search-box">
                    <i class="fa-solid fa-magnifying-glass pm-search-icon"></i>
                    <input type="text" id="pm-mem-search-input" class="pm-search-input" placeholder="实时搜索记忆内容、触发词、关联角色..." value="${escapeHtml(memorySearchQuery)}">
                    ${memorySearchQuery ? '<button id="pm-mem-search-clear" class="pm-search-clear-btn" title="清空搜索"><i class="fa-solid fa-xmark"></i></button>' : ''}
                </div>
            </div>

            ${selectedMemoryIds.size > 0 ? `
            <div class="pm-bulk-bar pm-mb-8">
                <span class="pm-bulk-badge"><i class="fa-solid fa-check-double"></i> 已选 <b>${selectedMemoryIds.size}</b> 项</span>
                <div class="pm-bulk-actions">
                    <button id="pm-bulk-pin" class="pm-bulk-btn" title="批量设为常驻"><i class="fa-solid fa-thumbtack pm-text-amber"></i> 常驻</button>
                    <button id="pm-bulk-trigger" class="pm-bulk-btn" title="批量设为条件激活"><i class="fa-solid fa-bolt pm-text-emerald"></i> 激活</button>
                    <button id="pm-bulk-archive" class="pm-bulk-btn" title="批量设为沉睡休眠"><i class="fa-solid fa-moon" style="color: #6366f1;"></i> 休眠</button>
                    <button id="pm-bulk-complete" class="pm-bulk-btn" title="批量标记为已履约/办结"><i class="fa-solid fa-check" style="color: #059669;"></i> 办结</button>
                    <button id="pm-bulk-refute" class="pm-bulk-btn" title="批量标记为已证伪"><i class="fa-solid fa-xmark" style="color: #dc2626;"></i> 证伪</button>
                    <button id="pm-bulk-delete" class="pm-bulk-btn pm-bulk-del" title="批量彻底删除"><i class="fa-solid fa-trash-can"></i> 删除</button>
                    <button id="pm-bulk-cancel" class="pm-bulk-btn" title="取消选择"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>` : ''}

            ${state.last_sync_error ? `
            <div style="background: rgba(239, 68, 68, 0.08); border-left: 3px solid #ef4444; padding: 6px 10px; border-radius: 4px; margin-bottom: 8px; font-size: 11px;">
                <span style="color: #dc2626; font-weight: 600;"><i class="fa-solid fa-triangle-exclamation"></i> 伴生标签解析未通过 (${escapeHtml(state.last_sync_error.time)}):</span>
                <span style="color: #64748b;"> ${escapeHtml(state.last_sync_error.error)}</span>
                <div style="font-family: monospace; font-size: 10px; opacity: 0.75; margin-top: 2px; word-break: break-all;">${escapeHtml(state.last_sync_error.rawSnippet || '')}</div>
            </div>` : ''}
            ${state.last_digest_error ? `
            <div style="background: rgba(245, 158, 11, 0.08); border-left: 3px solid #f59e0b; padding: 6px 10px; border-radius: 4px; margin-bottom: 8px; font-size: 11px;">
                <span style="color: #d97706; font-weight: 600;"><i class="fa-solid fa-circle-exclamation"></i> 提炼请求异常:</span>
                <span style="color: #64748b;"> ${escapeHtml(state.last_digest_error)}</span>
            </div>` : ''}

            ${isBacklogDigestRunning() ? `
            <!-- 全量回溯提炼进度指示器 -->
            <div id="pm-backlog-progress-wrap" style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; padding: 8px 10px; margin-bottom: 8px;">
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; margin-bottom: 4px;">
                    <span id="pm-backlog-prog-text" style="color: #16a34a; font-weight: 600;"><i class="fa-solid fa-spinner fa-spin"></i> 正在全量回溯提炼历史记忆...</span>
                    <button id="pm-btn-cancel-backlog" style="background: none; border: 1px solid #fca5a5; color: #dc2626; border-radius: 4px; padding: 1px 6px; font-size: 10px; cursor: pointer;">中止</button>
                </div>
                <div style="width: 100%; height: 6px; background: #dcfce7; border-radius: 3px; overflow: hidden;">
                    <div id="pm-backlog-prog-bar" style="width: 0%; height: 100%; background: #16a34a; transition: width 0.3s ease;"></div>
                </div>
            </div>` : ''}

            ${(!isBacklogDigestRunning() && Array.isArray(c?.chat) && c.chat.length >= 6 && (!memories || memories.length === 0)) ? `
            <!-- 中途启用用户智能引导条 -->
            <div class="pm-onboarding-card" style="background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%); border: 1px solid #bae6fd; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px;">
                <div style="font-weight: 700; color: #0369a1; font-size: 12px; display: flex; align-items: center; gap: 6px;">
                    <i class="fa-solid fa-sparkles" style="color: #0284c7;"></i> 检测到长程历史会话 (${c.chat.length} 条消息)
                </div>
                <div style="font-size: 11px; color: #475569; margin-top: 4px; line-height: 1.4;">
                    检测到当前会话尚未沉淀任何记忆。点击可一键从头分批回溯提炼，自动沉淀全量历史事实并建立精准的现场快照。
                </div>
                <div style="margin-top: 8px;">
                    <button id="pm-btn-digest-all-start" class="pm-btn-primary" style="padding: 4px 12px; font-size: 11px; background: #0284c7; border-color: #0369a1; width: auto; cursor: pointer;">
                        <i class="fa-solid fa-play"></i> 从头全量提炼 (${c.chat.length} 条)
                    </button>
                </div>
            </div>` : ''}

            <!-- 记忆列表 -->
            <div class="pm-section-card" style="flex: 1; display: flex; flex-direction: column;">
                <div class="pm-section-header" style="flex-wrap: wrap; gap: 8px; justify-content: space-between;">
                    <div style="display: flex; gap: 4px; align-items: center; flex-wrap: wrap;">
                        <label class="pm-select-all-label" title="全选/反选当前筛选出的记忆">
                            <input type="checkbox" id="pm-select-all-cb" ${isAllSelected ? 'checked' : ''}>
                            <span style="font-size: 11px; margin-left: 2px;">全选</span>
                        </label>
                        <button class="pm-filter-pill ${memoryFilter === 'active' ? 'pm-filter-active' : ''}" data-action="filter-mem" data-filter="active" title="常规活跃参与提示词注入的记忆">
                            活跃 (${activeCount})
                        </button>
                        <button class="pm-filter-pill ${memoryFilter === 'dormant' ? 'pm-filter-active' : ''}" data-action="filter-mem" data-filter="dormant" title="超期未提及自动沉睡、等待剧情触发唤醒的记忆">
                            <i class="fa-solid fa-moon" style="color: #6366f1;"></i> 沉睡 (${dormantCount})
                        </button>
                        <button class="pm-filter-pill ${memoryFilter === 'archived' ? 'pm-filter-active' : ''}" data-action="filter-mem" data-filter="archived" title="已结项/履约/证伪的历史记忆">
                            <i class="fa-solid fa-box-archive"></i> 结项 (${terminalCount})
                        </button>
                        <button class="pm-filter-pill ${memoryFilter === 'all' ? 'pm-filter-active' : ''}" data-action="filter-mem" data-filter="all">
                            全部 (${memories.length})
                        </button>
                        ${uniqueLorebookEntries.length > 0 ? `
                        <div style="display: inline-flex; align-items: center; margin-left: 4px;">
                            <select id="pm-filter-lorebook" class="pm-lore-filter-select" title="按关联世界书条目筛选">
                                <option value="" ${!lorebookFilter ? 'selected' : ''}>📖 全部设定 (${memories.length})</option>
                                <option value="__unlinked__" ${lorebookFilter === '__unlinked__' ? 'selected' : ''}>📄 未关联设定 (${unlinkedCount})</option>
                                ${uniqueLorebookEntries.map(name => {
                                    const count = memories.filter(m => m.lorebook_ref && m.lorebook_ref.entry_name === name).length;
                                    return `<option value="${escapeHtml(name)}" ${lorebookFilter === name ? 'selected' : ''}>📖 ${escapeHtml(name)} (${count})</option>`;
                                }).join('')}
                            </select>
                        </div>` : ''}
                    </div>
                    <div style="display: flex; gap: 6px; align-items: center;">
                        <button id="pm-btn-digest-backlog" class="pm-btn-secondary" style="padding: 3px 8px; font-size: 11px;" title="分批递进提炼历史未消化的上下文对话 (适应中途启用的用户)">
                            <i class="fa-solid fa-clock-rotate-left" style="color: #0284c7;"></i> 回溯提炼
                        </button>
                        <button id="pm-consolidate-now-btn" class="pm-btn-secondary" style="padding: 3px 8px; font-size: 11px;" title="智能将多条历史细节记忆浓缩为宏观长期事实">
                            <i class="fa-solid fa-compress" style="color: #2563eb;"></i> 宏观归并
                        </button>
                        ${archivedOrTerminalCount > 0 ? `
                        <button id="pm-purge-archived-btn" class="pm-btn-secondary" style="padding: 3px 8px; font-size: 11px; color: #dc2626;" title="永久清理已结项或迭代的废弃记忆">
                            <i class="fa-solid fa-trash-can"></i> 清理终态
                        </button>` : ''}
                    </div>
                </div>
                <div class="pm-mem-list" id="pm-mem-list-container">
                    ${memCardsHtml}
                </div>
            </div>

            <!-- 快捷添加面板 -->
            <div class="pm-quick-box">
                <div class="pm-section-title pm-mb-8">
                    <i class="fa-solid fa-plus"></i> 手动新增记忆条目
                </div>
                <div class="pm-input-row">
                    <input type="text" id="pm-new-mem-content" class="pm-input" placeholder="输入一句话记忆 (例如: 两人曾约定明晚在白马寺汇合)">
                </div>
                <div class="pm-grid-2col pm-mb-8">
                    <div class="pm-input-row" style="margin-bottom: 0;">
                        <label class="pm-input-label">记忆类型 (Type):</label>
                        <select id="pm-new-mem-type" class="pm-input" style="cursor: pointer;">
                            <option value="fact" selected>📌 客观事实 (fact)</option>
                            <option value="statement">💬 言行约定 (statement)</option>
                            <option value="inference">🧠 主观推断 (inference)</option>
                            <option value="todo">📝 即时待办 (todo)</option>
                        </select>
                    </div>
                    <div class="pm-input-row" style="margin-bottom: 0;">
                        <label class="pm-input-label">知情范围 (Scope):</label>
                        <select id="pm-new-mem-scope" class="pm-input" style="cursor: pointer;">
                            <option value="world" selected>🌐 世界事实 (公共常识)</option>
                            <option value="shared">👥 共同经历 (在场者共知)</option>
                            <option value="character">👤 角色私密 (专属知晓)</option>
                        </select>
                    </div>
                </div>
                <div class="pm-grid-2col pm-mb-8">
                    <div class="pm-input-row" style="margin-bottom: 0;">
                        <label class="pm-input-label">触发关键词 (逗号隔开):</label>
                        <input type="text" id="pm-new-mem-keys" class="pm-input" placeholder="例如: 白马寺, 汇合">
                    </div>
                    <div class="pm-input-row" id="pm-target-row" style="margin-bottom: 0;">
                        <label class="pm-input-label">关联/知情角色 (留空自动匹配):</label>
                        <input type="text" id="pm-new-mem-target" class="pm-input" placeholder="例如: 武大郎, 潘金莲">
                    </div>
                </div>
                <div class="pm-input-row pm-mb-8">
                    <label class="pm-input-label"><i class="fa-solid fa-book-atlas"></i> 关联世界书条目 (可选):</label>
                    <input type="text" id="pm-new-mem-lorebook" class="pm-input" placeholder="例如: 断钢圣剑 或 精灵之森 (填条目名称)">
                </div>
                <button id="pm-add-mem-btn" class="pm-btn-primary">
                    <i class="fa-solid fa-plus"></i> 录入到记忆库
                </button>
            </div>
        `;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TAB 2: 现场快照 (Scene State L0)
    // ─────────────────────────────────────────────────────────────────────────
    else if (currentTab === 'scene') {
        const rawChars = Array.isArray(scene.in_scene_characters)
            ? (scene.in_scene_characters.length === 0 ? '无' : scene.in_scene_characters.join(', '))
            : (scene.in_scene_characters === null ? '自动' : '');

        const sceneHistory = getSceneHistory();
        const hasHistory = sceneHistory.length > 0;

        let historyHtml = '';
        if (isSceneHistoryOpen) {
            if (sceneHistory.length === 0) {
                historyHtml = `
                    <div class="pm-scene-history-panel" style="text-align: center; color: #94a3b8; font-size: 11px; padding: 12px;">
                        <i class="fa-solid fa-clock-rotate-left"></i> 暂无快照变更记录
                    </div>
                `;
            } else {
                historyHtml = `
                    <div class="pm-scene-history-panel">
                        <div style="font-size: 11px; font-weight: 600; color: #475569; margin-bottom: 6px; display: flex; justify-content: space-between;">
                            <span><i class="fa-solid fa-timeline"></i> 快照历史版本 (最近 ${sceneHistory.length} 次)</span>
                            <span style="font-size: 10px; color: #94a3b8;">点击即可秒级回滚</span>
                        </div>
                        ${sceneHistory.map((item, idx) => {
                            const sc = item.scene || {};
                            const timeStr = item.timestamp ? new Date(item.timestamp).toLocaleTimeString() : '';
                            const desc = [
                                sc.location ? `📍${sc.location}` : '',
                                sc.action ? `🏃${sc.action.slice(0, 30)}${sc.action.length > 30 ? '...' : ''}` : ''
                            ].filter(Boolean).join(' | ') || '无细节描述';
                            return `
                                <div class="pm-history-item">
                                    <div style="flex: 1; min-width: 0;">
                                        <div class="pm-history-meta">
                                            <span style="font-weight: 600; color: #2563eb;">#${idx + 1} [第${item.floor || 0}轮]</span>
                                            <span>${timeStr}</span>
                                            <span style="background: #e2e8f0; padding: 1px 4px; border-radius: 3px;">${escapeHtml(item.reason || '更新')}</span>
                                        </div>
                                        <div class="pm-history-desc">${escapeHtml(desc)}</div>
                                    </div>
                                    <div style="display: flex; gap: 4px; align-items: center;">
                                        <button class="pm-history-slice-btn" data-history-idx="${idx}" title="查看当时现场切片与生效记忆">
                                            <i class="fa-solid fa-layer-group"></i> 切片
                                        </button>
                                        <button class="pm-history-revert-btn" data-history-idx="${idx}" title="将当前现场快照恢复为本版本">
                                            <i class="fa-solid fa-rotate-left"></i> 恢复
                                        </button>
                                    </div>
                                </div>
                            `;
                        }).reverse().join('')}
                    </div>
                `;
            }
        }

        tabHtml = `
            <div class="pm-section-card">
                <div class="pm-section-header">
                    <span class="pm-section-title"><i class="fa-solid fa-map-location-dot"></i> L0 现场快照 (Scene State)</span>
                    <span class="pm-hero-pill">现场置顶</span>
                </div>
                <div style="font-size: 12px; color: #475569; margin-bottom: 12px; line-height: 1.4;">
                    记录当前正在发生的客观局势。拥有独立硬 Token 预算（上限 ~${settings.maxSceneTokens || 150}），绝不遗忘此时此刻。
                </div>

                <div class="pm-grid-2col pm-mb-8" style="background: rgba(37, 99, 235, 0.04); border: 1px dashed #bfdbfe; border-radius: 6px; padding: 6px 10px; align-items: center;">
                    <div class="pm-input-row" style="margin-bottom: 0;">
                        <label class="pm-input-label" style="font-weight: 600; color: #1e40af;"><i class="fa-solid fa-sliders"></i> 快照 Token 预算上限 (Tok):</label>
                        <input type="number" id="pm-scene-max-tokens" class="pm-input" min="50" max="800" value="${settings.maxSceneTokens || 150}" title="现场快照所允许占用的独立硬 Token 预算 (默认 150，范围 50~800)">
                    </div>
                    <div class="pm-input-row" style="margin-bottom: 0; display: flex; align-items: center; justify-content: flex-start;">
                        <span style="font-size: 11px; color: #64748b; line-height: 1.4;">💡 独立硬预算，超额自动截断保底</span>
                    </div>
                </div>

                <!-- 现场快照时光机操作条 -->
                <div class="pm-scene-history-bar">
                    <div style="display: flex; gap: 6px; align-items: center;">
                        <button id="pm-rollback-scene-btn" class="pm-bulk-btn" ${!hasHistory ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''} title="一键撤销并回滚到上一次快照">
                            <i class="fa-solid fa-rotate-left"></i> 撤销回滚 (${sceneHistory.length})
                        </button>
                        <button id="pm-toggle-scene-history-btn" class="pm-bulk-btn" title="查看或折叠最近快照历史记录">
                            <i class="fa-solid fa-clock-rotate-left"></i> ${isSceneHistoryOpen ? '收起历史' : '历史时光机'}
                        </button>
                    </div>
                    <span style="font-size: 10px; color: #64748b;">秒级纠偏模型幻觉</span>
                </div>
                ${historyHtml}

                <div class="pm-input-row">
                    <label class="pm-input-label"><i class="fa-solid fa-location-dot"></i> 当前地点环境:</label>
                    <input type="text" id="pm-scene-location" class="pm-input" value="${escapeHtml(scene.location || '')}" placeholder="例如: 阳谷县临街炊饼铺内堂">
                </div>

                <div class="pm-input-row">
                    <label class="pm-input-label"><i class="fa-solid fa-clock"></i> 当前时段与天气环境:</label>
                    <input type="text" id="pm-scene-time" class="pm-input" value="${escapeHtml(scene.time || '')}" placeholder="例如: 傍晚时分，窗外细雨蒙蒙">
                </div>

                <div class="pm-input-row">
                    <label class="pm-input-label"><i class="fa-solid fa-person-running"></i> 当前正在进行的动作与细节:</label>
                    <textarea id="pm-scene-action" class="pm-input" rows="2" style="resize: vertical; min-height: 48px; line-height: 1.4;" placeholder="例如: 两人坐在桌前，正端起茶碗饮用。窗外雨势渐大，屋内烛火摇曳。">${escapeHtml(scene.action || '')}</textarea>
                </div>

                <div class="pm-grid-2col pm-mb-8">
                    <div class="pm-input-row" style="margin-bottom: 0;">
                        <label class="pm-input-label"><i class="fa-solid fa-gauge"></i> 心理张力/即时氛围:</label>
                        <input type="text" id="pm-scene-tension" class="pm-input" value="${escapeHtml(scene.tension || '')}" placeholder="例如: 表面平静，暗藏试探">
                    </div>
                    <div class="pm-input-row" style="margin-bottom: 0;">
                        <label class="pm-input-label"><i class="fa-solid fa-triangle-exclamation"></i> 悬而未决的冲突焦点:</label>
                        <input type="text" id="pm-scene-unresolved" class="pm-input" value="${escapeHtml(scene.unresolved || '')}" placeholder="例如: 药包已被金莲藏入袖中">
                    </div>
                </div>

                <div class="pm-input-row pm-mb-12">
                    <label class="pm-input-label">
                        <i class="fa-solid fa-users"></i> 现场在场角色 (知情权边界):
                        <span style="font-weight: 400; color: #64748b;">(填 "自动" 为未知回退，填 "无" 为明确无人)</span>
                    </label>
                    <input type="text" id="pm-scene-characters" class="pm-input" value="${escapeHtml(rawChars)}" placeholder="例如: 武大郎, 潘金莲">
                </div>

                <button id="pm-save-scene-btn" class="pm-btn-primary">
                    <i class="fa-solid fa-check"></i> 保存快照变更
                </button>
            </div>
        `;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TAB 3: 设置与独立 API (Settings & API)
    // ─────────────────────────────────────────────────────────────────────────
    else if (currentTab === 'settings') {
        tabHtml = `
            <!-- 全局启用总开关与悬浮球入口 -->
            <div class="pm-section-card pm-mb-8">
                <div class="flex-container alignitemscenter wide100p pm-mb-4" style="justify-content: space-between;">
                    <label class="pm-switch-wrapper flex1">
                        <span style="font-weight: 700; color: #0f172a; font-size: 13px;">
                            <i class="fa-solid fa-power-off" style="color: #2563eb;"></i> 启用持续记忆系统 (全局总开关)
                        </span>
                        <div class="pm-switch">
                            <input type="checkbox" id="pm-setting-hud-enabled" ${settings.enabled ? 'checked' : ''}>
                            <span class="pm-slider"></span>
                        </div>
                    </label>
                </div>
                <div class="flex-container alignitemscenter wide100p" style="justify-content: space-between; padding-top: 8px; border-top: 1px solid #e2e8f0;">
                    <label class="pm-switch-wrapper flex1">
                        <span style="color: #475569; font-size: 12px; font-weight: 600;">
                            <i class="fa-solid fa-circle-dot" style="color: #2563eb;"></i> 屏幕快捷悬浮球 (关后可从右侧抽屉打开)
                        </span>
                        <div class="pm-switch">
                            <input type="checkbox" id="pm-setting-hud-bubble" ${settings.showFloatingBubble !== false ? 'checked' : ''}>
                            <span class="pm-slider"></span>
                        </div>
                    </label>
                    <button id="pm-reset-bubble-btn" class="pm-btn-test" style="margin-left: 8px; padding: 3px 8px; font-size: 11px;" title="重置悬浮球到初始屏幕位置">
                        <i class="fa-solid fa-arrows-rotate"></i> 重置位置
                    </button>
                </div>
            </div>

            <!-- ⚡ 独立提炼 API 端点配置 (自定义兼容 OpenAI 格式) -->
            <div class="pm-section-card pm-mb-8">
                <label class="pm-switch-wrapper pm-mb-8">
                    <span class="pm-section-title">
                        <i class="fa-solid fa-server"></i> 独立提炼 API (自定义兼容 OpenAI)
                    </span>
                    <div class="pm-switch">
                        <input type="checkbox" id="pm-setting-custom-api-enabled" ${settings.useCustomApi ? 'checked' : ''}>
                        <span class="pm-slider"></span>
                    </div>
                </label>
                <div style="font-size: 12px; color: #475569; margin-bottom: 10px; line-height: 1.4;">
                    提炼任务走通用 OpenAI 格式专属 API 独立发送（完全支持 DeepSeek、OpenAI、Claude 代理、通义千问、硅基流动、本地 Ollama / LM Studio / vLLM 等所有兼容接口）。完全脱离酒馆主聊天链路，彻底根除 DeepSeek 思维链丢失 400 报错与主提示词干扰。
                </div>

                <div id="pm-custom-api-fields" style="${settings.useCustomApi ? 'display: block;' : 'display: none;'}">
                    <div class="pm-input-row">
                        <label class="pm-input-label">API Base URL (例如 https://api.openai.com/v1 或本地 http://localhost:11434/v1):</label>
                        <input type="text" id="pm-setting-custom-api-url" class="pm-input" value="${escapeHtml(settings.customApiUrl || '')}" placeholder="https://api.openai.com/v1">
                    </div>

                    <div class="pm-grid-2col pm-mb-8">
                        <div class="pm-input-row" style="margin-bottom: 0;">
                            <label class="pm-input-label">API Key (密钥):</label>
                            <input type="password" id="pm-setting-custom-api-key" class="pm-input" value="${escapeHtml(settings.customApiKey || '')}" placeholder="sk-... (无密码端点可留空)">
                        </div>
                        <div class="pm-input-row" style="margin-bottom: 0;">
                            <label class="pm-input-label">模型名称:</label>
                            <input type="text" id="pm-setting-custom-api-model" class="pm-input" value="${escapeHtml(settings.customApiModel || 'gpt-4o-mini')}" placeholder="gpt-4o-mini">
                        </div>
                    </div>

                    <div style="display: flex; gap: 10px; align-items: center; margin-top: 10px; flex-wrap: wrap;">
                        <button id="pm-btn-test-api" class="pm-btn-test">
                            <i class="fa-solid fa-plug"></i> 测试 API 连通性
                        </button>
                        <button id="pm-btn-import-st-api" class="pm-btn-test" title="一键同步酒馆主连接设置中填写的 Custom / OpenAI 端点与模型">
                            <i class="fa-solid fa-file-import"></i> 同步酒馆主 API 配置
                        </button>
                        <span id="pm-api-test-status" style="font-size: 11px; font-weight: 500;"></span>
                    </div>

                    <div class="pm-input-row pm-mt-8" style="margin-top: 10px;">
                        <label class="pm-input-label" style="font-size: 11px; color: #475569;">
                            <i class="fa-solid fa-wand-magic-sparkles" style="color: #2563eb;"></i> 快速填充常用 API 预设：
                        </label>
                        <div class="pm-preset-group">
                            <button type="button" class="pm-preset-pill" data-preset="deepseek">DeepSeek 官方</button>
                            <button type="button" class="pm-preset-pill" data-preset="siliconflow">硅基流动</button>
                            <button type="button" class="pm-preset-pill" data-preset="ollama">Ollama (本地)</button>
                            <button type="button" class="pm-preset-pill" data-preset="openai">OpenAI 官方</button>
                            <button type="button" class="pm-preset-pill" data-preset="openrouter">OpenRouter</button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 🚀 傻瓜式全托管运行概览与详细参数入口 -->
            <div class="pm-section-card pm-mb-8">
                <div class="pm-section-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <span class="pm-section-title" style="font-weight: 700; color: #0f172a; font-size: 13px; display: flex; align-items: center; gap: 6px;">
                        <i class="fa-solid fa-wand-magic-sparkles" style="color: #2563eb;"></i> 傻瓜式全托管模式 (官方推荐)
                    </span>
                    <span class="pm-hero-pill" style="background: rgba(37, 99, 235, 0.1); color: #2563eb; border: 1px solid rgba(37, 99, 235, 0.25); font-size: 11px; padding: 2px 8px; border-radius: 12px; font-weight: 600;">
                        已就绪
                    </span>
                </div>
                <div style="font-size: 12px; color: #475569; margin-bottom: 12px; line-height: 1.5;">
                    无需繁杂调试，系统已根据酒馆最佳实践预置黄金调控参数。记忆提炼、Token 硬预算隔离、混合语义检索与长程归并全自动无感运行。
                </div>

                <!-- 四大 RP 玩法流派专属一键预设 -->
                <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px;">
                    <div style="font-size: 11px; font-weight: 700; color: #0f172a; margin-bottom: 4px; display: flex; align-items: center; justify-content: space-between;">
                        <span><i class="fa-solid fa-gamepad" style="color: #6366f1;"></i> 玩法流派一键预设</span>
                        <span style="font-size: 10px; color: #64748b; font-weight: normal;">点击即刻按题材自动调优</span>
                    </div>
                    <div class="pm-preset-row">
                        ${Object.values(GAMEPLAY_PRESETS).map(gp => `
                            <button type="button" class="pm-gameplay-pill ${(settings.activeGameplayPreset || '') === gp.id ? 'pm-gameplay-active' : ''}" data-gameplay="${gp.id}" title="${escapeHtml(gp.desc)}">
                                <i class="fa-solid ${gp.icon}" style="color: ${gp.color};"></i> ${escapeHtml(gp.name)}
                            </button>
                        `).join('')}
                    </div>
                </div>

                <!-- 4 宫格全托管规则简报 -->
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px;">
                    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px 10px;">
                        <div style="font-size: 11px; font-weight: 600; color: #0f172a; display: flex; align-items: center; gap: 4px;">
                            <i class="fa-solid fa-clock-rotate-left" style="color: #f59e0b;"></i> 自适应节律
                        </div>
                        <div style="font-size: 11px; color: #64748b; margin-top: 2px;">
                            每 ${settings.asyncFrequency || 3} 轮后台静默提炼，智能过滤无剧情闲聊
                        </div>
                    </div>
                    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px 10px;">
                        <div style="font-size: 11px; font-weight: 600; color: #0f172a; display: flex; align-items: center; gap: 4px;">
                            <i class="fa-solid fa-shield-halved" style="color: #10b981;"></i> Token 安全预算
                        </div>
                        <div style="font-size: 11px; color: #64748b; margin-top: 2px;">
                            快照 ${settings.maxSceneTokens || 150} T + 记忆 ${settings.maxTotalMemoryTokens || 450} T 动态硬上限
                        </div>
                    </div>
                    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px 10px;">
                        <div style="font-size: 11px; font-weight: 600; color: #0f172a; display: flex; align-items: center; gap: 4px;">
                            <i class="fa-solid fa-brain" style="color: #8b5cf6;"></i> 混合语义检索
                        </div>
                        <div style="font-size: 11px; color: #64748b; margin-top: 2px;">
                            本地向量引擎 + 关键词近义关联召回
                        </div>
                    </div>
                    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px 10px;">
                        <div style="font-size: 11px; font-weight: 600; color: #0f172a; display: flex; align-items: center; gap: 4px;">
                            <i class="fa-solid fa-boxes-packing" style="color: #0284c7;"></i> 长期演进维护
                        </div>
                        <div style="font-size: 11px; color: #64748b; margin-top: 2px;">
                            满 ${settings.consolidateThreshold || 10} 条自动宏观归并，${settings.autoSleepTurns || 20} 轮闲置沉睡
                        </div>
                    </div>
                </div>

                <!-- 详细设置入口与一键恢复 -->
                <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px;">
                    <button id="pm-open-advanced-modal-btn" class="pm-btn-primary" style="flex: 1; padding: 9px 14px; font-size: 12px; background: #2563eb; border-color: #1d4ed8;">
                        <i class="fa-solid fa-sliders"></i> 打开详细与高级参数设置 (弹出面板)
                    </button>
                    <button id="pm-restore-defaults-quick-btn" class="pm-btn-secondary" style="padding: 9px 14px; font-size: 12px;" title="将除 API 外的全部底层参数还原为官方推荐黄金默认值">
                        <i class="fa-solid fa-rotate-left"></i> 一键恢复推荐默认值
                    </button>
                </div>

                <div class="pm-mt-8" style="margin-top: 10px; border-top: 1px dashed #e2e8f0; padding-top: 8px;">
                    <button id="pm-save-all-settings-btn" class="pm-btn-primary" style="width: 100%; padding: 8px 14px; font-size: 12px; background: #059669; border-color: #047857;">
                        <i class="fa-solid fa-floppy-disk"></i> 保存插件基础设置
                    </button>
                </div>
            </div>

                <!-- 记忆数据备份与跨会话迁移 -->
                <div class="pm-section-card pm-mt-12" style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-top: 14px;">
                    <div style="font-weight: 600; font-size: 13px; color: #1e293b; margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
                        <i class="fa-solid fa-file-export" style="color: #2563eb;"></i> 记忆数据备份与迁移
                    </div>
                    <div style="font-size: 12px; color: #64748b; margin-bottom: 10px; line-height: 1.4;">
                        可将当前会话的现场快照与全部记忆库导出为标准 JSON 备份文件，或导入外部备份进行智能合并。
                    </div>
                    <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                        <button id="pm-export-memories-btn" class="pm-btn-secondary" style="cursor: pointer;">
                            <i class="fa-solid fa-download"></i> 导出记忆数据 (JSON)
                        </button>
                        <button id="pm-import-memories-btn" class="pm-btn-secondary" style="cursor: pointer;">
                            <i class="fa-solid fa-upload"></i> 导入/合并记忆 (JSON)
                        </button>
                        <input type="file" id="pm-import-file-input" accept=".json" style="display: none;">
                    </div>
                </div>
            </div>
        `;
    }

    body.innerHTML = tabHtml;
    bindPanelEvents(body);
    } catch (err) {
        console.error(`[${MODULE_NAME}] [UI] 渲染控制台失败:`, err);
        body.innerHTML = `<div class="pm-section-card" style="color: #dc2626;"><i class="fa-solid fa-triangle-exclamation"></i> 渲染控制台发生异常: ${escapeHtml(err.message)}</div>`;
    }
}

/**
 * 绑定主面板事件
 */
function bindPanelEvents(container) {
    // 切换模式
    container.querySelectorAll('input[name="pm-mode"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            updateSettings({ mode: e.target.value });
            const nativeRadios = document.querySelectorAll('input[name="pm-native-mode"]');
            nativeRadios.forEach(nr => {
                if (nr.value === e.target.value) nr.checked = true;
            });
        });
    });

    // 提炼参数与 Token 预算 (实时双向联动 + 立即持久化落盘)
    container.querySelector('#pm-setting-freq')?.addEventListener('input', (e) => {
        const raw = parseInt(e.target.value);
        if (!isNaN(raw) && raw >= 1) updateSettings({ asyncFrequency: raw });
    });
    container.querySelector('#pm-setting-freq')?.addEventListener('change', (e) => {
        const val = Math.max(1, parseInt(e.target.value) || 3);
        updateSettings({ asyncFrequency: val });
        saveSettingsImmediately();
    });

    container.querySelector('#pm-setting-slice')?.addEventListener('input', (e) => {
        const raw = parseInt(e.target.value);
        if (!isNaN(raw) && raw >= 2 && raw <= 15) updateSettings({ digestSliceCount: raw });
    });
    container.querySelector('#pm-setting-slice')?.addEventListener('change', (e) => {
        const val = Math.max(2, Math.min(15, parseInt(e.target.value) || 6));
        updateSettings({ digestSliceCount: val });
        saveSettingsImmediately();
    });

    container.querySelector('#pm-setting-tokens')?.addEventListener('input', (e) => {
        const raw = parseInt(e.target.value);
        if (!isNaN(raw) && raw >= 150 && raw <= 2500) {
            updateSettings({ maxTotalMemoryTokens: raw });
            const nativeTok = document.getElementById('pm-native-tokens');
            if (nativeTok && document.activeElement !== nativeTok) nativeTok.value = raw;
        }
    });
    container.querySelector('#pm-setting-tokens')?.addEventListener('change', (e) => {
        const val = Math.max(150, Math.min(2500, parseInt(e.target.value) || 450));
        updateSettings({ maxTotalMemoryTokens: val });
        saveSettingsImmediately();
        const nativeTok = document.getElementById('pm-native-tokens');
        if (nativeTok && document.activeElement !== nativeTok) nativeTok.value = val;
    });

    container.querySelector('#pm-setting-scene-tokens')?.addEventListener('input', (e) => {
        const raw = parseInt(e.target.value);
        if (!isNaN(raw) && raw >= 50 && raw <= 800) {
            updateSettings({ maxSceneTokens: raw });
            const nativeScene = document.getElementById('pm-native-scene-tokens');
            if (nativeScene && document.activeElement !== nativeScene) nativeScene.value = raw;
            const tab2Scene = document.getElementById('pm-scene-max-tokens');
            if (tab2Scene && document.activeElement !== tab2Scene) tab2Scene.value = raw;
        }
    });
    container.querySelector('#pm-setting-scene-tokens')?.addEventListener('change', (e) => {
        const val = Math.max(50, Math.min(800, parseInt(e.target.value) || 150));
        updateSettings({ maxSceneTokens: val });
        saveSettingsImmediately();
        const nativeScene = document.getElementById('pm-native-scene-tokens');
        if (nativeScene && document.activeElement !== nativeScene) nativeScene.value = val;
        const tab2Scene = document.getElementById('pm-scene-max-tokens');
        if (tab2Scene && document.activeElement !== tab2Scene) tab2Scene.value = val;
    });

    // Tab 2 快照独立 Token 上限实时双向绑定
    container.querySelector('#pm-scene-max-tokens')?.addEventListener('input', (e) => {
        const raw = parseInt(e.target.value);
        if (!isNaN(raw) && raw >= 50 && raw <= 800) {
            updateSettings({ maxSceneTokens: raw });
            const hudScene = document.getElementById('pm-setting-scene-tokens');
            if (hudScene && document.activeElement !== hudScene) hudScene.value = raw;
            const nativeScene = document.getElementById('pm-native-scene-tokens');
            if (nativeScene && document.activeElement !== nativeScene) nativeScene.value = raw;
        }
    });
    container.querySelector('#pm-scene-max-tokens')?.addEventListener('change', (e) => {
        const val = Math.max(50, Math.min(800, parseInt(e.target.value) || 150));
        updateSettings({ maxSceneTokens: val });
        saveSettingsImmediately();
        const hudScene = document.getElementById('pm-setting-scene-tokens');
        if (hudScene && document.activeElement !== hudScene) hudScene.value = val;
        const nativeScene = document.getElementById('pm-native-scene-tokens');
        if (nativeScene && document.activeElement !== nativeScene) nativeScene.value = val;
    });

    container.querySelector('#pm-setting-max-pinned')?.addEventListener('change', (e) => {
        const val = Math.max(1, Math.min(15, parseInt(e.target.value) || 5));
        updateSettings({ maxPinnedCount: val });
        saveSettingsImmediately();
    });

    container.querySelector('#pm-setting-max-triggered')?.addEventListener('change', (e) => {
        const val = Math.max(1, Math.min(30, parseInt(e.target.value) || 5));
        updateSettings({ maxTriggeredCount: val });
        saveSettingsImmediately();
    });

    container.querySelector('#pm-setting-inject-pos')?.addEventListener('change', (e) => {
        const val = parseInt(e.target.value);
        updateSettings({ injectionPosition: !isNaN(val) ? val : 1 });
    });

    container.querySelector('#pm-setting-inject-depth')?.addEventListener('change', (e) => {
        const raw = parseInt(e.target.value);
        const val = !isNaN(raw) ? Math.max(0, Math.min(20, raw)) : 2;
        updateSettings({ injectionDepth: val });
    });

    container.querySelector('#pm-setting-inject-template')?.addEventListener('change', (e) => {
        updateSettings({ injectionTemplate: e.target.value });
        const drawerSelect = document.getElementById('pm-native-inject-template');
        if (drawerSelect) drawerSelect.value = e.target.value;
        saveSettingsImmediately();
        window.toastr?.info?.(`提示词注入模板已切换为: ${e.target.options[e.target.selectedIndex].text}`, '持续记忆');
    });

    container.querySelector('#pm-setting-auto-consolidate')?.addEventListener('change', (e) => {
        updateSettings({ autoConsolidate: e.target.value === '1' });
    });

    container.querySelector('#pm-setting-consolidate-threshold')?.addEventListener('change', (e) => {
        const val = Math.max(5, Math.min(50, parseInt(e.target.value) || 10));
        updateSettings({ consolidateThreshold: val });
    });

    container.querySelector('#pm-setting-auto-sleep')?.addEventListener('change', (e) => {
        updateSettings({ autoSleepEnabled: e.target.value === '1' });
    });

    container.querySelector('#pm-setting-auto-sleep-turns')?.addEventListener('change', (e) => {
        const val = Math.max(5, Math.min(100, parseInt(e.target.value) || 20));
        updateSettings({ autoSleepTurns: val });
    });

    container.querySelector('#pm-setting-adaptive-cadence')?.addEventListener('change', (e) => {
        updateSettings({ adaptiveCadenceEnabled: e.target.value === '1' });
    });

    container.querySelector('#pm-setting-adaptive-min-chars')?.addEventListener('change', (e) => {
        const val = Math.max(20, Math.min(500, parseInt(e.target.value) || 60));
        updateSettings({ adaptiveCadenceMinChars: val });
    });

    // 全局插件启用
    container.querySelector('#pm-setting-hud-enabled')?.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        updateSettings({ enabled: isChecked });
        const nativeToggle = document.getElementById('pm-setting-enabled');
        if (nativeToggle) nativeToggle.checked = isChecked;
    });

    // 屏幕悬浮球显隐与重置
    container.querySelector('#pm-setting-hud-bubble')?.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        updateSettings({ showFloatingBubble: isChecked });
        const bubble = document.getElementById('pm-floating-bubble');
        if (bubble) bubble.style.display = isChecked ? 'flex' : 'none';
        const nativeCb = document.getElementById('pm-native-bubble-enabled');
        if (nativeCb) nativeCb.checked = isChecked;
    });

    container.querySelector('#pm-reset-bubble-btn')?.addEventListener('click', () => {
        resetBubblePosition();
        window.toastr?.info?.('悬浮球位置已重置至默认推荐位置', '持续记忆');
    });

    // 独立提炼 API 配置监听
    container.querySelector('#pm-setting-custom-api-enabled')?.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        const fields = container.querySelector('#pm-custom-api-fields');
        if (fields) fields.style.display = isChecked ? 'block' : 'none';
        updateSettings({ useCustomApi: isChecked });
        // 双向同步原生抽屉
        const nativeCb = document.getElementById('pm-native-custom-api-enabled');
        if (nativeCb) {
            nativeCb.checked = isChecked;
            const nativeBody = document.getElementById('pm-native-custom-api-body');
            if (nativeBody) nativeBody.style.display = isChecked ? 'block' : 'none';
        }
    });

    const syncHudApiInputs = () => {
        const url = (container.querySelector('#pm-setting-custom-api-url')?.value || '').trim();
        const key = (container.querySelector('#pm-setting-custom-api-key')?.value || '').trim();
        const model = (container.querySelector('#pm-setting-custom-api-model')?.value || 'gpt-4o-mini').trim();
        updateSettings({ customApiUrl: url, customApiKey: key, customApiModel: model });
    };

    ['input', 'change'].forEach(evt => {
        container.querySelector('#pm-setting-custom-api-url')?.addEventListener(evt, syncHudApiInputs);
        container.querySelector('#pm-setting-custom-api-key')?.addEventListener(evt, syncHudApiInputs);
        container.querySelector('#pm-setting-custom-api-model')?.addEventListener(evt, syncHudApiInputs);
    });

    // 同步酒馆主 API 配置
    container.querySelector('#pm-btn-import-st-api')?.addEventListener('click', () => {
        const conf = importSillyTavernApiConfig();
        let count = 0;
        if (conf.url) {
            const el = container.querySelector('#pm-setting-custom-api-url');
            if (el) { el.value = conf.url; count++; }
        }
        if (conf.key) {
            const el = container.querySelector('#pm-setting-custom-api-key');
            if (el) { el.value = conf.key; count++; }
        }
        if (conf.model) {
            const el = container.querySelector('#pm-setting-custom-api-model');
            if (el) { el.value = conf.model; count++; }
        }
        syncHudApiInputs();
        if (count > 0) {
            window.toastr?.success?.(`已同步酒馆配置 (端点: ${conf.url || '未变'}, 模型: ${conf.model || '未变'})`, '持续记忆');
        } else {
            window.toastr?.info?.('未能从酒馆连接设置读取到有效 Custom/OpenAI 配置，请在酒馆连接处填写或手动输入', '持续记忆');
        }
    });

    // 测试 API 连通性
    container.querySelector('#pm-btn-test-api')?.addEventListener('click', async () => {
        syncHudApiInputs();
        const statusEl = container.querySelector('#pm-api-test-status');
        if (statusEl) {
            statusEl.style.color = '#38bdf8';
            statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 测试连通性中...';
        }
        const res = await testCustomApiConnection();
        if (res.success) {
            if (statusEl) {
                statusEl.style.color = '#34d399';
                statusEl.innerHTML = `<i class="fa-solid fa-check"></i> 连接成功！(${res.latency}ms)`;
            }
            window.toastr?.success?.(`API 连接成功！响应延时 ${res.latency}ms，模型: ${res.model}`, '持续记忆');
        } else {
            if (statusEl) {
                statusEl.style.color = '#f87171';
                statusEl.innerHTML = `<i class="fa-solid fa-xmark"></i> 失败: ${escapeHtml(res.error).slice(0, 35)}`;
            }
            window.toastr?.error?.(res.error, 'API 连接失败');
        }
    });

    // 打开即时注入透视镜模态对话框
    container.querySelector('#pm-open-inspector-btn')?.addEventListener('click', () => {
        showInjectionInspectorModal();
    });
    container.querySelector('#pm-stat-token-inspect')?.addEventListener('click', () => {
        showInjectionInspectorModal();
    });

    // 打开详细与高级参数设置模态面板
    container.querySelector('#pm-open-advanced-modal-btn')?.addEventListener('click', () => {
        showAdvancedSettingsModal({
            onSave: () => {
                renderPanelContent();
                renderNativeDrawerContent();
            }
        });
    });

    // 傻瓜式一键恢复官方推荐默认值
    container.querySelector('#pm-restore-defaults-quick-btn')?.addEventListener('click', () => {
        restoreRecommendedDefaults();
        renderPanelContent();
        renderNativeDrawerContent();
    });

    // 保存设置按钮 (Tab 3: 保存 API 配置与开关)
    container.querySelector('#pm-save-all-settings-btn')?.addEventListener('click', () => {
        syncHudApiInputs();
        const isEnabled = container.querySelector('#pm-setting-hud-enabled')?.checked ?? true;
        const showBubble = container.querySelector('#pm-setting-hud-bubble')?.checked ?? true;
        const useCustom = container.querySelector('#pm-setting-custom-api-enabled')?.checked ?? false;

        updateSettings({
            enabled: isEnabled,
            showFloatingBubble: showBubble,
            useCustomApi: useCustom
        });

        const ok = saveSettingsImmediately();
        const btn = container.querySelector('#pm-save-all-settings-btn');
        if (btn) {
            btn.innerHTML = '<i class="fa-solid fa-check"></i> 设置已保存！';
            setTimeout(() => {
                btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> 保存插件基础设置';
            }, 1800);
        }
        if (ok) {
            window.toastr?.success?.('设置已保存并立即生效！', '持续记忆');
        } else {
            window.toastr?.error?.('保存配置失败，请检查浏览器控制台', '持续记忆');
        }
    });

    // 保存快照 (同步保存现场内容与快照 Token 上限)
    container.querySelector('#pm-save-scene-btn')?.addEventListener('click', () => {
        const rawLocation = container.querySelector('#pm-scene-location')?.value || '';
        const rawTime = container.querySelector('#pm-scene-time')?.value || '';
        const rawAction = container.querySelector('#pm-scene-action')?.value || '';
        const rawTension = container.querySelector('#pm-scene-tension')?.value || '';
        const rawUnresolved = container.querySelector('#pm-scene-unresolved')?.value || '';
        const rawChars = container.querySelector('#pm-scene-characters')?.value?.trim() || '';

        // 同步检查与保存现场快照 Token 上限
        const rawSceneTok = parseInt(container.querySelector('#pm-scene-max-tokens')?.value);
        if (!isNaN(rawSceneTok)) {
            const sceneTok = Math.max(50, Math.min(800, rawSceneTok));
            updateSettings({ maxSceneTokens: sceneTok });
            saveSettingsImmediately();
        }

        let charsToSave;
        if (!rawChars || rawChars === '自动' || rawChars.toLowerCase() === 'auto') {
            charsToSave = null; // 重置为未知
        } else if (rawChars === '无' || rawChars.toLowerCase() === 'none' || rawChars === '[]') {
            charsToSave = []; // 明确无人
        } else {
            charsToSave = rawChars.split(/[,，]/).map(s => s.trim()).filter(Boolean);
        }

        updateScene({
            location: rawLocation,
            time: rawTime,
            action: rawAction,
            tension: rawTension,
            unresolved: rawUnresolved,
            in_scene_characters: charsToSave
        }, '手动保存');
        const btn = container.querySelector('#pm-save-scene-btn');
        if (btn) {
            btn.innerHTML = '<i class="fa-solid fa-check-double"></i> 快照已保存';
            setTimeout(() => { btn.innerHTML = '<i class="fa-solid fa-check"></i> 保存快照变更'; }, 1500);
        }
        window.toastr?.success?.('现场快照与上限设置已成功保存', '持续记忆');
    });

    // 现场快照时光机：一键撤销回滚
    container.querySelector('#pm-rollback-scene-btn')?.addEventListener('click', () => {
        const res = rollbackScene();
        if (res.success) {
            window.toastr?.success?.('已成功回滚到上一次现场快照', '快照时光机');
            renderHudContent();
        } else {
            window.toastr?.warning?.(res.message || '回滚失败', '快照时光机');
        }
    });

    // 现场快照时光机：展开/收起历史面板
    container.querySelector('#pm-toggle-scene-history-btn')?.addEventListener('click', () => {
        isSceneHistoryOpen = !isSceneHistoryOpen;
        renderHudContent();
    });

    // 现场快照时光机：恢复指定历史版本
    container.querySelectorAll('.pm-history-revert-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const idx = parseInt(e.currentTarget.getAttribute('data-history-idx'), 10);
            if (!isNaN(idx)) {
                const res = restoreSceneSnapshot(idx);
                if (res.success) {
                    window.toastr?.success?.('已恢复目标快照版本', '快照时光机');
                    renderHudContent();
                } else {
                    window.toastr?.warning?.(res.message || '恢复快照失败', '快照时光机');
                }
            }
        });
    });

    // 现场快照时光机：查看该轮次切片 (Historical Slice Replay)
    container.querySelectorAll('.pm-history-slice-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const idx = parseInt(e.currentTarget.getAttribute('data-history-idx'), 10);
            if (!isNaN(idx)) {
                showHistoricalSliceModal(idx, () => {
                    renderHudContent();
                });
            }
        });
    });

    // 添加记忆
    container.querySelector('#pm-add-mem-btn')?.addEventListener('click', () => {
        const contentInput = container.querySelector('#pm-new-mem-content');
        const typeSelect = container.querySelector('#pm-new-mem-type');
        const keysInput = container.querySelector('#pm-new-mem-keys');
        const scopeSelect = container.querySelector('#pm-new-mem-scope');
        const targetInput = container.querySelector('#pm-new-mem-target');
        const loreInput = container.querySelector('#pm-new-mem-lorebook');

        const content = (contentInput?.value || '').trim().slice(0, 150);
        if (!content) return;

        const type = typeSelect?.value || 'fact';
        const keys = (keysInput?.value || '').split(/[,，]/).map(k => k.trim()).filter(Boolean);
        const scope = scopeSelect?.value || 'world';
        const targets = (targetInput?.value || '').split(/[,，]/).map(k => k.trim()).filter(Boolean);
        const loreName = (loreInput?.value || '').trim();

        const state = getState();
        const c = window.SillyTavern?.getContext?.();
        const curCharName = c?.characters?.[c?.this_chid]?.name || '角色';
        const currentTurn = Array.isArray(c?.chat) ? c.chat.filter(m => !m.is_user).length : 0;

        let memData = {
            type: type,
            content: content,
            trigger_keys: keys,
            scope: scope,
            status: MEMORY_STATUS.TRIGGERED,
            floor: currentTurn,
            last_activated_floor: currentTurn
        };

        if (loreName) {
            memData.lorebook_ref = { entry_name: loreName };
        }

        if (scope === 'character') {
            memData.character = targets[0] || curCharName;
        } else if (scope === 'shared') {
            const authoritativeParts = Array.from(getContextParticipants(c, state));
            memData.known_by = targets.length > 0 ? targets : (authoritativeParts.length > 0 ? authoritativeParts : [curCharName, c?.name1 || 'User']);
        }

        const added = addMemory(memData);
        if (added) {
            window.toastr?.success?.(`已录入 [${type}] 记忆: "${content.slice(0, 15)}..."`, '持续记忆');
        }

        contentInput.value = '';
        keysInput.value = '';
        if (targetInput) targetInput.value = '';
        if (loreInput) loreInput.value = '';
    });

    // 卡片动作 (点击切换状态 / 点击切换类型 / 行内编辑 / 删除)
    container.querySelectorAll('.pm-card').forEach(card => {
        const id = card.getAttribute('data-id');
        card.querySelector('[data-action="cycle"]')?.addEventListener('click', () => {
            cycleMemoryStatus(id);
        });
        card.querySelector('[data-action="cycle-type"]')?.addEventListener('click', () => {
            cycleMemoryType(id);
        });
        card.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
            deleteMemory(id);
        });

        // 行内编辑切换
        const viewContent = card.querySelector('[data-role="view-content"]');
        const viewKeys = card.querySelector('[data-role="view-keys"]');
        const editBox = card.querySelector('[data-role="edit-box"]');
        const editContentInput = card.querySelector('.pm-edit-content-input');
        const editKeysInput = card.querySelector('.pm-edit-keys-input');

        card.querySelector('[data-action="edit"]')?.addEventListener('click', () => {
            if (editBox) {
                const isEditing = editBox.style.display !== 'none';
                if (isEditing) {
                    editBox.style.display = 'none';
                    if (viewContent) viewContent.style.display = 'block';
                    if (viewKeys) viewKeys.style.display = 'block';
                } else {
                    editBox.style.display = 'block';
                    if (viewContent) viewContent.style.display = 'none';
                    if (viewKeys) viewKeys.style.display = 'none';
                    editContentInput?.focus();
                }
            }
        });

        card.querySelector('[data-action="cancel-edit"]')?.addEventListener('click', () => {
            if (editBox) {
                editBox.style.display = 'none';
                if (viewContent) viewContent.style.display = 'block';
                if (viewKeys) viewKeys.style.display = 'block';
            }
        });

        card.querySelector('[data-action="save-edit"]')?.addEventListener('click', () => {
            const newContent = editContentInput?.value?.trim();
            if (!newContent) {
                window.toastr?.warning?.('记忆正文不可为空', '持续记忆');
                return;
            }
            const rawKeys = editKeysInput?.value || '';
            const newKeys = rawKeys.split(/[,，]/)
                .map(k => k.trim())
                .filter(k => k.length >= 2 && k.length <= 15)
                .slice(0, 5);
            const newLore = card.querySelector('.pm-edit-lore-input')?.value?.trim() || '';

            const memObj = getState().memories.find(m => m.id === id);
            const updated = updateMemory(id, {
                content: newContent,
                trigger_keys: newKeys,
                lorebook_ref: newLore ? { entry_name: newLore, book: memObj?.lorebook_ref?.book || '', entry_uid: memObj?.lorebook_ref?.entry_uid ?? null } : null
            });
            if (updated) {
                window.toastr?.success?.('记忆已成功修改！', '持续记忆');
            }
        });

        // 安全写回世界书条目 (Write-Back Hook)
        card.querySelector('[data-action="sync-lore"]')?.addEventListener('click', async () => {
            const syncBtn = card.querySelector('[data-action="sync-lore"]');
            if (syncBtn) syncBtn.disabled = true;

            try {
                // 1. Dry run 获取差量与目标信息
                const previewRes = await syncMemoryDeltaToWorldInfo(id, { dryRun: true });
                if (!previewRes.success) {
                    if (previewRes.alreadySynced) {
                        window.toastr?.info?.(previewRes.reason, '持续记忆');
                    } else {
                        window.toastr?.warning?.(previewRes.reason || '无法同步至世界书', '持续记忆');
                    }
                    if (syncBtn) syncBtn.disabled = false;
                    return;
                }

                // 2. 弹出确认框 (显示 diff 预览与勾选项)
                showSyncLoreModal(previewRes.preview, async (markCompleted, compactUpdates) => {
                    const commitRes = await syncMemoryDeltaToWorldInfo(id, { markCompleted, compactUpdates });
                    if (commitRes.success) {
                        window.toastr?.success?.(`已成功将动态事实写回至世界书【${commitRes.bookName} - ${commitRes.entryName}】！`, '持续记忆');
                        renderPanelContent();
                    } else {
                        window.toastr?.error?.(`写回失败: ${commitRes.reason}`, '持续记忆');
                    }
                });
            } catch (err) {
                window.toastr?.error?.('同步异常: ' + err.message, '持续记忆');
            } finally {
                if (syncBtn) syncBtn.disabled = false;
            }
        });

        // P2: 一键升格为世界书独立新词条 (Promote to Lorebook Entry)
        card.querySelector('[data-action="promote-lore"]')?.addEventListener('click', async () => {
            const promoteBtn = card.querySelector('[data-action="promote-lore"]');
            if (promoteBtn) promoteBtn.disabled = true;

            try {
                const memObj = getState().memories.find(m => m.id === id);
                if (!memObj) {
                    window.toastr?.error?.('未找到该条记忆', '持续记忆');
                    return;
                }

                const activeBookInfo = await getActiveWorldBookInfo();
                const defaultBook = activeBookInfo?.bookName || '';

                showPromoteLoreModal(memObj, defaultBook, async ({ bookName, entryName, keys, content, markCompleted }) => {
                    const res = await promoteMemoryToWorldInfo(id, {
                        bookName,
                        entryName,
                        keys,
                        content,
                        markCompleted
                    });

                    if (res.success) {
                        window.toastr?.success?.(`已成功将事实升格为世界书【${res.bookName} - ${res.entryName}】(UID: ${res.entryUid})！`, '持续记忆');
                        renderPanelContent();
                    } else {
                        window.toastr?.error?.(`升格失败: ${res.reason}`, '持续记忆');
                    }
                });
            } catch (err) {
                window.toastr?.error?.('升格异常: ' + err.message, '持续记忆');
            } finally {
                if (promoteBtn) promoteBtn.disabled = false;
            }
        });

        // P4: 查看记忆演化血缘追溯 (Evolution Lineage)
        card.querySelector('[data-action="view-lineage"]')?.addEventListener('click', () => {
            showMemoryLineageModal(id);
        });
    });

    // 记忆列表视图筛选 (活跃 / 归档 / 全部)
    container.querySelectorAll('[data-action="filter-mem"]').forEach(btn => {
        btn.addEventListener('click', () => {
            const filter = btn.getAttribute('data-filter');
            if (filter) {
                memoryFilter = filter;
                renderPanelContent();
            }
        });
    });

    // P0 实时搜索输入与清空
    const searchInput = container.querySelector('#pm-mem-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            memorySearchQuery = e.target.value;
            renderPanelContent();
            const reSearchInput = document.getElementById('pm-mem-search-input');
            if (reSearchInput) {
                reSearchInput.focus();
                reSearchInput.setSelectionRange(reSearchInput.value.length, reSearchInput.value.length);
            }
        });
    }
    container.querySelector('#pm-mem-search-clear')?.addEventListener('click', () => {
        memorySearchQuery = '';
        renderPanelContent();
    });

    // P0 卡片复选框事件
    container.querySelectorAll('.pm-card-select-cb').forEach(cb => {
        cb.addEventListener('change', (e) => {
            e.stopPropagation();
            const id = e.target.getAttribute('data-id');
            if (e.target.checked) selectedMemoryIds.add(id);
            else selectedMemoryIds.delete(id);
            renderPanelContent();
        });
    });

    // P0 全选/反选当前列表
    container.querySelector('#pm-select-all-cb')?.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        const memories = getState().memories || [];
        const isTerminal = m => m.lifecycle && m.lifecycle !== MEMORY_LIFECYCLE.ACTIVE;
        const isDormant = m => m.status === MEMORY_STATUS.ARCHIVED && (!m.lifecycle || m.lifecycle === MEMORY_LIFECYCLE.ACTIVE);
        const isTermOrArch = m => m.status === MEMORY_STATUS.ARCHIVED || isTerminal(m);
        const curList = memories.filter(m => {
            if (memoryFilter === 'active' && isTermOrArch(m)) return false;
            if (memoryFilter === 'dormant' && !isDormant(m)) return false;
            if (memoryFilter === 'archived' && !isTerminal(m)) return false;
            if (lorebookFilter === '__unlinked__') {
                if (m.lorebook_ref && m.lorebook_ref.entry_name) return false;
            } else if (lorebookFilter) {
                if (!m.lorebook_ref || m.lorebook_ref.entry_name !== lorebookFilter) return false;
            }
            if (memorySearchQuery) {
                const kw = memorySearchQuery.toLowerCase();
                const matchContent = m.content && m.content.toLowerCase().includes(kw);
                const matchChar = m.character && m.character.toLowerCase().includes(kw);
                const matchKeys = Array.isArray(m.trigger_keys) && m.trigger_keys.some(k => k.toLowerCase().includes(kw));
                const matchLb = m.lorebook_ref && m.lorebook_ref.entry_name && m.lorebook_ref.entry_name.toLowerCase().includes(kw);
                if (!matchContent && !matchChar && !matchKeys && !matchLb) return false;
            }
            return true;
        });

        if (isChecked) {
            curList.forEach(m => selectedMemoryIds.add(m.id));
        } else {
            curList.forEach(m => selectedMemoryIds.delete(m.id));
        }
        renderPanelContent();
    });

    // P0 批量操作按钮
    container.querySelector('#pm-bulk-pin')?.addEventListener('click', () => {
        if (selectedMemoryIds.size === 0) return;
        const count = selectedMemoryIds.size;
        batchUpdate(() => {
            const s = getState();
            for (const id of selectedMemoryIds) {
                const target = s.memories.find(m => m.id === id);
                if (target) {
                    target.status = MEMORY_STATUS.PINNED;
                    target.lifecycle = MEMORY_LIFECYCLE.ACTIVE;
                }
            }
        });
        window.toastr?.success?.(`已将选中的 ${count} 条记忆设为常驻置顶`, '持续记忆');
        selectedMemoryIds.clear();
        renderPanelContent();
    });

    container.querySelector('#pm-bulk-trigger')?.addEventListener('click', () => {
        if (selectedMemoryIds.size === 0) return;
        const count = selectedMemoryIds.size;
        batchUpdate(() => {
            const s = getState();
            for (const id of selectedMemoryIds) {
                const target = s.memories.find(m => m.id === id);
                if (target) {
                    target.status = MEMORY_STATUS.TRIGGERED;
                    target.lifecycle = MEMORY_LIFECYCLE.ACTIVE;
                }
            }
        });
        window.toastr?.success?.(`已将选中的 ${count} 条记忆设为条件激活`, '持续记忆');
        selectedMemoryIds.clear();
        renderPanelContent();
    });

    container.querySelector('#pm-bulk-archive')?.addEventListener('click', () => {
        if (selectedMemoryIds.size === 0) return;
        const count = selectedMemoryIds.size;
        batchUpdate(() => {
            const s = getState();
            for (const id of selectedMemoryIds) {
                const target = s.memories.find(m => m.id === id);
                if (target) target.status = MEMORY_STATUS.ARCHIVED;
            }
        });
        window.toastr?.success?.(`已将选中的 ${count} 条记忆归档休眠`, '持续记忆');
        selectedMemoryIds.clear();
        renderPanelContent();
    });

    container.querySelector('#pm-bulk-complete')?.addEventListener('click', () => {
        if (selectedMemoryIds.size === 0) return;
        const count = selectedMemoryIds.size;
        batchUpdate(() => {
            const s = getState();
            for (const id of selectedMemoryIds) {
                const target = s.memories.find(m => m.id === id);
                if (target) {
                    target.lifecycle = MEMORY_LIFECYCLE.COMPLETED;
                    target.status = MEMORY_STATUS.ARCHIVED;
                }
            }
        });
        window.toastr?.success?.(`已将选中的 ${count} 条记忆标记为已履约/办结`, '持续记忆');
        selectedMemoryIds.clear();
        renderPanelContent();
    });

    container.querySelector('#pm-bulk-refute')?.addEventListener('click', () => {
        if (selectedMemoryIds.size === 0) return;
        const count = selectedMemoryIds.size;
        batchUpdate(() => {
            const s = getState();
            for (const id of selectedMemoryIds) {
                const target = s.memories.find(m => m.id === id);
                if (target) {
                    target.lifecycle = MEMORY_LIFECYCLE.REFUTED;
                    target.status = MEMORY_STATUS.ARCHIVED;
                }
            }
        });
        window.toastr?.success?.(`已将选中的 ${count} 条记忆标记为已证伪`, '持续记忆');
        selectedMemoryIds.clear();
        renderPanelContent();
    });

    container.querySelector('#pm-bulk-delete')?.addEventListener('click', () => {
        if (selectedMemoryIds.size === 0) return;
        const count = selectedMemoryIds.size;
        if (confirm(`确定要彻底删除已选中的 ${count} 条记忆吗？此操作无法撤销。`)) {
            batchUpdate(() => {
                const s = getState();
                s.memories = s.memories.filter(m => !selectedMemoryIds.has(m.id));
            });
            window.toastr?.success?.(`已成功批量删除 ${count} 条记忆`, '持续记忆');
            selectedMemoryIds.clear();
            renderPanelContent();
        }
    });

    container.querySelector('#pm-bulk-cancel')?.addEventListener('click', () => {
        selectedMemoryIds.clear();
        renderPanelContent();
    });

    // P0 常用 API 预设快速填充按钮
    container.querySelectorAll('.pm-preset-pill').forEach(btn => {
        btn.addEventListener('click', () => {
            const p = btn.getAttribute('data-preset');
            applyApiPreset(p, false);
        });
    });

    // 玩法流派专属一键预设快速切换
    container.querySelectorAll('.pm-gameplay-pill').forEach(btn => {
        btn.addEventListener('click', () => {
            const gpId = btn.getAttribute('data-gameplay');
            if (gpId) {
                applyGameplayPreset(gpId);
                renderPanelContent();
            }
        });
    });

    // 关联世界书条目筛选
    container.querySelector('#pm-filter-lorebook')?.addEventListener('change', (e) => {
        lorebookFilter = e.target.value;
        renderPanelContent();
    });

    // 手动立即触发宏观记忆归并
    container.querySelector('#pm-consolidate-now-btn')?.addEventListener('click', async () => {
        const btn = container.querySelector('#pm-consolidate-now-btn');
        if (btn) btn.disabled = true;
        window.toastr?.info?.('正在执行记忆高阶归并与浓缩，请稍候...', '持续记忆');
        try {
            const res = await triggerMemoryConsolidation(true);
            if (res.success) {
                if (res.count > 0) {
                    window.toastr?.success?.(`成功生成 ${res.count} 条宏观记忆，已将 ${res.superseded} 条旧条目转入迭代状态！`, '持续记忆');
                } else {
                    window.toastr?.info?.(res.reason || '当前候选记忆各自独立，无需归并', '持续记忆');
                }
            } else {
                window.toastr?.warning?.(res.reason || res.error || '未产生归并变更', '持续记忆');
            }
        } catch (err) {
            window.toastr?.error?.('归并失败: ' + err.message, '持续记忆');
        } finally {
            if (btn) btn.disabled = false;
        }
    });

    // 清理已结项与废弃归档记忆
    container.querySelector('#pm-purge-archived-btn')?.addEventListener('click', () => {
        const confirmed = confirm('确定要永久清理所有已结项 (completed)、已迭代 (superseded)、已证伪 (refuted) 及已归档的记忆吗？\n注意：此操作不可撤销！');
        if (confirmed) {
            const res = purgeArchivedMemories();
            if (res.success) {
                window.toastr?.success?.(`已清理 ${res.removed} 条终态记忆 (剩余 ${res.remaining} 条)`, '持续记忆');
            }
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 全量与历史上下文回溯提炼 (Backlog Digestion UI)
    // ─────────────────────────────────────────────────────────────────────────
    async function runBacklogDigestionUI(fromStart = false) {
        if (isBacklogDigestRunning()) {
            window.toastr?.info?.('全量提炼任务正在执行中...', '持续记忆');
            return;
        }

        const c = getContext();
        const chatLen = Array.isArray(c?.chat) ? c.chat.length : 0;
        if (chatLen < 2) {
            window.toastr?.warning?.('当前对话消息过少，无需回溯提炼', '持续记忆');
            return;
        }

        const confirmMsg = fromStart
            ? `确认从头开始分批回溯提炼当前会话全部 ${chatLen} 条历史消息吗？\n将按时序分批消化并累积沉淀关键记忆。`
            : `确认对当前未消化的历史消息进行分批回溯提炼吗？`;

        if (!confirm(confirmMsg)) return;

        window.toastr?.info?.('已启动全量历史回溯提炼...', '持续记忆');
        renderPanelContent();

        try {
            const res = await triggerBacklogDigest({
                fromStart: fromStart,
                chunkSize: 8,
                overlap: 2,
                onProgress: (p) => {
                    const progText = document.getElementById('pm-backlog-prog-text');
                    const progBar = document.getElementById('pm-backlog-prog-bar');
                    if (progText) {
                        progText.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 正在提炼 (${p.percent}%): 第 ${p.currentBatch}/${p.totalBatches} 批 (共沉淀 ${p.memCount} 条)...`;
                    }
                    if (progBar) {
                        progBar.style.width = `${p.percent}%`;
                    }
                }
            });

            if (res.success) {
                window.toastr?.success?.(`全量提炼完成！共处理 ${res.batchesProcessed} 个批次，当前记忆库共 ${res.totalMemories} 条！`, '持续记忆');
            } else if (res.aborted) {
                window.toastr?.warning?.(res.reason || '回溯提炼已中止', '持续记忆');
            } else {
                window.toastr?.error?.(`提炼异常: ${res.reason || res.error}`, '持续记忆');
            }
        } catch (e) {
            window.toastr?.error?.('回溯提炼失败: ' + e.message, '持续记忆');
        } finally {
            renderPanelContent();
            renderNativeDrawerContent();
        }
    }

    // 中途启用引导：一键从头全量提炼
    container.querySelector('#pm-btn-digest-all-start')?.addEventListener('click', () => {
        runBacklogDigestionUI(true);
    });

    // 头部回溯提炼按钮：支持从头全量或增量补全
    container.querySelector('#pm-btn-digest-backlog')?.addEventListener('click', () => {
        const state = getState();
        const hasMemories = state.memories && state.memories.length > 0;
        const fromStart = !hasMemories || confirm('是否从第 1 条消息从头全量提炼？\n【确定】从头全量提炼 (推荐中途启用用户)\n【取消】仅补全未提炼的增量楼层');
        runBacklogDigestionUI(fromStart);
    });

    // 中止全量回溯
    container.querySelector('#pm-btn-cancel-backlog')?.addEventListener('click', () => {
        abortBacklogDigest();
        window.toastr?.info?.('正在中止全量提炼...', '持续记忆');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 记忆数据导出与导入 (JSON 备份与跨会话迁移)
    // ─────────────────────────────────────────────────────────────────────────
    container.querySelector('#pm-export-memories-btn')?.addEventListener('click', () => {
        try {
            const data = exportMemoryData();
            const jsonStr = JSON.stringify(data, null, 2);
            const blob = new Blob([jsonStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const charName = data.character_name || 'Chat';
            const safeName = charName.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_');
            const dateStr = new Date().toISOString().slice(0, 10);
            a.href = url;
            a.download = `ST-Memory-${safeName}-${dateStr}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            window.toastr?.success?.(`已成功导出 ${data.memories.length} 条记忆数据！`, '持续记忆');
        } catch (err) {
            console.error('[st_persistent_memory] 导出记忆失败:', err);
            window.toastr?.error?.('导出记忆失败: ' + err.message, '持续记忆');
        }
    });

    const fileInput = container.querySelector('#pm-import-file-input');
    container.querySelector('#pm-import-memories-btn')?.addEventListener('click', () => {
        fileInput?.click();
    });

    fileInput?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const parsed = JSON.parse(event.target.result);
                const res = importMemoryData(parsed, 'merge');
                let msg = `成功导入 ${res.count} 条新记忆 (当前总数: ${res.total})`;
                if (res.aclRejected > 0) {
                    msg += `，${res.aclRejected} 条因非当前会话参战角色越权被安全拦截`;
                    window.toastr?.warning?.(msg, '持续记忆导入');
                } else {
                    window.toastr?.success?.(msg, '持续记忆');
                }
            } catch (err) {
                console.error('[st_persistent_memory] 导入记忆数据失败:', err);
                window.toastr?.error?.('导入失败: ' + (err.message || '文件格式畸形'), '持续记忆');
            } finally {
                fileInput.value = '';
            }
        };
        reader.readAsText(file);
    });
}

export {
    API_PRESETS,
    GAMEPLAY_PRESETS,
    applyGameplayPreset,
    initUI,
    resetBubblePosition,
    importSillyTavernApiConfig,
    togglePanel,
    renderMemoryCard,
    showPromoteLoreModal,
    showAdvancedSettingsModal,
    showInjectionInspectorModal,
    showMemoryLineageModal,
    showHistoricalSliceModal,
    getMemoryLineage,
    getLastInjectionSnapshot,
    restoreRecommendedDefaults,
    registerSlashCommands,
    executeRememberCommand,
    executeSceneCommand,
    executeInspectCommand,
    executeDigestCommand,
    setBubbleState,
    getBubbleState,
    executeForgetCommand,
    executePresetCommand,
    parseCommandArgs,
    SLASH_COMMAND_DEFINITIONS
};
