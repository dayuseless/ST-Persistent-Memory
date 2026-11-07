/**
 * UI 管理器 (v0.1.12)：原生扩展抽屉集成、屏幕快捷悬浮按钮（支持自由拖拽与持久化）与 HUD 侧边控制台
 * 全面升级：行内即时编辑、记忆数据独立导出/导入迁移、长程宏观归并 (Consolidation)、终态记忆过滤与归档清理抽屉
 */

import { MODULE_NAME, MEMORY_STATUS, MEMORY_LIFECYCLE, MEMORY_SCOPE } from './config.js';
import { getState, getSettings, updateSettings, saveSettingsImmediately, updateScene, addMemory, updateMemory, deleteMemory, purgeArchivedMemories, cycleMemoryStatus, cycleMemoryType, exportMemoryData, importMemoryData, reindexAllMemories, onStateChange, getActiveWorldBookInfo, syncMemoryDeltaToWorldInfo } from './state.js';
import { triggerAsyncDigest, triggerMemoryConsolidation, testCustomApiConnection } from './extractor.js';
import { testEmbeddingApiConnection } from './semantic.js';

let panelEl = null;
let currentTab = 'memories'; // 'memories' | 'scene' | 'settings'
let memoryFilter = 'active'; // 'active' | 'archived' | 'all'
let lorebookFilter = '';    // '' (全部) | '__unlinked__' (未关联) | '<entry_name>'

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
    registerExtensionsMenuEntry();

    // 针对酒馆模板异步延迟生成，进行多轮对齐挂载
    setTimeout(() => {
        createNativeExtensionDrawer();
        registerExtensionsMenuEntry();
    }, 500);
    setTimeout(() => {
        createNativeExtensionDrawer();
        registerExtensionsMenuEntry();
    }, 2000);

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

    if (getSettings().showFloatingBubble === false) {
        btn.style.display = 'none';
    }

    // 绑定拖拽逻辑
    makeDraggable(btn, () => {
        togglePanel();
    });

    document.body.appendChild(btn);
}

/**
 * 重置悬浮球位置到系统默认推荐坐标 (适配 PC 与 手机)
 */
export function resetBubblePosition() {
    try {
        localStorage.removeItem('pm_bubble_pos');
        localStorage.removeItem('pm_bubble_pos_mobile');
    } catch {}
    const bubble = document.getElementById('pm-floating-bubble');
    if (bubble) {
        bubble.style.left = '';
        bubble.style.top = '';
        bubble.style.right = '';
        bubble.style.bottom = '';
    }
}

/**
 * 拖拽核心算法：手机触控与桌面鼠标双端适配、防遮挡安全边缘、坐标隔离持久化
 */
function makeDraggable(el, onClickCallback) {
    let isDragging = false;
    let hasMoved = false;
    let startX = 0, startY = 0;
    let initialX = 0, initialY = 0;

    const isMobile = () => window.innerWidth <= 768;
    const getStorageKey = () => isMobile() ? 'pm_bubble_pos_mobile' : 'pm_bubble_pos';

    // 恢复历史记忆位置 (手机端与桌面端分别记忆，避免桌面大屏坐标导致手机端飞出屏幕)
    try {
        const key = getStorageKey();
        const saved = localStorage.getItem(key);
        if (saved) {
            const { x, y } = JSON.parse(saved);
            const maxX = Math.max(10, window.innerWidth - 50);
            const maxY = Math.max(10, window.innerHeight - 50);
            const clampedX = Math.min(Math.max(10, x), maxX);
            const clampedY = Math.min(Math.max(10, y), maxY);
            el.style.left = `${clampedX}px`;
            el.style.top = `${clampedY}px`;
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        } else {
            // 未保存过自定义位置时，清空 inline 样式，严格使用 CSS 优雅响应式默认定位 (手机端 140px，桌面端 85px)
            el.style.left = '';
            el.style.top = '';
            el.style.right = '';
            el.style.bottom = '';
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
                localStorage.setItem(getStorageKey(), JSON.stringify({ x: rect.left, y: rect.top }));
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
 * 一键提取并同步 SillyTavern 原生连接设置中的 Custom / OpenAI API 端点、密钥与模型
 */
export function importSillyTavernApiConfig() {
    let url = '';
    let key = '';
    let model = '';

    try {
        const c = typeof window !== 'undefined' && window.SillyTavern?.getContext ? window.SillyTavern.getContext() : null;

        // 1. 尝试从酒馆 DOM 元素中提取 (最实时，用户当前在酒馆设置界面填写的)
        const customUrlEl = document.getElementById('custom_api_url_text');
        const customKeyEl = document.getElementById('api_key_custom') || document.getElementById('api_key_openai');
        const customModelEl = document.getElementById('custom_model_id') || document.getElementById('model_custom_select') || document.getElementById('model_openai_select');

        if (customUrlEl?.value) url = customUrlEl.value.trim();
        if (customKeyEl?.value) key = customKeyEl.value.trim();
        if (customModelEl?.value) model = customModelEl.value.trim();

        // 2. 尝试从酒馆上下文 chatCompletionSettings 中提取兜底
        if (c?.chatCompletionSettings) {
            if (!url && c.chatCompletionSettings.custom_url) {
                url = c.chatCompletionSettings.custom_url.trim();
            }
            if (!model && (c.chatCompletionSettings.custom_model || c.chatCompletionSettings.model)) {
                model = (c.chatCompletionSettings.custom_model || c.chatCompletionSettings.model).trim();
            }
        }
    } catch (e) {
        console.warn(`[${MODULE_NAME}] 读取酒馆 API 设置失败:`, e);
    }

    return { url, key, model };
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
            <b><i class="fa-solid fa-brain"></i> 持续记忆 (Persistent Memory)</b>
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
 * 注入顶部扩展下拉菜单入口 (#extensionsMenu)
 */
function registerExtensionsMenuEntry() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('pm-menu-entry')) return;

    const item = document.createElement('div');
    item.id = 'pm-menu-entry';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.innerHTML = '<i class="fa-solid fa-brain" style="color: #2563eb;"></i><span>持续记忆</span>';
    item.title = '打开持续记忆 HUD 控制台';
    item.addEventListener('click', () => {
        togglePanel(true);
    });
    menu.appendChild(item);
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
            <div class="flex-container alignitemscenter wide100p pm-mb-8" style="justify-content: space-between;">
                <label class="pm-switch-wrapper" style="gap: 10px;">
                    <span style="font-weight: 700; color: #0f172a; font-size: 13px;">
                        <i class="fa-solid fa-power-off" style="color: #2563eb;"></i> 启用持续记忆
                    </span>
                    <div class="pm-switch">
                        <input type="checkbox" id="pm-setting-enabled" ${settings.enabled ? 'checked' : ''}>
                        <span class="pm-slider"></span>
                    </div>
                </label>
                <button id="pm-open-hud-btn" class="menu_button menu_button_icon">
                    <i class="fa-solid fa-arrow-up-right-from-square"></i> 打开完整控制台 (HUD)
                </button>
            </div>

            <div class="flex-container alignitemscenter wide100p pm-mb-8">
                <label class="pm-switch-wrapper flex1">
                    <span style="color: #334155; font-size: 12px; font-weight: 600;">
                        <i class="fa-solid fa-circle-dot" style="color: #2563eb;"></i> 屏幕快捷悬浮球
                    </span>
                    <div class="pm-switch">
                        <input type="checkbox" id="pm-native-bubble-enabled" ${settings.showFloatingBubble !== false ? 'checked' : ''}>
                        <span class="pm-slider"></span>
                    </div>
                </label>
            </div>

            <!-- 独立提炼 API 直连配置 (自定义兼容 OpenAI 格式) -->
            <div class="pm-section-card pm-mb-8">
                <label class="pm-switch-wrapper pm-mb-8">
                    <span class="pm-section-title">
                        <i class="fa-solid fa-server" style="color: #2563eb;"></i> 启用独立提炼 API (自定义兼容 OpenAI)
                    </span>
                    <div class="pm-switch">
                        <input type="checkbox" id="pm-native-custom-api-enabled" ${settings.useCustomApi ? 'checked' : ''}>
                        <span class="pm-slider"></span>
                    </div>
                </label>
                <div id="pm-native-custom-api-body" style="${settings.useCustomApi ? 'display: block;' : 'display: none;'}">
                    <div class="pm-input-row pm-mb-4">
                        <label class="pm-input-label">Base URL (例如 https://api.openai.com/v1 或本地 http://localhost:11434/v1):</label>
                        <input type="text" id="pm-native-custom-api-url" class="pm-input" value="${escapeHtml(settings.customApiUrl || '')}" placeholder="https://api.openai.com/v1">
                    </div>
                    <div class="pm-grid-2col pm-mb-4">
                        <div class="pm-input-row">
                            <label class="pm-input-label">API Key (密钥):</label>
                            <input type="password" id="pm-native-custom-api-key" class="pm-input" value="${escapeHtml(settings.customApiKey || '')}" placeholder="sk-... (无密码端点可留空)">
                        </div>
                        <div class="pm-input-row">
                            <label class="pm-input-label">模型名称:</label>
                            <input type="text" id="pm-native-custom-api-model" class="pm-input" value="${escapeHtml(settings.customApiModel || 'gpt-4o-mini')}" placeholder="gpt-4o-mini">
                        </div>
                    </div>
                    <div style="display: flex; gap: 8px; align-items: center; margin-top: 6px; flex-wrap: wrap;">
                        <button id="pm-native-test-api-btn" class="pm-btn-test">
                            <i class="fa-solid fa-plug"></i> 测试 API 连通性
                        </button>
                        <button id="pm-native-import-st-api-btn" class="pm-btn-test" title="一键同步酒馆主连接设置中填写的 Custom / OpenAI 端点与模型">
                            <i class="fa-solid fa-file-import"></i> 同步酒馆主 API
                        </button>
                        <span id="pm-native-test-res" style="font-size: 11px; font-weight: 500;"></span>
                    </div>
                </div>
            </div>

            <div class="pm-input-row pm-mb-8">
                <label class="pm-input-label">提炼运行模式：</label>
                <div class="pm-toggle-group">
                    <label class="pm-radio-label">
                        <input type="radio" name="pm-native-mode" value="async" ${settings.mode === 'async' ? 'checked' : ''}>
                        <span>异步后台 (独立提炼)</span>
                    </label>
                    <label class="pm-radio-label">
                        <input type="radio" name="pm-native-mode" value="sync" ${settings.mode === 'sync' ? 'checked' : ''}>
                        <span>伴随标签 (零额外请求)</span>
                    </label>
                </div>
            </div>

            <div class="pm-input-row pm-mb-8">
                <label class="pm-input-label">最新提炼动态：</label>
                <div class="pm-status-box">
                    ${escapeHtml(state.last_digest_summary || '尚未执行提炼')} ${state.last_digest_time ? `<span style="color: #64748b; font-weight: 400;">(${state.last_digest_time})</span>` : ''}
                </div>
            </div>

            ${state.last_sync_error ? `
            <div class="pm-input-row pm-mb-8">
                <label class="pm-input-label" style="color: #ef4444;"><i class="fa-solid fa-triangle-exclamation"></i> 伴随标签解析异常：</label>
                <div class="pm-status-box" style="border-left: 3px solid #ef4444; background: rgba(239, 68, 68, 0.08);">
                    <div style="font-weight: 600; color: #dc2626;">${escapeHtml(state.last_sync_error.error)} (${escapeHtml(state.last_sync_error.time)})</div>
                    <div style="font-size: 11px; opacity: 0.8; word-break: break-all; margin-top: 4px; font-family: monospace;">${escapeHtml(state.last_sync_error.rawSnippet || '')}</div>
                </div>
            </div>` : ''}

            ${state.last_digest_error ? `
            <div class="pm-input-row pm-mb-8">
                <label class="pm-input-label" style="color: #f59e0b;"><i class="fa-solid fa-circle-exclamation"></i> 提炼请求异常：</label>
                <div class="pm-status-box" style="border-left: 3px solid #f59e0b; background: rgba(245, 158, 11, 0.08); color: #d97706;">
                    ${escapeHtml(state.last_digest_error)}
                </div>
            </div>` : ''}

            <div class="pm-input-row pm-mb-8">
                <label class="pm-input-label">现场快照与状态版本：</label>
                <div class="pm-status-box">
                    修订: <b>rev.${state.state_revision || 0}</b> | 地点: <b>${escapeHtml(scene.location || '未知')}</b> | 记忆: <b>${memories.length}</b> 条
                </div>
            </div>

            <div class="flex-container flexGap10 pm-mt-8">
                <button id="pm-native-save-settings-btn" class="pm-btn-primary flex1" style="background: #059669; border-color: #047857;">
                    <i class="fa-solid fa-floppy-disk"></i> 保存插件配置
                </button>
                <button id="pm-native-digest-btn" class="menu_button menu_button_icon flex1">
                    <i class="fa-solid fa-bolt"></i> 立即后台提炼
                </button>
            </div>
        </div>
    `;

    // 绑定原生事件
    content.querySelector('#pm-native-save-settings-btn')?.addEventListener('click', () => {
        syncNativeInputs();
        const ok = saveSettingsImmediately();
        const btn = content.querySelector('#pm-native-save-settings-btn');
        if (btn) {
            btn.innerHTML = '<i class="fa-solid fa-check"></i> 配置已保存';
            setTimeout(() => {
                btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> 保存插件配置';
            }, 1800);
        }
        if (ok) {
            window.toastr?.success?.('插件配置已成功保存！', '持续记忆');
        } else {
            window.toastr?.error?.('保存配置遇到异常', '持续记忆');
        }
    });

    content.querySelector('#pm-setting-enabled')?.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        updateSettings({ enabled: isChecked });
        const hudToggle = document.getElementById('pm-setting-hud-enabled');
        if (hudToggle) hudToggle.checked = isChecked;
    });

    content.querySelector('#pm-native-bubble-enabled')?.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        updateSettings({ showFloatingBubble: isChecked });
        const bubble = document.getElementById('pm-floating-bubble');
        if (bubble) bubble.style.display = isChecked ? 'flex' : 'none';
        const hudCb = document.getElementById('pm-setting-hud-bubble');
        if (hudCb) hudCb.checked = isChecked;
    });

    content.querySelector('#pm-open-hud-btn')?.addEventListener('click', () => {
        togglePanel(true);
    });

    content.querySelectorAll('input[name="pm-native-mode"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            updateSettings({ mode: e.target.value });
            const hudRadios = document.querySelectorAll('input[name="pm-mode"]');
            hudRadios.forEach(hr => {
                if (hr.value === e.target.value) hr.checked = true;
            });
        });
    });

    content.querySelector('#pm-native-custom-api-enabled')?.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        const body = content.querySelector('#pm-native-custom-api-body');
        if (body) body.style.display = isChecked ? 'block' : 'none';
        updateSettings({ useCustomApi: isChecked });
        // 双向同步 HUD 面板
        const hudCb = document.getElementById('pm-setting-custom-api-enabled');
        if (hudCb) {
            hudCb.checked = isChecked;
            const hudFields = document.getElementById('pm-custom-api-fields');
            if (hudFields) hudFields.style.display = isChecked ? 'block' : 'none';
        }
    });

    const syncNativeInputs = () => {
        const url = (content.querySelector('#pm-native-custom-api-url')?.value || '').trim();
        const key = (content.querySelector('#pm-native-custom-api-key')?.value || '').trim();
        const model = (content.querySelector('#pm-native-custom-api-model')?.value || 'gpt-4o-mini').trim();
        const mode = content.querySelector('input[name="pm-native-mode"]:checked')?.value || 'async';
        const isEnabled = content.querySelector('#pm-setting-enabled')?.checked ?? true;
        const bubble = content.querySelector('#pm-native-bubble-enabled')?.checked ?? true;
        const useCustom = content.querySelector('#pm-native-custom-api-enabled')?.checked ?? false;
        updateSettings({
            customApiUrl: url,
            customApiKey: key,
            customApiModel: model,
            mode: mode,
            enabled: isEnabled,
            showFloatingBubble: bubble,
            useCustomApi: useCustom
        });
    };

    ['input', 'change'].forEach(evt => {
        content.querySelector('#pm-native-custom-api-url')?.addEventListener(evt, syncNativeInputs);
        content.querySelector('#pm-native-custom-api-key')?.addEventListener(evt, syncNativeInputs);
        content.querySelector('#pm-native-custom-api-model')?.addEventListener(evt, syncNativeInputs);
    });

    content.querySelector('#pm-native-import-st-api-btn')?.addEventListener('click', () => {
        const conf = importSillyTavernApiConfig();
        let count = 0;
        if (conf.url) {
            const el = content.querySelector('#pm-native-custom-api-url');
            if (el) { el.value = conf.url; count++; }
        }
        if (conf.key) {
            const el = content.querySelector('#pm-native-custom-api-key');
            if (el) { el.value = conf.key; count++; }
        }
        if (conf.model) {
            const el = content.querySelector('#pm-native-custom-api-model');
            if (el) { el.value = conf.model; count++; }
        }
        syncNativeInputs();
        if (count > 0) {
            window.toastr?.success?.(`已同步酒馆配置 (端点: ${conf.url || '未变'}, 模型: ${conf.model || '未变'})`, '持续记忆');
        } else {
            window.toastr?.info?.('未能从酒馆连接设置读取到有效 Custom/OpenAI 配置，请在酒馆连接处填写或手动输入', '持续记忆');
        }
    });

    content.querySelector('#pm-native-test-api-btn')?.addEventListener('click', async () => {
        syncNativeInputs();
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
            <span class="pm-hero-pill">rev.<b>${state.state_revision || 0}</b></span>
            <span class="pm-hero-pill"><b>${memories.length}</b> 条</span>
        `;
    }

    const isTerminalOrArchived = m => m.status === MEMORY_STATUS.ARCHIVED || (m.lifecycle && m.lifecycle !== MEMORY_LIFECYCLE.ACTIVE);
    const activeCount = memories.filter(m => !isTerminalOrArchived(m)).length;
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

    // 根据当前筛选状态选择要渲染的卡片列表 (结合生命周期与世界书关联)
    const filteredMemories = memories.filter(m => {
        if (memoryFilter === 'active' && isTerminalOrArchived(m)) return false;
        if (memoryFilter === 'archived' && !isTerminalOrArchived(m)) return false;

        if (lorebookFilter === '__unlinked__') {
            if (m.lorebook_ref && m.lorebook_ref.entry_name) return false;
        } else if (lorebookFilter) {
            if (!m.lorebook_ref || m.lorebook_ref.entry_name !== lorebookFilter) return false;
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
        const memCardsHtml = filteredMemories.length > 0
            ? filteredMemories.map(renderMemoryCard).join('')
            : `<div class="pm-empty-hint"><i class="fa-solid fa-box-open" style="font-size: 24px; margin-bottom: 6px; display: block; opacity: 0.5;"></i>${lorebookFilter ? `设定【${escapeHtml(lorebookFilter === '__unlinked__' ? '未关联' : lorebookFilter)}】下暂无匹配记忆` : (memoryFilter === 'archived' ? '暂无归档或已结项记忆' : (memoryFilter === 'active' ? '暂无活跃记忆' : '记忆库暂无条目'))}</div>`;

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

            <!-- 记忆列表 -->
            <div class="pm-section-card" style="flex: 1; display: flex; flex-direction: column;">
                <div class="pm-section-header" style="flex-wrap: wrap; gap: 8px; justify-content: space-between;">
                    <div style="display: flex; gap: 4px; align-items: center; flex-wrap: wrap;">
                        <button class="pm-filter-pill ${memoryFilter === 'active' ? 'pm-filter-active' : ''}" data-action="filter-mem" data-filter="active">
                            活跃 (${activeCount})
                        </button>
                        <button class="pm-filter-pill ${memoryFilter === 'archived' ? 'pm-filter-active' : ''}" data-action="filter-mem" data-filter="archived">
                            <i class="fa-solid fa-box-archive"></i> 归档/终态 (${archivedOrTerminalCount})
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

        tabHtml = `
            <div class="pm-section-card">
                <div class="pm-section-header">
                    <span class="pm-section-title"><i class="fa-solid fa-map-location-dot"></i> L0 现场快照 (Scene State)</span>
                    <span class="pm-hero-pill">现场置顶</span>
                </div>
                <div style="font-size: 12px; color: #475569; margin-bottom: 12px; line-height: 1.4;">
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
                </div>
            </div>

            <!-- 核心参数与 Token 预算 -->
            <div class="pm-section-card">
                <div class="pm-section-header">
                    <span class="pm-section-title"><i class="fa-solid fa-sliders"></i> 提炼参数与 Token 预算</span>
                </div>

                <div class="pm-input-row pm-mb-8">
                    <label class="pm-input-label">提炼运行模式：</label>
                    <div class="pm-toggle-group">
                        <label class="pm-radio-label">
                            <input type="radio" name="pm-mode" value="async" ${settings.mode === 'async' ? 'checked' : ''}>
                            <span>异步后台 (独立提炼)</span>
                        </label>
                        <label class="pm-radio-label">
                            <input type="radio" name="pm-mode" value="sync" ${settings.mode === 'sync' ? 'checked' : ''}>
                            <span>伴随标签 (零额外请求)</span>
                        </label>
                    </div>
                    <div style="font-size: 11px; color: #64748b; line-height: 1.4; margin-top: 4px;">
                        💡 <b>异步后台 (独立提炼)</b>：主回复完成后由独立 API 自动异步安静提炼，不占正文输出；<br>
                        💡 <b>伴随标签 (零额外请求)</b>：回复末尾自动附带隐藏状态标签由插件拦截入库，零额外请求。
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

                <div class="pm-grid-2col pm-mb-8">
                    <div class="pm-input-row">
                        <label class="pm-input-label">提示词注入位置：</label>
                        <select id="pm-setting-inject-pos" class="pm-input" style="cursor: pointer;">
                            <option value="1" ${(settings.injectionPosition ?? 1) == 1 ? 'selected' : ''}>对话内 (In-Chat @ 深度)</option>
                            <option value="0" ${(settings.injectionPosition ?? 1) == 0 ? 'selected' : ''}>系统主提示词 (System Prompt)</option>
                        </select>
                    </div>
                    <div class="pm-input-row">
                        <label class="pm-input-label">对话注入深度 (Depth):</label>
                        <input type="number" id="pm-setting-inject-depth" class="pm-input" min="0" max="20" value="${settings.injectionDepth ?? 2}">
                    </div>
                </div>

                <div class="pm-grid-2col pm-mb-8">
                    <div class="pm-input-row">
                        <label class="pm-input-label">长程宏观自动归并：</label>
                        <select id="pm-setting-auto-consolidate" class="pm-input" style="cursor: pointer;">
                            <option value="1" ${settings.autoConsolidate !== false ? 'selected' : ''}>启用 (达到阈值后台自动压缩)</option>
                            <option value="0" ${settings.autoConsolidate === false ? 'selected' : ''}>停用 (仅允许手动触发)</option>
                        </select>
                    </div>
                    <div class="pm-input-row">
                        <label class="pm-input-label">归并触发阈值 (条数):</label>
                        <input type="number" id="pm-setting-consolidate-threshold" class="pm-input" min="5" max="50" value="${settings.consolidateThreshold || 20}">
                    </div>
                </div>

                <!-- 语义检索与向量基建 -->
                <div class="pm-section-card pm-mt-12" style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-top: 14px;">
                    <div class="pm-section-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                        <span class="pm-section-title" style="font-weight: 600; font-size: 13px; color: #1e293b; display: flex; align-items: center; gap: 6px;">
                            <i class="fa-solid fa-brain" style="color: #8b5cf6;"></i> 语义检索与向量基建 (Hybrid Search)
                        </span>
                        <div class="pm-switch">
                            <input type="checkbox" id="pm-setting-semantic-enabled" ${settings.semanticRetrievalEnabled !== false ? 'checked' : ''}>
                            <span class="pm-slider"></span>
                        </div>
                    </div>
                    <div style="font-size: 12px; color: #64748b; margin-bottom: 10px; line-height: 1.4;">
                        结合关键词词法与高维向量余弦相似度，精准识别近义表达与概念关联（如“海啸”与“巨浪侵袭村庄”），彻底摆脱死板字面匹配。
                    </div>

                    <div id="pm-semantic-settings-block" style="${settings.semanticRetrievalEnabled !== false ? 'display: block;' : 'display: none;'}">
                        <div class="pm-grid-2col pm-mb-8">
                            <div class="pm-input-row">
                                <label class="pm-input-label">向量计算引擎：</label>
                                <select id="pm-setting-embedding-provider" class="pm-input" style="cursor: pointer;">
                                    <option value="local" ${(settings.embeddingProvider || 'local') === 'local' ? 'selected' : ''}>内置轻量向量引擎 (零依赖/全离线/秒级响应)</option>
                                    <option value="custom_api" ${settings.embeddingProvider === 'custom_api' ? 'selected' : ''}>外部 OpenAI 兼容端点 (/embeddings)</option>
                                </select>
                            </div>
                            <div class="pm-input-row">
                                <label class="pm-input-label">语义相似度激活阈值 (<span id="pm-val-semantic-threshold">${Number(settings.semanticThreshold ?? 0.25).toFixed(2)}</span>):</label>
                                <input type="range" id="pm-setting-semantic-threshold" min="0.10" max="0.90" step="0.05" value="${settings.semanticThreshold ?? 0.25}" style="width: 100%; cursor: pointer;">
                            </div>
                        </div>

                        <div class="pm-grid-2col pm-mb-8">
                            <div class="pm-input-row">
                                <label class="pm-input-label">语义打分权重占比 (<span id="pm-val-semantic-weight">${Math.round((settings.semanticWeight ?? 0.60) * 100)}%</span> 语义 + <span id="pm-val-lexical-weight">${Math.round((1 - (settings.semanticWeight ?? 0.60)) * 100)}%</span> 词法):</label>
                                <input type="range" id="pm-setting-semantic-weight" min="0.0" max="1.0" step="0.05" value="${settings.semanticWeight ?? 0.60}" style="width: 100%; cursor: pointer;">
                            </div>
                            <div class="pm-input-row" style="display: flex; align-items: flex-end;">
                                <button id="pm-btn-reindex-all" class="pm-btn-secondary" style="width: 100%; cursor: pointer; padding: 6px 10px; font-size: 12px;">
                                    <i class="fa-solid fa-arrows-rotate"></i> 重新索引全库向量
                                </button>
                            </div>
                        </div>

                        <div id="pm-embedding-api-fields" style="${settings.embeddingProvider === 'custom_api' ? 'display: block;' : 'display: none;'} margin-top: 8px; padding-top: 8px; border-top: 1px dashed #cbd5e1;">
                            <div class="pm-input-row">
                                <label class="pm-input-label">Embedding API Base URL (留空沿用提炼端点):</label>
                                <input type="text" id="pm-setting-embedding-url" class="pm-input" value="${escapeHtml(settings.embeddingApiUrl || '')}" placeholder="继承提炼 API 或如 https://api.openai.com/v1">
                            </div>
                            <div class="pm-grid-2col pm-mb-8">
                                <div class="pm-input-row" style="margin-bottom: 0;">
                                    <label class="pm-input-label">Embedding API Key (留空沿用提炼密钥):</label>
                                    <input type="password" id="pm-setting-embedding-key" class="pm-input" value="${escapeHtml(settings.embeddingApiKey || '')}" placeholder="继承提炼 API Key">
                                </div>
                                <div class="pm-input-row" style="margin-bottom: 0;">
                                    <label class="pm-input-label">向量模型 (如 text-embedding-3-small, bge-m3):</label>
                                    <input type="text" id="pm-setting-embedding-model" class="pm-input" value="${escapeHtml(settings.embeddingModel || 'text-embedding-3-small')}" placeholder="text-embedding-3-small">
                                </div>
                            </div>
                            <div style="display: flex; gap: 8px; align-items: center; margin-top: 6px; flex-wrap: wrap;">
                                <button id="pm-btn-test-embedding-api" class="pm-btn-test">
                                    <i class="fa-solid fa-plug"></i> 测试向量 API 连通性
                                </button>
                                <button id="pm-btn-import-digest-api" class="pm-btn-test" title="一键从上方提炼 API 同步 Base URL 与 Key">
                                    <i class="fa-solid fa-copy"></i> 继承提炼 API 配置
                                </button>
                                <span id="pm-embedding-api-test-status" style="font-size: 11px; font-weight: 500;"></span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 世界书关联与协同 (World Info Integration) - 会话内作用域 -->
                <div class="pm-section-card pm-mt-8">
                    <div class="flex-container alignitemscenter wide100p pm-mb-4" style="justify-content: space-between;">
                        <div style="font-weight: 700; color: #0f172a; font-size: 13px; display: flex; align-items: center; gap: 6px;">
                            <i class="fa-solid fa-book-atlas" style="color: #0284c7;"></i> 世界书关联与协同 (World Info)
                            <span class="pm-hero-pill" style="background: rgba(14, 165, 233, 0.15); color: #0284c7; border: 1px solid rgba(14, 165, 233, 0.3);">会话内协同</span>
                        </div>
                        <div class="pm-switch">
                            <input type="checkbox" id="pm-setting-worldbook-enabled" ${settings.worldBookIntegrationEnabled !== false ? 'checked' : ''}>
                            <span class="pm-slider"></span>
                        </div>
                    </div>
                    <div style="font-size: 12px; color: #64748b; margin-bottom: 10px; line-height: 1.4;">
                        允许动态记忆与世界书设定条目进行关联，将故事中发生的状态变迁（如神剑拔出、城池失守）作为世界书条目的实时动态补丁协同注入上下文。
                    </div>

                    <div id="pm-worldbook-settings-block" style="${settings.worldBookIntegrationEnabled !== false ? 'display: block;' : 'display: none;'}">
                        <div class="pm-grid-2col pm-mb-8">
                            <div class="pm-input-row" style="margin-bottom: 0;">
                                <label class="pm-switch-wrapper">
                                    <span style="font-size: 12px; color: #334155; font-weight: 600;">提炼时参考当前世界书条目：</span>
                                    <div class="pm-switch" style="margin-left: 8px;">
                                        <input type="checkbox" id="pm-setting-worldbook-context" ${settings.worldBookContextToExtractor !== false ? 'checked' : ''}>
                                        <span class="pm-slider"></span>
                                    </div>
                                </label>
                            </div>
                            <div class="pm-input-row" style="margin-bottom: 0;">
                                <label class="pm-input-label">世界书条目激活加权 (<span id="pm-val-worldbook-boost">${Number(settings.worldBookBoostScore ?? 0.35).toFixed(2)}</span>):</label>
                                <input type="range" id="pm-setting-worldbook-boost" min="0.0" max="1.0" step="0.05" value="${settings.worldBookBoostScore ?? 0.35}" style="width: 100%; cursor: pointer;">
                            </div>
                        </div>
                        <div id="pm-active-worldbook-info" style="font-size: 12px; color: #475569; background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 6px; padding: 8px 10px; margin-top: 6px; display: flex; align-items: center; gap: 6px;">
                            <i class="fa-solid fa-spinner fa-spin" style="color: #0284c7;"></i> 检测当前会话生效的世界书...
                        </div>
                    </div>
                </div>

                <div class="pm-mt-8">
                    <button id="pm-save-all-settings-btn" class="pm-btn-primary" style="padding: 10px 14px; font-size: 13px; background: #059669; border-color: #047857;">
                        <i class="fa-solid fa-floppy-disk"></i> 保存并生效全部配置
                    </button>
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
}

/**
 * 渲染单个记忆卡片
 */
export function renderMemoryCard(mem) {
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

    return `
        <div class="pm-card" data-id="${escapeHtml(mem.id)}">
            <div class="pm-card-top">
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
                    ` : ''}
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

    container.querySelector('#pm-setting-inject-pos')?.addEventListener('change', (e) => {
        updateSettings({ injectionPosition: parseInt(e.target.value) || 0 });
    });

    container.querySelector('#pm-setting-inject-depth')?.addEventListener('change', (e) => {
        const val = Math.max(0, Math.min(20, parseInt(e.target.value) || 2));
        updateSettings({ injectionDepth: val });
    });

    container.querySelector('#pm-setting-auto-consolidate')?.addEventListener('change', (e) => {
        updateSettings({ autoConsolidate: e.target.value === '1' });
    });

    container.querySelector('#pm-setting-consolidate-threshold')?.addEventListener('change', (e) => {
        const val = Math.max(5, Math.min(50, parseInt(e.target.value) || 20));
        updateSettings({ consolidateThreshold: val });
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

    // 语义检索与向量设置交互
    container.querySelector('#pm-setting-semantic-enabled')?.addEventListener('change', (e) => {
        const isSemEnabled = e.target.checked;
        const block = container.querySelector('#pm-semantic-settings-block');
        if (block) block.style.display = isSemEnabled ? 'block' : 'none';
        updateSettings({ semanticRetrievalEnabled: isSemEnabled });
    });

    container.querySelector('#pm-setting-embedding-provider')?.addEventListener('change', (e) => {
        const provider = e.target.value;
        const apiBlock = container.querySelector('#pm-embedding-api-fields');
        if (apiBlock) apiBlock.style.display = provider === 'custom_api' ? 'block' : 'none';
        updateSettings({ embeddingProvider: provider });
    });

    container.querySelector('#pm-setting-semantic-threshold')?.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        const span = container.querySelector('#pm-val-semantic-threshold');
        if (span) span.textContent = val.toFixed(2);
        updateSettings({ semanticThreshold: val });
    });

    container.querySelector('#pm-setting-semantic-weight')?.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        const semSpan = container.querySelector('#pm-val-semantic-weight');
        const lexSpan = container.querySelector('#pm-val-lexical-weight');
        if (semSpan) semSpan.textContent = `${Math.round(val * 100)}%`;
        if (lexSpan) lexSpan.textContent = `${Math.round((1 - val) * 100)}%`;
        updateSettings({ semanticWeight: val });
    });

    // 测试向量 API 连通性
    container.querySelector('#pm-btn-test-embedding-api')?.addEventListener('click', async () => {
        const url = container.querySelector('#pm-setting-embedding-url')?.value?.trim() || getSettings().customApiUrl;
        const key = container.querySelector('#pm-setting-embedding-key')?.value?.trim() || getSettings().customApiKey;
        const model = container.querySelector('#pm-setting-embedding-model')?.value?.trim() || 'text-embedding-3-small';
        const statusEl = container.querySelector('#pm-embedding-api-test-status');
        if (statusEl) {
            statusEl.style.color = '#38bdf8';
            statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 测试向量接口中...';
        }
        const res = await testEmbeddingApiConnection({ apiUrl: url, apiKey: key, model });
        if (res.success) {
            if (statusEl) {
                statusEl.style.color = '#34d399';
                statusEl.innerHTML = `<i class="fa-solid fa-check"></i> 向量连接成功！(${res.latency}ms, ${res.dimensions}维)`;
            }
            window.toastr?.success?.(`向量 API 连接成功！响应延时 ${res.latency}ms，嵌入维度: ${res.dimensions}`, '持续记忆');
        } else {
            if (statusEl) {
                statusEl.style.color = '#f87171';
                statusEl.innerHTML = `<i class="fa-solid fa-xmark"></i> 失败: ${escapeHtml(res.error).slice(0, 35)}`;
            }
            window.toastr?.error?.(res.error, '向量 API 连接失败');
        }
    });

    // 继承提炼 API 配置
    container.querySelector('#pm-btn-import-digest-api')?.addEventListener('click', () => {
        const s = getSettings();
        const urlInput = container.querySelector('#pm-setting-embedding-url');
        const keyInput = container.querySelector('#pm-setting-embedding-key');
        if (urlInput && s.customApiUrl) urlInput.value = s.customApiUrl;
        if (keyInput && s.customApiKey) keyInput.value = s.customApiKey;
        window.toastr?.success?.('已从提炼 API 继承 Base URL 与 Key！', '持续记忆');
    });

    // 全库向量重建索引
    container.querySelector('#pm-btn-reindex-all')?.addEventListener('click', async () => {
        const btn = container.querySelector('#pm-btn-reindex-all');
        const originalHtml = btn?.innerHTML || '';
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 索引建立中...';
        }
        try {
            const res = await reindexAllMemories(true, (cur, total) => {
                if (btn) btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 索引进度: ${cur}/${total}`;
            });
            window.toastr?.success?.(`全库向量索引构建完成！共更新 ${res.updated} 条记忆向量`, '持续记忆');
            renderPanelContent();
        } catch (err) {
            window.toastr?.error?.(`向量索引失败: ${err.message}`, '持续记忆');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = originalHtml;
            }
        }
    });

    // 世界书关联与协同设置监听
    const wbBoostSlider = container.querySelector('#pm-setting-worldbook-boost');
    const wbBoostLabel = container.querySelector('#pm-val-worldbook-boost');
    if (wbBoostSlider && wbBoostLabel) {
        wbBoostSlider.addEventListener('input', (e) => {
            wbBoostLabel.textContent = Number(e.target.value).toFixed(2);
        });
    }

    const wbToggle = container.querySelector('#pm-setting-worldbook-enabled');
    const wbBlock = container.querySelector('#pm-worldbook-settings-block');
    if (wbToggle && wbBlock) {
        wbToggle.addEventListener('change', (e) => {
            wbBlock.style.display = e.target.checked ? 'block' : 'none';
        });
    }

    const wbInfoEl = container.querySelector('#pm-active-worldbook-info');
    if (wbInfoEl) {
        getActiveWorldBookInfo().then(wb => {
            if (!wbInfoEl) return;
            if (wb && wb.bookName) {
                const count = Array.isArray(wb.entries) ? wb.entries.length : 0;
                wbInfoEl.innerHTML = `<i class="fa-solid fa-book-open" style="color: #0284c7;"></i> 当前生效世界书: <strong>${escapeHtml(wb.bookName)}</strong> (${count} 个条目，来源: ${wb.source === 'character_embedded' ? '角色卡内置' : '会话绑定'})`;
            } else {
                wbInfoEl.innerHTML = `<i class="fa-solid fa-circle-info" style="color: #64748b;"></i> 当前会话未绑定专属世界书（可在酒馆聊天或角色设置中关联世界书）`;
            }
        }).catch(() => {
            if (wbInfoEl) wbInfoEl.innerHTML = `<i class="fa-solid fa-circle-info" style="color: #64748b;"></i> 当前会话未检测到生效的世界书`;
        });
    }

    // 保存并生效全部配置按钮 (Tab 3)
    container.querySelector('#pm-save-all-settings-btn')?.addEventListener('click', () => {
        syncHudApiInputs();
        const freqVal = Math.max(1, parseInt(container.querySelector('#pm-setting-freq')?.value) || 3);
        const sliceVal = Math.max(2, Math.min(15, parseInt(container.querySelector('#pm-setting-slice')?.value) || 6));
        const sceneTok = Math.max(50, Math.min(500, parseInt(container.querySelector('#pm-setting-scene-tokens')?.value) || 150));
        const memTok = Math.max(150, Math.min(2000, parseInt(container.querySelector('#pm-setting-tokens')?.value) || 450));
        const selectedMode = container.querySelector('input[name="pm-mode"]:checked')?.value || 'async';
        const isEnabled = container.querySelector('#pm-setting-hud-enabled')?.checked ?? true;
        const showBubble = container.querySelector('#pm-setting-hud-bubble')?.checked ?? true;
        const useCustom = container.querySelector('#pm-setting-custom-api-enabled')?.checked ?? false;
        const injectPos = parseInt(container.querySelector('#pm-setting-inject-pos')?.value) || 1;
        const injectDep = parseInt(container.querySelector('#pm-setting-inject-depth')?.value) || 2;
        const autoConsolidate = (container.querySelector('#pm-setting-auto-consolidate')?.value ?? '1') === '1';
        const consolidateThreshold = parseInt(container.querySelector('#pm-setting-consolidate-threshold')?.value) || 20;

        const isSemEnabled = container.querySelector('#pm-setting-semantic-enabled')?.checked ?? true;
        const embProvider = container.querySelector('#pm-setting-embedding-provider')?.value || 'local';
        const semThresh = parseFloat(container.querySelector('#pm-setting-semantic-threshold')?.value) || 0.25;
        const semWeight = parseFloat(container.querySelector('#pm-setting-semantic-weight')?.value) || 0.60;
        const embUrl = container.querySelector('#pm-setting-embedding-url')?.value?.trim() || '';
        const embKey = container.querySelector('#pm-setting-embedding-key')?.value?.trim() || '';
        const embModel = container.querySelector('#pm-setting-embedding-model')?.value?.trim() || 'text-embedding-3-small';

        const isWbEnabled = container.querySelector('#pm-setting-worldbook-enabled')?.checked ?? true;
        const isWbCtx = container.querySelector('#pm-setting-worldbook-context')?.checked ?? true;
        const wbBoost = parseFloat(container.querySelector('#pm-setting-worldbook-boost')?.value) || 0.35;

        updateSettings({
            enabled: isEnabled,
            showFloatingBubble: showBubble,
            useCustomApi: useCustom,
            asyncFrequency: freqVal,
            digestSliceCount: sliceVal,
            maxSceneTokens: sceneTok,
            maxTotalMemoryTokens: memTok,
            mode: selectedMode,
            injectionPosition: injectPos,
            injectionDepth: injectDep,
            autoConsolidate,
            consolidateThreshold,
            semanticRetrievalEnabled: isSemEnabled,
            embeddingProvider: embProvider,
            semanticThreshold: semThresh,
            semanticWeight: semWeight,
            embeddingApiUrl: embUrl,
            embeddingApiKey: embKey,
            embeddingModel: embModel,
            worldBookIntegrationEnabled: isWbEnabled,
            worldBookContextToExtractor: isWbCtx,
            worldBookBoostScore: wbBoost
        });

        const ok = saveSettingsImmediately();
        const btn = container.querySelector('#pm-save-all-settings-btn');
        if (btn) {
            btn.innerHTML = '<i class="fa-solid fa-check"></i> 全部配置已成功保存！';
            setTimeout(() => {
                btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> 保存并生效全部配置';
            }, 1800);
        }
        if (ok) {
            window.toastr?.success?.('插件配置已成功保存并立即生效！', '持续记忆');
        } else {
            window.toastr?.error?.('保存配置失败，请检查浏览器控制台', '持续记忆');
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

        let memData = {
            type: type,
            content: content,
            trigger_keys: keys,
            scope: scope,
            status: MEMORY_STATUS.TRIGGERED
        };

        if (loreName) {
            memData.lorebook_ref = { entry_name: loreName };
        }

        if (scope === 'character') {
            memData.character = targets[0] || curCharName;
        } else if (scope === 'shared') {
            memData.known_by = targets.length > 0 ? targets : (Array.isArray(state.scene.in_scene_characters) && state.scene.in_scene_characters.length > 0 ? state.scene.in_scene_characters : [curCharName, c?.name1 || 'User']);
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
            const newKeys = rawKeys.split(/[,，]/).map(k => k.trim()).filter(Boolean);
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
                showSyncLoreModal(previewRes.preview, async (markCompleted) => {
                    const commitRes = await syncMemoryDeltaToWorldInfo(id, { markCompleted });
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
                window.toastr?.success?.(`成功导入 ${res.count} 条新记忆 (当前总数: ${res.total})`, '持续记忆');
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

/**
 * 弹出确认写回世界书条目的安全确认对话框 (Diff 预览与确认)
 */
function showSyncLoreModal(preview, onConfirm) {
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
