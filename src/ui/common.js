/**
 * ST-Persistent-Memory - UI 基础通用工具与常量预设 (UI Utilities & Presets)
 * 职责：
 * 1. 跨 UI 组件统一 HTML 字符转义防御 (escapeHtml)
 * 2. 酒馆全局上下文安全提取 (getContext)
 * 3. 启发式中英韩全字符 Token 快速估算 (estimateTokens)
 * 4. 常用 OpenAI 兼容 API 预设与一键填充 (API_PRESETS & applyApiPreset)
 *
 * @version 0.1.41
 */

import { updateSettings, saveSettingsImmediately } from '../state.js';

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
