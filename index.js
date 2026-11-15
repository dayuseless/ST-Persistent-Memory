/**
 * SillyTavern 鎻掍欢鍏ュ彛: 鎸佺画璁板繂 (Persistent Memory) v0.1.44
 * 閬靛惊鐜板満蹇収 (L0 Resume) 涓庝簨浠堕┍鍔ㄨ蹇嗘灦鏋? */

import { MODULE_NAME, EXTENSION_VERSION } from './src/config.js';
import { loadCurrentState, getSettings, onStateChange } from './src/state.js';
import { buildAndInjectMemoryPrompt } from './src/injector.js';
import { extractAndApplySyncTag } from './src/apply.js';
import { triggerAsyncDigest } from './src/extractor.js';
import { initUI } from './src/ui.js';
import { registerSlashCommands } from './src/commands.js';
import { registerGlobalApi } from './src/sdk.js';

// 绔嬪嵆鎸傝浇鍏ㄥ眬 SDK (window.STPersistentMemoryAPI)
try {
    registerGlobalApi();
} catch (e) {
    console.warn(`[${MODULE_NAME}] 鍏ㄥ眬 SDK 娉ㄥ唽寮傚父:`, e);
}

const CTX_WAIT_MS = 250;
const CTX_TIMEOUT_MS = 30000;

function getContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

/**
 * 杞绛夊緟 SillyTavern 涓婁笅鏂囧氨缁? */
function waitForContext() {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
            const c = getContext();
            if (c && c.eventSource && typeof c.setExtensionPrompt === 'function') {
                return resolve(c);
            }
            if (Date.now() - start > CTX_TIMEOUT_MS) {
                return reject(new Error('绛夊緟 SillyTavern 涓婁笅鏂囪秴鏃?));
            }
            setTimeout(tick, CTX_WAIT_MS);
        };
        tick();
    });
}

/**
 * 绛夊緟 APP_READY 浜嬩欢
 */
function waitForAppReady(c) {
    return new Promise(resolve => {
        let done = false;
        const finish = () => { if (done) return; done = true; resolve(); };
        try {
            c.eventSource.on?.(c.event_types.APP_READY, finish);
        } catch { /* 蹇界暐 */ }
        setTimeout(finish, 1000); // 鍏滃簳瓒呮椂
    });
}

let isInitialized = false;

/**
 * 涓诲垵濮嬪寲鍑芥暟
 */
async function init() {
    if (isInitialized) {
        console.log(`[${MODULE_NAME}] 鎻掍欢宸插畬鎴愬垵濮嬪寲锛岃烦杩囬噸澶嶅垵濮嬪寲`);
        return;
    }
    isInitialized = true;
    console.log(`[${MODULE_NAME}] 姝ｅ湪鍒濆鍖栨寔缁蹇嗘彃浠?(v${EXTENSION_VERSION})...`);
    const c = await waitForContext();
    await waitForAppReady(c);

    // 1. 浼樺厛鍒濆鍖?UI 闈㈡澘 (淇濊瘉鎮诞鐞冧笌鍘熺敓鎶藉眽缁濆绋冲畾鍛堢幇锛屼笉鍙楀悗缁€昏緫骞叉壈)
    try {
        initUI();
    } catch (e) {
        console.error(`[${MODULE_NAME}] UI 鍒濆鍖栧紓甯?`, e);
    }

    // 2. 娉ㄥ唽鍘熺敓蹇嵎鏂滄潬鎸囦护 (/remember, /scene, /inspect, /digest, /forget)
    try {
        await registerSlashCommands();
    } catch (e) {
        console.warn(`[${MODULE_NAME}] 鏂滄潬鎸囦护娉ㄥ唽寮傚父:`, e);
    }

    // 3. 鍒濆鍖栧綋鍓嶈亰澶╃殑鐘舵€佸苟鎵ц鍒濇娉ㄥ叆
    try {
        loadCurrentState();
        if (getSettings().enabled) {
            buildAndInjectMemoryPrompt();
        }
    } catch (e) {
        console.error(`[${MODULE_NAME}] 鐘舵€佸姞杞戒笌鍒濇娉ㄥ叆寮傚父:`, e);
    }

    // 3. 鐩戝惉鍒囨。涓庤亰澶╄浇鍏ヤ簨浠?    const processedSyncMessages = new Set();
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
        console.log(`[${MODULE_NAME}] 浼氳瘽鍒囨崲/杞藉叆锛屽榻愮姸鎬佸苟鏇存柊鎻愮ず璇嶆敞鍏);
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

    // 4. 鍙戦€佸墠/鐢熸垚鍓嶇簿鍑嗛挬瀛愶細纭繚鍦ㄦ彁绀鸿瘝缁勮 (getCombinedPrompt & prepareOpenAIMessages) 涔嬪墠瀹屾垚娉ㄥ叆
    // 绉婚櫎鏃跺簭杩囨櫄鐨?CHAT_COMPLETION_PROMPT_READY (鍏惰Е鍙戞椂 Chat Completion 娑堟伅浣撳凡瀹氬瀷)
    // 绉婚櫎鎻愬墠閲忓啑浣欑殑 GENERATION_STARTED (鍦ㄦ枩鏉犳寚浠ゅ墠瑙﹀彂)
    // 閲囩敤 GENERATION_AFTER_COMMANDS (鏂滄潬鎸囦护澶勭悊瀹屾垚鍚庛€佺粍瑁呮彁绀鸿瘝鍓? 涓?GENERATE_BEFORE_COMBINE_PROMPTS
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

    // 5. 璁板繂鐘舵€佹垨蹇収鍙戠敓鍙樺姩鏃讹紝瀹炴椂瀵归綈娉ㄥ叆璇?    onStateChange(() => {
        ensurePromptInjected(true);
    });

    // 6. 娑堟伅瀹屾垚涓庢覆鏌撳鐞?(甯﹀叏閾捐矾娑堟伅骞傜瓑闃查噸瀹堝崼)
    // 鍚屾浼撮殢妯″紡锛氫互 MESSAGE_RECEIVED 涓烘潈濞佹暟鎹憚鍏ヤ簨浠讹紝CHARACTER_MESSAGE_RENDERED 浣滀负鍓嶇娓叉煋鍚屾鍏滃簳
    c.eventSource.on(c.event_types.CHARACTER_MESSAGE_RENDERED, (mesid) => {
        const settings = getSettings();
        if (!settings.enabled || settings.mode !== 'sync') return;

        const id = Number(mesid);
        const msg = c.chat?.[id];
        if (!msg || msg.is_user) return;

        const key = getMessageFingerprint(c, id, msg);
        if (processedSyncMessages.has(key)) {
            // 宸插湪 MESSAGE_RECEIVED 涓畬鎴愭爣绛炬彁鍙栦笌鐘舵€佸叆搴擄紝鐩存帴杩斿洖
            return;
        }

        // 鍏滃簳鍒嗘敮锛氳嫢娓叉煋浜嬩欢鍏堜簬鎺ユ敹浜嬩欢瑙﹀彂
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

    console.log(`[${MODULE_NAME}] 鎸佺画璁板繂绯荤粺 (v${EXTENSION_VERSION}) 鍒濆鍖栧氨缁猔);

    // 鏆撮湶鍏ㄥ眬璋冭瘯鎺ュ彛
    window.__persistentMemory = {
        getState: () => loadCurrentState(),
        injectNow: () => buildAndInjectMemoryPrompt(),
        digestNow: () => triggerAsyncDigest(true)
    };
}

// 鍚姩鍏ュ彛 (鏀寔绔嬪嵆鎵ц涓?jQuery ready 鍙岄噸淇濇椿)
if (typeof document !== 'undefined' && (document.readyState === 'complete' || document.readyState === 'interactive')) {
    init().catch(e => console.error(`[${MODULE_NAME}] 鍚姩澶辫触:`, e));
} else {
    jQuery(async () => {
        try {
            await init();
        } catch (e) {
            console.error(`[${MODULE_NAME}] 鍚姩澶辫触:`, e);
        }
    });
}
