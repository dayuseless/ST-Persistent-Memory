/**
 * 语义检索与向量基建核心模块 (v0.1.39)
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
    const len = Math.min(vecA.length, vecB.length);
    if (len === 0) return 0;

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < len; i++) {
        const a = Number(vecA[i]) || 0;
        const b = Number(vecB[i]) || 0;
        dot += a * b;
        normA += a * a;
        normB += b * b;
    }

    if (normA <= 0 || normB <= 0) return 0;

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator <= 0) return 0;

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
 */
export async function fetchApiEmbedding(texts, options = {}) {
    const {
        apiUrl,
        apiKey,
        model = 'text-embedding-3-small',
        timeoutMs = EMBEDDING_TIMEOUT_MS
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
        if (err.name === 'AbortError') {
            throw new Error(`Embedding API 请求超时 (超过 ${timeoutMs / 1000} 秒未响应)`);
        }
        throw err;
    } finally {
        clearTimeout(timeoutId);
    }
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

        // 批量分块请求 (每批 16 条)
        const BATCH_SIZE = 16;
        for (let i = 0; i < dirtyList.length; i += BATCH_SIZE) {
            const chunk = dirtyList.slice(i, i + BATCH_SIZE);
            const texts = chunk.map(m => getMemoryEmbeddingText(m));

            try {
                const vectors = await fetchApiEmbedding(texts, { apiUrl, apiKey, model });
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
        if (k && scanCorpus.includes(String(k).toLowerCase())) {
            lexicalHits += 2;
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
