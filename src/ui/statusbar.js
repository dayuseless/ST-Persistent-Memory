/**
/**
 * ST-Persistent-Memory (v0.1.49) - 现场外挂状态栏与原生生态宏服务 (Scene Status Bar & Native Macro Exporter)
 * 职责：
 * 1. 现场快照响应式渲染 (Reactive HUD)：支持输入框上方、聊天区吸顶、屏幕悬浮胶囊三种停靠模式
 * 2. 自由模板格式引擎 (Template Engine)：支持占位符解析与 4 大玩法风格预设 (TRPG跑团、Galgame、悬疑侦探、极简)
 * 3. 行内即改交互 (In-line Quick Edit)：点击现场字段直接原地编辑并实时落盘，零时延纠正 AI 偏差
 * 4. 4 大沉浸视觉皮肤 (Themes)：极光毛玻璃 (Glassmorphism)、赛博霓虹 (Cyber)、羊皮纸复古 (Parchment)、极简极净 (Minimal)
 * 5. 酒馆原生动态宏导出：注册 {{pm_location}}, {{pm_time}}, {{pm_characters}}, {{pm_action}}, {{pm_tension}}, {{pm_unresolved}}, {{pm_status_line}}
 * 6. 全局响应式广播事件：对外派发 st-pm-scene-update 原生自定义事件，无缝连接第三方插件与角色卡
 */

import { MODULE_NAME, STATUS_BAR_DOCKS, STATUS_BAR_THEMES, STATUS_BAR_PRESETS } from '../config.js';
import { getState, getSettings, updateSettings, saveSettingsImmediately, updateScene, onStateChange } from '../state.js';
import { rollbackScene } from '../scene.js';
import { resolveHostWindow } from './bubble.js';
import { escapeHtml } from './common.js';

const safeClone = (o) => (o == null ? o : (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o))));

const FIELD_LABELS = {
    location: '地点',
    time: '时间/天气',
    characters: '在场角色',
    action: '当前行动',
    tension: '氛围/张力',
    unresolved: '悬念/未决'
};

const FIELD_FALLBACKS = {
    location: '未知场景',
    time: '时间未定',
    characters: '当前角色',
    action: '正在交流',
    tension: '氛围平和',
    unresolved: '暂无悬念'
};

/**
 * 格式化场景模板字符串为纯文本 (用于原生动态宏与外部导出)
 * @param {string} template 
 * @param {object} scene 
 * @returns {string}
 */
export function formatSceneTemplate(template, scene) {
    if (!template || typeof template !== 'string') {
        template = STATUS_BAR_PRESETS.DEFAULT.template;
    }
    const sc = scene || {};

    const charStr = Array.isArray(sc.in_scene_characters) && sc.in_scene_characters.length > 0
        ? sc.in_scene_characters.join(', ')
        : (sc.in_scene_characters === null ? '无人在场' : '');

    return template
        .replace(/\{\{\s*location\s*\}\}/gi, sc.location || '')
        .replace(/\{\{\s*time\s*\}\}/gi, sc.time || '')
        .replace(/\{\{\s*characters\s*\}\}/gi, charStr)
        .replace(/\{\{\s*action\s*\}\}/gi, sc.action || '')
        .replace(/\{\{\s*tension\s*\}\}/gi, sc.tension || '')
        .replace(/\{\{\s*unresolved\s*\}\}/gi, sc.unresolved || '');
}

/**
 * 将模板解析为交互式 HTML 元素 (为每个字段添加行内即改钩子)
 * @param {string} template 
 * @param {object} scene 
 * @returns {string}
 */
export function renderStatusBarHtml(template, scene) {
    if (!template || typeof template !== 'string') {
        template = STATUS_BAR_PRESETS.DEFAULT.template;
    }
    const sc = scene || {};

    const charStr = Array.isArray(sc.in_scene_characters) && sc.in_scene_characters.length > 0
        ? sc.in_scene_characters.join(', ')
        : (sc.in_scene_characters === null ? '无人在场' : '');

    const values = {
        location: sc.location || '',
        time: sc.time || '',
        characters: charStr,
        action: sc.action || '',
        tension: sc.tension || '',
        unresolved: sc.unresolved || ''
    };

    // 分割模板并组装 HTML
    const regex = /\{\{\s*(location|time|characters|action|tension|unresolved)\s*\}\}/gi;
    let lastIndex = 0;
    let match;
    let html = '';

    while ((match = regex.exec(template)) !== null) {
        const textBefore = template.substring(lastIndex, match.index);
        if (textBefore) {
            html += `<span class="pm-status-static-text">${escapeHtml(textBefore)}</span>`;
        }

        const field = match[1].toLowerCase();
        const rawVal = values[field] || '';
        const displayVal = rawVal || FIELD_FALLBACKS[field];
        const isEmpty = !rawVal;
        const fieldName = FIELD_LABELS[field] || field;

        html += `<span class="pm-status-token pm-token-field ${isEmpty ? 'pm-field-empty' : ''}" data-field="${field}" title="点击修改「${fieldName}」 (Enter保存, Esc取消)">`
            + `<span class="pm-field-value">${escapeHtml(displayVal)}</span>`
            + `</span>`;

        lastIndex = regex.lastIndex;
    }

    const textAfter = template.substring(lastIndex);
    if (textAfter) {
        html += `<span class="pm-status-static-text">${escapeHtml(textAfter)}</span>`;
    }

    return html;
}

/**
 * 注入状态栏核心样式表 (支持多主题与移动端自适应)
 */
function ensureStatusBarStyles(doc) {
    if (!doc || doc.getElementById('pm-statusbar-styles')) return;

    const styleEl = doc.createElement('style');
    styleEl.id = 'pm-statusbar-styles';
    styleEl.textContent = `
        /* 状态栏基础容器 */
        #pm-scene-statusbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            box-sizing: border-box;
            width: 100%;
            margin: 4px 0 6px 0;
            padding: 5px 12px;
            font-size: 12px;
            line-height: 1.5;
            border-radius: 8px;
            transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
            user-select: none;
            position: relative;
            z-index: 45;
        }

        /* 停靠在输入框上方模式 */
        #pm-scene-statusbar[data-dock="input_top"] {
            margin-bottom: 6px;
        }

        /* 聊天区吸顶模式 */
        #pm-scene-statusbar[data-dock="chat_top"] {
            position: sticky;
            top: 0;
            left: 0;
            right: 0;
            z-index: 55;
            margin: 0 0 8px 0;
            border-radius: 0 0 8px 8px;
        }

        /* 独立悬浮胶囊模式 */
        #pm-scene-statusbar[data-dock="floating"] {
            position: fixed;
            top: 60px;
            left: 50%;
            transform: translateX(-50%);
            width: auto;
            max-width: 90vw;
            z-index: 9999;
            box-shadow: 0 8px 24px rgba(0,0,0,0.35);
        }

        /* 视觉主题 1: 极光毛玻璃 (Glassmorphism, 默认) */
        #pm-scene-statusbar.pm-status-theme-glass {
            background: rgba(15, 23, 42, 0.72);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 255, 255, 0.15);
            color: #f1f5f9;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
        }

        /* 视觉主题 2: 赛博霓虹 (Cyber) */
        #pm-scene-statusbar.pm-status-theme-cyber {
            background: rgba(10, 15, 30, 0.88);
            backdrop-filter: blur(8px);
            border: 1px solid #06b6d4;
            color: #67e8f9;
            box-shadow: 0 0 14px rgba(6, 182, 212, 0.35);
        }

        /* 视觉主题 3: 羊皮纸复古 (Parchment) */
        #pm-scene-statusbar.pm-status-theme-parchment {
            background: #fbf7ee;
            border: 1px solid #d4c5a9;
            color: #451a03;
            box-shadow: 0 3px 10px rgba(120, 53, 15, 0.15);
        }

        /* 视觉主题 4: 极简纯净 (Minimal) */
        #pm-scene-statusbar.pm-status-theme-minimal {
            background: rgba(24, 24, 27, 0.85);
            border: 1px solid rgba(255, 255, 255, 0.08);
            color: #e4e4e7;
        }

        /* 主体布局 */
        .pm-status-capsule {
            display: flex;
            align-items: center;
            justify-content: space-between;
            width: 100%;
            gap: 8px;
        }

        .pm-status-main {
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex: 1;
            overflow: hidden;
            gap: 8px;
        }

        .pm-status-line {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 4px;
            overflow-x: auto;
            white-space: pre-wrap;
            scrollbar-width: none;
            -ms-overflow-style: none;
        }
        .pm-status-line::-webkit-scrollbar {
            display: none;
        }

        /* 字段标签与交互效果 */
        .pm-status-token.pm-token-field {
            display: inline-flex;
            align-items: center;
            padding: 1px 6px;
            margin: 0 2px;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.15s ease;
            font-weight: 500;
            background: rgba(255, 255, 255, 0.08);
            border: 1px dashed rgba(255, 255, 255, 0.25);
        }
        .pm-status-theme-parchment .pm-status-token.pm-token-field {
            background: rgba(120, 53, 15, 0.08);
            border: 1px dashed rgba(120, 53, 15, 0.3);
        }
        .pm-status-token.pm-token-field:hover {
            background: rgba(59, 130, 246, 0.35);
            border-color: #60a5fa;
            transform: translateY(-1px);
        }
        .pm-status-theme-cyber .pm-status-token.pm-token-field:hover {
            background: rgba(6, 182, 212, 0.3);
            border-color: #22d3ee;
            box-shadow: 0 0 8px rgba(6, 182, 212, 0.5);
        }
        .pm-status-token.pm-field-empty {
            opacity: 0.6;
            font-style: italic;
        }

        /* 行内即改输入框 */
        .pm-status-inline-input {
            background: rgba(0, 0, 0, 0.45);
            border: 1px solid #38bdf8;
            border-radius: 4px;
            color: #ffffff;
            font-size: 11px;
            padding: 2px 6px;
            outline: none;
            box-shadow: 0 0 6px rgba(56, 189, 248, 0.4);
            min-width: 60px;
        }
        .pm-status-theme-parchment .pm-status-inline-input {
            background: #ffffff;
            border: 1px solid #b45309;
            color: #451a03;
        }

        /* 控制按钮与时光机 */
        .pm-status-actions {
            display: flex;
            align-items: center;
            gap: 4px;
            flex-shrink: 0;
        }

        .pm-status-btn {
            background: none;
            border: none;
            color: inherit;
            opacity: 0.75;
            cursor: pointer;
            padding: 3px 6px;
            border-radius: 4px;
            font-size: 11px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transition: all 0.15s ease;
        }
        .pm-status-btn:hover {
            opacity: 1;
            background: rgba(255, 255, 255, 0.15);
            transform: scale(1.08);
        }

        /* 折叠迷你状态 */
        #pm-scene-statusbar.pm-status-collapsed {
            width: auto;
            max-width: 140px;
            padding: 3px 8px;
            opacity: 0.85;
            border-radius: 20px;
        }
        #pm-scene-statusbar.pm-status-collapsed:hover {
            opacity: 1;
        }
        .pm-status-collapsed-hint {
            margin-left: 4px;
            font-size: 11px;
            font-weight: 600;
        }

        /* 移动端 WebView 响应式微调 */
        @media (max-width: 768px) {
            #pm-scene-statusbar {
                font-size: 11px;
                padding: 4px 8px;
            }
            .pm-status-line {
                max-height: 48px;
                overflow-y: auto;
            }
            .pm-status-token.pm-token-field {
                padding: 0 4px;
            }
        }
    `;

    const target = doc.head || doc.body;
    if (target && typeof target.appendChild === 'function') {
        target.appendChild(styleEl);
    }
}

/**
 * 寻找状态栏挂载的目标 DOM 节点
 */
function findMountTarget(doc, dock) {
    if (!doc) return null;

    if (dock === STATUS_BAR_DOCKS.CHAT_TOP) {
        const chat = doc.getElementById('chat');
        if (chat) return { target: chat, method: 'prepend' };
        const chatContainer = doc.getElementById('chat_container') || doc.getElementById('chat-container');
        if (chatContainer) return { target: chatContainer, method: 'prepend' };
    }

    if (dock === STATUS_BAR_DOCKS.FLOATING) {
        return { target: doc.body, method: 'append' };
    }

    // 默认: INPUT_TOP (输入框上方 / QR 栏上方)
    const qrBar = doc.getElementById?.('qr--bar') || doc.getElementById?.('qr-bar') || (typeof doc.querySelector === 'function' ? doc.querySelector('.qr--bar') : null);
    if (qrBar && qrBar.parentNode) {
        return { target: qrBar, method: 'before' };
    }

    const chatInput = doc.getElementById?.('chat_input');
    const formChat = doc.getElementById?.('form_chat') || doc.getElementById?.('send_form') || (chatInput && typeof chatInput.closest === 'function' ? chatInput.closest('form') : null);
    if (formChat && formChat.parentNode) {
        return { target: formChat, method: 'before' };
    }

    const sheld = doc.getElementById?.('sheld');
    if (sheld) {
        return { target: sheld, method: 'prepend' };
    }

    if (doc.body) {
        return { target: doc.body, method: 'append' };
    }
    return null;
}

/**
 * 派发全局只读原生事件 (供第三方插件与角色卡无缝监听)
 */
export function dispatchSceneUpdate(scene) {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        try {
            window.dispatchEvent(new CustomEvent('st-pm-scene-update', {
                detail: safeClone(scene || getState()?.scene || {})
            }));
        } catch {
            // 忽略事件派发异常
        }
    }
}

let activeInlineEditingField = null;

/**
 * 呈现场景状态栏 (主渲染函数)
 */
export function renderStatusBar() {
    const W = resolveHostWindow() || (typeof window !== 'undefined' ? window : null);
    const D = W?.document || (typeof document !== 'undefined' ? document : null);
    if (!W || !D || typeof D.getElementById !== 'function' || typeof D.createElement !== 'function') {
        dispatchSceneUpdate(getState()?.scene);
        return;
    }

    const settings = getSettings();
    let barEl = D.getElementById('pm-scene-statusbar');

    // 1. 若配置中未开启，安全移除或隐藏
    if (settings.showStatusBar === false) {
        if (barEl && typeof barEl.remove === 'function') barEl.remove();
        return;
    }

    // 2. 注入样式
    ensureStatusBarStyles(D);

    const scene = getState()?.scene || {};
    const dock = settings.statusBarDock || STATUS_BAR_DOCKS.INPUT_TOP;
    const theme = settings.statusBarTheme || STATUS_BAR_THEMES.GLASS;
    const isCollapsed = Boolean(settings.statusBarCollapsed);
    const template = settings.statusBarTemplate || STATUS_BAR_PRESETS.DEFAULT.template;

    // 3. 创建或复用 DOM
    if (!barEl) {
        barEl = D.createElement('div');
        barEl.id = 'pm-scene-statusbar';
    }

    barEl.className = `pm-statusbar-container pm-status-theme-${theme} ${isCollapsed ? 'pm-status-collapsed' : ''}`;
    if (typeof barEl.setAttribute === 'function') {
        barEl.setAttribute('data-dock', dock);
    }

    // 4. 挂载到目标位置
    const mount = findMountTarget(D, dock);
    if (mount && mount.target) {
        try {
            if (mount.method === 'before' && mount.target.parentNode && typeof mount.target.parentNode.insertBefore === 'function' && barEl.nextSibling !== mount.target) {
                mount.target.parentNode.insertBefore(barEl, mount.target);
            } else if (mount.method === 'prepend' && typeof mount.target.insertBefore === 'function' && barEl.parentNode !== mount.target) {
                mount.target.insertBefore(barEl, mount.target.firstChild);
            } else if (mount.method === 'append' && typeof mount.target.appendChild === 'function' && barEl.parentNode !== mount.target) {
                mount.target.appendChild(barEl);
            }
        } catch {
            // DOM 挂载异常兜底
        }
    }

    // 若当前正在进行行内编辑，不打断输入
    if (activeInlineEditingField && barEl.querySelector('.pm-status-inline-input')) {
        return;
    }

    // 5. 渲染内部 HTML
    const renderedContent = renderStatusBarHtml(template, scene);

    barEl.innerHTML = `
        <div class="pm-status-capsule">
            <button type="button" class="pm-status-btn pm-status-toggle-btn" id="pm-status-toggle-btn" title="${isCollapsed ? '展开场景状态栏' : '折叠场景状态栏'}">
                <i class="fa-solid ${isCollapsed ? 'fa-compass' : 'fa-chevron-up'}"></i>
                ${isCollapsed ? '<span class="pm-status-collapsed-hint">现场 HUD</span>' : ''}
            </button>
            <div class="pm-status-main" style="${isCollapsed ? 'display: none;' : ''}">
                <div class="pm-status-line">
                    ${renderedContent}
                </div>
                <div class="pm-status-actions">
                    <button type="button" class="pm-status-btn pm-status-undo-btn" id="pm-status-undo-btn" title="撤回上一次场景快照 (时光机)">
                        <i class="fa-solid fa-rotate-left"></i>
                    </button>
                    <button type="button" class="pm-status-btn pm-status-cycle-btn" id="pm-status-cycle-btn" title="一键切换玩法风格预设">
                        <i class="fa-solid fa-palette"></i>
                    </button>
                </div>
            </div>
        </div>
    `;

    // 6. 绑定事件
    bindStatusBarEvents(barEl, D);

    // 7. 广播全局事件
    dispatchSceneUpdate(scene);
}

/**
 * 绑定状态栏用户交互事件
 */
function bindStatusBarEvents(barEl, doc) {
    if (!barEl || typeof barEl.querySelector !== 'function') return;

    // 折叠 / 展开
    barEl.querySelector('#pm-status-toggle-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const settings = getSettings();
        const nextCollapsed = !settings.statusBarCollapsed;
        updateSettings({ statusBarCollapsed: nextCollapsed });
        saveSettingsImmediately();
        renderStatusBar();
    });

    // 时光机一键撤销
    barEl.querySelector('#pm-status-undo-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const res = rollbackScene();
        if (res && res.success) {
            renderStatusBar();
        } else {
            console.log(`[${MODULE_NAME}] 时光机回滚: ${res?.message || '暂无历史快照'}`);
        }
    });

    // 一键切换预设风格
    barEl.querySelector('#pm-status-cycle-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const settings = getSettings();
        const presets = Object.values(STATUS_BAR_PRESETS);
        const curTemplate = settings.statusBarTemplate || '';
        let currentIndex = presets.findIndex(p => p.template === curTemplate);
        if (currentIndex < 0) currentIndex = 0;
        const nextPreset = presets[(currentIndex + 1) % presets.length];

        updateSettings({ statusBarTemplate: nextPreset.template });
        saveSettingsImmediately();
        renderStatusBar();
    });

    // 行内即改 (In-line Quick Edit)
    barEl.querySelectorAll('.pm-token-field').forEach(tokenEl => {
        tokenEl.addEventListener('click', (e) => {
            e.stopPropagation();
            if (activeInlineEditingField) return;

            const field = tokenEl.getAttribute('data-field');
            if (!field) return;

            const scene = getState()?.scene || {};
            let rawVal = scene[field] || '';
            if (field === 'characters') {
                rawVal = Array.isArray(scene.in_scene_characters) ? scene.in_scene_characters.join(', ') : '';
            }

            activeInlineEditingField = field;
            tokenEl.innerHTML = `<input type="text" class="pm-status-inline-input" value="${escapeHtml(rawVal)}" placeholder="输入${FIELD_LABELS[field] || field}...">`;

            const input = tokenEl.querySelector('input');
            if (!input) return;

            input.focus();
            input.select();

            const finishEdit = (save) => {
                if (!activeInlineEditingField) return;
                activeInlineEditingField = null;

                if (save) {
                    const newVal = input.value.trim();
                    if (field === 'characters') {
                        const arr = newVal ? newVal.split(/[,，、]/).map(s => s.trim()).filter(Boolean) : [];
                        updateScene({ in_scene_characters: arr });
                    } else {
                        updateScene({ [field]: newVal });
                    }
                }
                renderStatusBar();
            };

            input.addEventListener('keydown', (ke) => {
                if (ke.key === 'Enter') {
                    ke.preventDefault();
                    finishEdit(true);
                } else if (ke.key === 'Escape') {
                    ke.preventDefault();
                    finishEdit(false);
                }
            });

            input.addEventListener('blur', () => {
                finishEdit(true);
            });
        });
    });
}

/**
 * 注册 SillyTavern 原生动态宏 (Native Macros)
 * 供用户角色卡开场白、描述、世界书与第三方插件直接通过 {{pm_location}} 等读取
 */
export function registerSceneMacros() {
    let c = null;
    try {
        c = window?.SillyTavern?.getContext?.();
    } catch {
        c = null;
    }
    if (!c) return;

    const definitions = [
        {
            name: 'pm_location',
            description: '持续记忆: 当前场景地点',
            handler: () => getState()?.scene?.location || ''
        },
        {
            name: 'pm_time',
            description: '持续记忆: 当前时间与天气环境',
            handler: () => getState()?.scene?.time || ''
        },
        {
            name: 'pm_characters',
            description: '持续记忆: 当前在场活跃角色列表',
            handler: () => {
                const chars = getState()?.scene?.in_scene_characters;
                return Array.isArray(chars) ? chars.join(', ') : '';
            }
        },
        {
            name: 'pm_action',
            description: '持续记忆: 当前正在进行的动作焦点',
            handler: () => getState()?.scene?.action || ''
        },
        {
            name: 'pm_tension',
            description: '持续记忆: 当前心境氛围与情绪张力',
            handler: () => getState()?.scene?.tension || ''
        },
        {
            name: 'pm_unresolved',
            description: '持续记忆: 当前悬念与未决问题',
            handler: () => getState()?.scene?.unresolved || ''
        },
        {
            name: 'pm_status_line',
            description: '持续记忆: 格式化场景状态总览 (遵循当前模板配置)',
            handler: () => {
                const s = getState();
                const settings = getSettings();
                return formatSceneTemplate(settings.statusBarTemplate, s?.scene);
            }
        }
    ];

    definitions.forEach(({ name, description, handler }) => {
        try {
            if (typeof window !== 'undefined' && window.macros?.registry && typeof window.macros.registry.registerMacro === 'function') {
                window.macros.registry.registerMacro(name, handler, description);
            } else if (c.macros && typeof c.macros.register === 'function') {
                c.macros.register(name, {
                    description,
                    handler
                });
            } else if (typeof c.registerMacro === 'function') {
                c.registerMacro(name, handler);
            }
        } catch (e) {
            console.warn(`[${MODULE_NAME}] 宏 {{${name}}} 注册警告:`, e);
        }
    });
}
