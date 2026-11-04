/**
 * 提炼引擎 (v0.1.1)
 * 严格落实跨会话隔离 (防异步切档污染)、数据 Schema 强校验、PATCH 提取
 */

import { MODULE_NAME, MEMORY_TYPES, MEMORY_STATUS } from './config.js';
import { getState, getSettings, updateScene, addMemory, archiveMemory, saveCurrentState } from './state.js';

function getContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

// 针对不同 ChatID 维护任务并发锁 (解决跨聊天串线问题)
const activeChatDigests = new Set();

// 匹配同步标签正则: <!--PERSISTENT_MEMORY ... --> 或 <!--STATE ... -->
const SYNC_TAG_REGEX = /<!--(?:PERSISTENT_MEMORY|STATE)\s*([\s\S]*?)-->/i;

/**
 * 获取当前聊天的全局唯一稳定标识
 */
export function getChatIdentifier(c) {
    if (!c) return 'unknown';
    if (c.chatId) return String(c.chatId);
    if (typeof c.getCurrentChatId === 'function') {
        const id = c.getCurrentChatId();
        if (id) return String(id);
    }
    if (c.characters && c.this_chid !== undefined && c.characters[c.this_chid]) {
        return `char_${c.this_chid}_${c.characters[c.this_chid].chat || 'default'}`;
    }
    return 'default_chat';
}

/**
 * 鲁棒的 JSON 清洗与修复解析器
 * 自动剥离 <think> 思考链、Markdown 代码块、前后说明文字及尾部逗号
 */
export function cleanAndParseJson(raw) {
    if (!raw || typeof raw !== 'string') return null;

    let text = raw.trim();

    // 1. 剥离思考链标签 (如 DeepSeek R1 / Claude thinking)
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    // 2. 剥离 Markdown 代码块标记 (```json ... ```)
    text = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/gi, '$1').trim();

    // 3. 定位最外层的 JSON 对象边界
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
        return null;
    }
    text = text.substring(firstBrace, lastBrace + 1);

    // 4. 清理常见的非法尾部逗号 (Trailing comma)
    text = text.replace(/,\s*([}\]])/g, '$1');

    try {
        return JSON.parse(text);
    } catch (e) {
        try {
            const sanitized = text
                .replace(/(?:\r\n|\r|\n)/g, ' ')
                .replace(/,\s*([}\]])/g, '$1');
            return JSON.parse(sanitized);
        } catch (err) {
            console.warn(`[${MODULE_NAME}] JSON 解析失败:`, err, '原始片段:', text.slice(0, 160));
            return null;
        }
    }
}

/**
 * P0-4 修复：建立严格的数据 Schema 验证拦截器 (validateExtractedPayload)
 * 拒绝非法结构、超长字符串、未知类型，防止模型产生格式污染
 */
export function validateExtractedPayload(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
    }

    const validated = {
        scene: null,
        new_memories: [],
        resolved_memory_ids: []
    };

    // 1. 校验 scene 结构
    if (raw.scene && typeof raw.scene === 'object' && !Array.isArray(raw.scene)) {
        const sc = raw.scene;
        validated.scene = {};

        if (typeof sc.location === 'string' && sc.location.trim()) {
            validated.scene.location = sc.location.trim().slice(0, 80);
        }
        if (typeof sc.time === 'string' && sc.time.trim()) {
            validated.scene.time = sc.time.trim().slice(0, 40);
        }
        if (typeof sc.action === 'string' && sc.action.trim()) {
            validated.scene.action = sc.action.trim().slice(0, 150);
        }
        if (typeof sc.tension === 'string' && sc.tension.trim()) {
            validated.scene.tension = sc.tension.trim().slice(0, 80);
        }
        if (typeof sc.unresolved === 'string' && sc.unresolved.trim()) {
            validated.scene.unresolved = sc.unresolved.trim().slice(0, 120);
        }
        if (Array.isArray(sc.in_scene_characters)) {
            validated.scene.in_scene_characters = sc.in_scene_characters
                .filter(x => typeof x === 'string' && x.trim())
                .map(x => x.trim().slice(0, 30))
                .slice(0, 10);
        }
    }

    // 2. 校验 new_memories 数组
    const validTypes = new Set(Object.values(MEMORY_TYPES));
    if (Array.isArray(raw.new_memories)) {
        for (const item of raw.new_memories) {
            if (!item || typeof item !== 'object') continue;
            const content = typeof item.content === 'string' ? item.content.trim() : '';
            if (!content || content.length < 2) continue;

            const type = validTypes.has(item.type) ? item.type : MEMORY_TYPES.FACT;
            const status = item.status === MEMORY_STATUS.PINNED ? MEMORY_STATUS.PINNED : MEMORY_STATUS.TRIGGERED;

            validated.new_memories.push({
                type: type,
                content: content.slice(0, 100), // 限制单条记忆不超过 100 字，避免整段贴入
                trigger_keys: sanitizeTriggerKeys(item.trigger_keys),
                status: status
            });
        }
    }

    // 3. 校验 resolved_memory_ids
    if (Array.isArray(raw.resolved_memory_ids)) {
        validated.resolved_memory_ids = raw.resolved_memory_ids
            .filter(id => typeof id === 'string' && id.trim())
            .map(id => id.trim().slice(0, 40));
    }

    return validated;
}

/**
 * 检查并解析文本中的同步记忆标签
 * 如果命中，剥离标签并更新状态，返回剥离后的纯文本
 */
export function extractAndApplySyncTag(rawText) {
    if (!rawText || typeof rawText !== 'string') return rawText;

    const match = rawText.match(SYNC_TAG_REGEX);
    if (!match) return rawText;

    const jsonStr = match[1].trim();
    const cleanText = rawText.replace(SYNC_TAG_REGEX, '').trim();

    const rawPayload = cleanAndParseJson(jsonStr);
    const payload = validateExtractedPayload(rawPayload);

    if (payload) {
        applyExtractedData(payload);
        console.log(`[${MODULE_NAME}] [Sync] 伴生标签校验通过，已安全提取记忆状态`);
    } else {
        console.warn(`[${MODULE_NAME}] [Sync] 伴生标签未通过 Schema 数据完整性验证`);
    }

    return cleanText;
}

/**
 * P0-1 修复：触发异步后台静默提炼，落实会话隔离防污染机制
 */
export async function triggerAsyncDigest(force = false) {
    const c = getContext();
    const settings = getSettings();

    if (!c || !settings.enabled) return;
    if (settings.mode !== 'async' && !force) return;

    const chat = c.chat;
    if (!Array.isArray(chat) || chat.length < 2) return;

    // 捕获任务启动时的会话身份快照
    const startChatId = getChatIdentifier(c);
    const currentFloor = chat.length;
    const state = getState();

    // 针对同一 ChatID 防止并发重入
    if (activeChatDigests.has(startChatId)) {
        console.log(`[${MODULE_NAME}] [Async] 会话 ${startChatId} 的提炼任务已在进行中，跳过本次触发`);
        return;
    }

    // 检查轮数间隔
    const frequency = Math.max(1, Number(settings.asyncFrequency) || 3);
    if (!force && (currentFloor - state.last_digest_floor < frequency)) {
        return;
    }

    activeChatDigests.add(startChatId);
    console.log(`[${MODULE_NAME}] [Async] 启动提炼任务 (会话: ${startChatId}, 楼层: ${currentFloor})...`);

    try {
        const sliceCount = Math.max(2, Math.min(15, Number(settings.digestSliceCount) || 6));
        const recentSlice = chat.slice(-sliceCount);
        const conversationText = recentSlice.map((m, idx) => {
            const sender = m.is_user ? (c.name1 || 'User') : (m.name || 'AI');
            return `[${sender}]: ${m.mes}`;
        }).join('\n\n');

        const currentScene = JSON.stringify(state.scene, null, 2);

        // 整理当前已有的活跃记忆摘要（帮助提炼模型去重或发现任务完成）
        const activeMemList = (state.memories || [])
            .filter(m => m.status !== 'archived')
            .slice(-15)
            .map(m => `(ID: ${m.id}) [${m.type}] ${m.content}`)
            .join('\n') || '（暂无）';

        const digestPrompt = `你是一个严格遵循“事实分级与防幻觉纪律”的持续性记忆系统提炼专家。
你的任务是基于角色扮演对话的最近进展，更新【现场快照 (Scene State)】，并提炼出值得沉淀为长期记忆的【关键信息】。

### 核心底线（违背将导致记忆严重污染）：
1. 【事实与推测严格解耦】：
   - 角色亲口说过的话（statement），记录为言行约定，不推定未来必然兑现。
   - 角色当下表达的怀疑、好感或心境（inference），记录为主观推断，绝不能写成世界物理事实。
   - 双方共同约定要执行的事或明显悬念，记录为待办（todo）。
2. 【严禁脑补过去】：只能根据最近对话中明确出现的内容提炼。禁止擅自补充角色未经提及的身世背景、隐秘动机。
3. 【情境稳定无新进展时输出空数组】：若最近几句只是普通的闲聊、逗趣或无实质进展的对话，new_memories 必须输出为空数组 []（绝不凑数）。
4. 【旧记忆消解】：若最近对话表明某个旧状态/任务已解决或已过时，请将对应的条目 ID 填入 resolved_memory_ids。
5. 【触发词 (trigger_keys) 规范】：
   - 必须是具体的实体词、道具名、地点、专有名词（如 ["解药", "地牢", "中毒", "配方"]）。
   - 严禁包含代词或无意义虚词（如 ["你", "我", "说话", "事情", "东西"]）。
   - 数量控制在 2~5 个。

【已有现场状态】：
${currentScene}

【已有记忆库条目】：
${activeMemList}

【最近对话记录】：
${conversationText}

请直接输出且只输出一个合法的 JSON 纯文本对象（不要 markdown 标记，不要多余解释），字段规范如下：
{
  "scene": {
    "location": "当前具体地点/环境（若未变动则继承原样）",
    "time": "时间/天气/时段",
    "action": "当前正在进行的具体可观察动作或交谈焦点",
    "tension": "当下的心理张力或气氛",
    "unresolved": "当下悬而未决的冲突或关键疑问",
    "in_scene_characters": ["在场角色A", "在场角色B"]
  },
  "new_memories": [
    {
      "type": "fact 或 statement 或 inference 或 todo",
      "content": "精炼的一句话事实或约定（≤40字）",
      "trigger_keys": ["实体词1", "实体词2", "实体词3"],
      "status": "triggered"
    }
  ],
  "resolved_memory_ids": ["已解决或已过期的已有记忆ID（无则为空数组）"]
}`;

        // 调用后台静默接口
        const response = await c.generateQuietPrompt(digestPrompt, false, false);
        if (!response) {
            console.warn(`[${MODULE_NAME}] [Async] 静默提炼未收到回复`);
            return;
        }

        // ══════════════════════════════════════════════════════════════════════
        // ★ P0-1 核心安全屏障：验证异步任务返回时的会话一致性！
        // ══════════════════════════════════════════════════════════════════════
        const finishChatId = getChatIdentifier(c);
        if (finishChatId !== startChatId) {
            console.warn(`[${MODULE_NAME}] [Async 隔离拦截] 检测到用户在提炼期间切换了会话！(发起会话: ${startChatId} -> 当前会话: ${finishChatId})。已安全丢弃旧提炼结果，防止跨会话数据污染！`);
            return; // 坚决不执行写入！
        }

        const rawPayload = cleanAndParseJson(response);
        const payload = validateExtractedPayload(rawPayload);

        if (payload) {
            const summary = applyExtractedData(payload, currentFloor);
            state.last_digest_floor = currentFloor;
            state.last_digest_time = new Date().toLocaleTimeString();
            state.last_digest_summary = summary;
            saveCurrentState();
            console.log(`[${MODULE_NAME}] [Async] 提炼成功落盘 (会话: ${startChatId}): ${summary}`);
        } else {
            console.warn(`[${MODULE_NAME}] [Async] 提炼内容未通过数据完整性校验，已丢弃`);
        }
    } catch (e) {
        console.error(`[${MODULE_NAME}] [Async] 后台提炼异常:`, e);
    } finally {
        activeChatDigests.delete(startChatId);
    }
}

/**
 * 清洗并过滤低质触发词
 */
function sanitizeTriggerKeys(keys) {
    if (!Array.isArray(keys)) return [];
    const stopWords = new Set(['你', '我', '他', '她', '它', '我们', '你们', '他们', '这个', '那个', '是', '在', '有', '说', '想', '看', '去', '来', '做', '事情', '东西', '什么', '怎么', '然后', '但是']);
    return keys
        .map(k => String(k || '').trim())
        .filter(k => k.length >= 2 && k.length <= 15 && !stopWords.has(k))
        .slice(0, 5);
}

/**
 * 将解析出的数据更新到底层状态库
 */
function applyExtractedData(payload, floor = 0) {
    if (!payload || typeof payload !== 'object') return '无有效更新';

    let sceneUpdated = false;
    let addedCount = 0;
    let resolvedCount = 0;

    // 1. PATCH 语义更新现场快照 (只更新非空有效字段)
    if (payload.scene && typeof payload.scene === 'object') {
        updateScene(payload.scene);
        sceneUpdated = true;
    }

    // 2. 处理已解决/已过期的记忆归档
    if (Array.isArray(payload.resolved_memory_ids)) {
        for (const id of payload.resolved_memory_ids) {
            if (id && typeof id === 'string') {
                archiveMemory(id.trim());
                resolvedCount++;
            }
        }
    }

    // 3. 追加新记忆（通过 addMemory 自动触发防幻觉与去重合并）
    if (Array.isArray(payload.new_memories)) {
        for (const m of payload.new_memories) {
            if (m && m.content) {
                const added = addMemory({
                    type: m.type,
                    content: m.content,
                    trigger_keys: m.trigger_keys,
                    status: m.status,
                    floor: floor
                });
                if (added) addedCount++;
            }
        }
    }

    const parts = [];
    if (sceneUpdated) parts.push('快照已更新');
    if (addedCount > 0) parts.push(`沉淀 ${addedCount} 条记忆`);
    if (resolvedCount > 0) parts.push(`归档 ${resolvedCount} 条过期条目`);
    if (parts.length === 0) parts.push('情境稳定，无新记忆沉淀');

    return parts.join(' | ');
}
