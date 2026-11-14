/**
 * 提炼引擎 (v0.1.39)
 * 严格落实：状态版本并发保护 (state_revision)、独立API传输层解耦 (src/api.js)、统一ACL准入层介入、长程归并引擎解耦 (src/consolidator.js)、全量历史回溯管道解耦 (src/backlog.js)、智能文本清洗与容错JSON解析解耦 (src/parser.js)、数据模式校验与防线准入网关解耦 (src/schema.js)、提示词模板与元指令编排模块解耦 (src/prompt.js)、提炼落盘与伴随协议流水线解耦 (src/apply.js)
 */

import { MODULE_NAME, MEMORY_TYPES, MEMORY_STATUS, MEMORY_LIFECYCLE, MEMORY_SCOPE } from './config.js';
import { getState, getSettings, saveCurrentState, batchUpdate, getActiveWorldBookInfo, applyInactivitySleep } from './state.js';
import { getContextParticipants, validateMemoryAcl, normalizeAndValidateMemory, checkAclEscalation, recordAclAudit } from './acl.js';
import { withTimeout, executeDigestRequest, testCustomApiConnection, DIGEST_REQUEST_TIMEOUT_MS, TEST_CONNECTION_TIMEOUT_MS } from './api.js';
import {
    stripThinkingTags,
    repairTruncatedJson,
    unwrapJsonPayload,
    isQuietDigestPayload,
    cleanAndParseJson
} from './parser.js';
import {
    validateExtractedPayload,
    validateConsolidatedPayload,
    sanitizeTriggerKeys,
    MODEL_ALLOWED_LIFECYCLES
} from './schema.js';
import {
    SYNC_TAG_REGEX,
    UNTRUSTED_TRACE_HEADER,
    UNTRUSTED_TRACE_FOOTER,
    UNTRUSTED_SECURITY_NOTICE,
    getActionGuidance,
    getMemoryContentGuidance,
    buildDigestPrompt,
    buildBacklogDigestPrompt,
    buildConsolidationPrompt
} from './prompt.js';
import {
    buildConsolidationCandidateGroups,
    triggerMemoryConsolidation,
    isMemoryConsolidationRunning
} from './consolidator.js';
import {
    findMessageIndexByTurn,
    abortBacklogDigest,
    isBacklogDigestRunning,
    triggerBacklogDigest
} from './backlog.js';
import {
    filterMemoriesForDigest,
    applyExtractedData,
    extractAndApplySyncTag
} from './apply.js';

export {
    filterMemoriesForDigest,
    applyExtractedData,
    extractAndApplySyncTag,
    stripThinkingTags,
    repairTruncatedJson,
    unwrapJsonPayload,
    isQuietDigestPayload,
    cleanAndParseJson,
    validateExtractedPayload,
    validateConsolidatedPayload,
    sanitizeTriggerKeys,
    MODEL_ALLOWED_LIFECYCLES,
    SYNC_TAG_REGEX,
    UNTRUSTED_TRACE_HEADER,
    UNTRUSTED_TRACE_FOOTER,
    UNTRUSTED_SECURITY_NOTICE,
    getActionGuidance,
    getMemoryContentGuidance,
    buildDigestPrompt,
    buildBacklogDigestPrompt,
    buildConsolidationPrompt,
    getContextParticipants,
    validateMemoryAcl,
    normalizeAndValidateMemory,
    checkAclEscalation,
    recordAclAudit,
    withTimeout,
    testCustomApiConnection,
    executeDigestRequest,
    DIGEST_REQUEST_TIMEOUT_MS,
    TEST_CONNECTION_TIMEOUT_MS,
    buildConsolidationCandidateGroups,
    triggerMemoryConsolidation,
    isMemoryConsolidationRunning,
    findMessageIndexByTurn,
    abortBacklogDigest,
    isBacklogDigestRunning,
    triggerBacklogDigest
};

function getContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

/**
 * 计算实际对话轮数 (以 AI 回复次数为基准统计真实轮次)
 */
export function getChatTurnCount(chat) {
    if (!Array.isArray(chat)) return 0;
    return chat.filter(m => !m.is_user).length;
}

// 针对不同 ChatID 维护任务并发锁 (解决跨聊天串线问题)
const activeChatDigests = new Set();

/**
 * 获取当前聊天的全局唯一稳定标识 (无有效标识时返回 null，严禁回退到统一默认会话)
 */
export function getChatIdentifier(c) {
    if (!c) return null;
    if (c.chatId) return String(c.chatId);
    if (typeof c.getCurrentChatId === 'function') {
        const id = c.getCurrentChatId();
        if (id) return String(id);
    }
    if (c.characters && c.this_chid !== undefined && c.characters[c.this_chid]) {
        const chatFile = c.characters[c.this_chid].chat;
        if (chatFile) return `char_${c.this_chid}_${chatFile}`;
    }
    return null;
}


/**
 * P0-1 核心修复：带会话身份与 state_revision 版本一致性核验的异步提炼
 */
export async function triggerAsyncDigest(force = false) {
    const c = getContext();
    const settings = getSettings();

    if (!c || !settings.enabled) return;
    if (settings.mode !== 'async' && !force) return;

    const chat = c.chat;
    if (!Array.isArray(chat) || chat.length < 2) return;

    // 捕获任务启动时的会话身份
    const startChatId = getChatIdentifier(c);
    if (!startChatId) {
        console.warn(`[${MODULE_NAME}] [Async] 无法获取有效会话标识，拒绝启动提炼任务`);
        return;
    }

    // 捕获任务启动时的状态修订号快照与轮次 (P2: 统一使用真实对话轮次)
    const state = getState();
    const startRevision = state.state_revision || 0;
    const currentTurn = getChatTurnCount(chat);

    // 针对同一 ChatID 防止并发重入
    if (activeChatDigests.has(startChatId)) {
        console.log(`[${MODULE_NAME}] [Async] 会话 ${startChatId} 的提炼正在运行中，跳过本次重入`);
        return;
    }

    // 检查真实轮数间隔与回退自愈
    const frequency = Math.max(1, Number(settings.asyncFrequency) || 3);
    if (currentTurn < (state.last_digest_floor || 0)) {
        console.log(`[${MODULE_NAME}] [Async] 检测到对话轮次发生回退或裁剪 (${state.last_digest_floor} -> ${currentTurn})，自动校准提炼基准楼层`);
        state.last_digest_floor = Math.max(0, currentTurn - frequency);
        saveCurrentState();
    }
    if (!force && (currentTurn - state.last_digest_floor < frequency)) {
        return;
    }

    // P2: 智能信息增量感知与自适应提炼节律 (防止寒暄/短消息徒增 API 消耗)
    if (!force && settings.adaptiveCadenceEnabled !== false) {
        const deltaTurns = currentTurn - (state.last_digest_floor || 0);
        const maxDelayTurns = Math.max(4, frequency * 2);
        if (deltaTurns < maxDelayTurns) {
            const startMsgIdx = findMessageIndexByTurn(chat, state.last_digest_floor || 0);
            const incrementalMessages = chat.slice(startMsgIdx);
            const totalIncrementalChars = incrementalMessages
                .map(m => (typeof m.mes === 'string' ? m.mes.trim() : ''))
                .join('').length;

            const minChars = Math.max(20, Number(settings.adaptiveCadenceMinChars) || 60);
            if (totalIncrementalChars < minChars) {
                console.log(`[${MODULE_NAME}] [Adaptive] 近期 ${deltaTurns} 轮增量对话总字数仅 ${totalIncrementalChars} 字 (< 设定阈值 ${minChars} 字)，未检测到实质剧情推进，智能延迟提炼以节约 API 消耗`);
                return;
            }
        }
    }

    activeChatDigests.add(startChatId);
    console.log(`[${MODULE_NAME}] [Async] 启动提炼任务 (会话: ${startChatId}, 修订版本: rev.${startRevision}, 轮次: 第 ${currentTurn} 轮)...`);

    let currentState = state;
    try {
        const sliceCount = Math.max(2, Math.min(15, Number(settings.digestSliceCount) || 6));
        const recentSlice = chat.slice(-sliceCount);

        // P2-04 修复：提炼输入总预算与单条消息长度约束 (防超长文本撑爆上下文与节约用户 Token 费用)
        const MAX_SINGLE_MSG_CHARS = 1000;
        const MAX_TOTAL_CONVERSATION_CHARS = 3500;

        const formattedMsgs = [];
        let accumulatedChars = 0;

        // 从最新消息往前回溯累加，优先保证最新对话的完整性，遇满则舍弃更早轮次，杜绝从单句中间机械腰斩
        for (let i = recentSlice.length - 1; i >= 0; i--) {
            const m = recentSlice[i];
            const sender = m.is_user ? (c.name1 || 'User') : (m.name || 'AI');
            let rawMes = typeof m.mes === 'string' ? m.mes.trim() : '';

            // 单条消息超长安全压缩
            if (rawMes.length > MAX_SINGLE_MSG_CHARS) {
                rawMes = rawMes.slice(0, 600) + '\n...[中间叙事已压缩]...\n' + rawMes.slice(-300);
            }

            const formatted = `[${sender}]: ${rawMes}`;
            if (accumulatedChars + formatted.length > MAX_TOTAL_CONVERSATION_CHARS && formattedMsgs.length >= 2) {
                // 已保留最新至少2条完整消息，超出总上限停止吸纳更早消息
                break;
            }

            formattedMsgs.unshift(formatted);
            accumulatedChars += formatted.length;
        }

        const conversationText = formattedMsgs.join('\n\n');

        const currentScene = JSON.stringify(state.scene, null, 2);

        // 私有记忆的上送遵循当前场景；仅当场景未知时才按近期发言者回退。
        // 该生产函数也被测试直接覆盖，避免测试重写一套与实际代码不同的过滤逻辑。
        const activeMemList = filterMemoriesForDigest(state.memories, {
            sceneParticipants: state.scene.in_scene_characters,
            conversationParticipants: recentSlice
                .map(m => m.is_user ? (c.name1 || 'User') : (m.name || 'AI')),
            fallbackParticipants: [c.name1, c.name2]
        })
            .slice(-10)
            .map(m => `(ID: ${m.id}) [${m.type}] [归属:${m.character || '公共'}] [范围:${m.scope}] ${String(m.content || '').slice(0, 90)}`)
            .join('\n') || '（暂无活跃记忆）';

        let activeWbSection = '';
        if (settings.worldBookIntegrationEnabled !== false && settings.worldBookContextToExtractor !== false) {
            try {
                const wb = await getActiveWorldBookInfo();
                if (wb && Array.isArray(wb.entries) && wb.entries.length > 0) {
                    const selectedEntries = wb.entries.slice(0, 15).map(e => {
                        const keysStr = Array.isArray(e.keys) && e.keys.length > 0 ? ` (触发词: ${e.keys.slice(0, 4).join(', ')})` : '';
                        const contentBrief = e.content ? ` - 概要: ${e.content.slice(0, 60).replace(/\s+/g, ' ')}...` : '';
                        return `- [UID: ${e.uid}] "${e.comment}"${keysStr}${contentBrief}`;
                    }).join('\n');
                    activeWbSection = `\n【当前会话关联世界书条目 (${wb.bookName})】：\n${selectedEntries}\n`;
                }
            } catch (err) {
                console.warn(`[${MODULE_NAME}] 获取世界书条目供提炼失败:`, err);
            }
        }

        const maxSceneTok = Math.max(50, Number(settings?.maxSceneTokens) || 150);
        const maxTotalTok = Math.max(100, Number(settings?.maxTotalMemoryTokens) || 450);

        const digestPrompt = buildDigestPrompt({
            currentScene,
            activeWbSection,
            activeMemList,
            conversationText,
            maxSceneTokens: maxSceneTok,
            maxTotalMemoryTokens: maxTotalTok
        });

        // 执行提炼请求 (优先独立 API，或调用 generateRaw 纯净单轮接口，绝不附带污染历史与丢失的 reasoning_content)
        const response = await executeDigestRequest(c, digestPrompt, settings);
        if (!response) {
            console.warn(`[${MODULE_NAME}] [Async] 静默提炼未收到有效回复`);
            return { success: false, error: '模型未返回有效内容' };
        }

        // ══════════════════════════════════════════════════════════════════════
        // ★ P0-1 核心安全屏障：会话身份 + state_revision 双重版本一致性核验！
        // ══════════════════════════════════════════════════════════════════════
        const finishChatId = getChatIdentifier(c);
        if (finishChatId !== startChatId) {
            console.warn(`[${MODULE_NAME}] [会话隔离拦截] 检测到用户在提炼期间切换了会话 (${startChatId} -> ${finishChatId})，已丢弃旧结果！`);
            return { success: false, error: '提炼期间会话发生切换，已丢弃' };
        }

        currentState = getState();
        if ((currentState.state_revision || 0) !== startRevision) {
            console.warn(`[${MODULE_NAME}] [状态版本冲突拦截] 在提炼期间，会话状态已被修改 (启动版本: rev.${startRevision} -> 当前版本: rev.${currentState.state_revision})。已丢弃旧提炼结果，保护用户最新手改与状态一致性！`);
            return { success: false, error: '提炼期间状态被编辑，为防冲突已放弃提交' };
        }

        const participants = getContextParticipants(c, currentState);
        const rawPayload = cleanAndParseJson(response);

        if (!rawPayload) {
            const rawSnippet = String(response || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 100);
            const parseErr = `模型返回无法解析为有效 JSON (可能因上下文膨胀或思考耗尽 Token 被腰斩截断)。片段: "${rawSnippet}..."`;
            console.warn(`[${MODULE_NAME}] [Async] ${parseErr}`);
            currentState.last_digest_error = parseErr;
            saveCurrentState();
            return { success: false, error: parseErr };
        }

        // 检查是否为模型输出的良性“无变化/空摘要”轮次
        if (isQuietDigestPayload(rawPayload)) {
            const quietSummary = unwrapJsonPayload(rawPayload)?.summary || '情境平稳，本轮对话无关键新记忆沉淀';
            batchUpdate(() => {
                currentState.last_digest_floor = currentTurn;
                currentState.last_digest_time = new Date().toLocaleTimeString();
                currentState.last_digest_summary = quietSummary;
                currentState.last_digest_error = null;
                // 执行超期未激活记忆自动沉睡巡检 (同周期原子落盘)
                applyInactivitySleep(currentTurn, settings);
            });
            console.log(`[${MODULE_NAME}] [Async] 识别为良性静默提炼 (${quietSummary})，状态保持平稳`);
            return { success: true, summary: quietSummary };
        }

        const payload = validateExtractedPayload(rawPayload, currentState.memories || [], participants);

        if (payload) {
            batchUpdate(() => {
                const summary = applyExtractedData(payload, currentTurn);
                currentState.last_digest_floor = currentTurn;
                currentState.last_digest_time = new Date().toLocaleTimeString();
                currentState.last_digest_summary = summary;
                currentState.last_digest_error = null;
                // 执行超期未激活记忆自动沉睡巡检 (同周期原子落盘)
                applyInactivitySleep(currentTurn, settings);
            });
            console.log(`[${MODULE_NAME}] [Async] 提炼原子提交落盘 (会话: ${startChatId}, rev.${currentState.state_revision}): ${currentState.last_digest_summary}`);

            // 检查是否达到长程记忆归并阈值 (由后台异步触发，不阻塞当前响应)
            if (settings.autoConsolidate !== false) {
                setTimeout(() => {
                    triggerMemoryConsolidation(false).catch(err => {
                        console.error(`[${MODULE_NAME}] [Auto-Consolidate] 自动归并异常:`, err);
                    });
                }, 1000);
            }

            return { success: true, summary: currentState.last_digest_summary };
        } else {
            console.warn(`[${MODULE_NAME}] [Async] 提炼内容未通过数据完整性校验，已安全丢弃`);
            const schemaErr = '模型返回字段缺失或记忆知情权限未通过 (Schema 校验未通过)';
            currentState.last_digest_error = schemaErr;
            saveCurrentState();
            return { success: false, error: schemaErr };
        }
    } catch (e) {
        console.error(`[${MODULE_NAME}] [Async] 后台提炼异常:`, e);
        const errorMessage = e.message || String(e);
        // 会话已切换时不得将旧请求的失败状态写入新聊天。
        if (getChatIdentifier(c) === startChatId) {
            const errorState = currentState || getState();
            errorState.last_digest_error = errorMessage;
            saveCurrentState();
        } else {
            console.warn(`[${MODULE_NAME}] [Async] 提炼失败时会话已切换，未写入其他聊天的错误状态`);
        }
        return { success: false, error: errorMessage };
    } finally {
        activeChatDigests.delete(startChatId);
    }
}


