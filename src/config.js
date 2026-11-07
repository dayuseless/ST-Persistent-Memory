/**
 * 持续记忆插件配置与常量定义 (v0.1.15)
 */

export const EXTENSION_VERSION = '0.1.15';
export const MODULE_NAME = 'st_persistent_memory';
export const INJECT_KEY = 'PERSISTENT_MEMORY_INJECT';

export const MEMORY_TYPES = {
    FACT: 'fact',             // 客观物理事实与事件
    STATEMENT: 'statement',   // 角色/用户亲口原话与明确承诺 (不等于未来必兑现)
    INFERENCE: 'inference',   // 角色当下主观推测或心境 (保护演变轨迹)
    TODO: 'todo'              // 剧情钩子/未决事项/待办
};

// 检索注入状态
export const MEMORY_STATUS = {
    PINNED: 'pinned',         // 📌 核心常驻：每轮必带 (受 Token 总预算约束)
    TRIGGERED: 'triggered',   // ⚡ 条件激活：关键词/情境命中才带
    ARCHIVED: 'archived'      // 💤 归档休眠：不参与常规注入
};

// 事实生命周期状态 (与检索状态解耦)
export const MEMORY_LIFECYCLE = {
    ACTIVE: 'active',         // 当前仍然有效
    COMPLETED: 'completed',   // 约定已履行、待办已办结
    SUPERSEDED: 'superseded', // 旧状态已被新事件取代 (如伤势痊愈)
    REFUTED: 'refuted'        // 原有判断已被证实为假 (被证伪)
};

// 记忆知情范围 (Presence Routing 的数据来源)
export const MEMORY_SCOPE = {
    CHARACTER: 'character',   // 仅限特定角色知道的秘密/私人经历
    SHARED: 'shared',         // 在场参与者共同经历
    WORLD: 'world'            // 世界层面的公共公开常识
};

export const DEFAULT_SETTINGS = {
    enabled: true,
    showFloatingBubble: true,  // 是否在屏幕上显示快捷悬浮球
    mode: 'async',             // 'async' (后台静默) | 'sync' (伴随标签)
    asyncFrequency: 3,         // 异步模式下每几轮提炼一次
    digestSliceCount: 6,       // 提炼时回溯的历史消息数量 (2~15)
    injectionDepth: 2,         // 注入深度 (默认 2: 紧贴最新对话上方)
    injectionPosition: 1,      // 1: IN_CHAT, 0: IN_PROMPT
    maxSceneTokens: 150,       // L0 现场快照 Token/字符预算上限
    maxTotalMemoryTokens: 450, // 注入总 Token 预算上限 (防止挤占对话窗口)
    maxPinnedCount: 5,         // 常驻记忆最大条数保护
    maxTriggeredCount: 5,      // 激活记忆最大条数保护
    logVerbose: true,          // 控制台详细调试日志

    // 独立提炼 API (自定义兼容 OpenAI 格式，彻底隔离主会话与历史思维链)
    useCustomApi: false,       // 是否启用独立提取 API
    customApiUrl: '',          // 自定义 Base URL (例如 https://api.openai.com/v1 或 http://localhost:11434/v1)
    customApiKey: '',          // 自定义 API Key
    customApiModel: 'gpt-4o-mini', // 自定义提炼模型名称 (如 gpt-4o-mini, deepseek-chat, qwen-turbo 等)

    // 记忆生命周期演进与高阶归并
    autoConsolidate: true,     // 是否在活跃记忆达到阈值时自动触发宏观归并压缩
    consolidateThreshold: 20,  // 触发宏观归并的活跃记忆条数阈值 (10~50)

    // 语义检索基建配置 (Semantic Retrieval Infrastructure)
    semanticRetrievalEnabled: true,       // 是否启用语义向量与混合检索
    embeddingProvider: 'local',           // 'local' (内置轻量向量引擎) | 'custom_api' (OpenAI 兼容端点) | 'disabled'
    embeddingApiUrl: '',                  // 独立 Embedding API 端点 (留空沿用 customApiUrl)
    embeddingApiKey: '',                  // 独立 Embedding API Key (留空沿用 customApiKey)
    embeddingModel: 'text-embedding-3-small', // 向量模型 (如 text-embedding-3-small, bge-m3, nomic-embed-text)
    semanticThreshold: 0.25,              // 语义余弦相似度下限激活门槛 (0.1 ~ 0.9)
    semanticWeight: 0.60,                 // 混合打分权重: 语义权重占比 (0.0~1.0, 默认 0.60 语义 + 0.40 词法)

    // 世界书关联与协同 (World Info Integration) - 当前会话作用域
    worldBookIntegrationEnabled: true,    // 是否启用世界书条目关联与动态注入
    worldBookContextToExtractor: true,    // 提炼时是否注入当前世界书条目索引供模型参考关联
    worldBookBoostScore: 0.35             // 命中关联世界书时的激活加权分 (0.0~1.0)
};

export const DEFAULT_STATE = {
    version: 3,
    state_revision: 0,        // 状态修订计数器 (每次手改或落盘递增，用于并发一致性核验)
    scene: {
        scene_id: 'scene_init',   // 场景唯一标识
        location: '',             // 场景/地点
        time: '',                 // 时间/天气/环境
        action: '',               // 正在进行的动作或对话焦点 (可观察状态)
        tension: '',              // 即时气氛或张力
        unresolved: '',           // 当前悬念或未决问题
        in_scene_characters: undefined, // 当前活跃在场的角色名列表 (undefined: 初始未知/默认单聊上下文; []: 明确全员离场无人)
        updated_at: ''            // 快照最后更新时间
    },
    memories: [],
    turn_count: 0,
    last_digest_floor: 0,
    last_digest_time: '',
    last_digest_summary: '尚未执行提炼'
};
