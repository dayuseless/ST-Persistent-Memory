/**
 * ST-Persistent-Memory - 原生扩展抽屉与菜单集成模块 (Native Drawer & Menu Integration)
 * 职责：
 * 1. 注入 SillyTavern 原生扩展面板 (#extensions_settings)
 * 2. 注入顶部扩展下拉菜单快捷入口 (#extensionsMenu)
 * 3. 一键提取并同步酒馆原生 API 连接配置 (importSillyTavernApiConfig)
 * 4. 傻瓜式全托管运行状态概览与详细参数设置弹窗入口
 * 5. 原生面板配置双向绑定、即时保存与连通性测试
 *
 * @version 0.1.42
 */

import { MODULE_NAME } from '../config.js';
import { getState, getSettings, updateSettings, saveSettingsImmediately } from '../state.js';
import { triggerAsyncDigest, testCustomApiConnection } from '../extractor.js';
import { escapeHtml, applyApiPreset, restoreRecommendedDefaults } from './common.js';
import { showAdvancedSettingsModal } from './modal.js';

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
        if (typeof document !== 'undefined') {
            const customUrlEl = document.getElementById('custom_api_url_text');
            const customKeyEl = document.getElementById('api_key_custom') || document.getElementById('api_key_openai');
            const customModelEl = document.getElementById('custom_model_id') || document.getElementById('model_custom_select') || document.getElementById('model_openai_select');

            if (customUrlEl?.value) url = customUrlEl.value.trim();
            if (customKeyEl?.value) key = customKeyEl.value.trim();
            if (customModelEl?.value) model = customModelEl.value.trim();
        }

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
 * 注入 SillyTavern 原生扩展面板 (#extensions_settings)
 */
export function createNativeExtensionDrawer(onToggleHUD, onRenderPanel) {
    if (typeof document === 'undefined') return;
    const container = document.getElementById('extensions_settings');
    if (!container) return;

    if (document.getElementById('pm-native-container')) return;

    const drawerWrapper = document.createElement('div');
    drawerWrapper.id = 'pm-native-container';
    drawerWrapper.className = 'extension_container inline-drawer';
    drawerWrapper.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b><i class="fa-solid fa-brain"></i> 持续记忆 (Persistent Memory)</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" id="pm-native-content">
            <!-- 动态渲染设置与快速状态 -->
        </div>
    `;

    container.appendChild(drawerWrapper);

    renderNativeDrawerContent(onToggleHUD, onRenderPanel);
}

/**
 * 注入顶部扩展下拉菜单入口 (#extensionsMenu)
 */
export function registerExtensionsMenuEntry(onToggleHUD) {
    if (typeof document === 'undefined') return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('pm-menu-entry')) return;

    const item = document.createElement('div');
    item.id = 'pm-menu-entry';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.innerHTML = '<i class="fa-solid fa-brain" style="color: #2563eb;"></i><span>持续记忆</span>';
    item.title = '打开持续记忆 HUD 控制台';
    item.addEventListener('click', () => {
        if (typeof onToggleHUD === 'function') {
            onToggleHUD(true);
        }
    });
    menu.appendChild(item);
}

/**
 * 渲染原生扩展面板里的内容
 */
export function renderNativeDrawerContent(onToggleHUD, onRenderPanel) {
    if (typeof document === 'undefined') return;
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
                    <div class="pm-input-row pm-mt-8" style="margin-top: 8px;">
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

            <!-- 🚀 傻瓜式全托管运行简报与详细参数入口 -->
            <div class="pm-section-card pm-mb-8">
                <div style="font-weight: 700; color: #0f172a; font-size: 13px; display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
                    <span><i class="fa-solid fa-wand-magic-sparkles" style="color: #2563eb;"></i> 傻瓜式全托管模式</span>
                    <span style="font-size: 11px; color: #16a34a; font-weight: 600;"><i class="fa-solid fa-circle-check"></i> 官方推荐生效中</span>
                </div>
                <div style="font-size: 11px; color: #64748b; line-height: 1.4; margin-bottom: 10px;">
                    已自动编排自适应提炼、Token 硬预算与混合语义检索。如需微调底层参数，可随时打开详细面板。
                </div>
                <button type="button" id="pm-native-open-adv-btn" class="pm-btn-primary" style="width: 100%; margin-bottom: 6px; padding: 7px 10px; font-size: 12px; background: #2563eb; border-color: #1d4ed8;">
                    <i class="fa-solid fa-sliders"></i> 打开详细与高级参数设置 (弹出面板)
                </button>
                <button type="button" id="pm-native-restore-btn" class="pm-btn-secondary" style="width: 100%; padding: 6px 10px; font-size: 11px;" title="重置除 API 之外的所有底层微调参数为官方最优默认值">
                    <i class="fa-solid fa-rotate-left"></i> 一键恢复推荐默认参数 (保持API)
                </button>
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
        if (typeof onToggleHUD === 'function') {
            onToggleHUD(true);
        }
    });

    content.querySelector('#pm-native-open-adv-btn')?.addEventListener('click', () => {
        showAdvancedSettingsModal({
            onSave: () => {
                if (typeof onRenderPanel === 'function') onRenderPanel();
                renderNativeDrawerContent(onToggleHUD, onRenderPanel);
            }
        });
    });

    content.querySelector('#pm-native-restore-btn')?.addEventListener('click', () => {
        restoreRecommendedDefaults();
        if (typeof onRenderPanel === 'function') onRenderPanel();
        renderNativeDrawerContent(onToggleHUD, onRenderPanel);
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
        const isEnabled = content.querySelector('#pm-setting-enabled')?.checked ?? true;
        const bubble = content.querySelector('#pm-native-bubble-enabled')?.checked ?? true;
        const useCustom = content.querySelector('#pm-native-custom-api-enabled')?.checked ?? false;
        updateSettings({
            customApiUrl: url,
            customApiKey: key,
            customApiModel: model,
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
        renderNativeDrawerContent(onToggleHUD, onRenderPanel);
        if (typeof onRenderPanel === 'function') {
            onRenderPanel();
        }
        if (res?.success) {
            window.toastr?.success?.(res.summary || '提炼完成', '持续记忆');
        } else {
            window.toastr?.warning?.(res?.error || '提炼未产生有效更新', '持续记忆');
        }
    });

    content.querySelectorAll('.pm-preset-pill').forEach(btn => {
        btn.addEventListener('click', () => {
            const p = btn.getAttribute('data-preset');
            applyApiPreset(p, true);
        });
    });
}
