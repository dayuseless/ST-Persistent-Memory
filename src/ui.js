/**
 * UI 管理器：原生扩展抽屉集成、屏幕快捷悬浮按钮（支持自由拖拽与持久化）与 HUD 侧边控制台
 */

import { MODULE_NAME, MEMORY_STATUS } from './config.js';
import { getState, getSettings, updateSettings, updateScene, addMemory, deleteMemory, cycleMemoryStatus, onStateChange } from './state.js';
import { triggerAsyncDigest } from './extractor.js';

let panelEl = null;

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
    btn.title = '持续记忆系统 (可拖动，点击打开控制台)';
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

    // 捕获阶段拦截点击：拖动过则不触发弹窗
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
                <label class="checkbox_label flex1">
                    <input type="checkbox" id="pm-setting-enabled" ${settings.enabled ? 'checked' : ''}>
                    <span>启用持续记忆</span>
                </label>
                <button id="pm-open-hud-btn" class="menu_button menu_button_icon">
                    <i class="fa-solid fa-arrow-up-right-from-square"></i> 打开完整 HUD 面板
                </button>
            </div>

            <div class="pm-input-row pm-mb-8">
                <label>运行模式：</label>
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
                <label>当前现场地点：</label>
                <div class="pm-text-preview">${escapeHtml(scene.location || '（尚未记录地点）')}</div>
            </div>

            <div class="pm-input-row pm-mb-8">
                <label>记忆条目概览：</label>
                <div class="pm-text-preview">共 ${memories.length} 条记忆（${memories.filter(m => m.status === 'pinned').length} 条常驻，${memories.filter(m => m.status === 'triggered').length} 条条件触发）</div>
            </div>

            <div class="flex-container flexGap10 pm-mt-8">
                <button id="pm-native-digest-btn" class="menu_button menu_button_icon flex1">
                    <i class="fa-solid fa-bolt"></i> 立即执行后台提炼
                </button>
            </div>
        </div>
    `;

    content.querySelector('#pm-setting-enabled')?.addEventListener('change', (e) => {
        updateSettings({ enabled: e.target.checked });
    });

    content.querySelectorAll('input[name="pm-native-mode"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            updateSettings({ mode: e.target.value });
        });
    });

    content.querySelector('#pm-open-hud-btn')?.addEventListener('click', () => {
        togglePanel(true);
    });

    content.querySelector('#pm-native-digest-btn')?.addEventListener('click', async () => {
        const btn = content.querySelector('#pm-native-digest-btn');
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 提炼中...';
        await triggerAsyncDigest(true);
        btn.innerHTML = '<i class="fa-solid fa-bolt"></i> 立即执行后台提炼';
    });
}

/**
 * 3. 创建主抽屉 HUD 控制台 DOM
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
                <span class="pm-title-text">持续记忆控制台 (HUD)</span>
            </div>
            <div class="pm-header-actions">
                <button id="pm-manual-digest-btn" class="pm-btn-icon" title="立即触发后台提炼"><i class="fa-solid fa-bolt"></i></button>
                <button id="pm-close-btn" class="pm-btn-icon" title="关闭"><i class="fa-solid fa-xmark"></i></button>
            </div>
        </div>
        <div class="pm-panel-body" id="pm-panel-body">
            <!-- 动态渲染内容 -->
        </div>
    `;

    document.body.appendChild(panelEl);

    panelEl.querySelector('#pm-close-btn')?.addEventListener('click', () => togglePanel(false));
    panelEl.querySelector('#pm-manual-digest-btn')?.addEventListener('click', async () => {
        const btn = panelEl.querySelector('#pm-manual-digest-btn');
        btn.classList.add('pm-spinning');
        await triggerAsyncDigest(true);
        btn.classList.remove('pm-spinning');
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
 * 渲染主抽屉面板内部组件
 */
function renderPanelContent() {
    const body = document.getElementById('pm-panel-body');
    if (!body) return;

    const state = getState();
    const settings = getSettings();
    const scene = state.scene || {};
    const memories = state.memories || [];

    const pinnedCount = memories.filter(m => m.status === MEMORY_STATUS.PINNED).length;
    const triggeredCount = memories.filter(m => m.status === MEMORY_STATUS.TRIGGERED).length;

    body.innerHTML = `
        <!-- 运行模式设置 -->
        <div class="pm-section pm-mode-selector">
            <div class="pm-flex-between">
                <span class="pm-section-label">运行模式</span>
                <div class="pm-toggle-group">
                    <label class="pm-radio-label">
                        <input type="radio" name="pm-mode" value="async" ${settings.mode === 'async' ? 'checked' : ''}>
                        <span>异步后台</span>
                    </label>
                    <label class="pm-radio-label">
                        <input type="radio" name="pm-mode" value="sync" ${settings.mode === 'sync' ? 'checked' : ''}>
                        <span>伴随标签</span>
                    </label>
                </div>
            </div>
        </div>

        <!-- 现场快照 HUD -->
        <div class="pm-section">
            <div class="pm-flex-between pm-mb-8">
                <span class="pm-section-label"><i class="fa-solid fa-map-location-dot"></i> 现场快照 (Scene State)</span>
                <span class="pm-badge-pill">L0 状态</span>
            </div>
            <div class="pm-scene-grid">
                <div class="pm-input-row">
                    <label>地点 / 时段</label>
                    <input type="text" id="pm-scene-location" class="pm-input" value="${escapeHtml(scene.location || '')}" placeholder="例如: 港口酒馆二楼 (暴雨深夜)">
                </div>
                <div class="pm-input-row">
                    <label>当前动作 / 焦点</label>
                    <input type="text" id="pm-scene-action" class="pm-input" value="${escapeHtml(scene.action || '')}" placeholder="例如: 两人坐在壁炉旁低声交谈">
                </div>
                <div class="pm-input-row">
                    <label>即时气氛 / 张力</label>
                    <input type="text" id="pm-scene-tension" class="pm-input" value="${escapeHtml(scene.tension || '')}" placeholder="例如: 戒备逐渐缓解，各怀心事">
                </div>
                <div class="pm-input-row">
                    <label>未决悬念 / 冲突</label>
                    <input type="text" id="pm-scene-unresolved" class="pm-input" value="${escapeHtml(scene.unresolved || '')}" placeholder="例如: 尚未挑明那枚徽章的真正来历">
                </div>
                <div class="pm-input-row">
                    <label>在场角色 (逗号分隔)</label>
                    <input type="text" id="pm-scene-characters" class="pm-input" value="${escapeHtml((scene.in_scene_characters || []).join(', '))}" placeholder="留空则自动检测">
                </div>
            </div>
            <button id="pm-save-scene-btn" class="pm-btn-primary pm-mt-8"><i class="fa-solid fa-check"></i> 保存快照变更</button>
        </div>

        <!-- 记忆条目列表 -->
        <div class="pm-section">
            <div class="pm-flex-between pm-mb-8">
                <span class="pm-section-label"><i class="fa-solid fa-database"></i> 记忆档案库 (${memories.length})</span>
                <div class="pm-stats-hint">
                    <span class="pm-tag-pin">📌 ${pinnedCount} 常驻</span>
                    <span class="pm-tag-trig">⚡ ${triggeredCount} 激活</span>
                </div>
            </div>

            <!-- 快捷添加 -->
            <div class="pm-add-box">
                <input type="text" id="pm-new-mem-content" class="pm-input" placeholder="输入一条重要事实、约定或认知...">
                <div class="pm-flex-between pm-mt-4">
                    <input type="text" id="pm-new-mem-keys" class="pm-input pm-flex-1 pm-mr-4" placeholder="触发词(逗号隔开，可选)">
                    <button id="pm-add-mem-btn" class="pm-btn-secondary"><i class="fa-solid fa-plus"></i> 添加</button>
                </div>
            </div>

            <!-- 卡片列表 -->
            <div class="pm-mem-list">
                ${memories.length === 0 ? '<div class="pm-empty-hint">暂无沉淀记忆，将随对话自动生成</div>' : ''}
                ${memories.map(m => renderMemoryCard(m)).join('')}
            </div>
        </div>
    `;

    bindPanelEvents(body);
}

function renderMemoryCard(mem) {
    let statusClass = 'pm-chip-triggered';
    let statusIcon = '⚡ 触发';
    if (mem.status === MEMORY_STATUS.PINNED) {
        statusClass = 'pm-chip-pinned';
        statusIcon = '📌 常驻';
    } else if (mem.status === MEMORY_STATUS.ARCHIVED) {
        statusClass = 'pm-chip-archived';
        statusIcon = '💤 归档';
    }

    const keysHtml = (mem.trigger_keys || []).map(k => `<span class="pm-key-pill">${escapeHtml(k)}</span>`).join('');

    return `
        <div class="pm-card" data-id="${mem.id}">
            <div class="pm-card-top">
                <button class="pm-status-chip ${statusClass}" title="点击切换：常驻 / 触发 / 归档" data-action="cycle">
                    ${statusIcon}
                </button>
                <span class="pm-type-badge">${escapeHtml(mem.type || 'fact')}</span>
                <div class="pm-card-actions">
                    <button class="pm-del-btn" title="删除此条记忆" data-action="delete"><i class="fa-solid fa-trash-can"></i></button>
                </div>
            </div>
            <div class="pm-card-content">${escapeHtml(mem.content)}</div>
            ${keysHtml ? `<div class="pm-card-keys">${keysHtml}</div>` : ''}
        </div>
    `;
}

function bindPanelEvents(container) {
    container.querySelectorAll('input[name="pm-mode"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            updateSettings({ mode: e.target.value });
        });
    });

    container.querySelector('#pm-save-scene-btn')?.addEventListener('click', () => {
        const rawChars = container.querySelector('#pm-scene-characters')?.value || '';
        const chars = rawChars.split(/[,，]/).map(s => s.trim()).filter(Boolean);

        updateScene({
            location: container.querySelector('#pm-scene-location')?.value || '',
            action: container.querySelector('#pm-scene-action')?.value || '',
            tension: container.querySelector('#pm-scene-tension')?.value || '',
            unresolved: container.querySelector('#pm-scene-unresolved')?.value || '',
            in_scene_characters: chars
        });
        const btn = container.querySelector('#pm-save-scene-btn');
        if (btn) {
            btn.innerHTML = '<i class="fa-solid fa-check-double"></i> 快照已保存';
            setTimeout(() => { btn.innerHTML = '<i class="fa-solid fa-check"></i> 保存快照变更'; }, 1500);
        }
    });

    container.querySelector('#pm-add-mem-btn')?.addEventListener('click', () => {
        const contentInput = container.querySelector('#pm-new-mem-content');
        const keysInput = container.querySelector('#pm-new-mem-keys');
        const content = contentInput?.value?.trim();
        if (!content) return;

        const keys = (keysInput?.value || '').split(/[,，]/).map(k => k.trim()).filter(Boolean);
        addMemory({
            content: content,
            trigger_keys: keys,
            status: MEMORY_STATUS.TRIGGERED
        });

        contentInput.value = '';
        keysInput.value = '';
    });

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

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
