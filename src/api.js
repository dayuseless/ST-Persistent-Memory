/**
 * 持续记忆 API 通信客户端与网络传输层 (API Client & Transport Layer, v0.1.39)
 *
 * 核心职责：
 * 1. 领域职责解耦：将底层 HTTP 请求、酒馆宿主 generateRaw 降级、AbortController 超时管理从提炼业务引擎中彻底剥离。
 * 2. 统一超时控制：对自定义端点与原生酒馆请求提供统一生命周期控制与主动中止 (withTimeout)。
 * 3. 端点格式规范化：自动规范化 Base URL，智能兼容并补齐 /chat/completions。
 * 4. 连通性探测：提供专用轻量探测接口 (testCustomApiConnection)，实时计算往返延迟与模型响应。
 */

import { MODULE_NAME } from './config.js';
import { getSettings } from './state.js';

export const DIGEST_REQUEST_TIMEOUT_MS = 45000;  // P2-03: 45秒提炼请求硬超时
export const TEST_CONNECTION_TIMEOUT_MS = 15000; // P2-03: 15秒接口连通性测试超时

/**
 * 规范化 OpenAI 兼容端点 URL
 * 智能去除末尾多余斜杠并自动补齐 /chat/completions
 */
export function normalizeChatCompletionsUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    const cleanUrl = rawUrl.trim().replace(/\/+$/, '');
    if (!cleanUrl) return '';
    return cleanUrl.endsWith('/chat/completions') ? cleanUrl : `${cleanUrl}/chat/completions`;
}

/**
 * 包装带超时与主动中止控制的 Promise
 * 注：原生酒馆接口 (c.generateRaw / c.generateQuietPrompt) 本身不提供宿主底层的 cancellation handle，
 * 此处超时或中止时立即向调用方拒绝 (reject) 并释放任务锁，确保后续任务不被挂起阻断；
 * 自定义 fetch API 则会通过绑定的 AbortController 真正终止网络传输。
 *
 * @param {Function} startRequest - 返回 Promise 的异步任务发起函数
 * @param {number} timeoutMs - 超时毫秒数
 * @param {string} label - 错误提示标签
 * @param {AbortSignal|null} [abortSignal] - 外部主动中止信号
 * @returns {Promise<any>}
 */
export function withTimeout(startRequest, timeoutMs, label, abortSignal = null) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let onAbort = null;

        const cleanup = () => {
            clearTimeout(timeoutId);
            if (onAbort && abortSignal) {
                try { abortSignal.removeEventListener('abort', onAbort); } catch {}
            }
        };

        const timeoutId = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error(`${label}超时 (超过 ${timeoutMs / 1000} 秒未响应)`));
        }, timeoutMs);

        if (abortSignal) {
            if (abortSignal.aborted) {
                settled = true;
                cleanup();
                return reject(new Error(`${label}已被中止取消`));
            }
            onAbort = () => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new Error(`${label}已被用户手动中止取消`));
            };
            try {
                abortSignal.addEventListener('abort', onAbort, { once: true });
            } catch {}
        }

        Promise.resolve()
            .then(startRequest)
            .then(value => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(value);
            }, error => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(error);
            });
    });
}

/**
 * 执行提炼生成请求：
 * 1. 若配置了独立 API，直接 fetch OpenAI 兼容端点 (彻底隔绝主会话上下文与历史思维链丢失问题)
 * 2. 否则优先调用酒馆 context.generateRaw 发送单轮自包含 Prompt (不带全量聊天历史，杜绝 DeepSeek reasoning_content 错误)
 * 3. 兜底回退至 context.generateQuietPrompt
 *
 * @param {object} c - SillyTavern 上下文对象
 * @param {string} digestPrompt - 自包含提炼提示词
 * @param {object} settings - 插件配置项
 * @param {AbortSignal|null} [abortSignal] - 主动中止信号
 * @returns {Promise<string>}
 */
export async function executeDigestRequest(c, digestPrompt, settings, abortSignal = null) {
    if (abortSignal?.aborted) {
        throw new Error('提炼请求已被主动中止');
    }

    // 方案 A: 独立 API 直连 (彻底解耦主端点)
    if (settings?.useCustomApi && settings?.customApiUrl) {
        const targetUrl = normalizeChatCompletionsUrl(settings.customApiUrl);
        const modelName = (settings.customApiModel || 'gpt-4o-mini').trim();

        console.log(`[${MODULE_NAME}] [Async] 使用自定义 OpenAI 兼容接口发起提炼: ${targetUrl} (模型: ${modelName})`);
        const headers = { 'Content-Type': 'application/json' };
        if (settings.customApiKey) {
            headers['Authorization'] = `Bearer ${settings.customApiKey.trim()}`;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
            controller.abort();
        }, DIGEST_REQUEST_TIMEOUT_MS);

        let onExternalAbort = null;
        if (abortSignal) {
            onExternalAbort = () => controller.abort();
            try {
                abortSignal.addEventListener('abort', onExternalAbort, { once: true });
            } catch {}
        }

        try {
            const res = await fetch(targetUrl, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({
                    model: modelName,
                    messages: [
                        { role: 'user', content: digestPrompt }
                    ],
                    max_tokens: 2048,
                    temperature: 0.1
                }),
                signal: controller.signal
            });

            if (!res.ok) {
                const errBody = await res.text().catch(() => '');
                throw new Error(`独立 API 响应异常 HTTP ${res.status}: ${errBody.slice(0, 300)}`);
            }

            const data = await res.json();
            const content = data?.choices?.[0]?.message?.content;
            if (!content) throw new Error('独立 API 返回内容为空');
            return content;
        } catch (fetchErr) {
            if (abortSignal?.aborted) {
                throw new Error('提炼请求已被用户主动中止');
            }
            if (fetchErr.name === 'AbortError') {
                throw new Error(`独立提炼 API 请求超时 (超过 ${DIGEST_REQUEST_TIMEOUT_MS / 1000} 秒未响应)`);
            }
            throw fetchErr;
        } finally {
            clearTimeout(timeoutId);
            if (onExternalAbort && abortSignal) {
                try { abortSignal.removeEventListener('abort', onExternalAbort); } catch {}
            }
        }
    }

    // 方案 B: 优先使用 generateRaw (单轮独立 Prompt，显式指定 responseLength 脱钩前端对话长度限制)
    if (c && typeof c.generateRaw === 'function') {
        return await withTimeout(
            () => c.generateRaw({ prompt: digestPrompt, responseLength: 2048 }),
            DIGEST_REQUEST_TIMEOUT_MS,
            '原生 generateRaw 提炼请求',
            abortSignal
        );
    }

    // 方案 C: 兜底调用 generateQuietPrompt (显式剥离 reasoning 并指定输出长度)
    if (c && typeof c.generateQuietPrompt === 'function') {
        return await withTimeout(
            () => c.generateQuietPrompt({ quietPrompt: digestPrompt, responseLength: 2048, removeReasoning: true }),
            DIGEST_REQUEST_TIMEOUT_MS,
            '原生 generateQuietPrompt 提炼请求',
            abortSignal
        );
    }

    throw new Error('当前环境未发现可用的文本生成接口 (generateRaw / generateQuietPrompt)');
}

/**
 * 测试独立 API 连通性
 * 发送轻量探针请求，评估网络往返延迟与端点可用性
 *
 * @param {object|null} [overrideSettings] - 可选的覆盖配置项
 * @returns {Promise<{ success: boolean, latency?: number, model?: string, error?: string }>}
 */
export async function testCustomApiConnection(overrideSettings = null) {
    const settings = overrideSettings || getSettings();
    if (!settings?.customApiUrl) {
        return { success: false, error: '请先填写 Base URL (例如: https://api.openai.com/v1 或本地 http://localhost:11434/v1)' };
    }
    const targetUrl = normalizeChatCompletionsUrl(settings.customApiUrl);
    const modelName = (settings.customApiModel || 'gpt-4o-mini').trim();

    const headers = { 'Content-Type': 'application/json' };
    if (settings.customApiKey) {
        headers['Authorization'] = `Bearer ${settings.customApiKey.trim()}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        controller.abort();
    }, TEST_CONNECTION_TIMEOUT_MS);

    const start = Date.now();
    try {
        const res = await fetch(targetUrl, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                model: modelName,
                messages: [
                    { role: 'user', content: 'Respond with the single word "OK".' }
                ],
                max_tokens: 8,
                temperature: 0.1
            }),
            signal: controller.signal
        });

        const latency = Date.now() - start;

        if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            return {
                success: false,
                error: `HTTP ${res.status} (${res.statusText}): ${errBody.slice(0, 160)}`
            };
        }

        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content?.trim();
        return {
            success: true,
            latency,
            model: data?.model || modelName,
            reply: content || 'OK'
        };
    } catch (e) {
        if (e.name === 'AbortError') {
            return { success: false, error: `连接超时 (超过 ${TEST_CONNECTION_TIMEOUT_MS / 1000} 秒无响应)` };
        }
        return { success: false, error: e.message || '网络连接失败' };
    } finally {
        clearTimeout(timeoutId);
    }
}
