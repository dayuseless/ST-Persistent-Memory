/**
 * ST-Persistent-Memory - 全局开放 API 接口层 (Global SDK, v0.1.43)
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
 */
export function buildGlobalApi() {
    return {
        version: EXTENSION_VERSION,

        // 状态与配置
        getState: () => getState(),
        getSettings: () => getSettings(),
        updateSettings: (patch) => updateSettings(patch),
        saveSettingsImmediately: () => saveSettingsImmediately(),

        // 记忆 CRUD 与状态流转
        addMemory: (item, options) => addMemory(item, options),
        updateMemory: (id, patch) => updateMemory(id, patch),
        deleteMemory: (id) => deleteMemory(id),
        setMemoryLifecycle: (id, lifecycle) => setMemoryLifecycle(id, lifecycle),
        cycleMemoryStatus: (id) => cycleMemoryStatus(id),
        cycleMemoryType: (id) => cycleMemoryType(id),
        purgeArchivedMemories: () => purgeArchivedMemories(),

        // 记忆演化血缘追溯
        getMemoryLineage: (id) => getMemoryLineage(id),

        // L0 现场与时光机快照
        getScene: () => getState()?.scene,
        updateScene: (patch) => updateScene(patch),
        getSceneHistory: () => getSceneHistory(),
        restoreSceneSnapshot: (index) => restoreSceneSnapshot(index),
        rollbackScene: () => rollbackScene(),

        // 即时注入透视镜 (Live Inspector)
        getLiveSnapshot: (forceRefresh = true) => getLastInjectionSnapshot(forceRefresh),

        // 玩法流派预设
        getPresets: () => ({ ...GAMEPLAY_PRESETS }),
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
