/**
 * UI 管理器 (v0.1.6)：原生扩展抽屉集成、屏幕快捷悬浮按钮（支持自由拖拽与持久化）与 HUD 侧边控制台
 * 全面升级：选项卡式现代工业风界面、大号高对比度数字显示、独立 API 完整配置与连通性测试
 */

import { MODULE_NAME, MEMORY_STATUS, MEMORY_LIFECYCLE, MEMORY_SCOPE } from './config.js';
import { getState, getSettings, updateSettings, updateScene, addMemory, deleteMemory, cycleMemoryStatus, onStateChange } from './state.js';
import { triggerAsyncDigest, testCustomApiConnection } from './extractor.js';

let panelEl = null;
let currentTab = 'memories'; // 'memories' | 'scene' | 'settings'

function escapeHtml(str) {
    if (!str || typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * 初始化 UI 并绑定事件
 */
export function initUI() {
    createPanelDOM();
    createFloatingButton();
    createNativeExtensionDrawer();
    onStateChange(() => {
        renderPanelContent();
        renderNativeDrawerContent();
    });
}

/**
 * 1. 注入屏幕快捷入口（悬浮气泡，支持任意拖拽与坐标记忆）
 */
function createFloatingButton() {
    if (document.getElementById('pm-floating-bubble')) return;

    const btn = document.createElement('div');
    btn.id = 'pm-floating-bubble';
    btn.className = 'pm-floating-bubble';
    btn.title = '持续记忆系统 (可拖拽，点击打开 HUD 面板)';
    btn.innerHTML = '<i class="fa-solid fa-brain"></i>';

    // 绑定拖拽逻辑
    makeDraggable(btn, () => {
        togglePanel();
    });

    document.body.appendChild(btn);
}

/**
 * 拖拽核心算法：支持边缘保护、点击/拖动区分、触控与坐标持久化
 */
function makeDraggable(el, onClickCallback) {
    let isDragging = false;
    let hasMoved = false;
    let startX = 0, startY = 0;
    let initialX = 0, initialY = 0;

    // 恢复历史记忆位置
    try {
        const saved = localStorage.getItem('pm_bubble_pos');
        if (saved) {
            const { x, y } = JSON.parse(saved);
            const maxX = Math.max(10, window.innerWidth - 60);
            const maxY = Math.max(10, window.innerHeight - 60);
            const clampedX = Math.min(Math.max(10, x), maxX);
            const clampedY = Math.min(Math.max(10, y), maxY);
            el.style.left = `${clampedX}px`;
            el.style.top = `${clampedY}px`;
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        }
    } catch {}

    const onStart = (e) => {
        isDragging = true;
        hasMoved = false;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        startX = clientX;
        startY = clientY;

        const rect = el.getBoundingClientRect();
        initialX = rect.left;
        initialY = rect.top;

        el.style.transition = 'none';
        el.classList.add('pm-dragging');

        window.addEventListener('mousemove', onMove, { passive: false });
        window.addEventListener('mouseup', onEnd);
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', onEnd);
    };

    const onMove = (e) => {
        if (!isDragging) return;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const dx = clientX - startX;
        const dy = clientY - startY;

        if (Math.hypot(dx, dy) > 5) {
            hasMoved = true;
            if (e.cancelable) e.preventDefault();
        }

        if (!hasMoved) return;

        let newX = initialX + dx;
        let newY = initialY + dy;

        const maxX = window.innerWidth - el.offsetWidth;
        const maxY = window.innerHeight - el.offsetHeight;
        newX = Math.min(Math.max(0, newX), maxX);
        newY = Math.min(Math.max(0, newY), maxY);

        el.style.left = `${newX}px`;
        el.style.top = `${newY}px`;
        el.style.right = 'auto';
        el.style.bottom = 'auto';
    };

    const onEnd = () => {
        if (!isDragging) return;
        isDragging = false;
        el.style.transition = '';
        el.classList.remove('pm-dragging');

        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onEnd);
        window.removeEventListener('touchmove', onMove);
        window.removeEventListener('touchend', onEnd);

        if (hasMoved) {
            const rect = el.getBoundingClientRect();
            try {
                localStorage.setItem('pm_bubble_pos', JSON.stringify({ x: rect.left, y: rect.top }));
            } catch {}
        }
    };

    el.addEventListener('mousedown', onStart);
    el.addEventListener('touchstart', onStart, { passive: true });

    el.addEventListener('click', (e) => {
        if (hasMoved) {
            e.stopImmediatePropagation();
            e.preventDefault();
            hasMoved = false;
            return;
        }
        onClickCallback?.();
    });
}

/**
 * 2. 注入 SillyTavern 原生扩展面板 (#extensions_settings)
 */
function createNativeExtensionDrawer() {
    const container = document.getElementById('extensions_settings');
    if (!container) return;

    if (document.getElementById('pm-native-container')) return;

    const drawerWrapper = document.createElement('div');
    drawerWrapper.id = 'pm-native-container';
    drawerWrapper.className = 'extension_container inline-drawer';
    drawerWrapper.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b><i class="fa-solid fa-brain" style="color: #a78bfa;"></i> 持续记忆 (Persistent Memory)</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
        </div>
        <div class="inline-drawer-content" id="pm-native-content">
            <!-- 动态渲染设置与快速状态 -->
        </div>
    `;

    container.appendChild(drawerWrapper);

    const toggle = drawerWrapper.querySelector('.inline-drawer-toggle');
    const content = drawerWrapper.querySelector('.inline-drawer-content');
    const icon = drawerWrapper.querySelector('.inline-drawer-icon');

    toggle?.addEventListener('click', () => {
        content?.classList.toggle('pm-native-open');
        icon?.classList.toggle('fa-circle-chevron-up');
        icon?.classList.toggle('fa-circle-chevron-down');
    });

    renderNativeDrawerContent();
}

/**
 * 渲染原生扩展面板里的内容
 */
function renderNativeDrawerContent() {
    const content = document.getElementById('pm-native-content');
    if (!content) return;

    const settings = getSettings();
    const state = getState();
    const scene = state.scene || {};
    const memories = state.memories || [];

    content.innerHTML = `
        <div class="pm-native-box">
            <div class="flex-container alignitemscenter wide100p pm-mb-8">
                <label class="checkbox_label flex1" style="font-weight: 700; color: #f8fafc;">
                    <input type="checkbox" id="pm-setting-enabled" ${settings.enabled ? 'checked' : ''}>
                    <span>启用持续记忆</span>
                </label>
                <button id="pm-open-hud-btn" class="menu_button menu_button_icon">
                    <i class="fa-solid fa-arrow-up-right-from-square"></i> 打开完整控制台 (HUD)
                </button>
            </div>

            <!-- 独立提炼 API 直连配置 (原生抽屉同步) -->
            <div style="background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; padding: 10px; margin-bottom: 10px;">
                <div class="flex-container alignitemscenter wide100p pm-mb-8">
                    <label class="checkbox_label flex1" style="color: #38bdf8; font-weight: 700;">
                        <input type="checkbox" id="pm-native-custom-api-enabled" ${settings.useCustomApi ? 'checked' : ''}>
                        <span><i class="fa-solid fa-bolt"></i> 启用独立提炼 API (直连 DeepSeek / 本地模型)</span>
                    </label>
                </div>
                <div id="pm-native-custom-api-body" style="${settings.useCustomApi ? '' : 'display: none;'}">
                    <div class="pm-input-row pm-mb-4">
                        <label class="pm-input-label">Base URL (例如 https://api.deepseek.com/v1):</label>
                        <input type="text" id="pm-native-custom-api-url" class="pm-input" value="${escapeHtml(settings.customApiUrl || '')}" placeholder="https://api.deepseek.com/v1">
                    </div>
                    <div class="pm-grid-2col pm-mb-4">
                        <div class="pm-input-row">
                            <label class="pm-input-label">API Key:</label>
                            <input type="password" id="pm-native-custom-api-key" class="pm-input" value="${escapeHtml(settings.customApiKey || '')}" placeholder="sk-...">
                        </div>
                        <div class="pm-input-row">
                            <label class="pm-input-label">模型名称:</label>
                            <input type="text" id="pm-native-custom-api-model" class="pm-input" value="${escapeHtml(settings.customApiModel || 'deepseek-chat')}" placeholder="deepseek-chat">
                        </div>
                    </div>
                    <div style="display: flex; gap: 8px; align-items: center; margin-top: 6px;">
                        <button id="pm-native-test-api-btn" class="pm-btn-test">
                            <i class="fa-solid fa-plug"></i> 测试 API 连通性
                        </button>
                        <span id="pm-native-test-res" style="font-size: 11px; font-weight: 600;"></span>
                    </div>
                </div>
            </div>

            <div class="pm-input-row pm-mb-8">
                <label class="pm-input-label">提炼运行模式：</label>
                <div class="pm-toggle-group">
                    <label class="pm-radio-label">
                        <input type="radio" name="pm-native-mode" value="async" ${settings.mode === 'async' ? 'checked' : ''}>
                        <span>异步后台 (安静提炼)</span>
                    </label>
                    <label class="pm-radio-label">
                        <input type="radio" name="pm-native-mode" value="sync" ${settings.mode === 'sync' ? 'checked' : ''}>
                        <span>伴随标签 (零额外请求)</span>
                    </label>
                </div>
            </div>

            <div class="pm-input-row pm-mb-8">
                <label class="pm-input-label">最新提炼动态：</label>
                <div style="background: rgba(0,0,0,0.35); padding: 8px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.08); font-size: 12px; color: #38bdf8; font-weight: 600;">
                    ${escapeHtml(state.last_digest_summary || '尚未执行提炼')} ${state.last_digest_time ? `<span style="color: #94a3b8; font-weight: 400;">(${state.last_digest_time})</span>` : ''}
                </div>
            </div>

            <div class="pm-input-row pm-mb-8">
                <label class="pm-input-label">现场快照与状态版本：</label>
                <div style="background: rgba(0,0,0,0.35); padding: 8px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.08); font-size: 12px; color: #f8fafc;">
                    修订: <b style="color: #c084fc;">rev.${state.state_revision || 0}</b> | 地点: <b style="color: #38bdf8;">${escapeHtml(scene.location || '未知')}</b> | 记忆: <b style="color: #10b981;">${memories.length}</b> 条
                </div>
            </div>

            <div class="flex-container flexGap10 pm-mt-8">
                <button id="pm-native-digest-btn" class="menu_button menu_button_icon flex1" style="font-weight: 700;">
                    <i class="fa-solid fa-bolt"></i> 立即执行后台提炼
                </button>
            </div>
        </div>
    `;

    // 绑定原生事件
    content.querySelector('#pm-setting-enabled')?.addEventListener('change', (e) => {
        updateSettings({ enabled: e.target.checked });
    });

    content.querySelector('#pm-open-hud-btn')?.addEventListener('click', () => {
        togglePanel(true);
    });

    content.querySelectorAll('input[name="pm-native-mode"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            updateSettings({ mode: e.target.value });
        });
    });

    content.querySelector('#pm-native-custom-api-enabled')?.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        const body = content.querySelector('#pm-native-custom-api-body');
        if (body) body.style.display = isChecked ? '' : 'none';
        updateSettings({ useCustomApi: isChecked });
    });

    content.querySelector('#pm-native-custom-api-url')?.addEventListener('change', (e) => {
        updateSettings({ customApiUrl: e.target.value.trim() });
    });

    content.querySelector('#pm-native-custom-api-key')?.addEventListener('change', (e) => {
        updateSettings({ customApiKey: e.target.value.trim() });
    });

    content.querySelector('#pm-native-custom-api-model')?.addEventListener('change', (e) => {
        updateSettings({ customApiModel: e.target.value.trim() || 'deepseek-chat' });
    });

    content.querySelector('#pm-native-test-api-btn')?.addEventListener('click', async () => {
        const resEl = content.querySelector('#pm-native-test-res');
        if (resEl) {
            resEl.style.color = '#38bdf8';
            resEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 测试中...';
        }
        const res = await testCustomApiConnection();
        if (res.success) {
            if (resEl) {
                resEl.style.color = '#34d399';
                resEl.innerHTML = `<i class="fa-solid fa-check"></i> 连通正常 (${res.latency}ms)`;
            }
            window.toastr?.success?.(`API 连接成功！延时 ${res.latency}ms，模型: ${res.model}`, '持续记忆');
        } else {
            if (resEl) {
                resEl.style.color = '#f87171';
                resEl.innerHTML = `<i class="fa-solid fa-xmark"></i> 失败: ${escapeHtml(res.error).slice(0, 30)}`;
            }
            window.toastr?.error?.(res.error, 'API 连接失败');
        }
    });

    content.querySelector('#pm-native-digest-btn')?.addEventListener('click', async () => {
        const btn = content.querySelector('#pm-native-digest-btn');
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 提炼中...';
        window.toastr?.info?.('后台提炼任务已启动...', '持续记忆');
        const res = await triggerAsyncDigest(true);
        btn.innerHTML = '<i class="fa-solid fa-bolt"></i> 立即执行后台提炼';
        renderNativeDrawerContent();
        renderPanelContent();
        if (res?.success) {
            window.toastr?.success?.(res.summary || '提炼完成', '持续记忆');
        } else {
            window.toastr?.warning?.(res?.error || '提炼未产生有效更新', '持续记忆');
        }
    });
}

/**
 * 3. 创建主抽屉 HUD 控制台 DOM (带导航 Tab)
 */
function createPanelDOM() {
    if (document.getElementById('pm-drawer-panel')) return;

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
export function togglePanel(show) {
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
 * 估算记忆库大概消耗的 Token
 */
function estimateTokens(str) {
    if (!str) return 0;
    return Math.ceil(str.length / 2.5);
}

/**
 * 渲染主抽屉面板内部组件
 */
function renderPanelContent() {
    const body = document.getElementById('pm-panel-body');
    if (!body) return;

    const state = getState();
    const settings = getSettings();
    const scene = state.scene || {};
    const memories = state.memories || [];

    // 更新顶部 Header 状态胶囊
    const badgesEl = document.getElementById('pm-header-badges');
    if (badgesEl) {
        badgesEl.innerHTML = `
            <span class="pm-hero-pill pm-pill-cyan">rev.<b>${state.state_revision || 0}</b></span>
            <span class="pm-hero-pill pm-pill-purple"><b>${memories.length}</b> 条</span>
        `;
    }

    const pinnedCount = memories.filter(m => m.status === MEMORY_STATUS.PINNED).length;
    const triggeredCount = memories.filter(m => m.status === MEMORY_STATUS.TRIGGERED).length;
    const archivedCount = memories.filter(m => m.status === MEMORY_STATUS.ARCHIVED).length;

    // 粗估活跃记忆的 Token 占用
    let activeTokenEstimate = 0;
    memories.filter(m => m.status !== MEMORY_STATUS.ARCHIVED).forEach(m => {
        activeTokenEstimate += estimateTokens(m.content) + 12;
    });

    let tabHtml = '';

    // ─────────────────────────────────────────────────────────────────────────
    // TAB 1: 记忆流 (Memories)
    // ─────────────────────────────────────────────────────────────────────────
    if (currentTab === 'memories') {
        const memCardsHtml = memories.length > 0
            ? memories.map(renderMemoryCard).join('')
            : '<div class="pm-empty-hint"><i class="fa-solid fa-box-open" style="font-size: 24px; margin-bottom: 6px; display: block; opacity: 0.5;"></i>记忆库暂无条目，等待对话提炼或从下方快速添加</div>';

        tabHtml = `
            <!-- 统计数据横幅 (大号清晰数字) -->
            <div class="pm-stats-banner">
                <div class="pm-stat-box">
                    <span class="pm-stat-label"><i class="fa-solid fa-thumbtack"></i> 常驻记忆</span>
                    <span class="pm-stat-value pm-text-amber">${pinnedCount} <span style="font-size: 11px; font-weight: 500; color: #64748b;">/ 5</span></span>
                </div>
                <div class="pm-stat-box">
                    <span class="pm-stat-label"><i class="fa-solid fa-bolt"></i> 动态触发</span>
                    <span class="pm-stat-value pm-text-emerald">${triggeredCount} <span style="font-size: 11px; font-weight: 500; color: #64748b;">/ 5</span></span>
                </div>
                <div class="pm-stat-box">
                    <span class="pm-stat-label"><i class="fa-solid fa-gauge-high"></i> 估算占用</span>
                    <span class="pm-stat-value pm-text-sky">~${activeTokenEstimate} <span style="font-size: 11px; font-weight: 500; color: #64748b;">/ ${settings.maxTotalMemoryTokens || 450}T</span></span>
                </div>
            </div>

            <!-- 记忆列表 -->
            <div class="pm-section-card" style="flex: 1; display: flex; flex-direction: column;">
                <div class="pm-section-header">
                    <span class="pm-section-title"><i class="fa-solid fa-list-check" style="color: #a78bfa;"></i> 记忆条目清单 (${memories.length})</span>
                    <span style="font-size: 11px; color: #94a3b8;">归档 ${archivedCount} 条</span>
                </div>
                <div class="pm-mem-list" id="pm-mem-list-container">
                    ${memCardsHtml}
                </div>
            </div>

            <!-- 快捷添加面板 -->
            <div class="pm-quick-box">
                <div class="pm-section-title pm-mb-8">
                    <i class="fa-solid fa-plus-circle" style="color: #38bdf8;"></i> 手动新增记忆条目
                </div>
                <div class="pm-input-row">
                    <input type="text" id="pm-new-mem-content" class="pm-input" placeholder="输入一句话记忆事实 (例如: 两人曾约定明晚在白马寺汇合)">
                </div>
                <div class="pm-grid-2col pm-mb-8">
                    <div class="pm-input-row" style="margin-bottom: 0;">
                        <label class="pm-input-label">触发关键词 (逗号隔开):</label>
                        <input type="text" id="pm-new-mem-keys" class="pm-input" placeholder="白马寺, 汇合">
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
                <div class="pm-input-row" id="pm-target-row" style="margin-bottom: 8px;">
                    <label class="pm-input-label">关联/知情角色 (逗号隔开，留空自动匹配):</label>
                    <input type="text" id="pm-new-mem-target" class="pm-input" placeholder="例如: 武大郎, 潘金莲">
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

        tabHtml = `
            <div class="pm-section-card">
                <div class="pm-section-header">
                    <span class="pm-section-title"><i class="fa-solid fa-map-location-dot" style="color: #38bdf8;"></i> L0 现场快照 (Scene State)</span>
                    <span class="pm-hero-pill pm-pill-cyan">每轮必带置顶</span>
                </div>
                <div style="font-size: 11px; color: #94a3b8; margin-bottom: 12px; line-height: 1.4;">
                    记录当前正在发生的客观局势。拥有独立硬 Token 预算（上限 ~${settings.maxSceneTokens || 150}），绝不遗忘此时此刻。
                </div>

                <div class="pm-input-row">
                    <label class="pm-input-label"><i class="fa-solid fa-location-dot"></i> 当前地点环境:</label>
                    <input type="text" id="pm-scene-location" class="pm-input" value="${escapeHtml(scene.location || '')}" placeholder="例如: 阳谷县临街炊饼铺内堂">
                </div>

                <div class="pm-input-row">
                    <label class="pm-input-label"><i class="fa-solid fa-clock"></i> 当前时段与天气环境:</label>
                    <input type="text" id="pm-scene-time" class="pm-input" value="${escapeHtml(scene.time || '')}" placeholder="例如: 傍晚时分，窗外细雨蒙蒙">
                </div>

                <div class="pm-input-row">
                    <label class="pm-input-label"><i class="fa-solid fa-person-running"></i> 当前正在进行的动作:</label>
                    <input type="text" id="pm-scene-action" class="pm-input" value="${escapeHtml(scene.action || '')}" placeholder="例如: 两人坐在桌前，正端起茶碗饮用">
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
            <!-- ⚡ 独立提炼 API 端点配置 (解决主会话脚本冲突与思维链 400 报错) -->
            <div class="pm-section-card" style="border: 1px solid rgba(56, 189, 248, 0.4); background: rgba(14, 165, 233, 0.05);">
                <div class="pm-section-header">
                    <span class="pm-section-title" style="color: #38bdf8;">
                        <i class="fa-solid fa-server"></i> 独立提炼 API 端点 (强烈推荐)
                    </span>
                    <label class="checkbox_label" style="cursor: pointer; font-weight: 700; color: #38bdf8;">
                        <input type="checkbox" id="pm-setting-custom-api-enabled" ${settings.useCustomApi ? 'checked' : ''}>
                        <span>启用独立直连</span>
                    </label>
                </div>
                <div style="font-size: 11px; color: #cbd5e1; margin-bottom: 12px; line-height: 1.5;">
                    提炼任务走专属 API 发送，<b>完全脱离酒馆主聊天链路</b>。彻底解决 DeepSeek 思维链丢失 400 报错、避免主聊天复杂脚本干扰，并大幅节省 Token！
                </div>

                <div id="pm-custom-api-fields" style="${settings.useCustomApi ? '' : 'display: none;'}">
                    <div class="pm-input-row">
                        <label class="pm-input-label">API Base URL:</label>
                        <input type="text" id="pm-setting-custom-api-url" class="pm-input" value="${escapeHtml(settings.customApiUrl || '')}" placeholder="https://api.deepseek.com/v1">
                    </div>

                    <div class="pm-grid-2col pm-mb-8">
                        <div class="pm-input-row" style="margin-bottom: 0;">
                            <label class="pm-input-label">API Key (密钥):</label>
                            <input type="password" id="pm-setting-custom-api-key" class="pm-input" value="${escapeHtml(settings.customApiKey || '')}" placeholder="sk-...">
                        </div>
                        <div class="pm-input-row" style="margin-bottom: 0;">
                            <label class="pm-input-label">模型名称:</label>
                            <input type="text" id="pm-setting-custom-api-model" class="pm-input" value="${escapeHtml(settings.customApiModel || 'deepseek-chat')}" placeholder="deepseek-chat">
                        </div>
                    </div>

                    <div style="display: flex; gap: 10px; align-items: center; margin-top: 10px;">
                        <button id="pm-btn-test-api" class="pm-btn-test">
                            <i class="fa-solid fa-plug"></i> 测试 API 连通性
                        </button>
                        <span id="pm-api-test-status" style="font-size: 12px; font-weight: 600;"></span>
                    </div>
                </div>
            </div>

            <!-- 核心参数与 Token 预算 -->
            <div class="pm-section-card">
                <div class="pm-section-header">
                    <span class="pm-section-title"><i class="fa-solid fa-sliders" style="color: #a78bfa;"></i> 提炼参数与 Token 硬预算</span>
                </div>

                <div class="pm-input-row pm-mb-8">
                    <label class="pm-input-label">提炼模式：</label>
                    <div class="pm-toggle-group">
                        <label class="pm-radio-label">
                            <input type="radio" name="pm-mode" value="async" ${settings.mode === 'async' ? 'checked' : ''}>
                            <span>异步后台 (安静提炼)</span>
                        </label>
                        <label class="pm-radio-label">
                            <input type="radio" name="pm-mode" value="sync" ${settings.mode === 'sync' ? 'checked' : ''}>
                            <span>伴随标签 (零额外请求)</span>
                        </label>
                    </div>
                </div>

                <div class="pm-grid-2col pm-mb-8">
                    <div class="pm-input-row">
                        <label class="pm-input-label">提炼频率 (每 N 轮):</label>
                        <input type="number" id="pm-setting-freq" class="pm-input" min="1" max="20" value="${settings.asyncFrequency || 3}">
                    </div>
                    <div class="pm-input-row">
                        <label class="pm-input-label">历史回溯 (条数):</label>
                        <input type="number" id="pm-setting-slice" class="pm-input" min="2" max="15" value="${settings.digestSliceCount || 6}">
                    </div>
                </div>

                <div class="pm-grid-2col pm-mb-8">
                    <div class="pm-input-row">
                        <label class="pm-input-label">现场快照上限 (Tok):</label>
                        <input type="number" id="pm-setting-scene-tokens" class="pm-input" min="50" max="500" value="${settings.maxSceneTokens || 150}">
                    </div>
                    <div class="pm-input-row">
                        <label class="pm-input-label">记忆总 Token 预算:</label>
                        <input type="number" id="pm-setting-tokens" class="pm-input" min="150" max="2000" value="${settings.maxTotalMemoryTokens || 450}">
                    </div>
                </div>
            </div>
        `;
    }

    body.innerHTML = tabHtml;
    bindPanelEvents(body);
}

/**
 * 渲染单个记忆卡片
 */
function renderMemoryCard(mem) {
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

    return `
        <div class="pm-card" data-id="${escapeHtml(mem.id)}">
            <div class="pm-card-top">
                <button class="pm-status-chip ${statusClass}" title="点击切换：常驻 / 触发 / 归档" data-action="cycle">
                    ${statusIcon}
                </button>
                <span class="pm-type-badge">${escapeHtml(mem.type || 'fact')}</span>
                <span class="pm-scope-badge ${scopeClass}">${scopeLabel}</span>
                ${lifecycleBadge}
                <div class="pm-card-actions">
                    <button class="pm-del-btn" title="删除此条记忆" data-action="delete"><i class="fa-solid fa-trash-can"></i></button>
                </div>
            </div>
            <div class="pm-card-content">${escapeHtml(mem.content)}</div>
            ${keysHtml ? `<div class="pm-card-keys">${keysHtml}</div>` : ''}
        </div>
    `;
}

/**
 * 绑定主面板事件
 */
function bindPanelEvents(container) {
    // 切换模式
    container.querySelectorAll('input[name="pm-mode"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            updateSettings({ mode: e.target.value });
        });
    });

    // 提炼参数与 Token 预算
    container.querySelector('#pm-setting-freq')?.addEventListener('change', (e) => {
        const val = Math.max(1, parseInt(e.target.value) || 3);
        updateSettings({ asyncFrequency: val });
    });

    container.querySelector('#pm-setting-slice')?.addEventListener('change', (e) => {
        const val = Math.max(2, Math.min(15, parseInt(e.target.value) || 6));
        updateSettings({ digestSliceCount: val });
    });

    container.querySelector('#pm-setting-tokens')?.addEventListener('change', (e) => {
        const val = Math.max(150, Math.min(2000, parseInt(e.target.value) || 450));
        updateSettings({ maxTotalMemoryTokens: val });
    });

    container.querySelector('#pm-setting-scene-tokens')?.addEventListener('change', (e) => {
        const val = Math.max(50, Math.min(500, parseInt(e.target.value) || 150));
        updateSettings({ maxSceneTokens: val });
    });

    // 独立提炼 API 配置监听
    container.querySelector('#pm-setting-custom-api-enabled')?.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        const fields = container.querySelector('#pm-custom-api-fields');
        if (fields) fields.style.display = isChecked ? '' : 'none';
        updateSettings({ useCustomApi: isChecked });
    });

    container.querySelector('#pm-setting-custom-api-url')?.addEventListener('change', (e) => {
        updateSettings({ customApiUrl: e.target.value.trim() });
    });

    container.querySelector('#pm-setting-custom-api-key')?.addEventListener('change', (e) => {
        updateSettings({ customApiKey: e.target.value.trim() });
    });

    container.querySelector('#pm-setting-custom-api-model')?.addEventListener('change', (e) => {
        updateSettings({ customApiModel: e.target.value.trim() || 'deepseek-chat' });
    });

    // 测试 API 连通性
    container.querySelector('#pm-btn-test-api')?.addEventListener('click', async () => {
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

    // 保存快照
    container.querySelector('#pm-save-scene-btn')?.addEventListener('click', () => {
        const rawLocation = container.querySelector('#pm-scene-location')?.value || '';
        const rawTime = container.querySelector('#pm-scene-time')?.value || '';
        const rawAction = container.querySelector('#pm-scene-action')?.value || '';
        const rawTension = container.querySelector('#pm-scene-tension')?.value || '';
        const rawUnresolved = container.querySelector('#pm-scene-unresolved')?.value || '';
        const rawChars = container.querySelector('#pm-scene-characters')?.value?.trim() || '';

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
        });
        const btn = container.querySelector('#pm-save-scene-btn');
        if (btn) {
            btn.innerHTML = '<i class="fa-solid fa-check-double"></i> 快照已保存';
            setTimeout(() => { btn.innerHTML = '<i class="fa-solid fa-check"></i> 保存快照变更'; }, 1500);
        }
        window.toastr?.success?.('现场快照已更新保存', '持续记忆');
    });

    // 添加记忆
    container.querySelector('#pm-add-mem-btn')?.addEventListener('click', () => {
        const contentInput = container.querySelector('#pm-new-mem-content');
        const keysInput = container.querySelector('#pm-new-mem-keys');
        const scopeSelect = container.querySelector('#pm-new-mem-scope');
        const targetInput = container.querySelector('#pm-new-mem-target');

        const content = contentInput?.value?.trim();
        if (!content) return;

        const keys = (keysInput?.value || '').split(/[,，]/).map(k => k.trim()).filter(Boolean);
        const scope = scopeSelect?.value || 'world';
        const targets = (targetInput?.value || '').split(/[,，]/).map(k => k.trim()).filter(Boolean);

        const state = getState();
        const c = window.SillyTavern?.getContext?.();
        const curCharName = c?.characters?.[c?.this_chid]?.name || '角色';

        let memData = {
            content: content,
            trigger_keys: keys,
            scope: scope,
            status: MEMORY_STATUS.TRIGGERED
        };

        if (scope === 'character') {
            memData.character = targets[0] || curCharName;
        } else if (scope === 'shared') {
            memData.known_by = targets.length > 0 ? targets : (Array.isArray(state.scene.in_scene_characters) && state.scene.in_scene_characters.length > 0 ? state.scene.in_scene_characters : [curCharName, c?.name1 || 'User']);
        }

        const added = addMemory(memData);
        if (added) {
            window.toastr?.success?.(`已录入记忆: "${content.slice(0, 15)}..."`, '持续记忆');
        }

        contentInput.value = '';
        keysInput.value = '';
        if (targetInput) targetInput.value = '';
    });

    // 卡片动作 (点击切换状态 / 删除)
    container.querySelectorAll('.pm-card').forEach(card => {
        const id = card.getAttribute('data-id');
        card.querySelector('[data-action="cycle"]')?.addEventListener('click', () => {
            cycleMemoryStatus(id);
        });
        card.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
            deleteMemory(id);
        });
    });
}
