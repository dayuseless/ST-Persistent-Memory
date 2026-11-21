/**
 * 语义检索与向量基建核心模块 (v0.1.49)
 * 
 * 核心能力：
 * 1. 向量数学运算：高精度余弦相似度计算与 L2 归一化，具备零模长、维度不符与异常数据防御。
 * 2. 本地轻量向量化引擎 (Local Dense Vectorizer)：
 *    基于多尺度字符级 N-gram、子词特征哈希 (Feature Hashing) 与符号投射的 128 维紧凑稠密向量。
 *    零外部依赖、纯前端即开即用、确定性 (Deterministic) 且极度轻快 (<0.1ms)。
 * 3. 外部通用 OpenAI 兼容 Embedding API：
 *    支持 POST /embeddings 批量接口，具备 AbortController 超时保护与本地优雅降级。
 * 4. 向量缓存与失效状态机 (Embedding Cache & Invalidation)：
 *    按内容与触发词哈希值按需重算，保护内存与网络开销。
 * 5. 混合检索打分引擎 (Hybrid Retrieval Fusion)：
 *    结合词法匹配 (Lexical BM25/Exact match) 与密集向量相似度 (Dense Cosine Similarity) 双路召回。
 */

import { MODULE_NAME, MEMORY_TYPES, MEMORY_STATUS, MEMORY_LIFECYCLE } from './config.js';

export const LOCAL_VECTOR_DIM = 256;
export const EMBEDDING_TIMEOUT_MS = 15000;
export const DEFAULT_EMBEDDING_MAX_RETRIES = 2;
export const DEFAULT_EMBEDDING_INITIAL_DELAY_MS = 400;
export const DEFAULT_EMBEDDING_MAX_DELAY_MS = 5000;
export const DEFAULT_BATCH_THROTTLE_MS = 50;

const STOPWORDS = new Set([
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '那', '与', '及', '把', '被', '向', '从', '给', '但', '而', '或者', '如果', '因为', '所以', '地点', '玩家', '角色', '动作', '气氛', '焦点'
]);

const PUNCT_REGEX = /[\s,，.。!！?？;；:：'"`“”‘’()（）[\]【】{}《》\/\\|#*~_\-+]+/;

/**
 * 快速字符串非加密哈希 (djb2 变种)
 */
export function hashString(str) {
    if (!str || typeof str !== 'string') return '0';
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return (hash >>> 0).toString(16);
}

/**
 * 计算两个向量之间的余弦相似度 (Cosine Similarity)
 * 包含严密的空值、零模长与边界截断保护，返回 [0, 1] 范围的相似度值
 */
export function cosineSimilarity(vecA, vecB) {
    if (!Array.isArray(vecA) || !Array.isArray(vecB)) return 0;
    // 严格维度校验：严禁异构维度对比 (防止截断导致不同模型向量被错误比较)
    if (vecA.length !== vecB.length || vecA.length === 0) return 0;

    const len = vecA.length;
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < len; i++) {
        const a = Number(vecA[i]);
        const b = Number(vecB[i]);
        // 有限数值守门：拦截 NaN 与 Infinity
        if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;

        dot += a * b;
        normA += a * a;
        normB += b * b;
    }

    if (normA <= 0 || normB <= 0) return 0;

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator <= 0 || !Number.isFinite(denominator)) return 0;

    const sim = dot / denominator;
    // 浮点数误差与非负截断保护
    return Math.max(0, Math.min(1, sim));
}

/**
 * 本地多尺度 N-gram 密集特征向量生成器
 * 将自然语言映射为 128 维单位球面向量
 */
export function generateLocalEmbedding(text) {
    if (!text || typeof text !== 'string') {
        return new Array(LOCAL_VECTOR_DIM).fill(0);
    }

    const clean = text.toLowerCase().trim();
    if (!clean) {
        return new Array(LOCAL_VECTOR_DIM).fill(0);
    }

    const vec = new Float32Array(LOCAL_VECTOR_DIM);
    const tokens = [];

    // 1. 词级切分 (过滤停用词与标点)
    const words = clean.split(PUNCT_REGEX).filter(Boolean);
    for (const w of words) {
        if (!STOPWORDS.has(w)) {
            tokens.push({ term: w, weight: w.length >= 2 ? 2.5 : 1.0 });
        }
    }

    // 2. 字符级 N-gram (涵盖 1-gram, 2-gram, 3-gram，对 CJK 复合词与前缀后缀极为敏锐)
    for (let i = 0; i < clean.length; i++) {
        const c1 = clean[i];
        if (c1 > ' ' && !PUNCT_REGEX.test(c1) && !STOPWORDS.has(c1)) {
            tokens.push({ term: c1, weight: 0.6 });
        }
        if (i + 1 < clean.length) {
            const c2 = clean.slice(i, i + 2);
            if (!PUNCT_REGEX.test(c2) && !STOPWORDS.has(c2)) {
                tokens.push({ term: c2, weight: 1.6 });
            }
        }
        if (i + 2 < clean.length) {
            const c3 = clean.slice(i, i + 3);
            if (!PUNCT_REGEX.test(c3) && !STOPWORDS.has(c3)) {
                tokens.push({ term: c3, weight: 2.0 });
            }
        }
    }

    // 3. 双散列符号投射 (Hash Trick)
    for (const item of tokens) {
        let h1 = 2166136261;
        let h2 = 16777619;
        for (let j = 0; j < item.term.length; j++) {
            const code = item.term.charCodeAt(j);
            h1 = Math.imul(h1 ^ code, 16777619);
            h2 = Math.imul(h2 ^ code, 2166136261);
        }

        const index = Math.abs(h1) % LOCAL_VECTOR_DIM;
        const sign = (h2 & 1) === 0 ? 1 : -1;
        vec[index] += sign * item.weight;
    }

    // 4. L2 模长归一化
    let sumSq = 0;
    for (let i = 0; i < LOCAL_VECTOR_DIM; i++) {
        sumSq += vec[i] * vec[i];
    }

    const norm = Math.sqrt(sumSq);
    if (norm > 0) {
        for (let i = 0; i < LOCAL_VECTOR_DIM; i++) {
            vec[i] /= norm;
        }
    }

    return Array.from(vec);
}

/**
 * 规范化构造用于计算向量的文本
 */
export function getMemoryEmbeddingText(mem) {
    if (!mem) return '';
    const content = typeof mem.content === 'string' ? mem.content.trim() : '';
    const keys = Array.isArray(mem.trigger_keys) ? mem.trigger_keys.filter(Boolean).join(' ') : '';
    const typeLabel = mem.type ? `[${mem.type}] ` : '';
    const loreLabel = (mem.lorebook_ref && typeof mem.lorebook_ref === 'object' && mem.lorebook_ref.entry_name)
        ? `[世界书:${mem.lorebook_ref.entry_name}] `
        : '';
    return `${typeLabel}${loreLabel}${content} ${keys}`.trim();
}

/**
 * 计算记忆条目的嵌入指纹
 */
export function computeMemoryEmbeddingHash(mem) {
    return hashString(getMemoryEmbeddingText(mem));
}

/**
 * 校验记忆对象的向量缓存是否过期或缺失
 */
export function isEmbeddingDirty(mem, targetProvider = 'local') {
    if (!mem) return false;
    if (!Array.isArray(mem.embedding) || mem.embedding.length === 0) return true;
    if (!mem.embedding_hash) return true;
    if (mem.embedding_provider && mem.embedding_provider !== targetProvider) return true;
    return mem.embedding_hash !== computeMemoryEmbeddingHash(mem);
}

/**
 * 通用 OpenAI 兼容 /embeddings 接口调用
 * 内置速率限制重试 (429 Backoff)、临时服务异常重试 (5xx) 与网络抖动自愈
 */
export async function fetchApiEmbedding(texts, options = {}) {
    const {
        apiUrl,
        apiKey,
        model = 'text-embedding-3-small',
        timeoutMs = EMBEDDING_TIMEOUT_MS,
        maxRetries = DEFAULT_EMBEDDING_MAX_RETRIES,
        initialDelayMs = DEFAULT_EMBEDDING_INITIAL_DELAY_MS,
        maxDelayMs = DEFAULT_EMBEDDING_MAX_DELAY_MS
    } = options;

    if (!apiUrl || typeof apiUrl !== 'string') {
        throw new Error('未提供有效的 Embedding API Base URL');
    }

    let endpoint = apiUrl.trim().replace(/\/+$/, '');
    if (!endpoint.endsWith('/embeddings')) {
        endpoint = `${endpoint}/embeddings`;
    }

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey && typeof apiKey === 'string' && apiKey.trim()) {
        headers['Authorization'] = `Bearer ${apiKey.trim()}`;
    }

    const inputTexts = Array.isArray(texts) ? texts : [texts];

    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model: model.trim() || 'text-embedding-3-small',
                    input: inputTexts
                }),
                signal: controller.signal
            });

            if (!res.ok) {
                const isRetryable = res.status === 429 || (res.status >= 500 && res.status <= 504);
                if (isRetryable && attempt < maxRetries) {
                    let waitTime = Math.min(maxDelayMs, initialDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 50));
                    // 检查 Retry-After 标头 (秒数或 HTTP-date)
                    const retryAfter = res.headers?.get ? (res.headers.get('retry-after') || res.headers.get('Retry-After')) : null;
                    if (retryAfter) {
                        const parsedSec = parseFloat(retryAfter);
                        if (!isNaN(parsedSec) && parsedSec > 0) {
                            waitTime = Math.min(maxDelayMs, Math.round(parsedSec * 1000));
                        }
                    }
                    console.warn(`[${MODULE_NAME}] [Embedding] 外部 API 触发限流或临时错误 (HTTP ${res.status})，等待 ${waitTime}ms 后重试 (尝试 ${attempt + 1}/${maxRetries})...`);
                    await new Promise(r => setTimeout(r, waitTime));
                    continue;
                }

                const errText = await res.text().catch(() => '');
                throw new Error(`Embedding API 响应错误 HTTP ${res.status}: ${errText.slice(0, 200)}`);
            }

            const data = await res.json();
            if (!data || !Array.isArray(data.data)) {
                throw new Error('Embedding API 返回数据格式缺失 data 数组');
            }

            // 按 index 排序确保对应顺序
            const sorted = [...data.data].sort((a, b) => (a.index || 0) - (b.index || 0));
            return sorted.map(item => item.embedding);
        } catch (err) {
            lastError = err;
            if (err.name === 'AbortError') {
                lastError = new Error(`Embedding API 请求超时 (超过 ${timeoutMs / 1000} 秒未响应)`);
            }
            // 若为可重试的网络抖动且未达重试上限
            const isNetworkErr = err.name !== 'AbortError' && (err.name === 'TypeError' || err.message?.includes('fetch failed') || err.message?.includes('network'));
            if (isNetworkErr && attempt < maxRetries) {
                const waitTime = Math.min(maxDelayMs, initialDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 50));
                console.warn(`[${MODULE_NAME}] [Embedding] 外部 API 网络异常 (${err.message})，等待 ${waitTime}ms 后重试 (尝试 ${attempt + 1}/${maxRetries})...`);
                await new Promise(r => setTimeout(r, waitTime));
                continue;
            }
            throw lastError;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    throw lastError || new Error('Embedding API 重试用尽');
}

/**
 * 测试 Embedding API 连通性
 */
export async function testEmbeddingApiConnection(options = {}) {
    const start = Date.now();
    try {
        const testText = 'SillyTavern Persistent Memory Embedding Ping';
        const embeddings = await fetchApiEmbedding([testText], options);
        const latency = Date.now() - start;

        if (Array.isArray(embeddings) && embeddings.length > 0 && Array.isArray(embeddings[0])) {
            return {
                success: true,
                latency,
                dimensions: embeddings[0].length,
                model: options.model || 'text-embedding-3-small'
            };
        }
        return {
            success: false,
            error: 'API 返回的嵌入向量结构异常'
        };
    } catch (err) {
        return {
            success: false,
            error: err.message || String(err)
        };
    }
}

/**
 * 确保单条记忆的向量嵌入已更新（带优雅降级）
 */
export function syncEnsureLocalEmbedding(mem) {
    if (!mem) return false;
    const currentHash = computeMemoryEmbeddingHash(mem);
    if (mem.embedding && mem.embedding_hash === currentHash && mem.embedding_provider === 'local') {
        return false; // 已是最新，无需更新
    }
    const text = getMemoryEmbeddingText(mem);
    mem.embedding = generateLocalEmbedding(text);
    mem.embedding_hash = currentHash;
    mem.embedding_provider = 'local';
    return true;
}

/**
 * 批量为记忆库建立/更新向量索引 (同步/异步双通道)
 */
export async function reindexMemories(memories, settings = {}, onProgress = null) {
    if (!Array.isArray(memories)) return { total: 0, updated: 0 };

    const provider = settings.embeddingProvider || 'local';
    const dirtyList = memories.filter(m => isEmbeddingDirty(m, provider));

    if (dirtyList.length === 0) {
        return { total: memories.length, updated: 0 };
    }

    let updatedCount = 0;

    // 通道 1: 本地内置向量化引擎 (纯同步极速计算)
    if (provider === 'local' || provider === 'disabled') {
        for (let i = 0; i < dirtyList.length; i++) {
            const m = dirtyList[i];
            if (syncEnsureLocalEmbedding(m)) {
                updatedCount++;
            }
            if (typeof onProgress === 'function') {
                onProgress(i + 1, dirtyList.length);
            }
        }
        return { total: memories.length, updated: updatedCount };
    }

    // 通道 2: 外部 API (OpenAI 兼容端点批量处理)
    if (provider === 'custom_api') {
        const apiUrl = settings.embeddingApiUrl || settings.customApiUrl;
        const apiKey = settings.embeddingApiKey || settings.customApiKey;
        const model = settings.embeddingModel || 'text-embedding-3-small';
        const batchThrottleMs = typeof settings.embeddingBatchThrottleMs === 'number'
            ? settings.embeddingBatchThrottleMs
            : DEFAULT_BATCH_THROTTLE_MS;

        // 批量分块请求 (每批 16 条)
        const BATCH_SIZE = 16;
        for (let i = 0; i < dirtyList.length; i += BATCH_SIZE) {
            const chunk = dirtyList.slice(i, i + BATCH_SIZE);
            const texts = chunk.map(m => getMemoryEmbeddingText(m));

            try {
                const vectors = await fetchApiEmbedding(texts, {
                    apiUrl,
                    apiKey,
                    model,
                    maxRetries: settings.embeddingMaxRetries ?? DEFAULT_EMBEDDING_MAX_RETRIES,
                    initialDelayMs: settings.embeddingInitialDelayMs ?? DEFAULT_EMBEDDING_INITIAL_DELAY_MS
                });
                for (let j = 0; j < chunk.length; j++) {
                    const m = chunk[j];
                    if (Array.isArray(vectors[j])) {
                        m.embedding = vectors[j];
                        m.embedding_hash = computeMemoryEmbeddingHash(m);
                        m.embedding_provider = 'custom_api';
                        updatedCount++;
                    } else {
                        // 单条降级
                        syncEnsureLocalEmbedding(m);
                        updatedCount++;
                    }
                }
            } catch (err) {
                console.warn(`[${MODULE_NAME}] [Semantic] 外部 Embedding API 调用失败，自动降级为本地向量引擎:`, err.message);
                // 批次降级为本地向量
                for (const m of chunk) {
                    syncEnsureLocalEmbedding(m);
                    updatedCount++;
                }
            }

            if (typeof onProgress === 'function') {
                onProgress(Math.min(dirtyList.length, i + BATCH_SIZE), dirtyList.length);
            }

            // 批次间速率控制节流 (若还有下一批)
            if (i + BATCH_SIZE < dirtyList.length && batchThrottleMs > 0) {
                await new Promise(r => setTimeout(r, batchThrottleMs));
            }
        }
        return { total: memories.length, updated: updatedCount };
    }

    return { total: memories.length, updated: updatedCount };
}

/**
 * 构建当前上下文的现场语义查询对象 (Query Context)
 */
export function buildQueryContext(c, scene, settings = {}) {
    const parts = [];

    // 1. 现场快照核心要素 (地点、动作焦点、即时气氛、悬念)
    if (scene && typeof scene === 'object') {
        if (scene.location) parts.push(`地点: ${scene.location}`);
        if (scene.action) parts.push(`动作: ${scene.action}`);
        if (scene.tension) parts.push(`气氛: ${scene.tension}`);
        if (scene.unresolved) parts.push(`焦点: ${scene.unresolved}`);
    }

    // 2. 最近消息轮次 (取最后 2 轮即时对话)
    if (c && Array.isArray(c.chat)) {
        const recent = c.chat.slice(-2);
        for (const msg of recent) {
            if (msg && msg.mes) {
                const sender = msg.name || (msg.is_user ? (c.name1 || '玩家') : (c.name2 || '角色'));
                parts.push(`${sender}: ${msg.mes}`);
            }
        }
    }

    const queryText = parts.join(' | ');

    // 词法匹配语料 (取最后 5 轮对话文本小写化)
    const scanCorpus = (c && Array.isArray(c.chat))
        ? c.chat.slice(-5).map(m => m.mes || '').join('\n').toLowerCase()
        : '';

    // 生成查询向量 (目前注入流程为同步执行，默认采用本地轻量向量引擎，确保零网络卡顿与秒级响应)
    const queryVector = queryText ? generateLocalEmbedding(queryText) : null;

    return {
        queryText,
        scanCorpus,
        queryVector
    };
}

/**
 * 核心混合检索打分算法 (Hybrid Lexical + Dense Retrieval Fusion)
 * 
 * @param {object} mem 记忆对象
 * @param {object} queryContext 现场查询对象
 * @param {object} settings 插件配置
 * @returns {number} 归一化综合相关度得分 (0 表示未达阈值或未命中，>0 表示激活)
 */
export function calculateHybridMemoryScore(mem, queryContext, settings = {}) {
    if (!mem || !mem.content) return 0;

    const enabled = settings.semanticRetrievalEnabled !== false;
    const scanCorpus = queryContext?.scanCorpus || '';
    const queryVector = queryContext?.queryVector || null;

    // ─────────────────────────────────────────────
    // 1. 词法/关键词打分 (Lexical Matching)
    // ─────────────────────────────────────────────
    const keys = Array.isArray(mem.trigger_keys) ? mem.trigger_keys : [];
    let lexicalHits = 0;

    for (const k of keys) {
        if (!k) continue;
        const kStr = String(k).toLowerCase();
        if (scanCorpus.includes(kStr)) {
            lexicalHits += 2;
        } else if (kStr.length >= 2) {
            // Bigram 细粒度容错匹配 (仅针对 2 字及以上复合词，杜绝单字虚假触发)
            const keyTokens = tokenizeCjkBigram(kStr).filter(t => t.length >= 2);
            if (keyTokens.length > 0) {
                const hitCount = keyTokens.filter(t => scanCorpus.includes(t)).length;
                if (hitCount > 0) {
                    lexicalHits += Number((1.5 * (hitCount / keyTokens.length)).toFixed(2));
                }
            }
        }
    }

    // 若正文片段在对话中有明确子串吻合，额外累加词法分
    const memContentLower = mem.content.toLowerCase();
    if (scanCorpus && memContentLower.length >= 6) {
        const headPiece = memContentLower.slice(0, 12);
        if (scanCorpus.includes(headPiece)) {
            lexicalHits += 1.5;
        }
    }

    // 准则：对于未配置特定触发词的记忆 (keys 为空)，赋予基础保底词法分 1.0 (保持系统既有保底激活设计)
    const hasKeys = keys.length > 0;
    if (!hasKeys) {
        lexicalHits = Math.max(lexicalHits, 1.0);
    }

    // 世界书条目关联加权 (若记忆关联了世界书条目，且该条目名称在当前会话语料中出现)
    if (settings.worldBookIntegrationEnabled !== false && mem.lorebook_ref && typeof mem.lorebook_ref === 'object' && mem.lorebook_ref.entry_name) {
        const lbNameLower = String(mem.lorebook_ref.entry_name).toLowerCase();
        if (scanCorpus && scanCorpus.includes(lbNameLower)) {
            const boost = Number(settings.worldBookBoostScore !== undefined ? settings.worldBookBoostScore : 0.35);
            lexicalHits += 2.0 + boost;
        }
    }

    // 若未启用语义检索或缺乏查询向量，严格保持历史纯词法逻辑
    if (!enabled || !queryVector) {
        return lexicalHits;
    }

    // ─────────────────────────────────────────────
    // 2. 向量语义打分 (Dense Semantic Cosine Similarity)
    // ─────────────────────────────────────────────
    let semanticScore = 0;
    if (Array.isArray(mem.embedding) && mem.embedding.length > 0) {
        semanticScore = cosineSimilarity(queryVector, mem.embedding);
    } else {
        // 实时回退生成本地向量
        const localVec = generateLocalEmbedding(getMemoryEmbeddingText(mem));
        semanticScore = cosineSimilarity(queryVector, localVec);
    }

    const threshold = typeof settings.semanticThreshold === 'number'
        ? settings.semanticThreshold
        : 0.35;
    const semanticWeight = typeof settings.semanticWeight === 'number'
        ? settings.semanticWeight
        : 0.60;

    // 词法得分归一化到 [0, 1]
    const normLexical = Math.min(1.0, lexicalHits / 4.0);

    // ─────────────────────────────────────────────
    // 3. 激活与截断门槛裁决 (Activation Decision)
    // ─────────────────────────────────────────────
    // 准则：只要关键词命中 (lexicalHits > 0) 或者语义余弦达到激活门槛 (semanticScore >= threshold)
    if (lexicalHits === 0 && semanticScore < threshold) {
        return 0; // 双重落选，不予激活
    }

    // 综合加权融合
    const fusedScore = (semanticWeight * semanticScore) + ((1.0 - semanticWeight) * normLexical);

    // 放大至兼容基准分
    return Math.max(0.1, Number((fusedScore * 5).toFixed(3)));
}

/**
 * CJK 与字母数字混合离散 Bigram 分词器 (纯本地、零外部依赖、高吞吐)
 * 
 * 规则：
 * 1. 过滤标点、控制字符及常见通用停用词。
 * 2. 针对 CJK (中日韩汉字/假名/谚文) 片段：
 *    - 提取单字 (Unigram)，过滤单字停用词；
 *    - 提取相邻双字 (Bigram)，例如 "黑刀刺客" -> ["黑刀", "刀刺", "刺客"]，极大强化实体与地名人名组合词判别力。
 * 3. 针对英文字母/数字词汇：提取单词级 Token (如 "excalibur")。
 * 
 * @param {string} text 输入文本
 * @returns {string[]} 去重后的 Token 词元数组
 */
export function tokenizeCjkBigram(text) {
    if (!text || typeof text !== 'string') return [];
    const clean = text.toLowerCase().trim();
    if (!clean) return [];

    const tokens = new Set();
    // 匹配英文/数字词 与 CJK 字符片段 (含中日韩常用汉字、全部扩展区汉字 Ext A~I、假名及长音符、谚文与子音字母)
    const segmentRegex = /([a-z0-9_\-]+)|([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30fc]+)/giu;
    let match;
    while ((match = segmentRegex.exec(clean)) !== null) {
        const enWord = match[1];
        const cjkSeg = match[2];
        if (enWord) {
            if (!STOPWORDS.has(enWord) && enWord.length > 1) {
                tokens.add(enWord);
            }
        } else if (cjkSeg) {
            // 将字符串解构为 Unicode 码点字符数组 (杜绝 UTF-16 代理对截断，完美支持 CJK 扩展区字如 𠮷)
            const chars = Array.from(cjkSeg);
            // 生成 2-gram (二元词)
            for (let i = 0; i < chars.length - 1; i++) {
                const bg = chars[i] + chars[i + 1];
                tokens.add(bg);
            }
            // 生成 1-gram (过滤停用单字)
            for (let i = 0; i < chars.length; i++) {
                const char = chars[i];
                if (!STOPWORDS.has(char)) {
                    tokens.add(char);
                }
            }
        }
    }
    return Array.from(tokens);
}

/**
 * 基于 CJK Bigram + Unigram 的纯本地加权词法重合度打分器 (Dice 系数加权变种)
 * 
 * 权重分配：
 * - 2-gram 及以上复合词命中权重为 2.0 (专名、实体词强特征)
 * - 1-gram 单字命中权重为 0.5 (弱特征)
 * 
 * @param {string} textA 文本 A
 * @param {string} textB 文本 B
 * @returns {number} 归一化重合度得分 [0, 1]
 */
export function calculateBigramLexicalScore(textA, textB) {
    if (!textA || !textB || typeof textA !== 'string' || typeof textB !== 'string') {
        return 0;
    }
    const tokensA = tokenizeCjkBigram(textA);
    const tokensB = tokenizeCjkBigram(textB);
    if (tokensA.length === 0 || tokensB.length === 0) {
        return 0;
    }

    const setB = new Set(tokensB);
    let intersectionWeight = 0;
    let weightA = 0;

    for (const t of tokensA) {
        const w = t.length >= 2 ? 2.0 : 0.5;
        weightA += w;
        if (setB.has(t)) {
            intersectionWeight += w;
        }
    }

    let weightB = 0;
    for (const t of tokensB) {
        weightB += (t.length >= 2 ? 2.0 : 0.5);
    }

    const totalWeight = weightA + weightB;
    if (totalWeight <= 0) return 0;

    const score = (2.0 * intersectionWeight) / totalWeight;
    return Math.max(0, Math.min(1.0, Number(score.toFixed(4))));
}

/**
 * 计算记忆条目相对于现场查询语料的原始词法匹配得分
 * 
 * @param {object} mem 记忆对象
 * @param {object} queryContext 现场查询上下文
 * @param {object} [settings={}] 插件配置
 * @returns {number} 原始词法打分
 */
export function calculateRawLexicalScore(mem, queryContext, settings = {}) {
    if (!mem || !mem.content) return 0;
    const scanCorpus = queryContext?.scanCorpus || '';
    const queryText = queryContext?.queryText || '';
    const combinedCorpus = `${scanCorpus} ${queryText}`.toLowerCase().trim();
    if (!combinedCorpus) return 0;

    let score = 0;
    const keys = Array.isArray(mem.trigger_keys) ? mem.trigger_keys : [];

    // 1. 触发词命中 (精确匹配与 Bigram 细粒度容错)
    for (const k of keys) {
        if (!k) continue;
        const kStr = String(k).toLowerCase();
        if (combinedCorpus.includes(kStr)) {
            score += 2.0;
        } else if (kStr.length >= 2) {
            const keyTokens = tokenizeCjkBigram(kStr).filter(t => t.length >= 2);
            if (keyTokens.length > 0) {
                const hitCount = keyTokens.filter(t => combinedCorpus.includes(t)).length;
                if (hitCount > 0) {
                    score += 1.5 * (hitCount / keyTokens.length);
                }
            }
        }
    }

    // 2. 正文与现场语料的 Bigram 重合度
    const bigramOverlap = calculateBigramLexicalScore(mem.content, combinedCorpus);
    score += bigramOverlap * 3.0;

    // 3. 世界书关联加权
    if (settings.worldBookIntegrationEnabled !== false && mem.lorebook_ref?.entry_name) {
        const lbName = String(mem.lorebook_ref.entry_name).toLowerCase();
        if (combinedCorpus.includes(lbName)) {
            score += 2.0;
        }
    }

    return Number(score.toFixed(4));
}

/**
 * 计算记忆条目相对于现场查询向量的稠密语义相似度得分
 * 
 * @param {object} mem 记忆对象
 * @param {object} queryContext 现场查询上下文
 * @returns {number} 原始语义余弦相似度 [0, 1]
 */
export function calculateRawSemanticScore(mem, queryContext) {
    if (!mem) return 0;
    const queryVector = queryContext?.queryVector;
    if (!queryVector || !Array.isArray(queryVector)) return 0;

    if (Array.isArray(mem.embedding) && mem.embedding.length > 0) {
        return Number(cosineSimilarity(queryVector, mem.embedding).toFixed(4));
    }
    const localVec = generateLocalEmbedding(getMemoryEmbeddingText(mem));
    return Number(cosineSimilarity(queryVector, localVec).toFixed(4));
}

/**
 * 倒数排名融合算法 (Reciprocal Rank Fusion, RRF)
 * 工业级混合检索标准融合算法：无量纲失真、无需经验超参微调分数比例、对极端偏斜分具有极强抗噪性
 * 
 * 融合公式：RRF_Score(d) = \sum_{m \in M} \frac{1}{k + rank_m(d)}
 * 
 * @param {Array<Array<object|string>>} rankedLists 各检索通道已排序的候选列表
 * @param {number} [k=60] 平滑阻尼常数 (默认工业标准 60)
 * @returns {Array<{id: string, item: any, rrfScore: number, ranks: number[]}>} 按 RRF 得分降序排序的融合结果
 */
export function reciprocalRankFusion(rankedLists, k = 60) {
    if (!Array.isArray(rankedLists) || rankedLists.length === 0) {
        return [];
    }
    const smoothingK = typeof k === 'number' && k > 0 ? k : 60;
    const scoreMap = new Map(); // id -> { id, item, rrfScore, ranks: [] }

    for (let listIdx = 0; listIdx < rankedLists.length; listIdx++) {
        const list = rankedLists[listIdx];
        if (!Array.isArray(list)) continue;

        const seenInList = new Set();
        let validRank = 0;

        for (let rank = 0; rank < list.length; rank++) {
            const entry = list[rank];
            if (!entry) continue;

            // 严格实体身份校验：严禁使用榜单位置 String(rank) 充当实体 ID 兜底以防身份碰撞
            const rawId = typeof entry === 'string'
                ? entry
                : (entry.id || entry.mem?.id || null);
            const id = (typeof rawId === 'string' && rawId.trim()) ? rawId.trim() : null;

            if (!id) {
                continue; // 拒绝无 ID、空 ID 或纯空白字符 ID 实体 (且不挤占有效实体的位次)
            }

            // 同一通道内部重复 ID 去重：只记录第一次出现的有效位次与得分，拒绝同通道重复刷分
            if (seenInList.has(id)) {
                continue;
            }
            seenInList.add(id);

            validRank++; // 严格按有效非重复实体递增位次，保证排名连续性
            const rankScore = 1.0 / (smoothingK + validRank);

            if (!scoreMap.has(id)) {
                scoreMap.set(id, {
                    id,
                    item: typeof entry === 'object' ? entry : null,
                    rrfScore: 0,
                    ranks: new Array(rankedLists.length).fill(null)
                });
            }

            const record = scoreMap.get(id);
            record.rrfScore += rankScore;
            record.ranks[listIdx] = validRank;
            if (typeof entry === 'object') {
                record.item = entry;
            }
        }
    }

    const results = Array.from(scoreMap.values());
    results.sort((a, b) => b.rrfScore - a.rrfScore);

    return results.map(r => ({
        id: r.id,
        item: r.item,
        rrfScore: Number(r.rrfScore.toFixed(6)),
        ranks: r.ranks
    }));
}

/**
 * 针对候选记忆条目执行稠密语义与离散 Bigram 双路检索并采用 RRF 倒数排名融合重排序
 * 
 * @param {Array<object>} candidates 候选记忆列表 (记忆对象或带包装的对象)
 * @param {object} queryContext 现场查询上下文
 * @param {object} [settings={}] 插件配置
 * @param {number} [k=60] RRF 阻尼常数
 * @returns {Array<object>} 经 RRF 融合重排序的候选条目列表 (带详细排名归因)
 */
export function rankCandidatesWithRRF(candidates, queryContext, settings = {}, k = 60, options = {}) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
        return [];
    }

    // 规范化候选对象统一封装并确保具备有效 ID (严厉拒绝无 ID 实体，且对相同 ID 执行首次有效保留去重)
    const validItems = [];
    const seenCandidateIds = new Set();
    for (const c of candidates) {
        const mem = (c && c.mem) ? c.mem : c;
        if (!mem) continue;
        const id = (typeof mem.id === 'string' && mem.id.trim()) 
            ? mem.id.trim() 
            : (typeof c.id === 'string' && c.id.trim() ? c.id.trim() : null);
        if (!id) continue; // 坚决丢弃无合法 ID 实体，杜绝身份碰撞
        if (seenCandidateIds.has(id)) continue; // 候选池去重：同 ID 条目仅保留首次出现
        seenCandidateIds.add(id);
        validItems.push({
            id,
            mem,
            rawItem: c
        });
    }

    if (validItems.length === 0) return [];

    const semanticThreshold = typeof settings.semanticThreshold === 'number'
        ? settings.semanticThreshold
        : 0.20;

    const filterZeroScores = (options && typeof options.filterZeroScores === 'boolean')
        ? options.filterZeroScores
        : (settings.filterZeroScores !== false && settings.includeZeroScores !== true);

    // 1. 稠密语义通道打分与排序
    const semanticScored = validItems.map(item => ({
        ...item,
        score: calculateRawSemanticScore(item.mem, queryContext)
    }));

    // 2. 离散词法通道打分与排序
    const lexicalScored = validItems.map(item => ({
        ...item,
        score: calculateRawLexicalScore(item.mem, queryContext, settings)
    }));

    let rankedSemanticList;
    let rankedLexicalList;

    if (filterZeroScores) {
        // 3. 双通道零分杂音候选过滤：若记忆词法完全无命中且语义相似度低于噪音门槛，严禁进入排名榜单
        rankedSemanticList = semanticScored
            .filter(item => item.score >= semanticThreshold)
            .sort((a, b) => b.score - a.score);

        rankedLexicalList = lexicalScored
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score);

        // 若双通道均无任何条目达标，返回空
        if (rankedSemanticList.length === 0 && rankedLexicalList.length === 0) {
            return [];
        }
    } else {
        rankedSemanticList = [...semanticScored].sort((a, b) => b.score - a.score);
        rankedLexicalList = [...lexicalScored].sort((a, b) => b.score - a.score);
    }

    // 4. RRF 双路榜单融合
    const fused = reciprocalRankFusion([rankedSemanticList, rankedLexicalList], k);

    // 5. 组装归因输出
    const semanticScoreMap = new Map(semanticScored.map(s => [s.id, s.score]));
    const lexicalScoreMap = new Map(lexicalScored.map(s => [s.id, s.score]));

    return fused.map(f => {
        const original = validItems.find(it => it.id === f.id);
        const mem = original ? original.mem : (f.item.mem || f.item);
        return {
            id: f.id,
            mem,
            rawItem: original ? original.rawItem : f.item,
            rrfScore: f.rrfScore,
            semanticRank: f.ranks[0] || null,
            lexicalRank: f.ranks[1] || null,
            semanticScore: semanticScoreMap.get(f.id) || 0,
            lexicalScore: lexicalScoreMap.get(f.id) || 0
        };
    });
}
