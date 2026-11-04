/**
 * SillyTavern 插件入口: 持续记忆 (Persistent Memory)
 * 遵循现场快照 (L0 Resume) 与事件驱动记忆架构
 */

import { MODULE_NAME } from './src/config.js';
import { loadCurrentState, getSettings } from './src/state.js';
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
            c.eventSource.once?.(c.event_types.APP_READY, finish);
        } catch { /* 忽略 */ }
        setTimeout(finish, 3000); // 兜底超时
    });
}

/**
 * 主初始化函数
 */
async function init() {
    console.log(`[${MODULE_NAME}] 正在初始化持续记忆插件...`);
    const c = await waitForContext();
    await waitForAppReady(c);

    // 1. 初始化当前聊天的状态
    loadCurrentState();

    // 2. 初始化 UI 面板
    initUI();

    // 3. 监听切档/切换聊天事件
    c.eventSource.on(c.event_types.CHAT_CHANGED, () => {
        console.log(`[${MODULE_NAME}] 检测到聊天会话切换，重新加载记忆元数据`);
        loadCurrentState();
        buildAndInjectMemoryPrompt();
    });

    // 4. 发送前钩子：打包注入记忆 Prompt
    c.eventSource.on(c.event_types.GENERATE_BEFORE_COMBINE_PROMPTS, () => {
        if (getSettings().enabled) {
            buildAndInjectMemoryPrompt();
        }
    });

    // 5. 消息完成与渲染处理
    // 针对同步模式 (Sync Tag)：在消息渲染时剥离隐藏标签
    c.eventSource.on(c.event_types.CHARACTER_MESSAGE_RENDERED, (mesid) => {
        const id = Number(mesid);
        const msg = c.chat?.[id];
        if (!msg || msg.is_user) return;

        // 如果开启了同步伴生模式，尝试剥离
        const cleaned = extractAndApplySyncTag(msg.mes);
        if (cleaned !== msg.mes) {
            msg.mes = cleaned;
            const el = document.querySelector(`#chat > .mes[mesid="${id}"] .mes_text`);
            if (el) {
                // 仅更新文本容器
                el.innerHTML = c.markdown(cleaned);
            }
        }
    });

    // 针对异步模式 (Async Quiet Prompt)：在生成完成后触发后台提炼
    c.eventSource.on(c.event_types.MESSAGE_RECEIVED, async (mesid) => {
        const id = Number(mesid);
        const msg = c.chat?.[id];
        if (msg && !msg.is_user) {
            // AI 回复完成后，尝试触发异步消化
            await triggerAsyncDigest(false);
        }
    });

    console.log(`[${MODULE_NAME}] 持续记忆系统初始化完毕，准备接管跨会话情境连续性`);

    // 暴露全局调试接口
    window.__persistentMemory = {
        getState: () => loadCurrentState(),
        injectNow: () => buildAndInjectMemoryPrompt(),
        digestNow: () => triggerAsyncDigest(true)
    };
}

// 启动入口
jQuery(async () => {
    try {
        await init();
    } catch (e) {
        console.error(`[${MODULE_NAME}] 启动失败:`, e);
    }
});
