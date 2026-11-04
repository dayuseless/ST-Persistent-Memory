/**
 * 持续记忆插件配置与常量定义
 */

export const MODULE_NAME = 'st_persistent_memory';
export const INJECT_KEY = 'PERSISTENT_MEMORY_INJECT';

export const MEMORY_TYPES = {
    FACT: 'fact',             // 客观事实/事件 (不可篡改)
    STATEMENT: 'statement',   // 明确言行与承诺 (原话/约定)
    INFERENCE: 'inference',   // 主观心境/态度演变 (允许随剧情修正)
    TODO: 'todo'              // 伏笔/意图/待办 (推动剧情)
};

export const MEMORY_STATUS = {
    PINNED: 'pinned',         // 📌 核心常驻：每轮必带
    TRIGGERED: 'triggered',   // ⚡ 条件激活：关键词/情境命中才带
    ARCHIVED: 'archived'      // 💤 归档休眠：不占用注入空间
};

export const DEFAULT_SETTINGS = {
    enabled: true,
    mode: 'async',             // 'async' (后台静默) | 'sync' (伴随标签)
    asyncFrequency: 3,         // 异步模式下每几轮提炼一次
    digestSliceCount: 6,       // 提炼时回溯的历史消息数量 (4~12)
    injectionDepth: 2,         // 注入深度 (默认 2: 紧贴最新对话上方)
    injectionPosition: 1,      // 1: IN_CHAT, 0: IN_PROMPT
    maxSceneTokens: 200,       // 现场快照最大字数估算
    autoPruneInactive: true,   // 自动沉淀与老化
    logVerbose: true           // 控制台详细调试日志
};

export const DEFAULT_STATE = {
    version: 1,
    scene: {
        location: '',             // 场景/地点
        time: '',                 // 时间/天气/环境
        action: '',               // 正在进行的动作或对话主题
        tension: '',              // 即时气氛或张力
        unresolved: '',           // 当前悬念或未决问题
        in_scene_characters: []   // 当前活跃在场的角色名列表
    },
    memories: [],
    turn_count: 0,
    last_digest_floor: 0,
    last_digest_time: '',
    last_digest_summary: '尚未执行提炼'
};
