/**
 * ST-Persistent-Memory - 全量与长程历史回溯消化管道 (Backlog Digestion Pipeline)
 * 职责：
 * 1. 历史对话连续滑动窗口分块划分 (chunkSize + overlap)
 * 2. 对话逆序字符预算截断控制 (MAX_SINGLE_MSG_CHARS, MAX_TOTAL_CONVERSATION_CHARS)
 * 3. 异步递进批次调度、实时进度汇报与任务可控中止 (AbortController + 标志位)
 * 4. 会话隔离检查，防止中途会话切换导致的数据串线落盘
 * 5. 批次消化后自动触发未激活记忆沉睡巡检及链式长程宏观归并
 *
 * @version 0.1.32
 */

import { MODULE_NAME, MEMORY_TYPES, MEMORY_STATUS, MEMORY_LIFECYCLE, MEMORY_SCOPE } from './config.js';
import { getState, getSettings, updateScene, addMemory, saveCurrentState, batchUpdate, getActiveWorldBookInfo, applyInactivitySleep } from './state.js';
import { getContextParticipants } from './acl.js';
import { executeDigestRequest } from './api.js';
import {
    cleanAndParseJson,
    unwrapJsonPayload,
    isQuietDigestPayload,
    validateExtractedPayload,
    filterMemoriesForDigest,
    applyExtractedData,
    getChatTurnCount,
    getChatIdentifier
} from './extractor.js';
import { triggerMemoryConsolidation } from './consolidator.js';

function getContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

/**
 * 根据对话轮次 (AI 消息数量) 定位对应的消息在 chat 数组中的下一轮起始索引
 */
export function findMessageIndexByTurn(chat, targetTurn) {
    if (!Array.isArray(chat) || targetTurn <= 0) return 0;
    let aiCount = 0;
    for (let i = 0; i < chat.length; i++) {
        if (!chat[i].is_user) {
            aiCount++;
            if (aiCount >= targetTurn) {
                return i + 1; // 下一轮起始索引
            }
        }
    }
    return 0;
}

let isBacklogRunning = false;
let backlogTaskIdCounter = 0;
let currentBacklogTask = null; // { id: number, controller: AbortController, aborted: boolean }

export function abortBacklogDigest() {
    if (currentBacklogTask) {
        currentBacklogTask.aborted = true;
        try {
            currentBacklogTask.controller.abort();
        } catch {}
    }
    isBacklogRunning = false;
    console.log(`[${MODULE_NAME}] [Backlog] 用户已请求中断全量历史提炼任务`);
}

export function isBacklogDigestRunning() {
    return isBacklogRunning;
}

/**
 * 全量或未消化历史上下文分块渐进提炼 (Backlog / Full History Digestion)
 * 适应中途启用的用户，或需要从头回溯沉淀记忆的长程会话
 * @param {object} [options]
 * @param {boolean} [options.fromStart=false] - 是否无视已有楼层从消息 0 全量从头开始
 * @param {number} [options.chunkSize=8] - 每个批次消化的消息数 (建议 6~12)
 * @param {number} [options.overlap=2] - 批次间上下文重叠数，避免语义在分界处割裂
 * @param {function} [options.onProgress] - 进度回调 ({ currentBatch, totalBatches, percent, summary, memCount })
 * @returns {Promise<{success: boolean, batchesProcessed: number, totalBatches?: number, totalMemories?: number, reason?: string, aborted?: boolean}>}
 */
export async function triggerBacklogDigest(options = {}) {
    const c = getContext();
    const settings = getSettings();
    if (!c || !settings.enabled) return { success: false, reason: '插件未启用' };

    const chat = c.chat;
    if (!Array.isArray(chat) || chat.length < 2) {
        return { success: false, reason: '当前会话消息数量过少，无需回溯提炼' };
    }

    if (isBacklogRunning) {
        return { success: false, reason: '历史全量提炼任务正在执行中，请勿重复发起' };
    }

    const startChatId = getChatIdentifier(c);
    if (!startChatId) {
        return { success: false, reason: '无法获取有效会话标识' };
    }

    const taskId = ++backlogTaskIdCounter;
    const task = {
        id: taskId,
        controller: new AbortController(),
        aborted: false
    };
    currentBacklogTask = task;
    isBacklogRunning = true;

    const fromStart = Boolean(options.fromStart);
    const chunkSize = Math.max(4, Math.min(16, Number(options.chunkSize) || 8));
    const overlap = Math.max(1, Math.min(4, Number(options.overlap) || 2));

    const state = getState();
    let startMsgIdx = 0;

    if (!fromStart && state.memories && state.memories.length > 0 && (state.last_digest_floor || 0) > 0) {
        startMsgIdx = findMessageIndexByTurn(chat, state.last_digest_floor);
    }

    const totalMessages = chat.length;
    if (startMsgIdx >= totalMessages - 1) {
        if (currentBacklogTask?.id === taskId) {
            isBacklogRunning = false;
            currentBacklogTask = null;
        }
        return { success: true, batchesProcessed: 0, totalMemories: state.memories.length, reason: '当前历史均已提炼完成，无新增未消化轮次' };
    }

    // 构建连续滑动窗口批次
    const batches = [];
    let cursor = startMsgIdx;
    const step = Math.max(2, chunkSize - overlap);

    while (cursor < totalMessages) {
        const end = Math.min(totalMessages, cursor + chunkSize);
        if (end - cursor >= 2) {
            batches.push({ start: cursor, end });
        } else if (batches.length > 0) {
            batches[batches.length - 1].end = totalMessages;
        }
        cursor += step;
        if (end >= totalMessages) break;
    }

    if (batches.length === 0) {
        if (currentBacklogTask?.id === taskId) {
            isBacklogRunning = false;
            currentBacklogTask = null;
        }
        return { success: true, batchesProcessed: 0, totalMemories: state.memories.length, reason: '未生成有效批次' };
    }

    console.log(`[${MODULE_NAME}] [Backlog] 启动历史全量提炼: 会话 ${startChatId}, 起始消息 ${startMsgIdx}, 消息总数 ${totalMessages}, 共划分为 ${batches.length} 个递进批次`);

    let batchesProcessed = 0;
    const isAborted = () => task.aborted || task.controller.signal.aborted;

    try {
        for (let i = 0; i < batches.length; i++) {
            // 检查取消信号
            if (isAborted()) {
                console.log(`[${MODULE_NAME}] [Backlog] 任务已被用户中止 (已完成 ${batchesProcessed}/${batches.length} 批)`);
                return { success: false, aborted: true, batchesProcessed, totalMemories: getState().memories.length, reason: '任务已被用户中止' };
            }

            // 检查跨会话切换保护
            const curChatId = getChatIdentifier(c);
            if (curChatId !== startChatId) {
                console.warn(`[${MODULE_NAME}] [Backlog] 检测到用户中途切换了会话 (${startChatId} -> ${curChatId})，自动安全终止全量回溯！`);
                return { success: false, aborted: true, batchesProcessed, totalMemories: getState().memories.length, reason: '切换会话安全中断' };
            }

            const batch = batches[i];
            const batchSlice = chat.slice(batch.start, batch.end);

            // 格式化当前批次的对话文本 (P2-02 修复：单批总对话字符预算约束，逆序优先保留最新)
            const MAX_SINGLE_MSG_CHARS = 1000;
            const MAX_TOTAL_CONVERSATION_CHARS = 3500;
            const formattedMsgs = [];
            let accumulatedChars = 0;

            for (let j = batchSlice.length - 1; j >= 0; j--) {
                const m = batchSlice[j];
                const sender = m.is_user ? (c.name1 || 'User') : (m.name || 'AI');
                let rawMes = typeof m.mes === 'string' ? m.mes.trim() : '';
                if (rawMes.length > MAX_SINGLE_MSG_CHARS) {
                    rawMes = rawMes.slice(0, 600) + '\n...[中间叙事已压缩]...\n' + rawMes.slice(-300);
                }
                const formatted = `[${sender}]: ${rawMes}`;
                if (accumulatedChars + formatted.length > MAX_TOTAL_CONVERSATION_CHARS && formattedMsgs.length >= 2) {
                    break;
                }
                formattedMsgs.unshift(formatted);
                accumulatedChars += formatted.length;
            }
            const conversationText = formattedMsgs.join('\n\n');

            // 获取当前最新状态（前一批次累积演化后的现场与记忆）
            const curState = getState();
            const currentScene = JSON.stringify(curState.scene, null, 2);

            const activeMemList = filterMemoriesForDigest(curState.memories, {
                sceneParticipants: curState.scene.in_scene_characters,
                conversationParticipants: batchSlice.map(m => m.is_user ? (c.name1 || 'User') : (m.name || 'AI')),
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
                } catch {}
            }

            const maxSceneTok = Math.max(50, Number(settings?.maxSceneTokens) || 150);
            const maxTotalTok = Math.max(100, Number(settings?.maxTotalMemoryTokens) || 450);

            const actionGuidance = maxSceneTok >= 220
                ? `当前正在进行的具体可观察动作与细节（当前现场快照预算充裕约 ${maxSceneTok} Tok，请详尽生动描写现场动态与人物动作细节，约 ${Math.min(250, Math.floor(maxSceneTok * 1.2))} 字；如交谈已结束请填空串 \"\"）`
                : `当前正在进行的具体可观察动作`;

            const memContentGuidance = maxTotalTok >= 800
                ? `完整准确的一句话事实、承诺或推断（当前总预算充裕约 ${maxTotalTok} Tok，允许较详尽记录，≤80字）`
                : `精炼的一句话事实或约定（≤40字）`;

            const digestPrompt = `你是一个严格遵循“事实分级与防幻觉纪律”的持续性记忆系统提炼专家。
你的任务是基于角色扮演长程历史中的阶段片段（第 ${i + 1}/${batches.length} 阶段），递进更新【现场快照 (Scene State)】，并提炼出值得沉淀为长期记忆的【关键信息】。

### 核心底线：
1. 【事实与推测严格解耦】：亲口承诺记为 statement，当下推测心境记为 inference，即时待办记为 todo，物理经历记为 fact。
2. 【严禁脑补】：仅提炼文本明确表达的事实；平稳无新进展时 new_memories 输出空数组 []。
3. 【生命周期精准流转】：发现此前已履约、迭代或被证伪的记忆，在 lifecycle_updates 中流转为 completed / superseded / refuted。
4. 【知情范围隔离】：明确区分 character 私知、shared 共享 (列全 known_by) 与 world 公共。
5. 【世界书动态关联】：若推进或改变了已知世界书条目设定，添加 lorebook_ref。
6. 【严格标准 JSON 与双引号防破坏】：输出必须是严格合法的标准 JSON，不得有末尾多余逗号。content、action 等字符串内部如果出现角色台词或对话引用，务必使用中文全角引号（“...”）或反斜杠转义（\"），严禁输出未转义的双引号破坏 JSON 语法结构。

【上一阶段现场状态】：
${currentScene}
${activeWbSection}
【已有活跃记忆库】：
${activeMemList}

【本阶段对话记录 (第 ${batch.start + 1}~${batch.end} 条消息)】：
=== BEGIN UNTRUSTED DIALOGUE TRACE ===
${conversationText}
=== END UNTRUSTED DIALOGUE TRACE ===

请直接输出且只输出一个合法的 JSON 纯文本对象（不要 markdown 标记，不要多余解释），格式如下：
{
  "scene": {
    "location": "当前地点",
    "time": "时间/天气",
    "action": "${actionGuidance}",
    "tension": "当下的心理张力或气氛",
    "unresolved": "当下悬而未决的冲突",
    "in_scene_characters": ["在场角色A", "在场角色B"]
  },
  "new_memories": [
    {
      "type": "fact 或 statement 或 inference 或 todo",
      "content": "${memContentGuidance}",
      "trigger_keys": ["实体词1", "实体词2"],
      "character": "关联角色名或留空",
      "scope": "character 或 shared 或 world",
      "known_by": ["知情角色A", "知情角色B"],
      "lorebook_ref": null,
      "status": "triggered"
    }
  ],
  "lifecycle_updates": [
    {
      "id": "已有记忆ID",
      "lifecycle": "completed 或 superseded 或 refuted"
    }
  ]
}`;

            let response = null;
            try {
                response = await executeDigestRequest(c, digestPrompt, settings, task.controller.signal);
            } catch (reqErr) {
                if (isAborted()) {
                    console.log(`[${MODULE_NAME}] [Backlog] 请求异常期间检测到任务已被用户中止`);
                    return { success: false, aborted: true, batchesProcessed, totalMemories: getState().memories.length, reason: '任务已被用户中止' };
                }
                console.warn(`[${MODULE_NAME}] [Backlog] 批次 ${i + 1} 请求失败: ${reqErr.message}，跳过本批`);
                continue;
            }

            if (!response) {
                console.warn(`[${MODULE_NAME}] [Backlog] 批次 ${i + 1} 未收到有效回复，跳过本批`);
                continue;
            }

            // 再次验证会话是否发生切换与取消
            if (isAborted()) {
                console.log(`[${MODULE_NAME}] [Backlog] 批次 ${i + 1} 请求返回后检测到任务已被用户中止，丢弃本批结果`);
                return { success: false, aborted: true, batchesProcessed, totalMemories: getState().memories.length, reason: '任务已被用户中止' };
            }
            if (getChatIdentifier(c) !== startChatId) {
                return { success: false, aborted: true, batchesProcessed, totalMemories: getState().memories.length, reason: '切换会话安全中断' };
            }

            const participants = getContextParticipants(c, curState);
            const rawPayload = cleanAndParseJson(response);

            if (!rawPayload) {
                console.warn(`[${MODULE_NAME}] [Backlog] 批次 ${i + 1} 模型返回无法解析为有效 JSON (可能因上下文膨胀或截断)，跳过本批`);
                continue;
            }

            if (isQuietDigestPayload(rawPayload)) {
                if (isAborted()) {
                    return { success: false, aborted: true, batchesProcessed, totalMemories: getState().memories.length, reason: '任务已被用户中止' };
                }
                const turnAtBatchEnd = getChatTurnCount(chat.slice(0, batch.end));
                const quietSummary = unwrapJsonPayload(rawPayload)?.summary || '阶段情境平稳，无新增记忆';
                batchUpdate(() => {
                    curState.last_digest_floor = turnAtBatchEnd;
                    curState.last_digest_time = new Date().toLocaleTimeString();
                    curState.last_digest_summary = `历史回溯 (${i + 1}/${batches.length}): ${quietSummary}`;
                    curState.last_digest_error = null;
                });
                batchesProcessed++;
                const percent = Math.round(((i + 1) / batches.length) * 100);
                console.log(`[${MODULE_NAME}] [Backlog] 批次 ${i + 1}/${batches.length} 完成 (${percent}%): ${quietSummary}`);
                continue;
            }

            const payload = validateExtractedPayload(rawPayload, curState.memories || [], participants);

            if (payload) {
                if (isAborted()) {
                    return { success: false, aborted: true, batchesProcessed, totalMemories: getState().memories.length, reason: '任务已被用户中止' };
                }
                const turnAtBatchEnd = getChatTurnCount(chat.slice(0, batch.end));
                let batchSummary = '';

                batchUpdate(() => {
                    batchSummary = applyExtractedData(payload, turnAtBatchEnd);
                    curState.last_digest_floor = turnAtBatchEnd;
                    curState.last_digest_time = new Date().toLocaleTimeString();
                    curState.last_digest_summary = `历史回溯 (${i + 1}/${batches.length}): ${batchSummary}`;
                    curState.last_digest_error = null;
                });

                batchesProcessed++;
                const percent = Math.round(((i + 1) / batches.length) * 100);
                console.log(`[${MODULE_NAME}] [Backlog] 批次 ${i + 1}/${batches.length} 完成 (${percent}%): ${batchSummary}`);

                if (typeof options.onProgress === 'function') {
                    try {
                        options.onProgress({
                            currentBatch: i + 1,
                            totalBatches: batches.length,
                            percent: percent,
                            startMsgIdx: batch.start,
                            endMsgIdx: batch.end,
                            summary: batchSummary,
                            memCount: curState.memories.length
                        });
                    } catch {}
                }
            } else {
                console.warn(`[${MODULE_NAME}] [Backlog] 批次 ${i + 1} Payload 格式未通过，跳过`);
            }
        }

        if (isAborted()) {
            return { success: false, aborted: true, batchesProcessed, totalMemories: getState().memories.length, reason: '任务已被用户中止' };
        }

        const finalState = getState();
        finalState.last_digest_summary = `全量历史提炼完成：共消化 ${batchesProcessed}/${batches.length} 批次，当前共 ${finalState.memories.length} 条记忆`;
        saveCurrentState();

        // 历史回溯消化完成后：
        // 1. 执行未命中记忆沉睡巡检
        const lastTurn = getChatTurnCount(chat);
        applyInactivitySleep(lastTurn, settings);

        // 2. 自动链式触发高阶宏观归并 (固化压缩琐碎细节)
        if (settings.autoConsolidate !== false) {
            console.log(`[${MODULE_NAME}] [Backlog] 全量提炼完成，链式启动宏观归并固化...`);
            setTimeout(() => {
                triggerMemoryConsolidation(true).catch(err => {
                    console.error(`[${MODULE_NAME}] [Backlog] 归并异常:`, err);
                });
            }, 1000);
        }

        return {
            success: true,
            batchesProcessed,
            totalBatches: batches.length,
            totalMemories: finalState.memories.length
        };
    } finally {
        if (currentBacklogTask?.id === taskId) {
            isBacklogRunning = false;
            currentBacklogTask = null;
        }
    }
}
