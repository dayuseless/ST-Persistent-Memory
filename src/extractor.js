/**
 * 提炼引擎：支持同步伴生解析 (Sync Tag) 与 后台静默提炼 (Async Quiet Prompt)
 */

import { MODULE_NAME } from './config.js';
import { getState, getSettings, updateScene, addMemory, saveCurrentState } from './state.js';

function getContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

let isDigesting = false;

// 匹配同步标签正则: <!--PERSISTENT_MEMORY ... --> 或 <!--STATE ... -->
const SYNC_TAG_REGEX = /<!--(?:PERSISTENT_MEMORY|STATE)\s*([\s\S]*?)-->/i;

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

    try {
        const payload = JSON.parse(jsonStr);
        applyExtractedData(payload);
        console.log(`[${MODULE_NAME}] [Sync] 成功从消息中伴生提取记忆状态`);
    } catch (e) {
        // 尝试容错提取 JSON
        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                const payload = JSON.parse(jsonMatch[0]);
                applyExtractedData(payload);
                console.log(`[${MODULE_NAME}] [Sync] 容错修复并提取伴生记忆状态`);
            } catch (err) {
                console.warn(`[${MODULE_NAME}] [Sync] 解析伴生标签 JSON 失败:`, err);
            }
        }
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
    if (!force && (currentFloor - state.last_digest_floor < (settings.asyncFrequency || 3))) {
        return;
    }

    isDigesting = true;
    console.log(`[${MODULE_NAME}] [Async] 开始后台静默提炼 (当前楼层: ${currentFloor})...`);

    try {
        // 取最近 4~6 条消息作为提炼素材
        const sliceCount = Math.min(6, chat.length);
        const recentSlice = chat.slice(-sliceCount);
        const conversationText = recentSlice.map((m, idx) => {
            const sender = m.is_user ? (c.name1 || 'User') : (m.name || 'AI');
            return `${sender}: ${m.mes}`;
        }).join('\n\n');

        const currentScene = JSON.stringify(state.scene, null, 2);

        const digestPrompt = `你是一个持续性记忆提炼专家。请仔细分析以下角色扮演对话的最近进展，更新【当前现场快照】，并提取值得长期记忆的【关键信息】。

【已有现场状态】：
${currentScene}

【最近对话】：
${conversationText}

请直接输出且只输出一个合法的 JSON 纯文本对象（不要 markdown 标记，不要多余解释），字段格式如下：
{
  "scene": {
    "location": "当前具体地点/环境",
    "time": "时间/天气或大致时段",
    "action": "双方正在做什么或当前核心对话主题",
    "tension": "当下的气氛、情绪或心理张力",
    "unresolved": "当下未解决的悬念、待办或冲突",
    "in_scene_characters": ["在场角色名1", "在场角色名2"]
  },
  "new_memories": [
    {
      "type": "fact 或 statement 或 inference 或 todo",
      "content": "高保真提取的具体事实/言行约定/心境变化（一句话）",
      "trigger_keys": ["关键词1", "关键词2"],
      "status": "triggered 或 pinned"
    }
  ]
}
注意：
1. 提炼应严格忠于实际对话，不虚构未发生的情节。
2. 只有新出现的重要约定、核心秘密、关键认知才写入 new_memories，若没有新信息则 new_memories 为空数组。
3. 事实(fact)、明确言行(statement)、推断(inference)、待办(todo)严格区分。`;

        // 调用 SillyTavern 的 generateQuietPrompt
        const response = await c.generateQuietPrompt(digestPrompt, false, false);
        if (!response) {
            console.warn(`[${MODULE_NAME}] [Async] 静默提炼未收到有效回复`);
            return;
        }

        // 解析并应用
        let payload = null;
        try {
            payload = JSON.parse(response.trim());
        } catch {
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                payload = JSON.parse(jsonMatch[0]);
            }
        }

        if (payload) {
            applyExtractedData(payload, currentFloor);
            state.last_digest_floor = currentFloor;
            saveCurrentState();
            console.log(`[${MODULE_NAME}] [Async] 提炼完成并成功写入记忆状态`);
        }
    } catch (e) {
        console.error(`[${MODULE_NAME}] [Async] 后台提炼异常:`, e);
    } finally {
        isDigesting = false;
    }
}

/**
 * 将解析出的数据更新到底层状态库
 */
function applyExtractedData(payload, floor = 0) {
    if (!payload || typeof payload !== 'object') return;

    // 1. 更新现场快照
    if (payload.scene && typeof payload.scene === 'object') {
        updateScene(payload.scene);
    }

    // 2. 追加新记忆
    if (Array.isArray(payload.new_memories)) {
        for (const m of payload.new_memories) {
            if (m && m.content) {
                addMemory({
                    type: m.type || 'fact',
                    content: m.content,
                    trigger_keys: m.trigger_keys || [],
                    status: m.status || 'triggered',
                    floor: floor
                });
            }
        }
    }
}
