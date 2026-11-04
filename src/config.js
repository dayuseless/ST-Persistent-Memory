/**
 * 持续记忆插件配置与常量定义 (v0.1.1)
 */

export const MODULE_NAME = 'st_persistent_memory';
export const INJECT_KEY = 'PERSISTENT_MEMORY_INJECT';

export const MEMORY_TYPES = {
    FACT: 'fact',             // 客观物理事实与事件
    STATEMENT: 'statement',   // 角色/用户亲口原话与明确承诺
    INFERENCE: 'inference',   // 角色当下主观推测或心境 (允许随剧情演变)
    TODO: 'todo'              // 剧情钩子/未决事项/待办
};

// 检索注入状态
export const MEMORY_STATUS = {
    PINNED: 'pinned',         // 📌 核心常驻：每轮必带 (受最大预算约束)
    TRIGGERED: 'triggered',   // ⚡ 条件激活：关键词/情境命中才带
    ARCHIVED: 'archived'      // 💤 归档休眠：不参与常规注入
};

// 事实生命周期状态 (与检索状态解耦)
export const MEMORY_LIFECYCLE = {
    ACTIVE: 'active',         // 当前依然有效
    COMPLETED: 'completed',   // 已完成 (如约定已履行、待办已办结)
    SUPERSEDED: 'superseded', // 已被后续新事实取代 (如旧伤痊愈)
    REFUTED: 'refuted'        // 已被证伪 (如谎言被拆穿)
};

export const DEFAULT_SETTINGS = {
    enabled: true,
    mode: 'async',             // 'async' (后台静默) | 'sync' (伴随标签)
    asyncFrequency: 3,         // 异步模式下每几轮提炼一次
    digestSliceCount: 6,       // 提炼时回溯的历史消息数量 (2~15)
    injectionDepth: 2,         // 注入深度 (默认 2: 紧贴最新对话上方)
    injectionPosition: 1,      // 1: IN_CHAT, 0: IN_PROMPT
    maxSceneTokens: 150,       // L0 现场快照字符/Token 预算
    maxTotalMemoryTokens: 450, // 注入总 Token 预算上限 (防止挤占对话窗口)
    maxPinnedCount: 5,         // 常驻记忆最大条数上限
    maxTriggeredCount: 5,      // 激活记忆最大条数上限
    logVerbose: true           // 控制台详细调试日志
};

export const DEFAULT_STATE = {
    version: 2,
    scene: {
        scene_id: 'scene_init',   // 场景唯一标识
        location: '',             // 场景/地点
        time: '',                 // 时间/天气/环境
        action: '',               // 正在进行的动作或对话焦点 (可观察状态)
        tension: '',              // 即时气氛或张力
        unresolved: '',           // 当前悬念或未决问题
        in_scene_characters: [],  // 当前活跃在场的角色名列表
        updated_at: ''            // 快照最后更新时间
    },
    memories: [],
    turn_count: 0,
    last_digest_floor: 0,
    last_digest_time: '',
    last_digest_summary: '尚未执行提炼'
};
