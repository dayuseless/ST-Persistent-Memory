/**
 * 智能文本清洗与容错 JSON 解析模块 (v0.1.40)
 * 专注于思考型大模型推理标签剥离 (DeepSeek-R1 / QwQ / Claude thinking)、Markdown 代码块提取、断尾修复与顶层对象安全解包
 */

import { MODULE_NAME } from './config.js';

/**
 * 智能缝合与修复被截断的 JSON 字符串 (Auto-Repair Truncated JSON)
 * 当模型因 Token 耗尽或生成中断在末尾截断时，抢救截断前已完整输出的有效节点
 */
export function repairTruncatedJson(str) {
    if (!str || typeof str !== 'string') return null;
    let s = str.trim();
    let inString = false;
    let isEscaped = false;
    const stack = [];

    for (let i = 0; i < s.length; i++) {
        const char = s[i];
        if (inString) {
            if (isEscaped) {
                isEscaped = false;
            } else if (char === '\\') {
                isEscaped = true;
            } else if (char === '"') {
                inString = false;
            }
        } else {
            if (char === '"') {
                inString = true;
            } else if (char === '{') {
                stack.push('}');
            } else if (char === '[') {
                stack.push(']');
            } else if (char === '}' || char === ']') {
                if (stack.length > 0 && stack[stack.length - 1] === char) {
                    stack.pop();
                }
            }
        }
    }

    // 若末尾仍处于未闭合的字符串中，先闭合字符串
    if (inString) {
        if (s.endsWith('\\')) {
            s = s.slice(0, -1);
        }
        s += '"';
    }

    // 清理尾部悬空的无效未完成结构 (例如未完成的键、悬空逗号冒号)
    // 兼容首键 (前缀为 {) 与非首键 (前缀为 ,)
    s = s.replace(/(?:,\s*|{\s*)"(?:[^"\\]|\\.)*"\s*:\s*$/g, (m) => m.startsWith('{') ? '{' : '');
    s = s.replace(/(?:,\s*|{\s*)"(?:[^"\\]|\\.)*"\s*$/g, (m) => m.startsWith('{') ? '{' : '');
    s = s.replace(/:\s*$/g, ': null');
    s = s.replace(/,\s*$/g, '');

    // 按栈逆序补齐所有缺失的闭合括号
    while (stack.length > 0) {
        s += stack.pop();
    }
    return s;
}

/**
 * 自动解包常见的顶层包装对象 (如 { data: ... }, { result: ... }, { response: ... })
 */
export function unwrapJsonPayload(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
    const wrapperKeys = ['data', 'result', 'response', 'output', 'state', 'payload'];
    for (const key of wrapperKeys) {
        if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
            const inner = obj[key];
            if (inner.scene !== undefined || inner.new_memories !== undefined || inner.lifecycle_updates !== undefined || inner.consolidated !== undefined || inner.summary !== undefined) {
                return inner;
            }
        }
    }
    return obj;
}

/**
 * 判定模型返回是否为良性的“静默/无变化”提炼轮次 (Benign Quiet No-Op)
 * 很多高阶模型在日常闲聊轮次会明确返回无新记忆沉淀，这属于健康状态，绝不能判定为 Schema 错误
 */
export function isQuietDigestPayload(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const unwrapped = unwrapJsonPayload(raw);

    const hasNewMemories = Array.isArray(unwrapped.new_memories) && unwrapped.new_memories.length > 0;
    const hasLifecycleUpdates = Array.isArray(unwrapped.lifecycle_updates) && unwrapped.lifecycle_updates.length > 0;
    const hasSceneChanges = unwrapped.scene && typeof unwrapped.scene === 'object' && Object.keys(unwrapped.scene).length > 0;

    // 如果没有任何增量记忆或状态变更
    if (!hasNewMemories && !hasLifecycleUpdates) {
        if (typeof unwrapped.summary === 'string' && unwrapped.summary.trim()) {
            return true;
        }
        if (unwrapped.status === 'no_change' || unwrapped.no_change === true) {
            return true;
        }
        if ((!hasSceneChanges || unwrapped.scene === null) && Array.isArray(unwrapped.new_memories) && unwrapped.new_memories.length === 0) {
            return true;
        }
    }
    return false;
}

/**
 * 思考型推理模型 (DeepSeek-R1, QwQ, Claude thinking 等) 思维链深度清洗器
 * 1. 完整闭合思考标签：<think>...</think>, <thought>...</thought>, <thinking>...</thinking>, [Thinking Process: ...] 等
 * 2. Markdown 块级思考标签：```thought ... ```
 * 3. 未闭合思考标签：当 <think> 未闭合但后续包含合法的 JSON 起始括号 '{' 时，精准保留 JSON；无 JSON 时整段剥除
 */
export function stripThinkingTags(raw) {
    if (!raw || typeof raw !== 'string') return '';
    let text = raw.trim();

    // 1. 剥离标准闭合的思维链标签
    text = text.replace(/<(?:think|thought|thinking)>[\s\S]*?<\/(?:think|thought|thinking)>/gi, '');
    text = text.replace(/```(?:thought|thinking)[\s\S]*?```/gi, '');
    text = text.replace(/\[(?:Thinking Process|Thinking|思考过程)[\s\S]*?\]/gi, '');

    // 2. 处理未闭合的思考标签 (例如模型直接输出 <think> 后因 Token 限制或粗心未闭合即输出主体)
    if (/<(?:think|thought|thinking)>/i.test(text)) {
        // 查找是否在未闭合标签之后存在有效的 JSON 或 Markdown 代码块起始
        const jsonMatch = text.search(/```(?:json)?\s*\{|\{/i);
        if (jsonMatch !== -1) {
            text = text.substring(jsonMatch);
        } else {
            text = text.replace(/<(?:think|thought|thinking)>[\s\S]*$/gi, '');
        }
    }

    return text.trim();
}

/**
 * 鲁棒的 JSON 清洗与边界解析器
 */
export function cleanAndParseJson(raw) {
    if (!raw || typeof raw !== 'string') return null;

    // 1. 剥离思考链与推理标签 (兼容 DeepSeek-R1 / QwQ / Claude thinking 及未闭合思考标签)
    let text = stripThinkingTags(raw);

    // 2. 优先提取 Markdown 代码块内部内容 (```json ... ```)，兼容截断未闭合的代码块
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (codeBlockMatch) {
        text = codeBlockMatch[1].trim();
    } else {
        const unclosedBlockMatch = text.match(/```(?:json)?\s*([\s\S]*)$/i);
        if (unclosedBlockMatch) {
            text = unclosedBlockMatch[1].trim();
        }
    }

    // 3. 定位最外层的 JSON 对象边界
    const firstBrace = text.indexOf('{');
    if (firstBrace === -1) {
        console.warn(`[${MODULE_NAME}] 未能在模型回复中找到合法的 JSON 起始括号:`, raw.slice(0, 200));
        return null;
    }

    const candidate = text.substring(firstBrace).trim();
    const lastBrace = candidate.lastIndexOf('}');
    const boundedText = lastBrace > 0 ? candidate.substring(0, lastBrace + 1) : candidate;

    const cleanTrailingCommas = (str) => str.replace(/,\s*([}\]])/g, '$1');

    // 尝试阶段 1: 直接标准解析
    try {
        return JSON.parse(cleanTrailingCommas(boundedText));
    } catch (e1) {
        // 尝试阶段 2: 处理行内未转义换行符
        try {
            const sanitized = boundedText
                .replace(/(?:\r\n|\r|\n)/g, ' ')
                .replace(/,\s*([}\]])/g, '$1');
            return JSON.parse(sanitized);
        } catch (e2) {
            // 尝试阶段 3: 执行断尾修复引擎 (解决 Token 耗尽导致的截断)
            try {
                const repaired = repairTruncatedJson(candidate);
                if (repaired) {
                    const parsed = JSON.parse(cleanTrailingCommas(repaired));
                    console.log(`[${MODULE_NAME}] [Auto-Repair] 成功通过断尾修复引擎挽回截断的 JSON 数据`);
                    return parsed;
                }
            } catch (e3) {
                // 尝试阶段 4: 对行内换行清洗后再次执行修复引擎
                try {
                    const sanitizedCandidate = candidate.replace(/(?:\r\n|\r|\n)/g, ' ');
                    const repairedSanitized = repairTruncatedJson(sanitizedCandidate);
                    if (repairedSanitized) {
                        const parsed = JSON.parse(cleanTrailingCommas(repairedSanitized));
                        console.log(`[${MODULE_NAME}] [Auto-Repair] 成功通过清洗换行+断尾修复引擎挽回截断的 JSON 数据`);
                        return parsed;
                    }
                } catch (e4) {
                    console.warn(`[${MODULE_NAME}] JSON 解析与自动修复均失败:`, e4.message, '原始片段:', candidate.slice(-160));
                    return null;
                }
            }
        }
    }
    return null;
}
