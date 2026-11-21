/**
 * ST-Persistent-Memory - 现场状态管理与快照时光机服务 (Scene Management & Time-Machine, v0.1.49)
 *
 * 核心职责：
 * 1. 领域解耦：将 L0 实时现场状态 (location, time, action, tension, unresolved, in_scene_characters)
 *    以及现场快照历史时光机从状态持久化核心中彻底剥离。
 * 2. 严格三态 PATCH 语义：
 *    - undefined: 未提供更新 -> 严格继承旧值 (保留)
 *    - null 或 "": 显式清空 -> 清空旧值
 *    - 非空字符串: 提供了有效新值 -> 覆盖旧值 (非字符串直接拒绝，防 [object Object] 污染)
 *    - 角色数组: 数组 (含 []) -> 按新数组去重覆盖；null -> 重置为 undefined 未知；undefined -> 保留旧值
 * 3. 现场快照时光机栈 (Scene Snapshot Time Machine)：
 *    - 严格限制最大 10 次变更历史，先进先出 (FIFO) 自动淘汰。
 *    - 仅有实质变更时入栈，空内容或与栈顶连续重复的快照拒绝入栈。
 *    - 支持一键撤销回滚 (rollbackScene) 与指定索引历史恢复 (restoreSceneSnapshot)。
 * 4. 场景标识生命周期：地点发生实质跃迁或显式指定时自动触发 scene_id 变更更迭。
 */

import { getState, saveCurrentState } from './state.js';

const safeClone = (o) => (o == null ? o : (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o))));

/**
 * 现场快照时光机：将当前快照入栈历史栈 (保留最近 10 次变更)
 * @param {object} s - 状态对象
 * @param {string} reason - 变更原因
 */
export function pushSceneSnapshot(s, reason = '变更前保存') {
    if (!s || !s.scene) return;
    if (!Array.isArray(s.scene_history)) {
        s.scene_history = [];
    }
    const cur = s.scene;
    // 只有具有实际内容的快照才入栈，避免将空对象频繁入栈
    const hasContent = Boolean(
        cur.location || cur.time || cur.action || cur.tension || cur.unresolved ||
        (Array.isArray(cur.in_scene_characters) && cur.in_scene_characters.length > 0)
    );
    if (!hasContent) return;

    // 检查是否与栈顶内容完全一致，避免连续重复记录
    const top = s.scene_history[s.scene_history.length - 1];
    if (top && top.scene &&
        top.scene.location === cur.location &&
        top.scene.time === cur.time &&
        top.scene.action === cur.action &&
        top.scene.tension === cur.tension &&
        top.scene.unresolved === cur.unresolved &&
        JSON.stringify(top.scene.in_scene_characters) === JSON.stringify(cur.in_scene_characters)) {
        return;
    }

    s.scene_history.push({
        timestamp: cur.updated_at || new Date().toISOString(),
        floor: Number(s.last_digest_floor || s.turn_count || 0),
        reason: String(reason || '更新'),
        scene: JSON.parse(JSON.stringify(cur))
    });

    if (s.scene_history.length > 10) {
        s.scene_history.shift();
    }
}

/**
 * 现场快照时光机：一键撤销并回滚到上一次快照
 * @returns {{success: boolean, message?: string, scene?: object, restoredFrom?: object}}
 */
export function rollbackScene() {
    const s = getState();
    if (!Array.isArray(s.scene_history) || s.scene_history.length === 0) {
        return { success: false, message: '暂无可回滚的历史快照' };
    }

    const previous = s.scene_history.pop();
    if (!previous || !previous.scene) {
        return { success: false, message: '历史快照数据异常' };
    }

    s.scene = {
        ...previous.scene,
        updated_at: new Date().toISOString()
    };

    saveCurrentState();
    return { success: true, scene: safeClone(s.scene), restoredFrom: safeClone(previous) };
}

/**
 * 现场快照时光机：恢复指定索引的历史快照
 * @param {number} index - 历史快照索引
 * @returns {{success: boolean, message?: string, scene?: object, restoredFrom?: object}}
 */
export function restoreSceneSnapshot(index) {
    const s = getState();
    if (!Array.isArray(s.scene_history) || index < 0 || index >= s.scene_history.length) {
        return { success: false, message: '指定的历史快照索引无效' };
    }

    const target = s.scene_history[index];
    if (!target || !target.scene) {
        return { success: false, message: '历史快照数据损坏' };
    }

    // 先把当前现场快照入栈（作为撤销保护点）
    pushSceneSnapshot(s, '回滚前自动保存');

    s.scene = {
        ...target.scene,
        updated_at: new Date().toISOString()
    };

    saveCurrentState();
    return { success: true, scene: safeClone(s.scene), restoredFrom: safeClone(target) };
}

/**
 * 获取现场快照历史列表 (只读深拷贝快照)
 * @returns {Array<object>}
 */
export function getSceneHistory() {
    const s = getState();
    return Array.isArray(s.scene_history) ? safeClone(s.scene_history) : [];
}

/**
 * 严格落实 L0 现场快照的三态 PATCH 语义
 * 
 * 1. 字段为 undefined: 未提供更新 -> 严格继承旧值 (保留)
 * 2. 字段为 null 或空字符串 "": 显式要求清空 -> 清空旧值
 * 3. 字段为非空字符串: 提供了有效新值 -> 覆盖旧值 (非字符串直接拒绝，防 [object Object] 污染)
 * 4. 角色数组: 若显式提供数组 (包括 []) -> 按新数组覆盖；若为 null -> 重置为 undefined 未知；若为 undefined -> 保留旧值
 * @param {object} scenePatch - 场景增量补丁
 * @param {string} reason - 变更原因
 */
export function updateScene(scenePatch, reason = '手动修改') {
    if (!scenePatch || typeof scenePatch !== 'object') return;
    const s = getState();
    const cur = s.scene || {};

    const resolveField = (newVal, oldVal) => {
        if (newVal === undefined) return oldVal; // 继承
        if (newVal === null || newVal === '') return ''; // 显式清空
        if (typeof newVal !== 'string') return oldVal; // 防污染：拒绝非字符串对象
        return newVal.trim(); // 覆盖
    };

    const newLocation = resolveField(scenePatch.location, cur.location);
    const newTime = resolveField(scenePatch.time, cur.time);
    const newAction = resolveField(scenePatch.action, cur.action);
    const newTension = resolveField(scenePatch.tension, cur.tension);
    const newUnresolved = resolveField(scenePatch.unresolved, cur.unresolved);

    // 角色数组三态处理
    let newChars = cur.in_scene_characters;
    if (Array.isArray(scenePatch.in_scene_characters)) {
        newChars = Array.from(new Set(scenePatch.in_scene_characters.filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean)));
    } else if (scenePatch.in_scene_characters === null) {
        newChars = undefined; // 显式重置为未知
    }

    // 判定是否有实质变更，有则在覆盖前将旧快照入栈时光机
    const isDifferent =
        newLocation !== cur.location ||
        newTime !== cur.time ||
        newAction !== cur.action ||
        newTension !== cur.tension ||
        newUnresolved !== cur.unresolved ||
        JSON.stringify(newChars) !== JSON.stringify(cur.in_scene_characters);

    if (isDifferent) {
        pushSceneSnapshot(s, reason);
    }

    // scene_id 独立机制：支持显式切换，或地点迁移时自动更迭
    let newSceneId = cur.scene_id;
    if (typeof scenePatch.scene_id === 'string' && scenePatch.scene_id.trim()) {
        newSceneId = scenePatch.scene_id.trim();
    } else if (newLocation && cur.location && newLocation !== cur.location) {
        newSceneId = 'scene_' + Date.now().toString(36);
    }

    s.scene = {
        scene_id: newSceneId,
        location: newLocation,
        time: newTime,
        action: newAction,
        tension: newTension,
        unresolved: newUnresolved,
        in_scene_characters: newChars,
        updated_at: new Date().toISOString()
    };

    saveCurrentState();
}

/**
 * 严格校验并规范化现场状态对象 (防外部导入或脏数据注入，P1-02)
 * @param {object} rawScene - 待校验的原始场景数据
 * @param {object|null} fallbackScene - 继承底模
 * @returns {object} 规范化后的纯净场景对象
 */
export function normalizeSceneState(rawScene, fallbackScene = null) {
    if (!rawScene || typeof rawScene !== 'object' || Array.isArray(rawScene)) {
        return fallbackScene ? safeClone(fallbackScene) : {
            scene_id: 'scene_init',
            location: '',
            time: '',
            action: '',
            tension: '',
            unresolved: '',
            in_scene_characters: undefined,
            updated_at: ''
        };
    }
    const base = fallbackScene || {};
    const cleanStr = (val, oldVal = '') => {
        if (typeof val === 'string') return val.trim();
        if (val === null || val === '') return '';
        if (val === undefined) return typeof oldVal === 'string' ? oldVal : '';
        return typeof oldVal === 'string' ? oldVal : '';
    };

    let cleanChars;
    if (Array.isArray(rawScene.in_scene_characters)) {
        cleanChars = Array.from(new Set(rawScene.in_scene_characters.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim())));
    } else if (rawScene.in_scene_characters === null) {
        cleanChars = undefined; // 显式重置为未知
    } else if (rawScene.in_scene_characters === undefined) {
        cleanChars = base.in_scene_characters;
    } else {
        // P1-02 防御：外部传入非法类型 (如 string, object 等)，坚决拒绝伪装为未知放行，
        // 强制设为 [] (明确无人) 实现 Fail-Closed
        cleanChars = [];
    }

    return {
        scene_id: cleanStr(rawScene.scene_id, base.scene_id || 'scene_init'),
        location: cleanStr(rawScene.location, base.location),
        time: cleanStr(rawScene.time, base.time),
        action: cleanStr(rawScene.action, base.action),
        tension: cleanStr(rawScene.tension, base.tension),
        unresolved: cleanStr(rawScene.unresolved, base.unresolved),
        in_scene_characters: cleanChars,
        updated_at: typeof rawScene.updated_at === 'string' && rawScene.updated_at ? rawScene.updated_at : new Date().toISOString()
    };
}

/**
 * 校验并规范化现场快照历史时光机栈
 * @param {Array} rawHistory - 待校验的原始历史数组
 * @returns {Array} 规范化后的历史栈 (FIFO 限制最多 10 条)
 */
export function normalizeSceneHistory(rawHistory) {
    if (!Array.isArray(rawHistory)) return [];
    return rawHistory
        .filter(h => h && typeof h === 'object' && h.scene && typeof h.scene === 'object')
        .slice(-10)
        .map(h => ({
            timestamp: typeof h.timestamp === 'string' && h.timestamp ? h.timestamp : new Date().toISOString(),
            floor: Number(h.floor) || 0,
            reason: String(h.reason || '历史快照'),
            scene: normalizeSceneState(h.scene)
        }));
}
