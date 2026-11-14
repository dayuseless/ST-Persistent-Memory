/**
 * ST-Persistent-Memory - UI 基础通用工具与常量预设 (UI Utilities & Presets)
 * 职责：
 * 1. 跨 UI 组件统一 HTML 字符转义防御 (escapeHtml)
 * 2. 酒馆全局上下文安全提取 (getContext)
 * 3. 启发式中英韩全字符 Token 快速估算 (estimateTokens)
 * 4. 常用 OpenAI 兼容 API 预设与一键填充 (API_PRESETS & applyApiPreset)
 * 5. 傻瓜式全托管默认参数一键恢复服务 (restoreRecommendedDefaults，保留用户 API 凭据)
 *
 * @version 0.1.43
 */

import { DEFAULT_SETTINGS } from '../config.js';
import { getSettings, updateSettings, saveSettingsImmediately } from '../state.js';

export const API_PRESETS = {
    deepseek: {
        url: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        name: 'DeepSeek 官方'
    },
    siliconflow: {
        url: 'https://api.siliconflow.cn/v1',
        model: 'deepseek-ai/DeepSeek-V3',
        name: '硅基流动'
    },
    ollama: {
        url: 'http://localhost:11434/v1',
        model: 'qwen2.5:7b',
        name: 'Ollama (本地)'
    },
    openai: {
        url: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        name: 'OpenAI 官方'
    },
    openrouter: {
        url: 'https://openrouter.ai/api/v1',
        model: 'deepseek/deepseek-chat',
        name: 'OpenRouter'
    }
};

/**
 * 四大 RP 玩法流派专属一键调优预设 (Gameplay Presets)
 * 免去玩家在二十多项参数中摸索，针对不同故事类型一键切入黄金参数组合
 */
export const GAMEPLAY_PRESETS = {
    romance: {
        id: 'romance',
        name: '纯爱日常',
        icon: 'fa-heart',
        color: '#ec4899',
        desc: '聚焦情绪羁绊、言行承诺与二人私语；高向量语义联想，宽松沉睡唤醒',
        settings: {
            asyncFrequency: 2,
            digestSliceCount: 6,
            maxSceneTokens: 120,
            maxTotalMemoryTokens: 400,
            maxPinnedCount: 4,
            maxTriggeredCount: 6,
            semanticWeight: 0.75,
            semanticThreshold: 0.20,
            autoSleepWakeThreshold: 0.50,
            autoSleepTurns: 30,
            worldBookBoostScore: 0.20,
            injectionTemplate: 'standard'
        }
    },
    fantasy_ttrpg: {
        id: 'fantasy_ttrpg',
        name: '西幻跑团',
        icon: 'fa-shield-halved',
        color: '#6366f1',
        desc: '聚焦客观物理事实、严苛地理场景与世界书设定深度联动；高预算与强力归并',
        settings: {
            asyncFrequency: 4,
            digestSliceCount: 8,
            maxSceneTokens: 200,
            maxTotalMemoryTokens: 650,
            maxPinnedCount: 6,
            maxTriggeredCount: 10,
            semanticWeight: 0.60,
            semanticThreshold: 0.25,
            autoSleepWakeThreshold: 0.65,
            autoSleepTurns: 20,
            worldBookIntegrationEnabled: true,
            worldBookContextToExtractor: true,
            worldBookBoostScore: 0.40,
            autoConsolidate: true,
            consolidateThreshold: 10,
            injectionTemplate: 'standard'
        }
    },
    ensemble_drama: {
        id: 'ensemble_drama',
        name: '群像修罗场',
        icon: 'fa-users-viewfinder',
        color: '#f59e0b',
        desc: '极致知情范围与 POV 权限隔离，严格在场保密约束，杜绝多角色串味读心',
        settings: {
            asyncFrequency: 3,
            digestSliceCount: 6,
            maxSceneTokens: 180,
            maxTotalMemoryTokens: 500,
            maxPinnedCount: 5,
            maxTriggeredCount: 8,
            semanticWeight: 0.65,
            semanticThreshold: 0.30,
            autoSleepWakeThreshold: 0.60,
            autoSleepTurns: 25,
            worldBookBoostScore: 0.30,
            injectionTemplate: 'xml'
        }
    },
    mystery_detective: {
        id: 'mystery_detective',
        name: '推理悬疑',
        icon: 'fa-magnifying-glass',
        color: '#059669',
        desc: '线索物证一字不漏，停用模糊归并以保全原话证据；高词法权重，长效不休眠',
        settings: {
            asyncFrequency: 2,
            digestSliceCount: 6,
            maxSceneTokens: 180,
            maxTotalMemoryTokens: 600,
            maxPinnedCount: 8,
            maxTriggeredCount: 10,
            semanticWeight: 0.40,
            semanticThreshold: 0.30,
            autoSleepWakeThreshold: 0.70,
            autoSleepTurns: 40,
            autoConsolidate: false,
            injectionTemplate: 'standard'
        }
    }
};

/**
 * 一键应用玩法流派预设 (100% 安全保留 API 凭据与基础总开关)
 * @param {string} presetId
 * @returns {boolean}
 */
export function applyGameplayPreset(presetId) {
    const preset = GAMEPLAY_PRESETS[presetId];
    if (!preset) return false;

    updateSettings({
        ...preset.settings,
        activeGameplayPreset: presetId
    });
    saveSettingsImmediately();
    if (typeof window !== 'undefined') {
        window.toastr?.success?.(`已切换为【${preset.name}】玩法预设！`, '持续记忆');
    }
    return true;
}

export function getContext() {
    return (typeof window !== 'undefined' && window.SillyTavern?.getContext) ? window.SillyTavern.getContext() : null;
}

export function escapeHtml(str) {
    if (!str || typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export function estimateTokens(str) {
    if (!str || typeof str !== 'string') return 0;
    const cjk = (str.match(/[\u4e00-\u9fa5\uac00-\ud7af\u3040-\u30ff]/g) || []).length;
    const words = (str.replace(/[\u4e00-\u9fa5\uac00-\ud7af\u3040-\u30ff]/g, ' ').match(/\b\w+\b/g) || []).length;
    return Math.ceil(cjk * 1.0 + words * 1.3);
}

export function applyApiPreset(key, isNative = false) {
    const p = API_PRESETS[key];
    if (!p) return;
    if (typeof document !== 'undefined') {
        if (isNative) {
            const u = document.getElementById('pm-native-custom-api-url');
            const m = document.getElementById('pm-native-custom-api-model');
            if (u) u.value = p.url;
            if (m) m.value = p.model;
        }
        const hu = document.getElementById('pm-setting-custom-api-url');
        const hm = document.getElementById('pm-setting-custom-api-model');
        if (hu) hu.value = p.url;
        if (hm) hm.value = p.model;
    }

    updateSettings({ customApiUrl: p.url, customApiModel: p.model });
    saveSettingsImmediately();
    if (typeof window !== 'undefined') {
        window.toastr?.success?.(`已载入预设：${p.name} (${p.model})`, '持续记忆');
    }
}

/**
 * 傻瓜式全托管默认参数一键恢复服务
 * 按照官方推荐设想将底层参数重置为系统最优默认值，同时绝对保留用户的 API 密钥与端点配置
 */
export function restoreRecommendedDefaults() {
    const current = getSettings();
    const preservedApi = {
        useCustomApi: current.useCustomApi,
        customApiUrl: current.customApiUrl,
        customApiKey: current.customApiKey,
        customApiModel: current.customApiModel,
        embeddingApiUrl: current.embeddingApiUrl,
        embeddingApiKey: current.embeddingApiKey,
        embeddingModel: current.embeddingModel
    };

    updateSettings({
        ...DEFAULT_SETTINGS,
        ...preservedApi
    });
    saveSettingsImmediately();
    if (typeof window !== 'undefined') {
        window.toastr?.success?.('已一键恢复官方推荐默认参数（API 设置已安全保留）！', '持续记忆');
    }
}
