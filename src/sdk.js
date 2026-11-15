/**
 * ST-Persistent-Memory - 全局开放 API 接口层 (Global SDK, v0.1.44)
 * 
 * 核心设计目标：
 * 1. 挂载 window.STPersistentMemoryAPI 与 globalThis.STPersistentMemoryAPI，
 *    提供外部生态 (如 Tavern Helper、Quick Reply、外部自动化脚本与开发者控制台) 零网络、免界面直接调用的稳定统一标准。
 * 2. 完整暴露：
 *    - 插件版本标识 (version)
 *    - 状态与配置 (getState, getSettings, updateSettings, saveSettingsImmediately)
 *    - 记忆完整 CRUD 与生命周期控制 (addMemory, updateMemory, deleteMemory, setMemoryLifecycle, cycleMemoryStatus, cycleMemoryType, purgeArchivedMemories)
 *    - 记忆演化血缘追溯 (getMemoryLineage)
 *    - L0 现场快照与时光机切片 (getScene, updateScene, getSceneHistory, restoreSceneSnapshot, rollbackScene)
 *    - 即时注入透视镜快照 (getLiveSnapshot)
 *    - 玩法流派预设 (getPresets, applyPreset)
 *    - 纯本地高性能检索算法套件 (tokenizeCjkBigram, calculateBigramLexicalScore, calculateRawLexicalScore, calculateRawSemanticScore, reciprocalRankFusion, rankCandidatesWithRRF, generateLocalEmbedding, cosineSimilarity)
 * 3. 0 API 开销保证：所有暴露方法均运行于本地环境，不产生任何未经用户主动触发的额外外部模型调用。
 */

import { EXTENSION_VERSION } from './config.js';
import {
    getState,
    getSettings,
    updateSettings,
    saveSettingsImmediately,
    addMemory,
    updateMemory,
    deleteMemory,
    setMemoryLifecycle,
    cycleMemoryStatus,
    cycleMemoryType,
    purgeArchivedMemories,
    getMemoryLineage,
    updateScene,
    getSceneHistory,
    restoreSceneSnapshot,
    rollbackScene
} from './state.js';
import { getLastInjectionSnapshot } from './injector.js';
import { GAMEPLAY_PRESETS, applyGameplayPreset } from './ui/common.js';
import {
    tokenizeCjkBigram,
    calculateBigramLexicalScore,
    calculateRawLexicalScore,
    calculateRawSemanticScore,
    reciprocalRankFusion,
    rankCandidatesWithRRF,
    generateLocalEmbedding,
    cosineSimilarity
} from './semantic.js';

/**
 * 组装全局 API 门面对象
 * 遵循严格的状态所有权隔离：
 * 1. 凡读取状态/记忆/现场的接口均返回深拷贝快照 (structuredClone)，物理阻断外部恶意变异内部内存；
 * 2. 凡写入接口严格屏蔽内部可信参数 (bypassAcl, 伪造 participants)，强制由内部统一准入判定层裁决。
 */
export function buildGlobalApi() {
    return {
        version: EXTENSION_VERSION,

        // 状态与配置 (返回只读深拷贝快照)
        getState: () => structuredClone(getState()),
        getStateSnapshot: () => structuredClone(getState()),
        getSettings: () => structuredClone(getSettings()),
        updateSettings: (patch) => {
            if (!patch || typeof patch !== 'object') return false;
            return updateSettings(patch);
        },
        saveSettingsImmediately: () => saveSettingsImmediately(),

        // 记忆 CRUD 与状态流转 (严格锁定所有权与防提权)
        getMemory: (id) => {
            if (!id || typeof id !== 'string') return null;
            const item = (getState()?.memories || []).find(m => m.id === id);
            return item ? structuredClone(item) : null;
        },
        addMemory: (item) => {
            if (!item || typeof item !== 'object') {
                throw new TypeError('[STPersistentMemoryAPI] addMemory 要求传入非空对象');
            }
            // 权限收敛铁律：强制剔除外部可控的提权与伪造环境参数，严格锁定内部权威判定
            const cleanItem = structuredClone(item);
            delete cleanItem.bypassAcl;
            delete cleanItem.participants;
            delete cleanItem.context;
            return addMemory(cleanItem, { bypassAcl: false });
        },
        updateMemory: (id, patch) => {
            if (!id || typeof id !== 'string') return null;
            if (!patch || typeof patch !== 'object') return null;
            const cleanPatch = structuredClone(patch);
            delete cleanPatch.bypassAcl;
            delete cleanPatch.participants;
            delete cleanPatch.context;
            return updateMemory(id, cleanPatch);
        },
        deleteMemory: (id) => deleteMemory(id),
        setMemoryLifecycle: (id, lifecycle) => setMemoryLifecycle(id, lifecycle),
        cycleMemoryStatus: (id) => cycleMemoryStatus(id),
        cycleMemoryType: (id) => cycleMemoryType(id),
        purgeArchivedMemories: () => purgeArchivedMemories(),

        // 记忆演化血缘追溯 (返回拓扑克隆快照)
        getMemoryLineage: (id) => {
            const lin = getMemoryLineage(id);
            return lin ? structuredClone(lin) : null;
        },

        // L0 现场与时光机快照 (返回只读深拷贝快照)
        getScene: () => {
            const sc = getState()?.scene;
            return sc ? structuredClone(sc) : null;
        },
        updateScene: (patch) => updateScene(patch),
        getSceneHistory: () => structuredClone(getSceneHistory()),
        restoreSceneSnapshot: (index) => restoreSceneSnapshot(index),
        rollbackScene: () => rollbackScene(),

        // 即时注入透视镜 (Live Inspector 快照)
        getLiveSnapshot: (forceRefresh = true) => {
            const snap = getLastInjectionSnapshot(forceRefresh);
            return snap ? structuredClone(snap) : null;
        },

        // 玩法流派预设
        getPresets: () => structuredClone(GAMEPLAY_PRESETS),
        applyPreset: (presetId) => applyGameplayPreset(presetId),

        // 纯本地算法套件 (0 API 开销)
        tokenizeCjkBigram: (text) => tokenizeCjkBigram(text),
        calculateBigramLexicalScore: (a, b) => calculateBigramLexicalScore(a, b),
        calculateRawLexicalScore: (mem, qCtx, settings) => calculateRawLexicalScore(mem, qCtx, settings),
        calculateRawSemanticScore: (mem, qCtx) => calculateRawSemanticScore(mem, qCtx),
        reciprocalRankFusion: (rankedLists, k) => reciprocalRankFusion(rankedLists, k),
        rankCandidatesWithRRF: (candidates, qCtx, settings, k) => rankCandidatesWithRRF(candidates, qCtx, settings, k),
        generateLocalEmbedding: (text) => generateLocalEmbedding(text),
        cosineSimilarity: (vecA, vecB) => cosineSimilarity(vecA, vecB)
    };
}

let cachedGlobalApi = null;

/**
 * 注册全局 API 实例至 window 与 globalThis
 */
export function registerGlobalApi() {
    if (!cachedGlobalApi) {
        cachedGlobalApi = buildGlobalApi();
    }

    if (typeof window !== 'undefined') {
        window.STPersistentMemoryAPI = cachedGlobalApi;
    }
    if (typeof globalThis !== 'undefined') {
        globalThis.STPersistentMemoryAPI = cachedGlobalApi;
    }

    return cachedGlobalApi;
}

/**
 * 获取当前全局 API 单例
 */
export function getGlobalApi() {
    if (!cachedGlobalApi) {
        return registerGlobalApi();
    }
    return cachedGlobalApi;
}

// 模块载入时立即注册，确保任何早期脚本皆可安全访问
registerGlobalApi();
