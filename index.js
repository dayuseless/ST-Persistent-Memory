/**
 * SillyTavern 插件入口: 持续记忆 (Persistent Memory) v0.1.41
 * 遵循现场快照 (L0 Resume) 与事件驱动记忆架构
 */

import { MODULE_NAME, EXTENSION_VERSION } from './src/config.js';
import { loadCurrentState, getSettings, onStateChange } from './src/state.js';
import { buildAndInjectMemoryPrompt } from './src/injector.js';
import { extractAndApplySyncTag } from './src/apply.js';
import { triggerAsyncDigest } from './src/extractor.js';
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

let isInitialized = false;

/**
 * 主初始化函数
 */
async function init() {
    if (isInitialized) {
        console.log(`[${MODULE_NAME}] 插件已完成初始化，跳过重复初始化`);
        return;
    }
    isInitialized = true;
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
    const processedSyncMessages = new Set();
    const processedAsyncMessages = new Set();

    function markMessageProcessed(set, key, maxItems = 500) {
        set.add(key);
        if (set.size > maxItems) {
            const first = set.values().next().value;
            set.delete(first);
        }
    }

    function getMessageFingerprint(context, mesid, msg) {
        const chatId = context?.chatId || 'default';
        const sendDate = msg?.send_date || '';
        const textLen = typeof msg?.mes === 'string' ? msg.mes.length : 0;
        return `${chatId}:${mesid}:${sendDate}:${textLen}`;
    }

    const onChatReset = () => {
        console.log(`[${MODULE_NAME}] 会话切换/载入，对齐状态并更新提示词注入`);
        processedSyncMessages.clear();
        processedAsyncMessages.clear();
        loadCurrentState();
        if (getSettings().enabled) {
            buildAndInjectMemoryPrompt();
        }
    };
    c.eventSource.on(c.event_types.CHAT_CHANGED, onChatReset);
    if (c.event_types.CHAT_LOADED) {
        c.eventSource.on(c.event_types.CHAT_LOADED, onChatReset);
    }

    // 4. 发送前/生成前精准钩子：确保在提示词组装 (getCombinedPrompt & prepareOpenAIMessages) 之前完成注入
    // 移除时序过晚的 CHAT_COMPLETION_PROMPT_READY (其触发时 Chat Completion 消息体已定型)
    // 移除提前量冗余的 GENERATION_STARTED (在斜杠指令前触发)
    // 采用 GENERATION_AFTER_COMMANDS (斜杠指令处理完成后、组装提示词前) 与 GENERATE_BEFORE_COMBINE_PROMPTS
    let lastInjectTime = 0;
    const ensurePromptInjected = (force = false) => {
        if (!getSettings().enabled) return;
        const now = Date.now();
        if (!force && (now - lastInjectTime < 50)) {
            return;
        }
        lastInjectTime = now;
        buildAndInjectMemoryPrompt();
    };

    if (c.event_types.GENERATION_AFTER_COMMANDS) {
        c.eventSource.on(c.event_types.GENERATION_AFTER_COMMANDS, () => ensurePromptInjected(false));
    }
    if (c.event_types.GENERATE_BEFORE_COMBINE_PROMPTS) {
        c.eventSource.on(c.event_types.GENERATE_BEFORE_COMBINE_PROMPTS, () => ensurePromptInjected(false));
    }
    if (c.event_types.MESSAGE_SENT) {
        c.eventSource.on(c.event_types.MESSAGE_SENT, () => ensurePromptInjected(false));
    }
    if (c.event_types.MESSAGE_DELETED) {
        c.eventSource.on(c.event_types.MESSAGE_DELETED, () => ensurePromptInjected(true));
    }
    if (c.event_types.MESSAGE_UPDATED) {
        c.eventSource.on(c.event_types.MESSAGE_UPDATED, () => ensurePromptInjected(true));
    }
    if (c.event_types.MESSAGE_SWIPED) {
        c.eventSource.on(c.event_types.MESSAGE_SWIPED, () => ensurePromptInjected(true));
    }

    // 5. 记忆状态或快照发生变动时，实时对齐注入词
    onStateChange(() => {
        ensurePromptInjected(true);
    });

    // 6. 消息完成与渲染处理 (带全链路消息幂等防重守卫)
    // 同步伴随模式：以 MESSAGE_RECEIVED 为权威数据摄入事件，CHARACTER_MESSAGE_RENDERED 作为前端渲染同步兜底
    c.eventSource.on(c.event_types.CHARACTER_MESSAGE_RENDERED, (mesid) => {
        const settings = getSettings();
        if (!settings.enabled || settings.mode !== 'sync') return;

        const id = Number(mesid);
        const msg = c.chat?.[id];
        if (!msg || msg.is_user) return;

        const key = getMessageFingerprint(c, id, msg);
        if (processedSyncMessages.has(key)) {
            // 已在 MESSAGE_RECEIVED 中完成标签提取与状态入库，直接返回
            return;
        }

        // 兜底分支：若渲染事件先于接收事件触发
        if (typeof msg.mes === 'string' && msg.mes.includes('<!--PERSISTENT_MEMORY')) {
            const cleaned = extractAndApplySyncTag(msg.mes);
            markMessageProcessed(processedSyncMessages, key);
            if (cleaned !== msg.mes) {
                msg.mes = cleaned;
                c?.saveChatDebounced?.();
                const el = document.querySelector(`#chat > .mes[mesid="${id}"] .mes_text`);
                if (el) {
                    el.innerHTML = c.markdown(cleaned);
                }
            }
        } else {
            markMessageProcessed(processedSyncMessages, key);
        }
    });

    c.eventSource.on(c.event_types.MESSAGE_RECEIVED, async (mesid) => {
        const settings = getSettings();
        if (!settings.enabled) return;

        const id = Number(mesid);
        const msg = c.chat?.[id];
        if (!msg || msg.is_user) return;

        if (settings.mode === 'sync') {
            const key = getMessageFingerprint(c, id, msg);
            if (processedSyncMessages.has(key)) {
                return;
            }
            if (typeof msg.mes === 'string' && msg.mes.includes('<!--PERSISTENT_MEMORY')) {
                const cleaned = extractAndApplySyncTag(msg.mes);
                markMessageProcessed(processedSyncMessages, key);
                if (cleaned !== msg.mes) {
                    msg.mes = cleaned;
                    c?.saveChatDebounced?.();
                    const el = document.querySelector(`#chat > .mes[mesid="${id}"] .mes_text`);
                    if (el) {
                        el.innerHTML = c.markdown(cleaned);
                    }
                }
            } else {
                markMessageProcessed(processedSyncMessages, key);
            }
        } else if (settings.mode === 'async') {
            const asyncKey = `${c?.chatId || 'default'}:${id}`;
            if (processedAsyncMessages.has(asyncKey)) {
                return;
            }
            markMessageProcessed(processedAsyncMessages, asyncKey);
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
