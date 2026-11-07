/**
 * SillyTavern 插件入口: 持续记忆 (Persistent Memory) v0.1.14
 * 遵循现场快照 (L0 Resume) 与事件驱动记忆架构
 */

import { MODULE_NAME, EXTENSION_VERSION } from './src/config.js';
import { loadCurrentState, getSettings, onStateChange } from './src/state.js';
import { buildAndInjectMemoryPrompt } from './src/injector.js';
import { extractAndApplySyncTag, triggerAsyncDigest } from './src/extractor.js';
import { initUI } from './src/ui.js';

const CTX_WAIT_MS = 250;
const CTX_TIMEOUT_MS = 30000;

function getContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

/**
 * 轮询等待 SillyTavern 上下文就绪
 */
function waitForContext() {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
            const c = getContext();
            if (c && c.eventSource && typeof c.setExtensionPrompt === 'function') {
                return resolve(c);
            }
            if (Date.now() - start > CTX_TIMEOUT_MS) {
                return reject(new Error('等待 SillyTavern 上下文超时'));
            }
            setTimeout(tick, CTX_WAIT_MS);
        };
        tick();
    });
}

/**
 * 等待 APP_READY 事件
 */
function waitForAppReady(c) {
    return new Promise(resolve => {
        let done = false;
        const finish = () => { if (done) return; done = true; resolve(); };
        try {
            c.eventSource.on?.(c.event_types.APP_READY, finish);
        } catch { /* 忽略 */ }
        setTimeout(finish, 1000); // 兜底超时
    });
}

/**
 * 主初始化函数
 */
async function init() {
    console.log(`[${MODULE_NAME}] 正在初始化持续记忆插件 (v${EXTENSION_VERSION})...`);
    const c = await waitForContext();
    await waitForAppReady(c);

    // 1. 优先初始化 UI 面板 (保证悬浮球与原生抽屉绝对稳定呈现，不受后续逻辑干扰)
    try {
        initUI();
    } catch (e) {
        console.error(`[${MODULE_NAME}] UI 初始化异常:`, e);
    }

    // 2. 初始化当前聊天的状态并执行初次注入
    try {
        loadCurrentState();
        if (getSettings().enabled) {
            buildAndInjectMemoryPrompt();
        }
    } catch (e) {
        console.error(`[${MODULE_NAME}] 状态加载与初次注入异常:`, e);
    }

    // 3. 监听切档与聊天载入事件
    const onChatReset = () => {
        console.log(`[${MODULE_NAME}] 会话切换/载入，对齐状态并更新提示词注入`);
        loadCurrentState();
        if (getSettings().enabled) {
            buildAndInjectMemoryPrompt();
        }
    };
    c.eventSource.on(c.event_types.CHAT_CHANGED, onChatReset);
    if (c.event_types.CHAT_LOADED) {
        c.eventSource.on(c.event_types.CHAT_LOADED, onChatReset);
    }

    // 4. 发送前/生成前多重钩子：确保无论走 OpenAI/Claude/DeepSeek 还是 TextGen，均能百分之百注入提示词
    const ensurePromptInjected = () => {
        if (getSettings().enabled) {
            buildAndInjectMemoryPrompt();
        }
    };

    if (c.event_types.GENERATION_STARTED) {
        c.eventSource.on(c.event_types.GENERATION_STARTED, ensurePromptInjected);
    }
    if (c.event_types.GENERATION_AFTER_COMMANDS) {
        c.eventSource.on(c.event_types.GENERATION_AFTER_COMMANDS, ensurePromptInjected);
    }
    if (c.event_types.GENERATE_BEFORE_COMBINE_PROMPTS) {
        c.eventSource.on(c.event_types.GENERATE_BEFORE_COMBINE_PROMPTS, ensurePromptInjected);
    }
    if (c.event_types.CHAT_COMPLETION_PROMPT_READY) {
        c.eventSource.on(c.event_types.CHAT_COMPLETION_PROMPT_READY, ensurePromptInjected);
    }
    if (c.event_types.MESSAGE_SENT) {
        c.eventSource.on(c.event_types.MESSAGE_SENT, ensurePromptInjected);
    }

    // 5. 记忆状态或快照发生变动时，实时对齐注入词
    onStateChange(() => {
        if (getSettings().enabled) {
            buildAndInjectMemoryPrompt();
        }
    });

    // 5. 消息完成与渲染处理 (同步/异步严格分流)
    // 同步伴随模式：消息渲染与接收双重防线截获伴生标签
    c.eventSource.on(c.event_types.CHARACTER_MESSAGE_RENDERED, (mesid) => {
        const settings = getSettings();
        if (!settings.enabled || settings.mode !== 'sync') return;

        const id = Number(mesid);
        const msg = c.chat?.[id];
        if (!msg || msg.is_user) return;

        const cleaned = extractAndApplySyncTag(msg.mes);
        if (cleaned !== msg.mes) {
            msg.mes = cleaned;
            c?.saveChatDebounced?.();
            const el = document.querySelector(`#chat > .mes[mesid="${id}"] .mes_text`);
            if (el) {
                el.innerHTML = c.markdown(cleaned);
            }
        }
    });

    c.eventSource.on(c.event_types.MESSAGE_RECEIVED, async (mesid) => {
        const settings = getSettings();
        if (!settings.enabled) return;

        const id = Number(mesid);
        const msg = c.chat?.[id];
        if (!msg || msg.is_user) return;

        if (settings.mode === 'sync') {
            const cleaned = extractAndApplySyncTag(msg.mes);
            if (cleaned !== msg.mes) {
                msg.mes = cleaned;
                c?.saveChatDebounced?.();
                const el = document.querySelector(`#chat > .mes[mesid="${id}"] .mes_text`);
                if (el) {
                    el.innerHTML = c.markdown(cleaned);
                }
            }
        } else if (settings.mode === 'async') {
            await triggerAsyncDigest(false);
        }
    });

    console.log(`[${MODULE_NAME}] 持续记忆系统 (v${EXTENSION_VERSION}) 初始化就绪`);

    // 暴露全局调试接口
    window.__persistentMemory = {
        getState: () => loadCurrentState(),
        injectNow: () => buildAndInjectMemoryPrompt(),
        digestNow: () => triggerAsyncDigest(true)
    };
}

// 启动入口 (支持立即执行与 jQuery ready 双重保活)
if (typeof document !== 'undefined' && (document.readyState === 'complete' || document.readyState === 'interactive')) {
    init().catch(e => console.error(`[${MODULE_NAME}] 启动失败:`, e));
} else {
    jQuery(async () => {
        try {
            await init();
        } catch (e) {
            console.error(`[${MODULE_NAME}] 启动失败:`, e);
        }
    });
}
