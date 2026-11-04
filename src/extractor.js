/**
 * 提炼引擎：基于事实分级与防幻觉纪律的记忆提取器
 * 支持：思考链标签剥离、JSON 容错修复、触发词智能清洗、旧记忆更新与去重
 */

import { MODULE_NAME } from './config.js';
import { getState, getSettings, updateScene, addMemory, archiveMemory, saveCurrentState } from './state.js';

function getContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

let isDigesting = false;

// 匹配同步标签正则: <!--PERSISTENT_MEMORY ... --> 或 <!--STATE ... -->
const SYNC_TAG_REGEX = /<!--(?:PERSISTENT_MEMORY|STATE)\s*([\s\S]*?)-->/i;

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
        // 二次容错修复：替换换行符未转义问题
        try {
            const sanitized = text
                .replace(/(?:\r\n|\r|\n)/g, ' ')
                .replace(/,\s*([}\]])/g, '$1');
            return JSON.parse(sanitized);
        } catch (err) {
            console.warn(`[${MODULE_NAME}] JSON 解析失败:`, err, '原始内容:', text.slice(0, 200));
            return null;
        }
    }
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

    const payload = cleanAndParseJson(jsonStr);
    if (payload) {
        applyExtractedData(payload);
        console.log(`[${MODULE_NAME}] [Sync] 成功从消息中伴生提取记忆状态`);
    } else {
        console.warn(`[${MODULE_NAME}] [Sync] 未能解析伴生标签中的有效 JSON`);
    }

    return cleanText;
}

/**
 * 触发异步后台静默提炼 (Quiet Prompt)
 */
export async function triggerAsyncDigest(force = false) {
    const c = getContext();
    const settings = getSettings();

    if (!c || isDigesting || !settings.enabled) return;
    if (settings.mode !== 'async' && !force) return;

    const chat = c.chat;
    if (!Array.isArray(chat) || chat.length < 2) return;

    const state = getState();
    const currentFloor = chat.length;

    // 检查轮数间隔
    const frequency = Math.max(1, Number(settings.asyncFrequency) || 3);
    if (!force && (currentFloor - state.last_digest_floor < frequency)) {
        return;
    }

    isDigesting = true;
    console.log(`[${MODULE_NAME}] [Async] 开始后台静默提炼 (当前楼层: ${currentFloor}, 回溯条数: ${settings.digestSliceCount || 6})...`);

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

### 核心纪律（违背将导致记忆污染）：
1. 【事实优先与证据链】：只能提取在对话中明确发生过的物理动作或已确认事实。严禁为了故事连贯脑补未发生的经历、背景故事或人物动机。
2. 【严格区分言行约定与主观推测】：
   - statement（明确言行）：必须是某一方亲口给出的承诺、约定、秘密交代或明确态度。
   - inference（主观推断）：角色当下对局视或关系的内心感受/怀疑。必须在内容中明确体现推断语气（如“觉得/怀疑/猜测”），绝不能写成既定事实。
   - todo（待办/悬念）：接下来双方明确约定要做的事或当前剧烈的未决伏笔。
3. 【拒绝废话与过度泛化】：如果最近对话只是日常闲聊或过渡寒暄，没有产生实质性的新事实/新承诺，new_memories 必须输出为空数组 []（绝不凑数）。
4. 【去重与旧记忆关联】：已在【已有记忆库】中的内容不要重复提取；若已有状态发生改变或旧任务已完成，可在 resolved_memory_ids 中给出对应 ID。
5. 【触发词 (trigger_keys) 规范】：
   - 必须是具体的实体词、道具名、地点、专有名词或特定行为（如 ["解药", "地牢", "中毒", "配方"]）。
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
    "action": "当前正在进行的具体动作或交流焦点",
    "tension": "当下的心理张力或气氛（如紧张对峙、放松小憩）",
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

        // 调用 SillyTavern 的 generateQuietPrompt
        const response = await c.generateQuietPrompt(digestPrompt, false, false);
        if (!response) {
            console.warn(`[${MODULE_NAME}] [Async] 静默提炼未收到有效回复`);
            return;
        }

        const payload = cleanAndParseJson(response);
        if (payload) {
            const summary = applyExtractedData(payload, currentFloor);
            state.last_digest_floor = currentFloor;
            state.last_digest_time = new Date().toLocaleTimeString();
            state.last_digest_summary = summary;
            saveCurrentState();
            console.log(`[${MODULE_NAME}] [Async] 提炼成功: ${summary}`);
        } else {
            console.warn(`[${MODULE_NAME}] [Async] 提炼回复未能提取出合法 JSON:`, response.slice(0, 150));
        }
    } catch (e) {
        console.error(`[${MODULE_NAME}] [Async] 后台提炼异常:`, e);
    } finally {
        isDigesting = false;
    }
}

/**
 * 清洗并过滤低质触发词
 */
function sanitizeTriggerKeys(keys) {
    if (!Array.isArray(keys)) return [];
    const stopWords = new Set(['你', '我', '他', '她', '它', '我们', '你们', '他们', '这个', '那个', '是', '在', '有', '说', '想', '看', '去', '来', '做', '事情', '东西', '什么', '怎么']);
    return keys
        .map(k => String(k || '').trim())
        .filter(k => k.length >= 2 && k.length <= 15 && !stopWords.has(k))
        .slice(0, 6);
}

/**
 * 将解析出的数据更新到底层状态库
 */
function applyExtractedData(payload, floor = 0) {
    if (!payload || typeof payload !== 'object') return '无有效更新';

    let sceneUpdated = false;
    let addedCount = 0;
    let resolvedCount = 0;

    // 1. 更新现场快照
    if (payload.scene && typeof payload.scene === 'object') {
        const sc = payload.scene;
        updateScene({
            location: sc.location || '',
            time: sc.time || '',
            action: sc.action || '',
            tension: sc.tension || '',
            unresolved: sc.unresolved || '',
            in_scene_characters: Array.isArray(sc.in_scene_characters) ? sc.in_scene_characters : []
        });
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
                const cleanKeys = sanitizeTriggerKeys(m.trigger_keys);
                const added = addMemory({
                    type: m.type || 'fact',
                    content: m.content,
                    trigger_keys: cleanKeys,
                    status: m.status || 'triggered',
                    floor: floor
                });
                if (added) addedCount++;
            }
        }
    }

    const parts = [];
    if (sceneUpdated) parts.push('快照已更新');
    if (addedCount > 0) parts.push(`新增/融合 ${addedCount} 条记忆`);
    if (resolvedCount > 0) parts.push(`归档 ${resolvedCount} 条过期条目`);
    if (parts.length === 0) parts.push('情境稳定，无新记忆沉淀');

    return parts.join(' | ');
}
