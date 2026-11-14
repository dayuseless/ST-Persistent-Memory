/**
 * ST-Persistent-Memory 自动化测试验证矩阵
 * 覆盖：状态迁移、权限路由、ACL 边界、提炼数据最小化、事务提交/回滚、Token 预算、错误重载、超时和凭据脱敏。
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 模拟 SillyTavern 环境
let mockLocalStorage = {};
global.localStorage = {
    getItem: (k) => mockLocalStorage[k] || null,
    setItem: (k, v) => { mockLocalStorage[k] = String(v); },
    removeItem: (k) => { delete mockLocalStorage[k]; },
    clear: () => { mockLocalStorage = {}; }
};

let mockContext = {
    this_chid: 0,
    characterId: 0,
    name1: '玩家',
    name2: '角色A',
    characters: [{ name: '角色A' }, { name: '角色B' }],
    chatId: 'chat_test_001',
    chat: [
        { is_user: true, mes: '你好！' },
        { is_user: false, name: '角色A', mes: '你好，很高兴见到你。' }
    ],
    chatMetadata: {},
    extensionSettings: {},
    setExtensionPrompt: (key, prompt, pos, depth) => {
        mockContext._injectedKey = key;
        mockContext._injectedPrompt = prompt;
        mockContext._injectedPos = pos;
        mockContext._injectedDepth = depth;
    }
};

global.window = {
    SillyTavern: {
        getContext: () => mockContext
    },
    toastr: {
        success: () => {},
        warning: () => {},
        info: () => {},
        error: () => {}
    }
};

import {
    MODULE_NAME,
    EXTENSION_VERSION,
    MEMORY_TYPES,
    MEMORY_STATUS,
    MEMORY_LIFECYCLE,
    MEMORY_SCOPE,
    DEFAULT_SETTINGS,
    DEFAULT_STATE,
    INJECTION_TEMPLATES
} from '../src/config.js';

import {
    loadCurrentState,
    getState,
    getSettings,
    updateSettings,
    saveSettingsImmediately,
    updateScene,
    addMemory,
    updateMemory,
    purgeArchivedMemories,
    exportMemoryData,
    importMemoryData,
    setMemoryLifecycle,
    reindexAllMemories,
    batchUpdate,
    saveCurrentState,
    getActiveWorldBookInfo,
    syncMemoryDeltaToWorldInfo,
    applyInactivitySleep,
    rollbackScene,
    restoreSceneSnapshot,
    getSceneHistory,
    pushSceneSnapshot,
    promoteMemoryToWorldInfo,
    sanitizeLorebookRef
} from '../src/state.js';

import {
    validateMemoryAcl,
    normalizeAndValidateMemory,
    checkAclEscalation,
    recordAclAudit,
    canRecipientAccessMemory
} from '../src/acl.js';

import {
    estimateTokens,
    getGeneratingEntity,
    buildAndInjectMemoryPrompt,
    SYNC_PROTOCOL_TEXT
} from '../src/injector.js';

import {
    normalizeChatCompletionsUrl,
    executeDigestRequest,
    testCustomApiConnection,
    DIGEST_REQUEST_TIMEOUT_MS,
    TEST_CONNECTION_TIMEOUT_MS
} from '../src/api.js';

import {
    cleanAndParseJson,
    stripThinkingTags,
    repairTruncatedJson,
    unwrapJsonPayload,
    isQuietDigestPayload,
    validateExtractedPayload,
    extractAndApplySyncTag,
    filterMemoriesForDigest,
    withTimeout,
    buildConsolidationCandidateGroups,
    validateConsolidatedPayload,
    triggerMemoryConsolidation,
    triggerAsyncDigest,
    triggerBacklogDigest,
    abortBacklogDigest,
    isBacklogDigestRunning,
    findMessageIndexByTurn,
    getContextParticipants,
    sanitizeTriggerKeys,
    MODEL_ALLOWED_LIFECYCLES,
    SYNC_TAG_REGEX,
    getActionGuidance,
    getMemoryContentGuidance,
    buildDigestPrompt,
    buildBacklogDigestPrompt,
    buildConsolidationPrompt,
    applyExtractedData
} from '../src/extractor.js';

import {
    stripThinkingTags as parserStripThinkingTags,
    repairTruncatedJson as parserRepairTruncatedJson,
    unwrapJsonPayload as parserUnwrapJsonPayload,
    isQuietDigestPayload as parserIsQuietDigestPayload,
    cleanAndParseJson as parserCleanAndParseJson
} from '../src/parser.js';

import {
    validateExtractedPayload as schemaValidateExtractedPayload,
    validateConsolidatedPayload as schemaValidateConsolidatedPayload,
    sanitizeTriggerKeys as schemaSanitizeTriggerKeys,
    MODEL_ALLOWED_LIFECYCLES as schemaModelAllowedLifecycles
} from '../src/schema.js';

import {
    SYNC_TAG_REGEX as promptSyncTagRegex,
    UNTRUSTED_TRACE_HEADER as promptUntrustedTraceHeader,
    UNTRUSTED_TRACE_FOOTER as promptUntrustedTraceFooter,
    UNTRUSTED_SECURITY_NOTICE as promptUntrustedSecurityNotice,
    getActionGuidance as promptGetActionGuidance,
    getMemoryContentGuidance as promptGetMemoryContentGuidance,
    buildDigestPrompt as promptBuildDigestPrompt,
    buildBacklogDigestPrompt as promptBuildBacklogDigestPrompt,
    buildConsolidationPrompt as promptBuildConsolidationPrompt
} from '../src/prompt.js';

import {
    buildConsolidationCandidateGroups as consolidatorBuildGroups,
    validateConsolidatedPayload as consolidatorValidatePayload,
    triggerMemoryConsolidation as consolidatorTrigger,
    isMemoryConsolidationRunning
} from '../src/consolidator.js';

import {
    findMessageIndexByTurn as backlogFindTurn,
    abortBacklogDigest as backlogAbort,
    isBacklogDigestRunning as backlogIsRunning,
    triggerBacklogDigest as backlogTrigger
} from '../src/backlog.js';

import {
    applyExtractedData as applyApplyExtractedData,
    extractAndApplySyncTag as applyExtractAndApplySyncTag,
    filterMemoriesForDigest as applyFilterMemoriesForDigest
} from '../src/apply.js';

import {
    sanitizeLorebookRef as lbSanitizeRef,
    getActiveWorldBookInfo as lbGetActiveInfo,
    syncMemoryDeltaToWorldInfo as lbSyncDelta,
    promoteMemoryToWorldInfo as lbPromote
} from '../src/lorebook.js';

import {
    pushSceneSnapshot as scnPushSnapshot,
    rollbackScene as scnRollback,
    restoreSceneSnapshot as scnRestoreSnapshot,
    getSceneHistory as scnGetHistory,
    updateScene as scnUpdateScene
} from '../src/scene.js';
import {
    sanitizeMemoryId as migSanitizeId,
    migrateMemoryItems as migMigrateItems,
    migrateLegacyState as migMigrateState,
    exportMemoryDataPackage as migExportPackage,
    importMemoryDataPackage as migImportPackage
} from '../src/migration.js';
import { renderMemoryCard, showPromoteLoreModal } from '../src/ui.js';
import {
    LOCAL_VECTOR_DIM,
    cosineSimilarity,
    generateLocalEmbedding,
    getMemoryEmbeddingText,
    computeMemoryEmbeddingHash,
    isEmbeddingDirty,
    buildQueryContext,
    calculateHybridMemoryScore
} from '../src/semantic.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`\x1b[32m✔ [PASS]\x1b[0m ${name}`);
        passed++;
    } catch (e) {
        console.error(`\x1b[31m✖ [FAIL]\x1b[0m ${name}`);
        console.error(e);
        failed++;
    }
}

async function testAsync(name, fn) {
    try {
        await fn();
        console.log(`\x1b[32m✔ [PASS]\x1b[0m ${name}`);
        passed++;
    } catch (e) {
        console.error(`\x1b[31m✖ [FAIL]\x1b[0m ${name}`);
        console.error(e);
        failed++;
    }
}

async function runTests() {
    console.log(`\n======================================================`);
    console.log(`  ST-Persistent-Memory (v${EXTENSION_VERSION}) 测试验证矩阵`);
    console.log(`======================================================\n`);

    // ─────────────────────────────────────────────────────────────
    // T1: 状态迁移 (旧版本数据保守封闭迁移，防止知情范围越权扩大)
    // ─────────────────────────────────────────────────────────────
    test('T1: 旧版本记忆无知情范围与角色时保守升级为当前角色的 private (CHARACTER)，防止未授权扩大至两方 shared', () => {
        mockContext.chatMetadata = {
            [MODULE_NAME]: {
                version: 1, // 旧版无 version: 3
                memories: [
                    { id: 'old_1', content: '十年前的古老旧约定', type: 'statement' }
                ]
            }
        };
        const state = loadCurrentState();
        assert.strictEqual(state.memories.length, 1);
        const m = state.memories[0];
        assert.strictEqual(m.scope, MEMORY_SCOPE.CHARACTER);
        assert.strictEqual(m.character, '角色A');
        assert.deepStrictEqual(m.known_by, ['角色A']);
        assert.strictEqual(m.lifecycle, MEMORY_LIFECYCLE.ACTIVE);
    });

    // ─────────────────────────────────────────────────────────────
    // T2: 生命周期流转与终态约束
    // ─────────────────────────────────────────────────────────────
    test('T2: 已结项记忆 (completed, superseded, refuted) 不参与常规注入，模型提炼拒绝流转至 active', () => {
        const state = getState();
        state.memories = [];
        const mem = addMemory({ content: '完成的约定', type: 'statement', scope: 'world' });
        setMemoryLifecycle(mem.id, MEMORY_LIFECYCLE.COMPLETED);

        // 验证注入器是否过滤
        const prompt = buildAndInjectMemoryPrompt();
        assert(!prompt.includes('完成的约定'), '已履约记忆绝不可出现在提示词注入中');

        // 验证 Schema 拒绝模型重新流转为 active
        const rawPayload = {
            lifecycle_updates: [{ id: mem.id, lifecycle: 'active' }]
        };
        const validated = validateExtractedPayload(rawPayload, state.memories);
        assert.strictEqual(validated.lifecycle_updates.length, 0, '模型严禁越权激活已完结记忆');
    });

    // ─────────────────────────────────────────────────────────────
    // T3: 去重与认知演化保护
    // ─────────────────────────────────────────────────────────────
    test('T3: 否定词对立拒绝合并，不同 scope 拒绝合并', () => {
        const state = getState();
        state.memories = [];
        addMemory({ content: '林冲愿意前往沧州', type: 'fact', scope: 'world' });
        addMemory({ content: '林冲不愿意前往沧州', type: 'fact', scope: 'world' });
        assert.strictEqual(state.memories.length, 2, '否定与肯定语义对立绝不应误合并');

        addMemory({ content: '高衙内仗势欺人', type: 'fact', scope: 'world' });
        addMemory({ content: '高衙内仗势欺人', type: 'fact', scope: 'character', character: '角色A' });
        assert.strictEqual(state.memories.length, 4, '不同知情范围的条目绝不应合并');
    });

    test('T3.1: 越权提权防护 (Scope Escalation Guard) 拦截将已有受限记忆提升为 world', () => {
        const state = getState();
        state.memories = [];
        // 已有角色A的私密记忆
        addMemory({ content: '角色A身怀藏宝图秘密', type: 'fact', scope: 'character', character: '角色A' });
        
        // 尝试以 world scope 录入高度相似内容
        const escalated = addMemory({ content: '角色A身怀藏宝图秘密', type: 'fact', scope: 'world' });
        assert.strictEqual(escalated.scope, MEMORY_SCOPE.CHARACTER, '检测到语义吻合时必须拦截权限提升，强制继承严格范围');
    });

    test('T3.2: shared 记忆的 known_by 不可被相似新条目扩大', () => {
        const state = getState();
        state.memories = [];
        // 在群聊环境中（角色A与角色B均为会话合法成员），核验语义相似条目无法突破已有 ACL 扩大知情权
        mockContext.groupId = 'grp_test_acl';
        mockContext.groups = [{ id: 'grp_test_acl', members: ['角色A', '角色B'] }];
        try {
            addMemory({
                content: '角色A知道藏宝图藏在枯井下',
                type: 'fact',
                scope: 'shared',
                known_by: ['角色A']
            });

            const attemptedExpansion = addMemory({
                content: '角色A知道藏宝图藏在枯井下',
                type: 'fact',
                scope: 'shared',
                known_by: ['角色A', '角色B']
            });

            assert.deepStrictEqual(attemptedExpansion.known_by, ['角色A'], '模型不得通过新增同义条目让角色B获得知情权');
            assert.strictEqual(state.memories.length, 1, '等价条目应收敛至已有 ACL，而非创建权限更宽的副本');
        } finally {
            delete mockContext.groupId;
            delete mockContext.groups;
        }
    });

    test('T3.3: character 私知不可借相似条目转移给另一角色', () => {
        const state = getState();
        state.memories = [];
        mockContext.groupId = 'grp_test_acl';
        mockContext.groups = [{ id: 'grp_test_acl', members: ['角色A', '角色B'] }];
        try {
            addMemory({ content: '角色A看过密诏原件', type: 'fact', scope: 'character', character: '角色A' });
            const attemptedTransfer = addMemory({ content: '角色A看过密诏原件', type: 'fact', scope: 'character', character: '角色B' });

            assert.strictEqual(attemptedTransfer.character, '角色A', '相似私知条目不得更换所属角色');
            assert.deepStrictEqual(attemptedTransfer.known_by, ['角色A']);
            assert.strictEqual(state.memories.length, 1);
        } finally {
            delete mockContext.groupId;
            delete mockContext.groups;
        }
    });

    // ─────────────────────────────────────────────────────────────
    // T4: 权限隔离与 POV 接收者路由 (P1-01 核心)
    // ─────────────────────────────────────────────────────────────
    test('T4: 角色私密记忆仅向该角色自身生成的上下文注入 (POV 路由)', () => {
        const state = getState();
        state.memories = [];
        state.scene = {
            location: '聚义厅',
            in_scene_characters: ['角色A', '角色B', '玩家']
        };

        // 角色A的私密经历
        addMemory({
            content: '角色A暗中私藏了密信',
            type: 'fact',
            scope: 'character',
            character: '角色A'
        });

        // 模拟当前生成目标为 角色B (characterId = 1)
        mockContext.characterId = 1;
        mockContext.this_chid = 1;
        let promptB = buildAndInjectMemoryPrompt();
        assert(!promptB.includes('角色A暗中私藏了密信'), '角色B生成时严禁获悉角色A的私密记忆！');

        // 模拟当前生成目标为 角色A (characterId = 0)
        mockContext.characterId = 0;
        mockContext.this_chid = 0;
        let promptA = buildAndInjectMemoryPrompt();
        assert(promptA.includes('角色A暗中私藏了密信'), '角色A自身生成时应正常注入其私密记忆');
    });

    test('T4.1: 共享记忆要求生成目标必须在知情者列表 known_by 中，若在场有不知情者附加机密约束', () => {
        const state = getState();
        state.memories = [];
        state.scene = {
            location: '书房',
            in_scene_characters: ['角色A', '角色B', '玩家']
        };

        // 角色A与玩家共享的机密 (角色B不知情)
        addMemory({
            content: '关于密道的地图线索',
            type: 'fact',
            scope: 'shared',
            known_by: ['角色A', '玩家']
        });

        // 角色B生成
        mockContext.characterId = 1;
        let promptB = buildAndInjectMemoryPrompt();
        assert(!promptB.includes('关于密道的地图线索'), '角色B不在知情者列表内，绝对不可注入！');

        // 角色A生成
        mockContext.characterId = 0;
        let promptA = buildAndInjectMemoryPrompt();
        assert(promptA.includes('关于密道的地图线索'), '角色A在知情列表中，应被注入');
        assert(promptA.includes('保密提示') && promptA.includes('角色B'), '现场存在不知情者角色B，应包含保密提示');
    });

    test('T4.2: 生成主体无法确定时，Fail-Closed 保守拒绝注入私密/共享记忆，仅注入公共常识', () => {
        const state = getState();
        state.memories = [];
        state.scene = { in_scene_characters: ['角色A', '角色B'] };
        addMemory({ content: '私密日记', type: 'fact', scope: 'character', character: '角色A' });
        addMemory({ content: '私下密谈', type: 'fact', scope: 'shared', known_by: ['角色A'] });
        addMemory({ content: '天下大治', type: 'fact', scope: 'world' });

        // 模拟无法确定生成主体的旁白环境
        mockContext.characterId = null;
        mockContext.this_chid = null;
        mockContext.name2 = null;
        mockContext.groupId = 'group_123';

        let prompt = buildAndInjectMemoryPrompt();
        assert(!prompt.includes('私密日记'), '未知主体不可注入私密');
        assert(!prompt.includes('私下密谈'), '未知主体不可注入共享');
        assert(prompt.includes('天下大治'), '公共世界常识正常注入');

        // 恢复环境
        mockContext.characterId = 0;
        mockContext.this_chid = 0;
        mockContext.name2 = '角色A';
        mockContext.groupId = null;
    });

    test('T4.3: 生产版提炼过滤器只上传当前场景相关的私有/共享记忆', () => {
        const state = getState();
        state.memories = [];
        state.scene = { in_scene_characters: ['角色A', '玩家'] };
        // 角色C不在场且不在当前对话中
        addMemory({ content: '角色C的秘密日记', type: 'fact', scope: 'character', character: '角色C' });
        // 角色A在场
        addMemory({ content: '角色A的公开伤势', type: 'fact', scope: 'character', character: '角色A' });
        addMemory({ content: '天下降下大雪', type: 'fact', scope: 'world' });

        const filtered = filterMemoriesForDigest(state.memories, {
            sceneParticipants: state.scene.in_scene_characters,
            conversationParticipants: ['角色C'],
            fallbackParticipants: ['玩家', '角色A']
        });

        assert.deepStrictEqual(
            filtered.map(m => m.content),
            ['角色A的公开伤势', '天下降下大雪'],
            '场景已知时，近期发言的角色C也不得导致其私密记忆被上传'
        );

        const emptySceneFiltered = filterMemoriesForDigest(state.memories, {
            sceneParticipants: [],
            conversationParticipants: ['角色A', '角色C']
        });
        assert.deepStrictEqual(emptySceneFiltered.map(m => m.content), ['天下降下大雪'], '显式空场景不应泄露任何私密或共享记忆');
    });

    // ─────────────────────────────────────────────────────────────
    // T5: 并发一致性与版本核验
    // ─────────────────────────────────────────────────────────────
    test('T5: state_revision 状态修订号在修改与保存时单调自增', () => {
        const state = getState();
        const initialRev = state.state_revision || 0;
        updateScene({ location: '东京汴梁' });
        assert.strictEqual(getState().state_revision, initialRev + 1, '快照更新必须递增 revision');
    });

    // ─────────────────────────────────────────────────────────────
    // T6: 事务原子性与异常回滚 (P1-02 核心)
    // ─────────────────────────────────────────────────────────────
    test('T6: batchUpdate 成功时仅提交一次并可重载，异常时完整回滚', () => {
        const state = getState();
        state.memories = [];
        updateScene({ location: '初始安全地点' });
        const beforeRev = state.state_revision;
        const beforeMemCount = state.memories.length;

        let threw = false;
        try {
            batchUpdate(() => {
                // 步骤 1: 修改快照
                state.scene.location = '半途中篡改的危险地点';
                // 步骤 2: 添加一条记忆
                state.memories.push({ id: 'mem-dirty', content: '脏记忆', type: 'fact', scope: 'world' });
                // 步骤 3: 模拟发生运行时异常
                throw new Error('模拟第三方故障');
            });
        } catch (e) {
            threw = true;
        }

        assert(threw, 'batchUpdate 必须向上抛出异常');
        const currentState = getState();
        assert.strictEqual(currentState.scene.location, '初始安全地点', '发生异常后快照地点必须回滚');
        assert.strictEqual(currentState.memories.length, beforeMemCount, '发生异常后脏记忆必须被回滚移除');

        const revisionBeforeCommit = currentState.state_revision;
        batchUpdate(() => {
            currentState.scene.location = '已提交地点';
            currentState.memories.push({ id: 'mem-committed', content: '成功提交的记忆', type: 'fact', scope: 'world' });
        });

        assert.strictEqual(currentState.state_revision, revisionBeforeCommit + 1, '成功批处理必须恰好递增一次 revision');
        assert.strictEqual(mockContext.chatMetadata[MODULE_NAME].memories.some(m => m.id === 'mem-committed'), true, '成功批处理必须写入 chatMetadata');
        const reloaded = loadCurrentState();
        assert.strictEqual(reloaded.scene.location, '已提交地点', '重新加载后必须保留批处理更新');
        assert.strictEqual(reloaded.memories.some(m => m.id === 'mem-committed'), true, '重新加载后必须保留批处理记忆');
    });

    // ─────────────────────────────────────────────────────────────
    // T7: Token 预算与韩文 Hangul 字符估算 (P2-02)
    // ─────────────────────────────────────────────────────────────
    test('T7: Token 预算涵盖韩文、time-only、显式空场景和极低 Sync 预算', () => {
        // 韩文测试
        const korean = '안녕하세요 반갑습니다'; // 10 字符 + 空格
        const tokens = estimateTokens(korean);
        assert(tokens >= 10, '韩文音节必须按照 CJK 规则正确估算 Token');

        // 伴随模式开销扣除
        updateSettings({ mode: 'sync', maxTotalMemoryTokens: 400 });
        const prompt = buildAndInjectMemoryPrompt();
        assert(prompt.includes('伴随记忆与情境更新协议'), '伴随模式必须注入协议');
        const totalEstimated = estimateTokens(prompt);
        assert(totalEstimated <= 400, `注入总内容 (~${totalEstimated} tok) 绝不能超出 maxTotalMemoryTokens (400)`);

        updateSettings({ mode: 'async', maxTotalMemoryTokens: 450 });
        const state = getState();
        state.memories = [];
        state.scene = { time: '深夜，下着雨', in_scene_characters: [] };
        const timeOnlyPrompt = buildAndInjectMemoryPrompt();
        assert(timeOnlyPrompt.includes('时间/天气: 深夜，下着雨'), '只有 time 时必须输出时间字段');
        assert(timeOnlyPrompt.includes('现场无人在场'), '显式空数组必须作为有效的空场景输出');

        updateSettings({ mode: 'sync', maxTotalMemoryTokens: 100 });
        const compactPrompt = buildAndInjectMemoryPrompt();
        assert(compactPrompt.includes('状态更新协议'), '低预算时应降级为紧凑 Sync 协议');
        assert(estimateTokens(compactPrompt) <= 100, '极低预算下的完整注入块仍不得超过总预算');
    });

    // ─────────────────────────────────────────────────────────────
    // T8: 伴生标签异常留存与可观测性 (P2-05)
    // ─────────────────────────────────────────────────────────────
    test('T8: 畸形伴随标签的错误记录可跨重载保留，并带有明确长度边界', () => {
        const state = getState();
        state.last_sync_error = null;

        const malformedMsg = '好的，我知道了。\n<!--PERSISTENT_MEMORY { "scene": { location: unquoted_err } } -->';
        const cleaned = extractAndApplySyncTag(malformedMsg);

        assert(!cleaned.includes('PERSISTENT_MEMORY'), '消息正文中标签必须被剥离');
        assert(state.last_sync_error !== null, '状态中必须记录 last_sync_error');
        assert(state.last_sync_error.error.includes('JSON 解析失败'), '必须记录具体解析失败原因');
        assert.strictEqual(state.last_sync_error.truncated, false, '短标签不应被标记为截断');
        const reloaded = loadCurrentState();
        assert(reloaded.last_sync_error?.error.includes('JSON 解析失败'), '重载后必须保留同步标签错误');
    });

    // ─────────────────────────────────────────────────────────────
    // T9: 提炼超时保护验证 (P2-03)
    // ─────────────────────────────────────────────────────────────
    await testAsync('T9: 原生提炼路径的超时包装器会丢弃迟到结果并释放等待', async () => {
        let completed = false;
        const slowRequest = () => new Promise(resolve => setTimeout(() => {
            completed = true;
            resolve('late result');
        }, 30));

        await assert.rejects(
            withTimeout(slowRequest, 5, '测试原生请求'),
            /超时/
        );
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.strictEqual(completed, true, '底层宿主请求可继续完成，但迟到结果不应提交到调用方');
    });

    // ─────────────────────────────────────────────────────────────
    // T10: 敏感凭据脱敏存储 (P1-04 核心)
    // ─────────────────────────────────────────────────────────────
    test('T10: localStorage 备份中严格脱敏 customApiKey', () => {
        mockLocalStorage = {};
        updateSettings({
            customApiUrl: 'https://api.openai.com/v1',
            customApiKey: 'sk-super-secret-key-123456789',
            customApiModel: 'gpt-4o'
        });
        saveSettingsImmediately();

        const raw = mockLocalStorage['ST_PM_SETTINGS_BACKUP'];
        assert(raw, 'localStorage 中必须存在备份');
        const parsed = JSON.parse(raw);
        assert.strictEqual(parsed.customApiKey, undefined, 'localStorage 备份中绝不可出现明文 customApiKey！');
        assert.strictEqual(parsed.customApiUrl, 'https://api.openai.com/v1', '非敏感配置正常保存');
    });

    // ─────────────────────────────────────────────────────────────
    // T17: 模型提炼 known_by 参与者白名单校验 (P0-1 核心)
    // ─────────────────────────────────────────────────────────────
    test('T17: 模型提炼输出中包含非参与者的 known_by / character 时触发 ACL 拦截并拒绝入库', () => {
        const allowed = new Set(['玩家', '角色A']);
        const payload = {
            new_memories: [
                {
                    content: '角色A和局外人隐秘交谈',
                    type: 'fact',
                    scope: 'shared',
                    known_by: ['角色A', '局外人C'] // 局外人C不在参与者名单中
                },
                {
                    content: '局外人C的私密想法',
                    type: 'fact',
                    scope: 'character',
                    character: '局外人C' // 局外人C不在名单中
                },
                {
                    content: '合法共享记忆',
                    type: 'fact',
                    scope: 'shared',
                    known_by: ['角色A', '玩家']
                }
            ]
        };
        const validated = validateExtractedPayload(payload, [], allowed);
        assert(validated, '校验器应返回合法部分');
        assert.strictEqual(validated.new_memories.length, 1, '非法成员条目必须被剔除');
        assert.strictEqual(validated.new_memories[0].content, '合法共享记忆');
    });

    // ─────────────────────────────────────────────────────────────
    // T18: 记忆类型 HTML 属性注入与存储型 XSS 防御 (P0-2 核心)
    // ─────────────────────────────────────────────────────────────
    test('T18: 恶意构造的 type (如带引号与事件注入) 在迁移载入与卡片渲染时被严格白名单净化', () => {
        mockContext.chatMetadata = {
            [MODULE_NAME]: {
                version: 3,
                memories: [
                    {
                        id: 'xss_1',
                        content: '正常事实内容',
                        type: 'fact" onclick="alert(1)" bad_attr="test',
                        scope: 'world'
                    }
                ]
            }
        };
        const state = loadCurrentState();
        const loadedMem = state.memories[0];
        assert.strictEqual(loadedMem.type, 'fact', 'state.js 载入时必须将非法类型规范化为合法枚举 (fact)');

        // 进一步验证 ui.js renderMemoryCard 输出
        const html = renderMemoryCard({
            id: 'xss_card',
            content: '测试防注入卡片',
            type: 'fact" onclick="alert(1)"',
            scope: 'world',
            lifecycle: 'active'
        });
        assert(!html.includes('onclick="alert(1)"'), 'HTML 渲染必须杜绝属性注入');
        assert(html.includes('pm-type-fact'), '类型徽章应渲染为合法的 pm-type-fact');
    });

    // ─────────────────────────────────────────────────────────────
    // T19: 旧数据迁移知情范围保守化 (P1-1 核心)
    // ─────────────────────────────────────────────────────────────
    test('T19: 旧版本无 scope 且无角色归属数据保守继承为 character 范围，严禁膨胀为两方共享', () => {
        mockContext.chatMetadata = {
            [MODULE_NAME]: {
                version: 2,
                memories: [
                    { id: 'legacy_unassigned', content: '旧记忆未分配归属', type: 'fact' },
                    { id: 'legacy_with_char', content: '角色专属旧记忆', type: 'statement', character: '角色B' }
                ]
            }
        };
        const state = loadCurrentState();
        assert.strictEqual(state.memories.length, 2);
        const mem1 = state.memories.find(m => m.id === 'legacy_unassigned');
        assert.strictEqual(mem1.scope, MEMORY_SCOPE.CHARACTER);
        assert.strictEqual(mem1.character, '角色A');
        assert.deepStrictEqual(mem1.known_by, ['角色A']);

        const mem2 = state.memories.find(m => m.id === 'legacy_with_char');
        assert.strictEqual(mem2.scope, MEMORY_SCOPE.CHARACTER);
        assert.strictEqual(mem2.character, '角色B');
        assert.deepStrictEqual(mem2.known_by, ['角色B']);
    });

    // ─────────────────────────────────────────────────────────────
    // T20: 损坏记忆元数据自愈与容错 (P1-2 核心)
    // ─────────────────────────────────────────────────────────────
    test('T20: 聊天元数据中存在 null、undefined、非对象或缺失 content 的损坏条目时，迁移平滑自愈不崩溃', () => {
        mockContext.chatMetadata = {
            [MODULE_NAME]: {
                version: 2,
                memories: [
                    null,
                    undefined,
                    "invalid-string-memory",
                    12345,
                    {}, // 缺失 content
                    { id: 'corrupt_empty', content: '   ' }, // 空白 content
                    { id: 'valid_mem', content: '正常完好的记忆', type: 'fact', scope: 'world' }
                ]
            }
        };
        assert.doesNotThrow(() => {
            const state = loadCurrentState();
            assert.strictEqual(state.memories.length, 1, '损坏条目过滤后仅保留完好记忆');
            assert.strictEqual(state.memories[0].id, 'valid_mem');
            assert.strictEqual(state.memories[0].content, '正常完好的记忆');
        });
    });

    // ─────────────────────────────────────────────────────────────
    // T21: updateMemory 规范化更新与行内编辑保护
    // ─────────────────────────────────────────────────────────────
    test('T21: updateMemory 规范化更新内容与触发词，强制限制150字符与类型校验', () => {
        const state = getState();
        state.memories = [];
        const mem = addMemory({ content: '原始记忆内容', type: 'statement', scope: 'world' });
        assert(mem);

        // 1. 超长文本截断至 150 字符
        const superLongText = 'A'.repeat(300);
        const updated = updateMemory(mem.id, {
            content: superLongText,
            trigger_keys: [' 关键词1 ', '  ', '关键词2']
        });
        assert.strictEqual(updated.content.length, 150);
        assert.deepStrictEqual(updated.trigger_keys, ['关键词1', '关键词2']);

        // 2. 空白内容拒绝覆盖原内容
        updateMemory(mem.id, { content: '   ' });
        const check1 = state.memories.find(m => m.id === mem.id);
        assert.strictEqual(check1.content.length, 150, '空白内容不应覆盖有效内容');

        // 3. 非法类型更新被拒绝
        updateMemory(mem.id, { type: 'invalid_type_xss' });
        const check2 = state.memories.find(m => m.id === mem.id);
        assert.strictEqual(check2.type, 'statement', '非法类型不得修改原类型');
    });

    // ─────────────────────────────────────────────────────────────
    // T22: 记忆数据导出结构完备性与导入智能去重合并
    // ─────────────────────────────────────────────────────────────
    test('T22: exportMemoryData 结构完备性与 importMemoryData 去重合并不受脏数据污染', () => {
        const state = getState();
        state.memories = [];
        state.scene = { location: '神殿大厅', in_scene_characters: ['角色A'] };
        addMemory({ content: '神殿深处的誓言', type: 'statement', scope: 'character', character: '角色A' });

        // 导出
        const exported = exportMemoryData();
        assert.strictEqual(exported.plugin, MODULE_NAME);
        assert.strictEqual(exported.memories.length, 1);
        assert.strictEqual(exported.scene.location, '神殿大厅');

        // 模拟外部导入包：包含重复项、全新项、损坏项
        const externalData = {
            scene: { time: '黄昏' },
            memories: [
                null,
                {}, // 空损坏
                { content: '神殿深处的誓言', type: 'statement' }, // 完全相同内容 (去重)
                { id: 'ext_mem_1', content: '藏在壁画后的地图', type: 'fact', scope: 'shared', known_by: ['角色A', '玩家'] }
            ]
        };

        const res = importMemoryData(externalData, 'merge');
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.count, 1, '重复项与损坏项跳过，仅导入1条全新有效记忆');
        assert.strictEqual(state.memories.length, 2, '当前总记忆数应为 2');
        assert.strictEqual(state.memories[1].content, '藏在壁画后的地图');
        assert.strictEqual(state.memories[1].scope, 'shared');
    });

    // ─────────────────────────────────────────────────────────────
    // T23: 记忆长程归并分组隔离与常驻/终态保护 (P0 核心架构)
    // ─────────────────────────────────────────────────────────────
    test('T23: buildConsolidationCandidateGroups 严格基于权限边界隔离分组，拒绝跨越不同知情范围混同', () => {
        const memories = [
            { id: 'w1', content: '世界事件1', scope: 'world', lifecycle: 'active', status: 'triggered' },
            { id: 'w2', content: '世界事件2', scope: 'world', lifecycle: 'active', status: 'triggered' },
            { id: 'w3_comp', content: '已结项世界事件', scope: 'world', lifecycle: 'completed', status: 'archived' }, // 结项不参与
            { id: 'w_hib', content: '检索休眠但事实有效事件', scope: 'world', lifecycle: 'active', status: 'archived' }, // 检索休眠不参与归并
            { id: 'ca1', content: '角色A私事1', scope: 'character', character: '角色A', lifecycle: 'active', status: 'triggered' },
            { id: 'ca2', content: '角色A私事2', scope: 'character', character: '角色A', lifecycle: 'active', status: 'triggered' },
            { id: 'ca_pinned', content: '角色A常驻锚点', scope: 'character', character: '角色A', lifecycle: 'active', status: 'pinned' }, // 常驻不参与
            { id: 'cb1', content: '角色B独占事件', scope: 'character', character: '角色B', lifecycle: 'active', status: 'triggered' }, // 仅1条不满足>=2
            { id: 'sh1', content: '共知事件1', scope: 'shared', known_by: ['角色A', '玩家'], lifecycle: 'active', status: 'triggered' },
            { id: 'sh2', content: '共知事件2', scope: 'shared', known_by: ['玩家', '角色A'], lifecycle: 'active', status: 'triggered' }
        ];

        const groups = buildConsolidationCandidateGroups(memories);
        assert.strictEqual(groups.length, 3, '应且仅应产生 3 个有效分组');

        const worldGroup = groups.find(g => g.key === 'world');
        assert(worldGroup);
        assert.strictEqual(worldGroup.items.length, 2, '仅 active 且 triggered 的两项纳入，常驻与休眠均被排除');

        const charAGroup = groups.find(g => g.key === 'character:角色A');
        assert(charAGroup);
        assert.strictEqual(charAGroup.items.length, 2, '常驻项 ca_pinned 被排除');

        const sharedGroup = groups.find(g => g.scope === 'shared');
        assert(sharedGroup);
        assert.strictEqual(sharedGroup.items.length, 2, '已知角色排序归一化后正确合并为同一分组');
    });

    // ─────────────────────────────────────────────────────────────
    // T24: 模型归并输出的权限越权、跨组拼凑与 Schema 校验
    // ─────────────────────────────────────────────────────────────
    test('T24: validateConsolidatedPayload 拦截越权提权、跨组拼凑与未授权知情者，并保证 supersedes 准确性', () => {
        const mems = [
            { id: 'm1', content: '角色A在山谷迷路', scope: 'character', character: '角色A', lifecycle: 'active', status: 'triggered' },
            { id: 'm2', content: '角色A采摘灵芝', scope: 'character', character: '角色A', lifecycle: 'active', status: 'triggered' },
            { id: 'm3', content: '世界公告天气大雪', scope: 'world', lifecycle: 'active', status: 'triggered' }
        ];

        // 1. 尝试跨越不同权限记忆进行拼凑 (m1 私知 + m3 世界公共)
        const badPayload1 = {
            consolidated: [
                {
                    content: '角色A在大雪天采摘了灵芝',
                    type: 'fact',
                    scope: 'world',
                    supersedes: ['m1', 'm3']
                }
            ]
        };
        const val1 = validateConsolidatedPayload(badPayload1, mems);
        assert.strictEqual(val1, null, '跨知情范围拼凑必须被全量拦截');

        // 2. 尝试借归并提权 (将私知 m1+m2 变造为 world)
        const badPayload2 = {
            consolidated: [
                {
                    content: '角色A不仅迷路还采了灵芝',
                    type: 'fact',
                    scope: 'world', // 越权提权
                    supersedes: ['m1', 'm2']
                }
            ]
        };
        const val2 = validateConsolidatedPayload(badPayload2, mems);
        assert.strictEqual(val2, null, '归并新记忆试图篡改原知情范围必须被拦截');

        // 3. 尝试 supersedes 仅包含 1 条或不存在的 ID
        const badPayload3 = {
            consolidated: [
                {
                    content: '单条无需归并',
                    type: 'fact',
                    scope: 'character',
                    supersedes: ['m1']
                }
            ]
        };
        const val3 = validateConsolidatedPayload(badPayload3, mems);
        assert.strictEqual(val3, null, '单条记忆替代不能构成归并');

        // 4. 正确合法归并
        const goodPayload = {
            consolidated: [
                {
                    content: '角色A在山谷迷路期间采获一株珍稀灵芝',
                    type: 'fact',
                    scope: 'character',
                    character: '角色A',
                    trigger_keys: ['灵芝', '山谷'],
                    supersedes: ['m1', 'm2']
                }
            ]
        };
        const valGood = validateConsolidatedPayload(goodPayload, mems);
        assert(valGood);
        assert.strictEqual(valGood.consolidated.length, 1);
        assert.strictEqual(valGood.consolidated[0].scope, 'character');
        assert.strictEqual(valGood.consolidated[0].character, '角色A');
        assert.deepStrictEqual(valGood.consolidated[0].supersedes, ['m1', 'm2']);
    });

    // ─────────────────────────────────────────────────────────────
    // T25: 终态记忆归档箱垃圾回收 (Purge)
    // ─────────────────────────────────────────────────────────────
    test('T25: purgeArchivedMemories 仅清理 completed/superseded/refuted 终态条目，完好保留 active 与 pinned', () => {
        const state = getState();
        state.memories = [
            { id: 'p1', content: '置顶关键事实', status: 'pinned', lifecycle: 'active' },
            { id: 'act1', content: '当前活跃待办', status: 'triggered', lifecycle: 'active' },
            { id: 'hib1', content: '用户休眠但事实仍有效', status: 'archived', lifecycle: 'active' },
            { id: 'comp1', content: '已完成的约定', status: 'archived', lifecycle: 'completed' },
            { id: 'sup1', content: '已被替代的历史细节', status: 'archived', lifecycle: 'superseded' },
            { id: 'ref1', content: '已被推翻的猜想', status: 'archived', lifecycle: 'refuted' }
        ];

        const res = purgeArchivedMemories();
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.removed, 3, '应清理 3 条终态记忆');
        assert.strictEqual(res.remaining, 3, '剩余 3 条有效记忆 (含检索休眠)');
        assert.deepStrictEqual(state.memories.map(m => m.id), ['p1', 'act1', 'hib1'], '仅置顶、活跃与休眠有效记忆完好保留');
    });

    // ─────────────────────────────────────────────────────────────
    // T26: 归并执行先废弃旧条目(superseded)再入库新条目，规避相似冲突误吞与失踪
    // ─────────────────────────────────────────────────────────────
    test('T26: 归并执行先废弃旧条目(superseded)再入库新条目，规避相似冲突误吞与失踪', () => {
        const state = getState();
        state.memories = [
            { id: 'old1', content: '角色A在山谷中偶然采摘到一株千年灵芝', scope: 'character', character: '角色A', lifecycle: 'active', status: 'triggered', trigger_keys: ['灵芝'] },
            { id: 'old2', content: '角色A获知灵芝可以解除天下奇毒', scope: 'character', character: '角色A', lifecycle: 'active', status: 'triggered', trigger_keys: ['灵芝', '解毒'] }
        ];

        // 模拟合法归并 payload，其内容与 old1 相似度超过 0.70
        const consolidatedItem = {
            type: 'fact',
            content: '角色A在山谷中偶然采摘到一株千年灵芝并探明其可解天下奇毒',
            scope: 'character',
            character: '角色A',
            trigger_keys: ['灵芝', '解毒', '山谷'],
            supersedes: ['old1', 'old2']
        };

        // 验证执行逻辑：先置 superseded，再 addMemory
        for (const oldId of consolidatedItem.supersedes) {
            setMemoryLifecycle(oldId, MEMORY_LIFECYCLE.SUPERSEDED);
        }
        const added = addMemory({
            type: consolidatedItem.type,
            content: consolidatedItem.content,
            scope: consolidatedItem.scope,
            character: consolidatedItem.character,
            known_by: [consolidatedItem.character],
            trigger_keys: consolidatedItem.trigger_keys,
            status: MEMORY_STATUS.TRIGGERED
        });

        assert(added && added.id, '新归并条目必须成功独立入库并拥有有效 ID');
        const activeMems = state.memories.filter(m => m.lifecycle === MEMORY_LIFECYCLE.ACTIVE);
        assert.strictEqual(activeMems.length, 1, '必须恰好保留 1 条活跃的新归并记忆');
        assert.strictEqual(activeMems[0].content, consolidatedItem.content);

        const supersededMems = state.memories.filter(m => m.lifecycle === MEMORY_LIFECYCLE.SUPERSEDED);
        assert.strictEqual(supersededMems.length, 2, '两项旧条目均已被安全标记为 superseded 终态');
    });

    // ─────────────────────────────────────────────────────────────
    // T27: 归并异步期间用户切换会话 (chatId 变化)，拦截落盘并安全丢弃
    // ─────────────────────────────────────────────────────────────
    await testAsync('T27: 归并异步期间用户切换会话 (chatId 变化)，拦截落盘并安全丢弃', async () => {
        mockContext.chatId = 'chat_session_alpha';
        const state = getState();
        state.memories = [
            { id: 'alpha_m1', content: 'Alpha会话关键事件1', scope: 'world', lifecycle: 'active', status: 'triggered' },
            { id: 'alpha_m2', content: 'Alpha会话关键事件2', scope: 'world', lifecycle: 'active', status: 'triggered' }
        ];

        // 模拟原生大模型调用期间，用户点击切换了会话窗口 (chatId 发生突变)
        mockContext.generateRaw = async () => {
            mockContext.chatId = 'chat_session_beta';
            return JSON.stringify({
                consolidated: [
                    {
                        content: 'Alpha会话归纳事实',
                        type: 'fact',
                        scope: 'world',
                        trigger_keys: ['Alpha'],
                        supersedes: ['alpha_m1', 'alpha_m2']
                    }
                ]
            });
        };

        const res = await triggerMemoryConsolidation(true);
        assert.strictEqual(res.success, false);
        assert(res.reason.includes('归并期间会话发生切换'), '必须精准拦截并丢弃');

        // 验证原会话数据未受破坏
        const m1 = state.memories.find(m => m.id === 'alpha_m1');
        assert.strictEqual(m1.lifecycle, MEMORY_LIFECYCLE.ACTIVE, 'Alpha 记忆未被错误标记为 superseded');
        assert.strictEqual(state.memories.length, 2, 'Beta 会话未被 Alpha 的归并结果污染');

        delete mockContext.generateRaw;
        mockContext.chatId = 'chat_test_001';
    });

    // ─────────────────────────────────────────────────────────────
    // T28: 语义向量数学运算与本地特征哈希嵌入确定性
    // ─────────────────────────────────────────────────────────────
    test('T28: 向量余弦相似度边界防护与本地 256 维嵌入确定性', () => {
        // 1. 余弦相似度边界
        assert.strictEqual(cosineSimilarity(null, [1, 2]), 0);
        assert.strictEqual(cosineSimilarity([0, 0], [0, 0]), 0);
        const v1 = [1, 0, 0];
        const v2 = [1, 0, 0];
        assert(Math.abs(cosineSimilarity(v1, v2) - 1.0) < 1e-5, '相同向量相似度应为 1.0');
        const vOrtho = [0, 1, 0];
        assert.strictEqual(cosineSimilarity(v1, vOrtho), 0, '正交向量相似度应为 0');

        // 2. 本地嵌入生成与确定性
        const emb1 = generateLocalEmbedding('山谷深处的千年灵芝能解奇毒');
        const emb2 = generateLocalEmbedding('山谷深处的千年灵芝能解奇毒');
        assert.strictEqual(emb1.length, LOCAL_VECTOR_DIM);
        assert.deepStrictEqual(emb1, emb2, '相同文本的本地向量必须绝对一致 (确定性)');

        // 3. 语义相近 vs 语义无关
        const embSimilar = generateLocalEmbedding('深山采摘灵芝草药解天下剧毒');
        const embIrrelevant = generateLocalEmbedding('世界金融股市剧烈波动下跌');

        const simHigh = cosineSimilarity(emb1, embSimilar);
        const simLow = cosineSimilarity(emb1, embIrrelevant);
        assert(simHigh > 0.20, `同义表达相似度应较高 (当前: ${simHigh.toFixed(3)})`);
        assert(simLow < 0.15, `无关表达相似度应极低 (当前: ${simLow.toFixed(3)})`);
        assert(simHigh > simLow, '语义相关相似度应显著高于无关文本');
    });

    // ─────────────────────────────────────────────────────────────
    // T29: 混合检索：同义转换无字面关键词时的语义激活
    // ─────────────────────────────────────────────────────────────
    test('T29: calculateHybridMemoryScore 在无字面关键词命中时，依据高语义相似度成功激活记忆', () => {
        const mem = {
            id: 'mem_sea',
            content: '海啸爆发摧毁了沿海渔村',
            type: 'fact',
            scope: 'world',
            trigger_keys: ['海啸', '渔村'], // 触发词严格为海啸与渔村
            embedding: generateLocalEmbedding('海啸爆发摧毁了沿海渔村 海啸 渔村')
        };

        // 对话上下文：使用近义与同义词，但完全不出现“海啸”与“渔村”
        const queryContext = {
            queryText: '地点: 海岸 | 玩家: 巨大的海浪疯狂席卷陆地，水势凶猛吞没了一切村落与房屋！',
            scanCorpus: '巨大的海浪疯狂席卷陆地，水势凶猛吞没了一切村落与房屋！',
            queryVector: generateLocalEmbedding('地点: 海岸 | 玩家: 巨大的海浪疯狂席卷陆地，水势凶猛吞没了一切村落与房屋！')
        };

        // 1. 关闭语义检索 (纯关键词): 词法未命中 -> 返回 0
        const lexicalOnlyScore = calculateHybridMemoryScore(mem, queryContext, { semanticRetrievalEnabled: false });
        assert.strictEqual(lexicalOnlyScore, 0, '纯词法匹配在无关键词命中时不得激活');

        // 2. 开启语义检索 (混合打分): 语义相似度达标 -> 成功激活
        const hybridScore = calculateHybridMemoryScore(mem, queryContext, {
            semanticRetrievalEnabled: true,
            semanticThreshold: 0.10,
            semanticWeight: 0.60
        });
        assert(hybridScore > 0, `混合检索应在无关键词命中时通过语义相似度成功激活 (得分: ${hybridScore})`);

        // 3. 对完全无关内容拒绝激活
        const irrelevantMem = {
            id: 'mem_book',
            content: '图书馆古籍记载了古代帝王谱系',
            trigger_keys: ['帝王', '谱系'],
            embedding: generateLocalEmbedding('图书馆古籍记载了古代帝王谱系 帝王 谱系')
        };
        const irrevScore = calculateHybridMemoryScore(irrelevantMem, queryContext, {
            semanticRetrievalEnabled: true,
            semanticThreshold: 0.20,
            semanticWeight: 0.60
        });
        assert.strictEqual(irrevScore, 0, '语义完全无关的记忆即便开启混合检索也必须被坚决拦截');
    });

    // ─────────────────────────────────────────────────────────────
    // T30: 语义高分绝不可穿透角色知情权 (ACL 权限绝对免疫)
    // ─────────────────────────────────────────────────────────────
    test('T30: 角色私密与共享记忆即便具备 100% 语义相似度，未授权角色也绝对无法获悉', () => {
        updateSettings({
            mode: 'async',
            maxTotalMemoryTokens: 450,
            semanticRetrievalEnabled: true
        });

        const state = getState();
        state.memories = [];
        state.scene = {
            location: '暗室',
            in_scene_characters: ['角色A', '角色B', '玩家']
        };

        // 角色A私密记忆
        addMemory({
            content: '角色A私藏了绝密藏宝图',
            type: 'fact',
            scope: 'character',
            character: '角色A',
            trigger_keys: ['藏宝图']
        });

        // 构造与记忆 100% 吻合的对话
        mockContext.chat = [
            { is_user: true, mes: '角色A私藏了绝密藏宝图' }
        ];

        // 角色B生成时，尽管语义吻合度极高，绝对严禁注入角色A的私密记忆！
        mockContext.characterId = 1; // 角色B
        mockContext.this_chid = 1;
        const promptB = buildAndInjectMemoryPrompt();
        assert(!promptB.includes('藏宝图'), '角色B生成时即便语义 100% 吻合也绝对严禁注入角色A私密记忆！');

        // 角色A生成时，正常注入
        mockContext.characterId = 0; // 角色A
        mockContext.this_chid = 0;
        const promptA = buildAndInjectMemoryPrompt();
        assert(promptA.includes('藏宝图'), '角色A自身生成时应正常注入');

        // 恢复聊天上下文
        mockContext.chat = [
            { is_user: true, mes: '你好！' },
            { is_user: false, name: '角色A', mes: '你好，很高兴见到你。' }
        ];
    });

    // ─────────────────────────────────────────────────────────────
    // T31: 向量缓存过期检测与批量重构 (Cache Invalidation & Reindexing)
    // ─────────────────────────────────────────────────────────────
    await testAsync('T31: 修改记忆内容使 embedding 缓存失效，reindexAllMemories 成功重新建立索引', async () => {
        const state = getState();
        state.memories = [];
        const mem = addMemory({
            content: '原始记忆文本',
            type: 'fact',
            scope: 'world'
        });
        assert(Array.isArray(mem.embedding), '新建记忆应同步产生本地向量');
        assert.strictEqual(isEmbeddingDirty(mem, 'local'), false, '新建记忆向量应为有效最新状态');

        // 修改记忆文本
        updateMemory(mem.id, { content: '更新后的全新剧情记忆' });
        const updatedMem = state.memories.find(m => m.id === mem.id);
        assert.strictEqual(isEmbeddingDirty(updatedMem, 'local'), false, 'updateMemory 后向量指纹同步刷新');

        // 人工使向量失效
        updatedMem.embedding = null;
        assert.strictEqual(isEmbeddingDirty(updatedMem, 'local'), true, '清空向量后应被标记为 dirty');

        const reindexRes = await reindexAllMemories(false);
        assert.strictEqual(reindexRes.updated, 1, '应有 1 条记忆被重新索引');
        assert(Array.isArray(updatedMem.embedding), '重新索引后向量恢复');
    });

    // ─────────────────────────────────────────────────────────────
    // T32: 敏感凭据脱敏存储支持 embeddingApiKey
    // ─────────────────────────────────────────────────────────────
    test('T32: localStorage 备份中严格脱敏 embeddingApiKey', () => {
        mockLocalStorage = {};
        updateSettings({
            embeddingApiUrl: 'https://api.openai.com/v1',
            embeddingApiKey: 'sk-embedding-secret-key-abcdef',
            embeddingModel: 'text-embedding-3-small'
        });
        saveSettingsImmediately();

        const raw = mockLocalStorage['ST_PM_SETTINGS_BACKUP'];
        assert(raw, 'localStorage 中必须存在备份');
        const parsed = JSON.parse(raw);
        assert.strictEqual(parsed.embeddingApiKey, undefined, 'localStorage 备份中绝不可出现明文 embeddingApiKey！');
        assert.strictEqual(parsed.embeddingApiUrl, 'https://api.openai.com/v1', '非敏感向量配置正常保存');
    });

    // ─────────────────────────────────────────────────────────────
    // T33: getActiveWorldBookInfo 单会话世界书动态解析（会话与角色作用域）
    // ─────────────────────────────────────────────────────────────
    await testAsync('T33: getActiveWorldBookInfo 正确解析当前聊天专属世界书与角色内置卡片世界书', async () => {
        // 场景 1: 当前聊天绑定了专属世界书
        mockContext.chatMetadata = { world_info: '世界书A' };
        mockContext.characters = [{ name: '角色A' }];
        mockContext.characterId = 0;
        mockContext.loadWorldInfo = async (name) => {
            if (name === '世界书A') {
                return {
                    entries: {
                        '1': { uid: 1, comment: '断钢圣剑', key: ['圣剑', '断钢'], content: '插在巨石中的圣剑' },
                        '2': { uid: 2, comment: '精灵之森', key: ['精灵', '森林'], content: '封闭千年的妖精领地' }
                    }
                };
            }
            return null;
        };

        const wbInfo = await getActiveWorldBookInfo();
        assert(wbInfo, '应成功解析到当前聊天的世界书');
        assert.strictEqual(wbInfo.bookName, '世界书A');
        assert.strictEqual(wbInfo.entries.length, 2);
        assert.strictEqual(wbInfo.entries[0].comment, '断钢圣剑');

        // 场景 2: 聊天未绑定，但角色卡拥有内置 character_book
        mockContext.chatMetadata = {};
        mockContext.characters = [{
            name: '角色A',
            data: {
                character_book: {
                    name: '卡片内置设定集',
                    entries: [
                        { uid: 10, comment: '暗黑魔核', key: ['魔核'], content: '提供无尽能量' }
                    ]
                }
            }
        }];
        const wbChar = await getActiveWorldBookInfo();
        assert(wbChar, '应成功回退解析角色卡内置设定集');
        assert.strictEqual(wbChar.bookName, '卡片内置设定集');
        assert.strictEqual(wbChar.entries.length, 1);
        assert.strictEqual(wbChar.entries[0].comment, '暗黑魔核');

        // 恢复 mock
        mockContext.chatMetadata = {};
        mockContext.characters = [{ name: '角色A' }, { name: '角色B' }];
    });

    // ─────────────────────────────────────────────────────────────
    // T34: 提取校验 validateExtractedPayload 对 lorebook_ref 严格净化
    // ─────────────────────────────────────────────────────────────
    test('T34: validateExtractedPayload 严格校验并净化 lorebook_ref (过滤原型污染与非法字段)', () => {
        const rawPayload = {
            scene: { location: '阿瓦隆' },
            new_memories: [
                {
                    type: 'fact',
                    content: '主角拔出了断钢圣剑',
                    trigger_keys: ['圣剑'],
                    scope: 'world',
                    lorebook_ref: {
                        entry_uid: 1,
                        entry_name: '断钢圣剑',
                        book: '世界书A',
                        __proto__: { evil: true }
                    }
                },
                {
                    type: 'fact',
                    content: '普通对话琐事',
                    trigger_keys: ['天气'],
                    scope: 'world',
                    lorebook_ref: null
                },
                {
                    type: 'fact',
                    content: '带畸形关联的记忆',
                    trigger_keys: ['测试'],
                    scope: 'world',
                    lorebook_ref: {
                        entry_uid: 'invalid_not_number',
                        entry_name: '   '
                    }
                }
            ]
        };

        const validated = validateExtractedPayload(rawPayload, [], new Set(['User', '角色A']));
        assert(validated, '校验应成功通过');
        assert.strictEqual(validated.new_memories.length, 3);

        const m1 = validated.new_memories[0];
        assert(m1.lorebook_ref, '合法条目保留 lorebook_ref');
        assert.strictEqual(m1.lorebook_ref.entry_uid, 1);
        assert.strictEqual(m1.lorebook_ref.entry_name, '断钢圣剑');
        assert.strictEqual(m1.lorebook_ref.book, '世界书A');
        assert.strictEqual(m1.lorebook_ref.evil, undefined, '严禁原型污染');

        const m2 = validated.new_memories[1];
        assert.strictEqual(m2.lorebook_ref, null, '未提供关联的应为 null');

        const m3 = validated.new_memories[2];
        assert.strictEqual(m3.lorebook_ref, null, '畸形或空条目关联应被清洗为 null');
    });

    // ─────────────────────────────────────────────────────────────
    // T35: 关联世界书的记忆注入格式化与动态加权唤醒
    // ─────────────────────────────────────────────────────────────
    test('T35: 记忆带有 lorebook_ref 时注入带 [世界书关联: xx] 标识，并享受检索加权唤醒', () => {
        const state = getState();
        state.memories = [];
        updateSettings({
            enabled: true,
            mode: 'async',
            worldBookIntegrationEnabled: true,
            worldBookBoostScore: 0.35,
            maxTotalMemoryTokens: 500
        });

        // 录入一条关联世界书“断钢圣剑”的动态事实
        addMemory({
            type: 'fact',
            content: '主角在第3章拔出了巨石中的圣剑，剑身附带金色裂痕',
            trigger_keys: ['圣剑拔出'],
            scope: 'world',
            status: MEMORY_STATUS.TRIGGERED,
            lorebook_ref: {
                entry_uid: 1,
                entry_name: '断钢圣剑',
                book: '世界书A'
            }
        });

        // 对话语料中提到了条目名称“断钢圣剑”，但没有提到原 trigger_keys “圣剑拔出”
        mockContext.chat = [
            { is_user: true, mes: '听说有人见到了断钢圣剑？' },
            { is_user: false, name: '角色A', mes: '是的，那柄剑确实已经不在巨石上了。' }
        ];

        const injected = buildAndInjectMemoryPrompt();
        assert(injected.includes('[世界书关联: 断钢圣剑]'), '注入提示词中必须包含世界书关联标记');
        assert(injected.includes('金色裂痕'), '关联条目因世界书加权被成功唤醒进入上下文');
    });

    // ─────────────────────────────────────────────────────────────
    // T36: 世界书关联绝对无法穿透权限边界 (ACL & POV 免疫)
    // ─────────────────────────────────────────────────────────────
    test('T36: 世界书关联记忆若设为 character/shared，未授权角色或未知主体绝对不可获悉 (Fail-Closed)', () => {
        const state = getState();
        state.memories = [];
        updateSettings({
            enabled: true,
            mode: 'async',
            worldBookIntegrationEnabled: true,
            maxTotalMemoryTokens: 500
        });

        // 角色A的私密记忆，但关联了公共世界书条目“断钢圣剑”
        addMemory({
            type: 'fact',
            content: '角色A独自知晓圣剑内部藏有一张密信',
            trigger_keys: ['断钢圣剑'],
            scope: 'character',
            character: '角色A',
            status: MEMORY_STATUS.TRIGGERED,
            lorebook_ref: {
                entry_uid: 1,
                entry_name: '断钢圣剑'
            }
        });

        // 语料中出现圣剑
        mockContext.chat = [
            { is_user: true, mes: '关于断钢圣剑你了解多少？' }
        ];

        // 1. 角色B生成时，即便命中世界书条目且余弦相似度极高，绝对严禁注入角色A的私知
        mockContext.characterId = 1; // 角色B
        mockContext.this_chid = 1;
        const promptB = buildAndInjectMemoryPrompt();
        assert(!promptB.includes('密信'), '角色B生成时严禁注入角色A私密世界书关联记忆！');

        // 2. 旁白/未知主体生成时，Fail-Closed 保守拒绝注入
        mockContext.characterId = null;
        mockContext.this_chid = null;
        mockContext.name2 = null;
        mockContext.groupId = 'group_123';
        const promptUnknown = buildAndInjectMemoryPrompt();
        assert(!promptUnknown.includes('密信'), '主体未知时 Fail-Closed 保守拒绝注入私密世界书关联记忆！');

        // 3. 角色A自身生成时，正常注入
        mockContext.characterId = 0; // 角色A
        mockContext.this_chid = 0;
        mockContext.name2 = '角色A';
        mockContext.groupId = null;
        const promptA = buildAndInjectMemoryPrompt();
        assert(promptA.includes('密信'), '角色A自身生成时应正常注入');
        assert(promptA.includes('[世界书关联: 断钢圣剑]'), '包含世界书关联标签');
    });

    // ─────────────────────────────────────────────────────────────
    // T37: updateMemory 与 importMemoryData 完备保留 lorebook_ref
    // ─────────────────────────────────────────────────────────────
    test('T37: updateMemory 与 importMemoryData 完备保留与更新 lorebook_ref', () => {
        const state = getState();
        state.memories = [];

        const m = addMemory({
            content: '初始记忆',
            type: 'fact',
            scope: 'world'
        });
        assert.strictEqual(m.lorebook_ref, null);

        // 更新增加 lorebook_ref
        const updated = updateMemory(m.id, {
            lorebook_ref: { entry_name: '精灵之森', entry_uid: 2, book: '主书' }
        });
        assert(updated.lorebook_ref, 'updateMemory 应成功设置 lorebook_ref');
        assert.strictEqual(updated.lorebook_ref.entry_name, '精灵之森');

        // 导出并导入
        const exported = exportMemoryData();
        state.memories = [];
        importMemoryData(exported, 'replace');

        const reloaded = getState().memories.find(item => item.id === m.id);
        assert(reloaded, '导入后条目应存在');
        assert(reloaded.lorebook_ref, '导入后应完好保留 lorebook_ref');
        assert.strictEqual(reloaded.lorebook_ref.entry_name, '精灵之森');
    });

    // ─────────────────────────────────────────────────────────────
    // T38: 世界书条目与生命周期双维复合筛选 (Lorebook & Lifecycle Filter Logic)
    // ─────────────────────────────────────────────────────────────
    test('T38: 世界书条目与生命周期双维复合筛选逻辑 (UI 筛选规则)', () => {
        const isTerminalOrArchived = m => m.status === MEMORY_STATUS.ARCHIVED || (m.lifecycle && m.lifecycle !== MEMORY_LIFECYCLE.ACTIVE);

        const sampleMemories = [
            { id: '1', content: '精灵之森的露水', status: 'triggered', lifecycle: 'active', lorebook_ref: { entry_name: '精灵之森' } },
            { id: '2', content: '精灵长老已交出秘符', status: 'archived', lifecycle: 'completed', lorebook_ref: { entry_name: '精灵之森' } },
            { id: '3', content: '圣剑已由湖中取出', status: 'triggered', lifecycle: 'active', lorebook_ref: { entry_name: '断钢圣剑' } },
            { id: '4', content: '普通日常对话记录', status: 'triggered', lifecycle: 'active', lorebook_ref: null },
            { id: '5', content: '旧的无关联废弃记忆', status: 'archived', lifecycle: 'superseded', lorebook_ref: null }
        ];

        const filterFn = (mems, memFilter, loreFilter) => mems.filter(m => {
            if (memFilter === 'active' && isTerminalOrArchived(m)) return false;
            if (memFilter === 'archived' && !isTerminalOrArchived(m)) return false;

            if (loreFilter === '__unlinked__') {
                if (m.lorebook_ref && m.lorebook_ref.entry_name) return false;
            } else if (loreFilter) {
                if (!m.lorebook_ref || m.lorebook_ref.entry_name !== loreFilter) return false;
            }
            return true;
        });

        // 1. 全部设定
        assert.strictEqual(filterFn(sampleMemories, 'all', '').length, 5, '全部+不限设定');
        assert.strictEqual(filterFn(sampleMemories, 'active', '').length, 3, '活跃+不限设定');
        assert.strictEqual(filterFn(sampleMemories, 'archived', '').length, 2, '归档+不限设定');

        // 2. 未关联设定
        assert.strictEqual(filterFn(sampleMemories, 'all', '__unlinked__').length, 2, '全部+未关联设定');
        assert.strictEqual(filterFn(sampleMemories, 'active', '__unlinked__').length, 1, '活跃+未关联设定');
        assert.strictEqual(filterFn(sampleMemories, 'archived', '__unlinked__').length, 1, '归档+未关联设定');

        // 3. 指定设定：精灵之森
        assert.strictEqual(filterFn(sampleMemories, 'all', '精灵之森').length, 2, '全部+精灵之森');
        assert.strictEqual(filterFn(sampleMemories, 'active', '精灵之森').length, 1, '活跃+精灵之森');
        assert.strictEqual(filterFn(sampleMemories, 'archived', '精灵之森').length, 1, '归档+精灵之森');

        // 4. 指定设定：断钢圣剑
        assert.strictEqual(filterFn(sampleMemories, 'active', '断钢圣剑').length, 1, '活跃+断钢圣剑');
        assert.strictEqual(filterFn(sampleMemories, 'archived', '断钢圣剑').length, 0, '归档+断钢圣剑');
    });

    // ─────────────────────────────────────────────────────────────
    // T39: 世界书安全差量写回机制 (Write-Back Hook: Dry-run, Commit, Idempotency & Guards)
    // ─────────────────────────────────────────────────────────────
    await testAsync('T39: 世界书安全差量写回机制 (Write-Back Hook: 预览、提交、幂等防重与安全边界)', async () => {
        const state = getState();
        state.memories = [];

        // 准备 Mock 世界书数据
        const mockLoreEntries = {
            101: {
                uid: 101,
                comment: '断钢圣剑',
                key: ['圣剑', '断钢'],
                content: '湖中仙女赠予亚瑟王的绝世神兵。'
            },
            102: {
                uid: 102,
                comment: '精灵之泉',
                key: ['泉水'],
                content: '传说中拥有治愈万物之效的秘泉。'
            }
        };

        let savedLoreName = null;
        let savedLoreData = null;

        mockContext.chatMetadata = { world_info: '王国史诗世界书' };
        mockContext.loadWorldInfo = async (name) => {
            if (name === '王国史诗世界书') {
                return { entries: mockLoreEntries };
            }
            return null;
        };
        mockContext.saveWorldInfo = async (name, data, imm) => {
            savedLoreName = name;
            savedLoreData = JSON.parse(JSON.stringify(data));
            return true;
        };

        // 添加一条关联到断钢圣剑的动态记忆
        const memSword = addMemory({
            content: '在第三章战斗中圣剑断为两截',
            type: 'fact',
            scope: 'world',
            lorebook_ref: { entry_name: '断钢圣剑', entry_uid: 101 }
        });

        // 1. 无关记忆写回拦截
        const memUnlinked = addMemory({
            content: '普通对话细节',
            type: 'fact',
            scope: 'world'
        });
        const unlinkedRes = await syncMemoryDeltaToWorldInfo(memUnlinked.id);
        assert.strictEqual(unlinkedRes.success, false, '未关联世界书的记忆应被拦截');
        assert(unlinkedRes.reason.includes('未关联任何世界书'), '明确拦截原因');

        // 2. 预览模式 (Dry Run)：只出 diff，绝不修改世界书原始数据
        const dryRes = await syncMemoryDeltaToWorldInfo(memSword.id, { dryRun: true });
        assert.strictEqual(dryRes.success, true, 'Dry run 应返回成功');
        assert.strictEqual(dryRes.dryRun, true, '明确标记 dryRun');
        assert.strictEqual(dryRes.preview.entryName, '断钢圣剑');
        assert.strictEqual(dryRes.preview.entryUid, 101);
        assert(dryRes.preview.newContent.includes('在第三章战斗中圣剑断为两截'), '新内容应包含追加差量');
        assert(!mockLoreEntries[101].content.includes('在第三章战斗中圣剑断为两截'), 'Dry run 绝不修改原始条目正文');
        assert.strictEqual(savedLoreData, null, 'Dry run 绝不调用 saveWorldInfo');

        // 3. 正式提交写回 (Commit) 配合 markCompleted
        const commitRes = await syncMemoryDeltaToWorldInfo(memSword.id, { markCompleted: true });
        assert.strictEqual(commitRes.success, true, '正式写回应成功');
        assert.strictEqual(savedLoreName, '王国史诗世界书');
        assert(mockLoreEntries[101].content.includes('在第三章战斗中圣剑断为两截'), '条目正文应成功追加差量');
        assert(mockLoreEntries[101].content.includes('[持续事实更新'), '应带有持续事实更新标记');

        // 验证记忆自身的状态更新
        const updatedMem = state.memories.find(m => m.id === memSword.id);
        assert.strictEqual(updatedMem.synced_to_world_info, true, '记忆应被标记为已同步入世界书');
        assert(updatedMem.synced_at, '应记录同步时间戳');
        assert.strictEqual(updatedMem.lifecycle, 'completed', '勾选 markCompleted 应将生命周期转为 completed');

        // 4. 幂等防重检查：再次写回相同事实应被拦截，杜绝重复污染世界书
        const dupRes = await syncMemoryDeltaToWorldInfo(memSword.id);
        assert.strictEqual(dupRes.success, false, '重复写回应被幂等拦截');
        assert.strictEqual(dupRes.alreadySynced, true, '标记 alreadySynced 为 true');
        assert(dupRes.reason.includes('无需重复写入'), '明确提示已包含内容');

        // 5. 角色卡内置世界书 (Embedded Character Book) 只读安全拦截
        mockContext.chatMetadata = {}; // 清空会话世界书
        mockContext.characterId = 0;
        mockContext.characters[0].data = {
            character_book: {
                name: '角色内置只读设定集',
                entries: [{ id: 1, name: '精灵之泉', content: '只读' }]
            }
        };

        const memEmbedded = addMemory({
            content: '泉水干涸',
            type: 'fact',
            scope: 'world',
            lorebook_ref: { entry_name: '精灵之泉' }
        });
        const embedRes = await syncMemoryDeltaToWorldInfo(memEmbedded.id);
        assert.strictEqual(embedRes.success, false, '内嵌角色卡世界书应被只读拦截');
        assert(embedRes.reason.includes('只读卡片资源'), '明确提示内嵌设定属于只读');
    });

    // ─────────────────────────────────────────────────────────────
    // T40: 对话轮次回退时自愈校准提炼楼层 (Floor Rewind Self-Healing)
    // ─────────────────────────────────────────────────────────────
    await testAsync('T40: 对话轮次回退时自愈校准提炼楼层 (Floor Rewind Self-Healing)', async () => {
        const state = getState();
        state.memories = [];
        state.last_digest_floor = 30; // 模拟旧状态曾记录到第30轮

        // 模拟用户回滚/删除了消息，当前会话仅剩 10 轮 AI 回复
        mockContext.chat = [];
        for (let i = 1; i <= 10; i++) {
            mockContext.chat.push({ is_user: true, mes: `用户问题 ${i}` });
            mockContext.chat.push({ is_user: false, name: '角色A', mes: `角色回答 ${i}` });
        }

        mockContext.generateRaw = async () => JSON.stringify({
            scene: { location: '自愈测试场景' },
            new_memories: []
        });

        // 触发自动提炼 (非强制)
        await triggerAsyncDigest(false);

        // 应当自愈校准：last_digest_floor 不再是 30，而是根据当前轮次 10 自动回退
        assert(state.last_digest_floor <= 10, `last_digest_floor 应自动校准至当前轮次以内 (当前值: ${state.last_digest_floor})`);
    });

    // ─────────────────────────────────────────────────────────────
    // T41: 全量与历史上下文分块回溯提炼管道 (Full Context Backlog Digestion Pipeline)
    // ─────────────────────────────────────────────────────────────
    await testAsync('T41: 全量历史分块回溯提炼管道 (适应中途启用用户从头回溯消化全量上下文)', async () => {
        const state = getState();
        state.memories = [];
        state.last_digest_floor = 0;

        // 构建一个较长的历史会话：共 16 条消息 (8 轮对话)
        mockContext.chat = [
            { is_user: true, mes: '听说王城地下藏有先皇密令？' },
            { is_user: false, name: '角色A', mes: '确有其事，但这需要三把青铜古钥才能开启。' },
            { is_user: true, mes: '第一把钥匙在哪里？' },
            { is_user: false, name: '角色A', mes: '就在白马寺的枯井石缝中。我们约定明夜子时去取。' },
            { is_user: true, mes: '好，那剩下两把呢？' },
            { is_user: false, name: '角色A', mes: '第二把在北境大将军手中，第三把下落不明。' },
            { is_user: true, mes: '现在我们到哪里了？' },
            { is_user: false, name: '角色A', mes: '我们已经抵达白马寺山门前，今夜风雨大作。' },
            { is_user: true, mes: '准备进入枯井！' },
            { is_user: false, name: '角色A', mes: '我已起出第一把青铜古钥，密诏地图显示第二把在寒铁关。' },
            { is_user: true, mes: '小心有埋伏！' },
            { is_user: false, name: '角色A', mes: '黑衣刺客杀出，我们合力击退了黑衣首领！' },
            { is_user: true, mes: '你受伤了吗？' },
            { is_user: false, name: '角色A', mes: '轻微擦伤，我们连夜转移到了隐秘破庙。' },
            { is_user: true, mes: '休整一下，天亮前往寒铁关。' },
            { is_user: false, name: '角色A', mes: '遵命，明日启程。' }
        ];

        let callCount = 0;
        mockContext.generateRaw = async (opts) => {
            callCount++;
            return JSON.stringify({
                scene: {
                    location: `历史场景阶段 ${callCount}`,
                    time: '黑夜暴雨',
                    action: '寻找古钥与密诏',
                    tension: '紧张',
                    unresolved: '古钥下落',
                    in_scene_characters: ['角色A', '玩家']
                },
                new_memories: [
                    {
                        type: 'fact',
                        content: `历史阶段关键记忆第 ${callCount} 项事实`,
                        scope: 'world',
                        status: 'triggered'
                    }
                ],
                lifecycle_updates: []
            });
        };

        const progressUpdates = [];
        const result = await triggerBacklogDigest({
            fromStart: true,
            chunkSize: 8,
            overlap: 2,
            onProgress: (p) => progressUpdates.push(p)
        });

        assert.strictEqual(result.success, true, '全量回溯提炼应成功完成');
        assert(result.batchesProcessed >= 2, `16条消息至少应分为2个以上批次递进处理 (实际: ${result.batchesProcessed})`);
        assert(progressUpdates.length >= 2, '进度回调应被多次调用');
        assert.strictEqual(progressUpdates[progressUpdates.length - 1].percent, 100, '最终进度百分比应达到 100%');
        assert(state.memories.length >= 2, '记忆库应成功沉淀多个历史阶段的记忆');
        assert.strictEqual(state.last_digest_floor, 8, '提炼终止楼层应推进到当前最新轮次 8');

        // 测试再次增量提炼：在无新消息时，再次调用应提示无新增未消化轮次
        const rerunResult = await triggerBacklogDigest({ fromStart: false });
        assert.strictEqual(rerunResult.success, true);
        assert.strictEqual(rerunResult.batchesProcessed, 0, '无新消息时不应重复执行批次');
    });

    // ─────────────────────────────────────────────────────────────
    // T42: 可信参与者名单为空时，受限范围记忆严格执行 Fail-Closed 拒绝入库
    // ─────────────────────────────────────────────────────────────
    test('T42: 可信名单为空 (Set.size === 0) 时，受限范围记忆 (character/shared) Fail-Closed 拒绝，仅允许公共常识 (world)', () => {
        const emptyParticipants = new Set([]);

        const payload = {
            new_memories: [
                {
                    content: '角色A的私密计划',
                    type: 'fact',
                    scope: 'character',
                    character: '角色A'
                },
                {
                    content: '角色A和玩家的秘密约定',
                    type: 'statement',
                    scope: 'shared',
                    known_by: ['角色A', '玩家']
                },
                {
                    content: '帝国历342年爆发了大陆战争',
                    type: 'fact',
                    scope: 'world',
                    character: ''
                }
            ]
        };

        const validated = validateExtractedPayload(payload, [], emptyParticipants);
        assert(validated, '校验器应返回结果');
        assert.strictEqual(validated.new_memories.length, 1, '名单为空时，私密与共享记忆必须全部被拦截！');
        assert.strictEqual(validated.new_memories[0].scope, 'world', '仅公共常识允许入库');
        assert.strictEqual(validated.new_memories[0].content, '帝国历342年爆发了大陆战争');

        // 测试归并路径的名单为空 Fail-Closed 校验
        const sourceMems = [
            { id: 'm1', content: '事实1', type: 'fact', scope: 'character', character: '角色A', status: 'triggered', lifecycle: 'active' },
            { id: 'm2', content: '事实2', type: 'fact', scope: 'character', character: '角色A', status: 'triggered', lifecycle: 'active' },
            { id: 'w1', content: '公共1', type: 'fact', scope: 'world', status: 'triggered', lifecycle: 'active' },
            { id: 'w2', content: '公共2', type: 'fact', scope: 'world', status: 'triggered', lifecycle: 'active' }
        ];

        const consolidateCharPayload = {
            consolidated: [
                {
                    content: '归并角色私密事实',
                    type: 'fact',
                    scope: 'character',
                    character: '角色A',
                    supersedes: ['m1', 'm2']
                }
            ]
        };
        const consolidateCharRes = validateConsolidatedPayload(consolidateCharPayload, sourceMems, emptyParticipants);
        assert.strictEqual(consolidateCharRes, null, '可信名单为空时，角色受限的归并条目必须被拒绝');

        const consolidateWorldPayload = {
            consolidated: [
                {
                    content: '归并公共历史事实',
                    type: 'fact',
                    scope: 'world',
                    supersedes: ['w1', 'w2']
                }
            ]
        };
        const consolidateWorldRes = validateConsolidatedPayload(consolidateWorldPayload, sourceMems, emptyParticipants);
        assert(consolidateWorldRes, '公共事实归并不受角色名单限制');
        assert.strictEqual(consolidateWorldRes.consolidated.length, 1);
    });

    // ─────────────────────────────────────────────────────────────
    // T43: 伴随标签同步提取幂等性测试 (保证重复执行不产生重复记忆)
    // ─────────────────────────────────────────────────────────────
    test('T43: 伴生标签同步提取幂等性测试 (extractAndApplySyncTag 在重复输入时不产生脏数据)', () => {
        mockContext.chatMetadata = {};
        loadCurrentState();
        mockContext.chat = [
            { is_user: true, mes: '我们在临街茶楼碰头。' },
            { is_user: false, mes: '好的。' }
        ];

        const tagText = '好的。\n<!--PERSISTENT_MEMORY\n{\n  "scene": { "location": "临街茶楼" },\n  "new_memories": [{ "content": "双方在临街茶楼碰头", "type": "fact", "scope": "world" }]\n}\n-->';

        // 第一次提取
        const cleaned1 = extractAndApplySyncTag(tagText);
        assert.strictEqual(cleaned1, '好的。', '伴生标签应被剥离');
        const state1 = getState();
        assert.strictEqual(state1.scene.location, '临街茶楼');
        assert.strictEqual(state1.memories.length, 1);

        // 第二次在已清洗的文本上执行（模拟 MESSAGE_RECEIVED 与 CHARACTER_MESSAGE_RENDERED 重复触发）
        const cleaned2 = extractAndApplySyncTag(cleaned1);
        assert.strictEqual(cleaned2, '好的。');
        const state2 = getState();
        assert.strictEqual(state2.memories.length, 1, '已清洗文本不应触发额外记忆');

        // 再次传入带相同标签的文本（模拟消息重复接收），相似度融合去重保护
        const cleaned3 = extractAndApplySyncTag(tagText);
        assert.strictEqual(cleaned3, '好的。');
        const state3 = getState();
        assert.strictEqual(state3.memories.length, 1, '相同记忆内容应被相似度去重融合，记忆总数保持 1 条');
    });

    // ──────────────────────────────────────────────────────────
    // T44: JSON 截断自动修复与外层包装解包测试 (Token 耗尽截断自愈)
    // ──────────────────────────────────────────────────────────
    test('T44: cleanAndParseJson 与 repairTruncatedJson 能自愈因 Token 耗尽被腰斩截断的 JSON 并成功解包', () => {
        // 场景 1: 在字符串中间因 Token 耗尽被腰斩
        const truncatedString = '{"scene": {"location": "破庙遗迹"}, "new_memories": [{"type": "fact", "content": "张三在二十年前曾受过重伤';
        const repaired1 = cleanAndParseJson(truncatedString);
        assert.ok(repaired1, '应成功修复并解析截断字符串');
        assert.strictEqual(repaired1.scene.location, '破庙遗迹');
        assert.strictEqual(repaired1.new_memories[0].content, '张三在二十年前曾受过重伤');

        // 场景 2: 在数组或对象键处被腰斩 (悬空逗号与键名)
        const truncatedKey = '{"scene": {"location": "古道"}, "new_memories": [{"type": "fact", "content": "队伍已出发", "trigger_';
        const repaired2 = cleanAndParseJson(truncatedKey);
        assert.ok(repaired2, '应成功修复带悬空键名的截断 JSON');
        assert.strictEqual(repaired2.scene.location, '古道');
        assert.strictEqual(repaired2.new_memories[0].content, '队伍已出发');

        // 场景 3: 外层被 API 包装加壳 (如 { data: { ... } })
        const wrappedJson = {
            data: {
                scene: { location: '王府正厅' },
                new_memories: [{ type: 'fact', content: '王爷下达了封城令', scope: 'world' }]
            }
        };
        const unwrapped = unwrapJsonPayload(wrappedJson);
        assert.strictEqual(unwrapped.scene.location, '王府正厅');
        const validated = validateExtractedPayload(wrappedJson, [], new Set());
        assert.ok(validated, 'validateExtractedPayload 应能自动解包外层 data');
        assert.strictEqual(validated.scene.location, '王府正厅');
        assert.strictEqual(validated.new_memories[0].content, '王爷下达了封城令');
    });

    // ──────────────────────────────────────────────────────────
    // T45: 良性静默提炼轮次 (isQuietDigestPayload / Benign No-Op) 测试
    // ──────────────────────────────────────────────────────────
    test('T45: 模型在无实质进展时返回空摘要或静默状态，被识别为良性静默而非格式错误', () => {
        // 常见静默返回 1: 仅有 summary
        const quietPayload1 = { summary: '双方日常闲聊，场景未改变，无关键新记忆沉淀' };
        assert.strictEqual(isQuietDigestPayload(quietPayload1), true, '纯 summary 应判定为良性静默');

        // 常见静默返回 2: new_memories 为空数组且 scene 为 null
        const quietPayload2 = {
            summary: '情境平稳',
            scene: null,
            new_memories: [],
            lifecycle_updates: []
        };
        assert.strictEqual(isQuietDigestPayload(quietPayload2), true, '空数组+空快照应判定为良性静默');

        // 常见静默返回 3: 带有 status: "no_change"
        const quietPayload3 = { status: 'no_change', note: '无状态变迁' };
        assert.strictEqual(isQuietDigestPayload(quietPayload3), true, 'no_change 声明应判定为良性静默');

        // 反例: 包含实质新记忆的正常 payload 不得判定为静默
        const activePayload = {
            scene: { location: '密道' },
            new_memories: [{ type: 'fact', content: '发现暗门' }]
        };
        assert.strictEqual(isQuietDigestPayload(activePayload), false, '含实质内容的 payload 不得判定为静默');
    });

    // ──────────────────────────────────────────────────────────
    // T46: 记忆长周期衰减与超时沉睡巡检引擎 (Inactivity Dormancy Engine)
    // ──────────────────────────────────────────────────────────
    test('T46: 连续多轮未命中的记忆自动转入沉睡休眠 (ARCHIVED)，常驻项 (PINNED) 豁免', () => {
        mockContext.chatMetadata = {};
        loadCurrentState();

        // 添加 3 条记忆：
        // 1. 第 5 楼创建的琐碎记忆 (最后活跃第 5 楼)
        const mem1 = addMemory({
            content: '李四在集市买了一匹黑马',
            type: MEMORY_TYPES.FACT,
            scope: MEMORY_SCOPE.WORLD,
            floor: 5
        });
        // 2. 第 5 楼创建但设为 PINNED 的核心记忆
        const mem2 = addMemory({
            content: '两家曾在三十年前订下血契',
            type: MEMORY_TYPES.FACT,
            scope: MEMORY_SCOPE.WORLD,
            floor: 5,
            status: MEMORY_STATUS.PINNED
        });
        // 3. 第 28 楼创建的新记忆
        const mem3 = addMemory({
            content: '队伍刚刚抵达玉门关城楼',
            type: MEMORY_TYPES.FACT,
            scope: MEMORY_SCOPE.WORLD,
            floor: 28
        });

        assert.strictEqual(mem1.status, MEMORY_STATUS.TRIGGERED);
        assert.strictEqual(mem2.status, MEMORY_STATUS.PINNED);
        assert.strictEqual(mem3.status, MEMORY_STATUS.TRIGGERED);

        // 当前对话推进至第 30 楼，执行沉睡衰减巡检 (默认 autoSleepTurns = 20)
        // mem1: 30 - 5 = 25 >= 20 轮，应当沉睡！
        // mem2: PINNED，常驻免除沉睡！
        // mem3: 30 - 28 = 2 < 20 轮，仍然保持激活活跃！
        const res = applyInactivitySleep(30, { autoSleepEnabled: true, autoSleepTurns: 20 });
        assert.strictEqual(res.sleptCount, 1, '应有 1 条记忆进入沉睡');

        const state = getState();
        const updated1 = state.memories.find(m => m.id === mem1.id);
        const updated2 = state.memories.find(m => m.id === mem2.id);
        const updated3 = state.memories.find(m => m.id === mem3.id);

        assert.strictEqual(updated1.status, MEMORY_STATUS.ARCHIVED, '超期未激活记忆应自动转入 ARCHIVED 沉睡');
        assert.strictEqual(updated2.status, MEMORY_STATUS.PINNED, '常驻置顶记忆绝不自动沉睡');
        assert.strictEqual(updated3.status, MEMORY_STATUS.TRIGGERED, '近期活跃记忆保持 TRIGGERED 状态');
    });

    // ──────────────────────────────────────────────────────────
    // T47: 沉睡记忆联想唤醒 (Associative Wake-Up / Recall) 测试
    // ──────────────────────────────────────────────────────────
    test('T47: 沉睡休眠的记忆在遇到强相关语义或关键词重新被激活时，能自动唤醒并刷新活跃楼层', () => {
        mockContext.chatMetadata = {};
        loadCurrentState();

        // 构造一条已处于沉睡状态的记忆
        const dormantMem = addMemory({
            content: '李四佩戴的古玉刻有玄武纹章',
            type: MEMORY_TYPES.FACT,
            scope: MEMORY_SCOPE.WORLD,
            floor: 2,
            trigger_keys: ['古玉', '玄武纹章', '李四']
        });
        dormantMem.status = MEMORY_STATUS.ARCHIVED;
        dormantMem.last_activated_floor = 2;
        saveCurrentState();

        // 构造包含强相关上下文的对话情境 (第 50 楼重新提及玄武纹章)
        mockContext.chat = [
            { is_user: true, mes: '你看李四身上那块古玉，上面的玄武纹章似乎有些眼熟。' },
            { is_user: false, name: '角色A', mes: '确实，这正是玄武门的信物！' }
        ];

        // 触发提示词注入
        const injected = buildAndInjectMemoryPrompt();
        assert.ok(injected.includes('古玉刻有玄武纹章'), '沉睡记忆应被高相关上下文联想召回并注入');

        const state = getState();
        const awakenedMem = state.memories.find(m => m.id === dormantMem.id);
        assert.strictEqual(awakenedMem.status, MEMORY_STATUS.TRIGGERED, '被召回的沉睡记忆应自动唤醒为 TRIGGERED 活跃状态');
        assert.ok(awakenedMem.last_activated_floor >= 1, '活跃楼层指针应被同步刷新');
    });

    // T48: 断尾修复首键截断测试 (BUG-01)
    test('T48: repairTruncatedJson 能正确修复首属性截断 (无前置逗号) 的残缺 JSON', () => {
        const testCases = [
            '{"loc',
            '{"scene": {"loc',
            '{"scene": {"location": "客栈"}, "new_memories": [{"cont',
            '{"scene": {"location": "客栈"}, "new_memories": [{"content": "测试", "type": "fact"}, {"con'
        ];
        for (const tc of testCases) {
            const repaired = repairTruncatedJson(tc);
            assert.ok(repaired, `应返回修复后的 JSON: ${tc}`);
            let parsed = null;
            assert.doesNotThrow(() => {
                parsed = JSON.parse(repaired);
            }, `修复后的 JSON 必须能被标准 JSON.parse 解析: ${repaired}`);
            assert.ok(parsed && typeof parsed === 'object');
        }
    });

    // T49: 记忆融合保护原始创建楼层并刷新活跃楼层 (BUG-06)
    test('T49: addMemory 保守融合保留条目原始创建楼层并刷新 last_activated_floor', () => {
        mockContext.chatMetadata = {};
        loadCurrentState();
        const mem1 = addMemory({
            content: '角色A在山顶藏有一柄宝剑',
            type: 'fact',
            scope: 'character',
            character: '角色A',
            floor: 5
        });
        assert.strictEqual(mem1.floor, 5);
        assert.strictEqual(mem1.last_activated_floor, 5);

        // 在第 25 轮融合相同的记忆
        const fused = addMemory({
            content: '角色A在山顶藏有一柄宝剑',
            type: 'fact',
            scope: 'character',
            character: '角色A',
            floor: 25
        });
        assert.strictEqual(fused.id, mem1.id, '应命中同条记忆融合');
        assert.strictEqual(fused.floor, 5, '条目原始创建楼层应被严格保留');
        assert.strictEqual(fused.last_activated_floor, 25, '最后活跃楼层应刷新至当前轮次');
    });

    // T50: 群聊与字符串 ID 兼容性测试 (BUG-03)
    test('T50: getGeneratingEntity 完美兼容字符串 characterId 与 this_chid，并在群聊中正确识别 POV', () => {
        // 单聊，characterId 为字符串 "1"
        const ctx1 = {
            characterId: '1',
            this_chid: 0,
            characters: [{ name: '角色A' }, { name: '角色B' }]
        };
        assert.strictEqual(getGeneratingEntity(ctx1), '角色B', '字符串 characterId 应正确映射到角色名');

        // 群聊环境 (groupId 存在)，characterId 缺省，this_chid 为 0
        const ctx2 = {
            groupId: 'grp_001',
            this_chid: 0,
            characters: [{ name: '角色A' }, { name: '角色B' }]
        };
        assert.strictEqual(getGeneratingEntity(ctx2), '角色A', '群聊中 characterId 缺省时应回退至 this_chid');

        // 单聊回退分支
        const ctx3 = {
            name2: '单聊角色'
        };
        assert.strictEqual(getGeneratingEntity(ctx3), '单聊角色', '单聊无角色列表时正确回退到 name2');
    });

    // T51: 宏观归并与导入记忆楼层完整性测试 (BUG-02)
    await testAsync('T51: 宏观归并新记忆与 importMemoryData 完备保留活跃楼层，避免被下一轮秒沉睡', async () => {
        mockContext.chatMetadata = {};
        loadCurrentState();

        // 模拟当前对话进展到第 30 轮
        mockContext.chat = new Array(60).fill(null).map((_, i) => ({
            is_user: i % 2 === 0,
            mes: `消息 ${i}`
        }));

        // 添加两条细节记忆准备归并
        const m1 = addMemory({ content: '双方在城西茶楼碰面交谈', type: 'fact', scope: 'world', floor: 10 });
        const m2 = addMemory({ content: '双方商定次日去往黑风寨', type: 'fact', scope: 'world', floor: 12 });

        // 模拟宏观归并
        mockContext.generateRaw = async () => JSON.stringify({
            consolidated: [{
                content: '双方在茶楼达成前往黑风寨的同盟',
                type: 'fact',
                scope: 'world',
                supersedes: [m1.id, m2.id]
            }]
        });

        const res = await triggerMemoryConsolidation(true);
        assert.ok(res.success, '归并应成功');

        const state = getState();
        const consolidatedMem = state.memories.find(m => m.content.includes('达成前往黑风寨的同盟'));
        assert.ok(consolidatedMem, '归并新记忆应已入库');
        assert.strictEqual(consolidatedMem.floor, 30, '归并记忆的创建楼层应同步为当前对话轮次 (30)');
        assert.strictEqual(consolidatedMem.last_activated_floor, 30, '最后活跃楼层应为 30');

        // 执行沉睡检测 (第 31 轮)
        const sleepRes = applyInactivitySleep(31);
        assert.strictEqual(sleepRes.sleptCount, 0, '归并刚生成的记忆绝对不应被误判休眠');
        assert.strictEqual(consolidatedMem.status, MEMORY_STATUS.TRIGGERED, '归并记忆仍应保持活跃状态');
    });

    // T52: importMemoryData 保留 last_activated_floor
    test('T52: importMemoryData 完备继承原始数据的 last_activated_floor', () => {
        mockContext.chatMetadata = {};
        loadCurrentState();

        const importPayload = {
            memories: [
                {
                    id: 'mem_import_01',
                    content: '历史遗留记忆',
                    type: 'fact',
                    scope: 'world',
                    floor: 10,
                    last_activated_floor: 28
                }
            ]
        };

        importMemoryData(importPayload, 'replace');
        const state = getState();
        const mem = state.memories[0];
        assert.strictEqual(mem.floor, 10);
        assert.strictEqual(mem.last_activated_floor, 28, '导入应完整保留历史活跃楼层');
    });

    test('T53: validateExtractedPayload 遵循用户配置的 maxSceneTokens 与 maxTotalMemoryTokens 动态放宽长度截断', () => {
        // 配置较高的预算
        updateSettings({ maxSceneTokens: 400, maxTotalMemoryTokens: 1200 });

        const longAction = '两人在暴雨中的驿站内相对而坐，烛火随狂风剧烈摇曳。角色A缓缓放下手中满是裂痕的青瓷茶盏，眼神中满是警惕与试探，而角色B则不动声色地将左手按在腰间暗藏的短匕之上，窗外的惊雷骤然撕裂夜空，气氛紧绷到了极点。';
        const longContent = '在暴雨之夜的青石驿站中，角色A与角色B达成了暂时休战的约定，承诺在天亮前互不拔刀，但双方依然各自防备。';

        const raw = {
            scene: {
                location: '青石山下的荒僻驿站内堂',
                time: '子夜暴雨',
                action: longAction,
                tension: '表面平和，杀机暗涌',
                unresolved: '茶水中是否被下了蒙汗药'
            },
            new_memories: [
                {
                    type: 'statement',
                    content: longContent,
                    trigger_keys: ['休战', '驿站'],
                    scope: 'world'
                }
            ]
        };

        const res = validateExtractedPayload(raw, []);
        assert.ok(res, '应解析通过');
        assert.strictEqual(res.scene.action, longAction, '400 Token 预算下长动作描述不应被 150 字符硬截断');
        assert.strictEqual(res.new_memories[0].content, longContent, '1200 Token 预算下长记忆正文不应被 100 字符硬截断');

        // 还原默认设置
        updateSettings({ maxSceneTokens: 150, maxTotalMemoryTokens: 450 });
    });

    test('T54: buildAndInjectMemoryPrompt 在总预算调高时弹性扩容注入条数，突破旧版硬编码 5 条上限', () => {
        mockContext.chatMetadata = {
            [MODULE_NAME]: JSON.parse(JSON.stringify(DEFAULT_STATE))
        };
        mockContext.chat = [
            { is_user: true, mes: '你好，我们继续探险吧！' },
            { is_user: false, name: '角色A', mes: '好的，我们一起探险去山洞。' }
        ];
        loadCurrentState();

        // 设置充裕总预算
        updateSettings({
            enabled: true,
            maxTotalMemoryTokens: 1500,
            maxPinnedCount: 5,
            maxTriggeredCount: 15
        });

        // 录入 10 条高相关度匹配的激活记忆
        batchUpdate(() => {
            const s = getState();
            s.scene = {
                location: '神秘山谷',
                in_scene_characters: ['角色A', '玩家']
            };
            for (let i = 1; i <= 10; i++) {
                s.memories.push({
                    id: `mem-t54-${i}`,
                    type: 'fact',
                    content: `角色A与用户共同经历了第${i}次探险旅程并在山洞中发现线索`,
                    trigger_keys: ['你好', '探险'],
                    scope: 'world',
                    status: MEMORY_STATUS.TRIGGERED,
                    lifecycle: MEMORY_LIFECYCLE.ACTIVE,
                    updated_at: new Date(Date.now() - i * 1000).toISOString()
                });
            }
        });

        buildAndInjectMemoryPrompt();
        const injected = mockContext._injectedPrompt;
        assert.ok(injected, '应生成有效注入文本');

        // 统计注入的记忆条目数
        const injectedItemCount = (injected.match(/- \[事实\]/g) || []).length;
        assert.ok(injectedItemCount > 5, `1500 Token 预算下注入条数应突破旧版 5 条上限，实际注入: ${injectedItemCount} 条`);

        // 还原默认设置
        updateSettings({ maxTotalMemoryTokens: 450, maxPinnedCount: 5, maxTriggeredCount: 5 });
    });

    // ─────────────────────────────────────────────────────────────
    // T55: 现场快照时光机历史栈入栈、去重、一键回滚与指定历史版本恢复 (P1 核心)
    // ─────────────────────────────────────────────────────────────
    test('T55: 现场快照时光机历史栈入栈、去重、一键回滚与指定历史版本恢复', () => {
        mockContext.chatMetadata = {
            [MODULE_NAME]: JSON.parse(JSON.stringify(DEFAULT_STATE))
        };
        loadCurrentState();

        const s = getState();
        // 初始快照
        updateScene({
            location: '清幽竹林',
            time: '清晨',
            action: '两人漫步在竹林小径上'
        }, '初始设定');

        assert.strictEqual(s.scene.location, '清幽竹林');
        assert.strictEqual(s.scene_history.length, 0, '初始第一次快照尚未发生变更，历史栈为空');

        // 第二次快照变更（触发第一次历史入栈）
        updateScene({
            location: '荒废破庙',
            time: '午后阴雨',
            action: '两人推开破庙大门躲雨'
        }, '手动保存');

        assert.strictEqual(s.scene.location, '荒废破庙');
        assert.strictEqual(s.scene_history.length, 1, '发生实质变更后，先前的快照应入栈历史');
        assert.strictEqual(s.scene_history[0].scene.location, '清幽竹林');

        // 重复相同内容，不应入栈
        updateScene({
            location: '荒废破庙',
            time: '午后阴雨',
            action: '两人推开破庙大门躲雨'
        }, '重复保存');
        assert.strictEqual(s.scene_history.length, 1, '无实质变更的更新绝不重复入栈历史栈');

        // 第三次变更（模拟模型提炼）
        updateScene({
            action: '在佛像后发现了刻着文字的暗格'
        }, '模型提炼');
        assert.strictEqual(s.scene.action, '在佛像后发现了刻着文字的暗格');
        assert.strictEqual(s.scene_history.length, 2);
        assert.strictEqual(s.scene_history[1].scene.action, '两人推开破庙大门躲雨');

        // 执行一键撤销回滚 (Rollback)
        const rollRes = rollbackScene();
        assert.ok(rollRes.success, '回滚应成功');
        assert.strictEqual(s.scene.action, '两人推开破庙大门躲雨', '回滚后动作应恢复为上一版本');
        assert.strictEqual(s.scene_history.length, 1, '回滚后历史栈顶应被弹出');

        // 测试指定版本恢复 (Restore)
        const restRes = restoreSceneSnapshot(0);
        assert.ok(restRes.success, '恢复指定索引应成功');
        assert.strictEqual(s.scene.location, '清幽竹林', '应成功恢复为最初的竹林快照');
    });

    // ─────────────────────────────────────────────────────────────
    // T56: 思考型推理模型思维链清洗与未闭合 <think> 自愈 (P1 核心)
    // ─────────────────────────────────────────────────────────────
    test('T56: 思考型模型 (<think>) 深度清洗、未闭合思考标签自愈与多类型思维链免疫', () => {
        // 场景 1: 标准完整闭合思考链 <think>...</think>
        const r1Output = `
<think>
用户想要从对话中提取关键情境。
当前发生的事件是：双方在聚宝阁进行了灵石交割。
地点：聚宝阁内堂。
动作：李四将储物袋递给张三。
</think>
\`\`\`json
{
  "scene": {
    "location": "聚宝阁内堂",
    "action": "李四将装有五千灵石的储物袋递给张三"
  },
  "new_memories": [
    {
      "type": "fact",
      "content": "李四在聚宝阁向张三交付了五千灵石",
      "scope": "world"
    }
  ]
}
\`\`\`
`;
        const p1 = cleanAndParseJson(r1Output);
        assert.ok(p1, '闭合的 <think> 思维链应被干净剥离并成功解析 JSON');
        assert.strictEqual(p1.scene.location, '聚宝阁内堂');
        assert.strictEqual(p1.new_memories[0].content, '李四在聚宝阁向张三交付了五千灵石');

        // 场景 2: 未闭合的 <think> 标签（因 Token 紧张或截断未输出 </think>，但已输出了 JSON 起始）
        const unclosedThinkOutput = `
<think>
正在分析对话...
这里需要更新现场快照和新增事实。
{
  "scene": {
    "location": "落日森林外围",
    "action": "三人背靠背警惕着周围林中的异响"
  }
}
`;
        const p2 = cleanAndParseJson(unclosedThinkOutput);
        assert.ok(p2, '未闭合的 <think> 标签应智能定位 JSON 起始，绝不吞没后续合法数据');
        assert.strictEqual(p2.scene.location, '落日森林外围');

        // 场景 3: 包含 [Thinking Process: ...] 与 \`\`\`thought ... \`\`\` 的变种
        const variantOutput = `
[Thinking Process: Step 1 extract entities. Step 2 format JSON.]
\`\`\`thought
Intermediate analysis details...
\`\`\`
{
  "scene": {
    "action": "双方在城门前依依惜别"
  }
}
`;
        const p3 = cleanAndParseJson(variantOutput);
        assert.ok(p3, '多变种思考标记应被完全过滤');
        assert.strictEqual(p3.scene.action, '双方在城门前依依惜别');
    });

    // ─────────────────────────────────────────────────────────────
    // T57: 自定义提示词注入模板 (XML, English, Compact, Standard) (P1 核心)
    // ─────────────────────────────────────────────────────────────
    test('T57: 自定义注入格式模板 (XML, English, Compact, Standard) 正确渲染与 Token 预算自洽', () => {
        mockContext.chatMetadata = {
            [MODULE_NAME]: JSON.parse(JSON.stringify(DEFAULT_STATE))
        };
        mockContext.chat = [
            { is_user: true, mes: '我们去山顶看日出吧！' },
            { is_user: false, name: '角色A', mes: '好的，我们一起去山顶看日出。' }
        ];
        loadCurrentState();

        batchUpdate(() => {
            const s = getState();
            s.scene = {
                location: '青云峰顶',
                time: '拂晓微光',
                action: '角色A与玩家并肩坐在岩石上远眺云海',
                tension: '宁静祥和',
                in_scene_characters: ['角色A', '玩家']
            };
            s.memories = [
                {
                    id: 'mem_t57_01',
                    type: 'statement',
                    content: '角色A曾向玩家许诺会永远守护云海的安宁',
                    scope: 'world',
                    status: MEMORY_STATUS.TRIGGERED,
                    lifecycle: MEMORY_LIFECYCLE.ACTIVE,
                    trigger_keys: ['山顶', '日出']
                }
            ];
        });

        // 1. 结构化 XML 模板
        updateSettings({ enabled: true, injectionTemplate: 'xml', maxTotalMemoryTokens: 600 });
        const xmlPrompt = buildAndInjectMemoryPrompt();
        assert.ok(xmlPrompt.includes('<persistent_memory>'), 'XML 模板必须包含 <persistent_memory> 根标签');
        assert.ok(xmlPrompt.includes('<scene_state>'), 'XML 模板必须包含 <scene_state> 标签');
        assert.ok(xmlPrompt.includes('<location>青云峰顶</location>'), 'XML 模板必须包含 <location> 标签');
        assert.ok(xmlPrompt.includes('<active_memories>'), 'XML 模板必须包含 <active_memories> 标签');
        assert.ok(xmlPrompt.includes('type="statement"'), 'XML 模板记忆标签应携带 type 属性');
        assert.ok(xmlPrompt.includes('</persistent_memory>'), 'XML 模板必须正确闭合根标签');

        // 2. 英文原生模板 (English RP)
        updateSettings({ injectionTemplate: 'english' });
        const engPrompt = buildAndInjectMemoryPrompt();
        assert.ok(engPrompt.includes('### Persistent Memory (Context & State)'), '英文模板必须采用原生英文标题');
        assert.ok(engPrompt.includes('[Current Scene State]'), '英文模板快照头应为 [Current Scene State]');
        assert.ok(engPrompt.includes('- Location: 青云峰顶'), '英文模板字段前缀应为英文');
        assert.ok(engPrompt.includes('- [Statement/Promise]'), '英文模板前缀应为 Statement/Promise');

        // 3. 极简紧凑模板 (Compact)
        updateSettings({ injectionTemplate: 'compact' });
        const compactPrompt = buildAndInjectMemoryPrompt();
        assert.ok(compactPrompt.includes('### 持续记忆'), '紧凑模板采用精炼标题');
        assert.ok(compactPrompt.includes('[现场] 地点: 青云峰顶'), '紧凑模板采用单行紧凑格式');
        assert.ok(compactPrompt.includes('• [明确约定/言行]'), '紧凑模板采用项目符号点');
        assert(estimateTokens(compactPrompt) < estimateTokens(xmlPrompt), '紧凑模板消耗 Token 必须显著低于 XML 模板');

        // 4. 还原默认标准模板
        updateSettings({ injectionTemplate: 'standard' });
        const stdPrompt = buildAndInjectMemoryPrompt();
        assert.ok(stdPrompt.includes('### 持续情境与记忆核心 (Persistent Memory)'));
        assert.ok(stdPrompt.includes('[当前情境快照 (Scene State)]'));
    });

    // ─────────────────────────────────────────────────────────────
    // T58: 记忆一键升格为世界书独立新词条 (P2 核心)
    // ─────────────────────────────────────────────────────────────
    await testAsync('T58: 记忆一键升格为世界书独立新词条 (UID 递增、格式合规、条目双向绑定与办结流转)', async () => {
        mockContext.chatMetadata = {
            world_info: '艾泽拉斯大百科'
        };
        const mockLoreEntries = {
            "0": { uid: 0, comment: '暴风城', key: ['暴风城'], content: '人类主城' },
            "5": { uid: 5, comment: '幽暗城', key: ['幽暗城'], content: '被遗忘者主城' }
        };
        let savedLoreData = null;
        let savedLoreName = null;

        mockContext.loadWorldInfo = async (name) => {
            if (name === '艾泽拉斯大百科') {
                return { entries: mockLoreEntries };
            }
            return null;
        };
        mockContext.saveWorldInfo = async (name, data, imm) => {
            savedLoreName = name;
            savedLoreData = JSON.parse(JSON.stringify(data));
            return true;
        };

        const state = getState();
        state.memories = [];
        const mem = addMemory({
            content: '提里奥·弗丁手持灰烬使者斩断了霜之哀伤',
            type: 'fact',
            scope: 'world',
            trigger_keys: ['灰烬使者', '霜之哀伤']
        });

        // 1. 执行升格词条
        const res = await promoteMemoryToWorldInfo(mem.id, {
            entryName: '灰烬使者重铸',
            keys: ['灰烬使者', '弗丁', '霜之哀伤'],
            content: '提里奥·弗丁手持灰烬使者斩断了霜之哀伤，彻底终结了巫妖王的统御之冠。',
            markCompleted: true
        });

        assert.strictEqual(res.success, true, '升格操作必须成功');
        assert.strictEqual(res.bookName, '艾泽拉斯大百科', '目标世界书应正确绑定');
        assert.strictEqual(res.entryUid, 6, '新词条 UID 必须在现有最大 UID 5 的基础上递增分配为 6');
        assert.strictEqual(savedLoreName, '艾泽拉斯大百科', '应正确保存至指定世界书');
        assert.ok(savedLoreData.entries['6'], '世界书条目字典中应包含 UID 6');
        assert.strictEqual(savedLoreData.entries['6'].comment, '灰烬使者重铸');
        assert.deepStrictEqual(savedLoreData.entries['6'].key, ['灰烬使者', '弗丁', '霜之哀伤']);
        assert.strictEqual(savedLoreData.entries['6'].selective, true);
        assert.strictEqual(savedLoreData.entries['6'].constant, false);

        // 验证记忆自身属性反向写回与履约流转
        const updatedMem = state.memories.find(m => m.id === mem.id);
        assert.strictEqual(updatedMem.synced_to_world_info, true);
        assert.ok(updatedMem.synced_at);
        assert.strictEqual(updatedMem.lifecycle, 'completed', '勾选 markCompleted 应将记忆流转至 completed 终态');
        assert.strictEqual(updatedMem.lorebook_ref.entry_uid, 6);
        assert.strictEqual(updatedMem.lorebook_ref.entry_name, '灰烬使者重铸');
        assert.strictEqual(updatedMem.lorebook_ref.book, '艾泽拉斯大百科');

        // 2. 角色卡内置只读世界书防御拦截测试
        mockContext.chatMetadata = {};
        mockContext.characters[0].data = {
            character_book: {
                name: '只读内置设定',
                entries: [{ id: 1, name: '霜之哀伤' }]
            }
        };
        const memReadonly = addMemory({ content: '不可写记忆', type: 'fact', scope: 'world' });
        const roRes = await promoteMemoryToWorldInfo(memReadonly.id);
        assert.strictEqual(roRes.success, false, '内置只读世界书必须拦截新建词条');
        assert.ok(roRes.reason.includes('只读卡片资源'));
    });

    // ─────────────────────────────────────────────────────────────
    // T59: 智能信息增量感知与自适应提炼节律 (P2 核心)
    // ─────────────────────────────────────────────────────────────
    await testAsync('T59: 智能信息增量感知与自适应提炼节律 (短句寒暄防空耗、实质增量提炼、上限兜底与强制绕过)', async () => {
        const state = getState();
        state.memories = [];
        state.last_digest_floor = 10;
        state.last_digest_summary = '';

        // 构建聊天上下文：前 10 轮历史
        mockContext.chat = [];
        for (let i = 1; i <= 10; i++) {
            mockContext.chat.push({ is_user: true, mes: `历史问答 ${i}` });
            mockContext.chat.push({ is_user: false, name: '角色A', mes: `历史回答 ${i}` });
        }

        let rawCallCount = 0;
        mockContext.generateRaw = async () => {
            rawCallCount++;
            return JSON.stringify({
                scene: { location: '增量推进新地点' },
                new_memories: []
            });
        };

        // 启用自适应节律，频率 = 3 轮，字数门槛 = 60 字
        updateSettings({
            enabled: true,
            mode: 'async',
            asyncFrequency: 3,
            adaptiveCadenceEnabled: true,
            adaptiveCadenceMinChars: 60
        });

        // 场景 1：新增 3 轮短句寒暄 (第 11-13 轮)，字数极少
        mockContext.chat.push({ is_user: true, mes: '好的' });
        mockContext.chat.push({ is_user: false, name: '角色A', mes: '嗯' });
        mockContext.chat.push({ is_user: true, mes: '早点休息' });
        mockContext.chat.push({ is_user: false, name: '角色A', mes: '好的' });
        mockContext.chat.push({ is_user: true, mes: '晚安' });
        mockContext.chat.push({ is_user: false, name: '角色A', mes: '好梦' });

        rawCallCount = 0;
        await triggerAsyncDigest(false);

        assert.strictEqual(rawCallCount, 0, '字数低于增量门槛且未达到最大推迟轮数时，必须智能跳过提炼');
        assert.strictEqual(state.last_digest_floor, 10, '跳过提炼时不应推进 last_digest_floor');

        // 场景 2：强制触发 (force = true) 必须绕过自适应增量门槛
        await triggerAsyncDigest(true);
        assert.strictEqual(rawCallCount, 1, '手动强制提炼必须无条件执行并调用 LLM API');
        assert.strictEqual(state.last_digest_floor, 13, '强制提炼完成后楼层应成功推进至 13');

        // 场景 3：新增 3 轮实质剧情推进对话 (第 14-16 轮)，总字数 > 60 字
        mockContext.chat.push({ is_user: true, mes: '我们在地下黑市发现了失踪已久的古代神器地图！' });
        mockContext.chat.push({ is_user: false, name: '角色A', mes: '太好了，地图上标记着藏宝密室就在王城大教堂地宫深处，今晚我们就必须出发！' });
        mockContext.chat.push({ is_user: true, mes: '需要准备哪些破除符咒的道具？' });
        mockContext.chat.push({ is_user: false, name: '角色A', mes: '准备三瓶圣水和一把淬银匕首即可，千万不要惊动守夜骑士。' });
        mockContext.chat.push({ is_user: true, mes: '好，我这就去准备。' });
        mockContext.chat.push({ is_user: false, name: '角色A', mes: '一小时后在教堂侧门汇合。' });

        rawCallCount = 0;
        await triggerAsyncDigest(false);

        assert.strictEqual(rawCallCount, 1, '剧情增量字数超出门槛时，必须正常触发后台提炼');
        assert.strictEqual(state.last_digest_floor, 16, '提炼成功后楼层推进至 16');

        // 场景 4：达到最大推迟轮数兜底 (例如 frequency=3, maxDelay=6)
        // 即使连续 6 轮全都是短消息，也必须强制提炼一次以保证状态不永远停滞
        for (let i = 17; i <= 22; i++) {
            mockContext.chat.push({ is_user: true, mes: '啊' });
            mockContext.chat.push({ is_user: false, name: '角色A', mes: '哦' });
        }
        rawCallCount = 0;
        await triggerAsyncDigest(false);
        assert.strictEqual(rawCallCount, 1, '达到最大推迟轮数时，即使字数不足也必须执行保底提炼');
        assert.strictEqual(state.last_digest_floor, 22, '保底提炼后楼层推进至 22');
    });

    // ─────────────────────────────────────────────────────────────
    // T60: 权威参与者白名单边界加固 (单聊与群聊模式下排除角色库无关角色，P1-01 修复)
    // ─────────────────────────────────────────────────────────────
    test('T60: 权威参与者白名单严格隔离 (单聊/群聊模式坚决排除角色库中未参战角色)', () => {
        // 场景 A: 单聊模式 (1-on-1 Chat)
        // 角色库包含角色A、角色B、角色C，但当前仅与角色A单聊 (characterId = 0, name2 = '角色A')
        const singleCtx = {
            name1: '玩家',
            name2: '角色A',
            characterId: 0,
            groupId: null,
            characters: [
                { name: '角色A', avatar: 'charA.png' },
                { name: '角色B', avatar: 'charB.png' },
                { name: '角色C', avatar: 'charC.png' }
            ]
        };

        const singleParts = getContextParticipants(singleCtx);
        assert.strictEqual(singleParts.has('玩家'), true, '玩家必须在白名单内');
        assert.strictEqual(singleParts.has('角色A'), true, '当前激活角色A必须在白名单内');
        assert.strictEqual(singleParts.has('角色B'), false, '单聊模式下，未参聊的角色B严禁进入白名单');
        assert.strictEqual(singleParts.has('角色C'), false, '单聊模式下，未参聊的角色C严禁进入白名单');

        // 测试 Schema 拒绝：模型尝试在单聊中为局外角色B建立 private 记忆
        const payloadB = {
            new_memories: [{ content: '角色B在暗中监视', type: 'fact', scope: 'character', character: '角色B' }]
        };
        const resB = validateExtractedPayload(payloadB, [], singleParts);
        assert.strictEqual(resB.new_memories.length, 0, '模型为局外角色B生成的私密记忆必须被 ACL 拦截丢弃');

        // 测试 Schema 拒绝：模型尝试在单聊中将记忆分享给局外角色C (known_by)
        const payloadShared = {
            new_memories: [{ content: '秘密据点位置', type: 'fact', scope: 'shared', known_by: ['角色A', '角色C'] }]
        };
        const resShared = validateExtractedPayload(payloadShared, [], singleParts);
        assert.strictEqual(resShared.new_memories.length, 0, '共享记忆知情者中包含局外角色C时必须被 ACL 拦截丢弃');

        // 场景 B: 群聊模式 (Group Chat)
        // 当前群聊包含角色A、角色B，但角色C依然不在群内
        const groupCtx = {
            name1: '玩家',
            groupId: 'group_test_01',
            groups: [
                { id: 'group_test_01', name: '探索小队', members: ['charA.png', 'charB.png'] }
            ],
            characters: [
                { name: '角色A', avatar: 'charA.png' },
                { name: '角色B', avatar: 'charB.png' },
                { name: '角色C', avatar: 'charC.png' }
            ]
        };

        const groupParts = getContextParticipants(groupCtx);
        assert.strictEqual(groupParts.has('玩家'), true);
        assert.strictEqual(groupParts.has('角色A'), true, '群成员角色A应在白名单内');
        assert.strictEqual(groupParts.has('角色B'), true, '群成员角色B应在白名单内');
        assert.strictEqual(groupParts.has('角色C'), false, '非群成员角色C绝不可进入群白名单');
    });

    // ─────────────────────────────────────────────────────────────
    // T61: 现场叙事角色 (in_scene_characters) 与授权凭证彻底解耦，阻断循环提权漏洞 (P1-01 修复)
    // ─────────────────────────────────────────────────────────────
    test('T61: 现场叙事角色与授权凭证彻底解耦 (模型生成的现场角色绝不可获得知情权与归属权)', () => {
        const ctx = {
            name1: '玩家',
            name2: '角色A',
            characterId: 0,
            groupId: null,
            characters: [{ name: '角色A' }]
        };

        // 现场描述中存在模型生成的临时 NPC 与局外人物
        const stateWithNpc = {
            scene: {
                in_scene_characters: ['角色A', '酒馆老板NPC', '神秘黑衣刺客']
            }
        };

        const parts = getContextParticipants(ctx, stateWithNpc);
        assert.strictEqual(parts.has('玩家'), true);
        assert.strictEqual(parts.has('角色A'), true);
        assert.strictEqual(parts.has('酒馆老板NPC'), false, '模型现场描述中的 NPC 绝不可被吸收为可信授权者');
        assert.strictEqual(parts.has('神秘黑衣刺客'), false, '模型生成的现场人物绝不可作为授权凭证');

        // 模型尝试向神秘黑衣刺客赋予已知权 (known_by)
        const payloadNpc = {
            new_memories: [
                {
                    content: '密道地图在城西古井',
                    type: 'fact',
                    scope: 'shared',
                    known_by: ['角色A', '神秘黑衣刺客']
                },
                {
                    content: '老板私藏假酒',
                    type: 'fact',
                    scope: 'character',
                    character: '酒馆老板NPC'
                }
            ]
        };

        const res = validateExtractedPayload(payloadNpc, [], parts);
        assert.strictEqual(res.new_memories.length, 0, '模型借由现场名单试图扩大知情权限必须全部被 Fail-Closed 拦截');
    });

    // ─────────────────────────────────────────────────────────────
    // T62: 历史回溯在请求执行期间被 abortBacklogDigest() 可靠中止 (P1-02 修复)
    // ─────────────────────────────────────────────────────────────
    await testAsync('T62: 历史回溯在请求执行期间被 abortBacklogDigest() 可靠中断并防止脏数据落盘', async () => {
        const state = getState();
        state.memories = [];
        state.last_digest_floor = 0;

        mockContext.chat = [];
        for (let i = 1; i <= 8; i++) {
            mockContext.chat.push({ is_user: true, mes: `历史问题 ${i}` });
            mockContext.chat.push({ is_user: false, name: '角色A', mes: `历史回答 ${i}` });
        }

        let resolveReq = null;
        mockContext.generateRaw = () => new Promise(resolve => {
            resolveReq = resolve;
        });

        // 启动历史回溯
        const backlogPromise = triggerBacklogDigest({ fromStart: true, chunkSize: 4 });

        // 验证任务已进入运行态
        assert.strictEqual(isBacklogDigestRunning(), true, '启动后 isBacklogDigestRunning 应为 true');

        // 在网络请求等待期间，模拟用户点击“中止”按钮
        abortBacklogDigest();
        assert.strictEqual(isBacklogDigestRunning(), false, '调用 abort 后 isBacklogDigestRunning 应立即为 false');

        // 随后异步响应返回
        if (resolveReq) {
            resolveReq(JSON.stringify({
                scene: { location: '迟到地点' },
                new_memories: [{ content: '迟到不应落盘的记忆', type: 'fact', scope: 'world' }]
            }));
        }

        const res = await backlogPromise;
        assert.strictEqual(res.success, false, '中止任务返回 success 必须为 false');
        assert.strictEqual(res.aborted, true, '中止任务必须明确标记 aborted: true');
        assert.strictEqual(state.memories.length, 0, '已被中止的批次绝不可向记忆库落盘脏数据');
        assert.strictEqual(state.last_digest_floor, 0, '已被中止的任务不可推进 floor');
    });

    // ─────────────────────────────────────────────────────────────
    // T63: 历史回溯任务 A 中止后立即启动任务 B，生命周期隔离不冲突 (P1-02 修复)
    // ─────────────────────────────────────────────────────────────
    await testAsync('T63: 历史回溯任务 A 中止后立即启动任务 B，任务生命周期隔离且旧任务不清除新任务状态', async () => {
        const state = getState();
        state.memories = [];
        state.last_digest_floor = 0;

        mockContext.chat = [
            { is_user: true, mes: '消息1' },
            { is_user: false, name: '角色A', mes: '回答1' },
            { is_user: true, mes: '消息2' },
            { is_user: false, name: '角色A', mes: '回答2' }
        ];

        let resolveTaskA = null;
        mockContext.generateRaw = () => new Promise(resolve => {
            resolveTaskA = resolve;
        });

        // 启动任务 A
        const taskAPromise = triggerBacklogDigest({ fromStart: true, chunkSize: 4 });

        // 中止任务 A
        abortBacklogDigest();

        // 立即切换为任务 B 的快速响应接口并启动任务 B
        mockContext.generateRaw = async () => JSON.stringify({
            scene: { location: '任务B成功地点' },
            new_memories: [{ content: '任务B沉淀的核心事实', type: 'fact', scope: 'world' }]
        });

        const taskBPromise = triggerBacklogDigest({ fromStart: true, chunkSize: 4 });

        // 任务 B 正常完成
        const resB = await taskBPromise;
        assert.strictEqual(resB.success, true, '任务 B 应当成功执行完成');
        assert.strictEqual(state.memories.length, 1, '任务 B 的有效记忆应成功写入');
        assert.strictEqual(state.memories[0].content, '任务B沉淀的核心事实');

        // 模拟任务 A 的延迟响应返回
        if (resolveTaskA) {
            resolveTaskA(JSON.stringify({
                scene: { location: '任务A迟到地点' },
                new_memories: []
            }));
        }
        const resA = await taskAPromise;
        assert.strictEqual(resA.aborted, true, '任务 A 应保持中止状态');

        // 验证任务 A 结束时绝未破坏全局状态
        assert.strictEqual(isBacklogDigestRunning(), false);
    });

    // ─────────────────────────────────────────────────────────────
    // T64: 历史回溯批次总对话字符受到 MAX_TOTAL_CONVERSATION_CHARS 严格约束与安全压缩 (P2-02 修复)
    // ─────────────────────────────────────────────────────────────
    await testAsync('T64: 历史回溯批次总对话字符受 MAX_TOTAL_CONVERSATION_CHARS 严格预算约束，防上下文膨胀', async () => {
        const state = getState();
        state.memories = [];
        state.last_digest_floor = 0;

        // 构建 10 条超长消息 (单条 800 字符，总字数达 8000 字符)
        mockContext.chat = [];
        for (let i = 1; i <= 10; i++) {
            const longText = `[超长叙事段落 ${i}] ` + '一段极为详尽的古代战役长篇叙述与对话细节内容。'.repeat(60);
            mockContext.chat.push({ is_user: i % 2 === 1, name: '角色A', mes: longText });
        }

        let capturedPrompt = '';
        mockContext.generateRaw = async ({ prompt }) => {
            capturedPrompt = prompt;
            return JSON.stringify({
                scene: { location: '压缩测试场景' },
                new_memories: []
            });
        };

        const res = await triggerBacklogDigest({ fromStart: true, chunkSize: 10 });
        assert.strictEqual(res.success, true);

        // 提取 prompt 中注入的对话记录部分
        const match = capturedPrompt.match(/=== BEGIN UNTRUSTED DIALOGUE TRACE ===([\s\S]*?)=== END UNTRUSTED DIALOGUE TRACE ===/);
        assert.ok(match, 'Prompt 应包含对话追踪区');
        const extractedDialogue = match[1].trim();

        // 验证总字符数被限制在 3500 左右 (加上角色名标签前缀不会超过 4500)
        assert(extractedDialogue.length <= 4500, `回溯批次对话总字数应受安全上限保护 (实际为 ${extractedDialogue.length} 字符，严禁达 8000 字符)`);
        assert(extractedDialogue.includes('[中间叙事已压缩]'), '超长单条消息应包含压缩标记');
    });

    // ─────────────────────────────────────────────────────────────
    // T65: 备份导入路径严格复用权威参与者校验 (单聊私密记忆越权拦截与 Fail-Closed)
    // ─────────────────────────────────────────────────────────────
    test('T65: 备份导入严格校验单聊可信参与者名单 (排除未参战角色的私密记忆，禁止越权入库)', () => {
        const state = getState();
        state.memories = [];

        // 当前单聊环境：仅 '玩家' 与 '角色A'
        mockContext.groupId = null;
        mockContext.groups = [];
        mockContext.name1 = '玩家';
        mockContext.name2 = '角色A';

        const backupData = {
            memories: [
                // 合法 1: 角色A 的私密记忆 (合法参战者)
                { id: 'mem_a_ok', content: '角色A私藏的宝石钥匙', scope: 'character', character: '角色A' },
                // 合法 2: 公共常识 (world 范围无论角色均可导入)
                { id: 'mem_w_ok', content: '暴风城建立于数百年前', scope: 'world' },
                // 越权 1: 角色库中存在但并未参与本会话的角色B (越权跨会话私密记忆)
                { id: 'mem_b_bad', content: '角色B秘密谋划政变', scope: 'character', character: '角色B' },
                // 越权 2: 外部完全未知角色 (越权入侵记忆)
                { id: 'mem_c_bad', content: '刺客C在暗处窥伺', scope: 'character', character: '刺客C' }
            ]
        };

        const res = importMemoryData(backupData, 'merge');
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.imported, 2, '仅导入2条当前会话合法条目');
        assert.strictEqual(res.aclRejected, 2, '2条越权私密记忆应被 ACL 严格拦截');
        assert.strictEqual(state.memories.length, 2);

        const contents = state.memories.map(m => m.content);
        assert.ok(contents.includes('角色A私藏的宝石钥匙'));
        assert.ok(contents.includes('暴风城建立于数百年前'));
        assert.ok(!contents.includes('角色B秘密谋划政变'), '未参战角色B的私密记忆严禁入库');
        assert.ok(!contents.includes('刺客C在暗处窥伺'), '未知角色C的私密记忆严禁入库');
    });

    // ─────────────────────────────────────────────────────────────
    // T66: 备份导入共享记忆知情者白名单安全核验 (排除未参战角色跨会话渗入)
    // ─────────────────────────────────────────────────────────────
    test('T66: 备份导入共享记忆知情者白名单安全核验 (排除未参战角色跨会话渗入)', () => {
        const state = getState();
        state.memories = [];

        mockContext.groupId = null;
        mockContext.groups = [];
        mockContext.name1 = '玩家';
        mockContext.name2 = '角色A';

        const backupData = {
            memories: [
                // 合法: 仅包含当前参战双方
                { id: 'sh_ok', content: '枯井下藏着羊皮纸卷轴', scope: 'shared', known_by: ['角色A', '玩家'] },
                // 越权: 包含未参战的角色B
                { id: 'sh_leak_b', content: '密诏原件藏在书房壁炉暗格', scope: 'shared', known_by: ['角色A', '角色B'] },
                // 越权: 包含完全外部角色
                { id: 'sh_leak_c', content: '城防布防图秘密', scope: 'shared', known_by: ['角色A', '间谍X'] },
                // 越权: 空知情者 (Fail-Closed)
                { id: 'sh_empty', content: '不知是谁留下的纸条', scope: 'shared', known_by: [] }
            ]
        };

        const res = importMemoryData(backupData, 'merge');
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.imported, 1, '仅导入1条合法共享记忆');
        assert.strictEqual(res.aclRejected, 3, '3条知情者越权或空知情者共享记忆被全部拦截');
        assert.strictEqual(state.memories.length, 1);
        assert.strictEqual(state.memories[0].content, '枯井下藏着羊皮纸卷轴');
    });

    // ─────────────────────────────────────────────────────────────
    // T67: 备份导入模式安全等价性 (replace 与 merge 执行同等强度的 ACL 约束)
    // ─────────────────────────────────────────────────────────────
    test('T67: 备份导入模式安全等价性 (replace 与 merge 执行同等强度的 ACL 约束，防全量替换绕过)', () => {
        const state = getState();

        mockContext.groupId = null;
        mockContext.name1 = '玩家';
        mockContext.name2 = '角色A';

        const mixedData = {
            memories: [
                { id: 'm_ok', content: '角色A的真实身份是王族后裔', scope: 'character', character: '角色A' },
                { id: 'm_bad1', content: '角色B谋杀先王的证词', scope: 'character', character: '角色B' },
                { id: 'm_bad2', content: '暗月马戏团集会暗号', scope: 'shared', known_by: ['角色B', '角色C'] }
            ]
        };

        // 1. replace 模式
        state.memories = [{ id: 'old_1', content: '旧记忆条目', scope: 'character', character: '角色A' }];
        const resReplace = importMemoryData(mixedData, 'replace');
        assert.strictEqual(resReplace.success, true);
        assert.strictEqual(resReplace.imported, 1);
        assert.strictEqual(resReplace.aclRejected, 2);
        assert.strictEqual(state.memories.length, 1);
        assert.strictEqual(state.memories[0].content, '角色A的真实身份是王族后裔');

        // 2. merge 模式
        state.memories = [{ id: 'old_1', content: '旧记忆条目', scope: 'character', character: '角色A' }];
        const resMerge = importMemoryData(mixedData, 'merge');
        assert.strictEqual(resMerge.success, true);
        assert.strictEqual(resMerge.imported, 1);
        assert.strictEqual(resMerge.aclRejected, 2);
        assert.strictEqual(state.memories.length, 2); // old_1 + m_ok
    });

    // ─────────────────────────────────────────────────────────────
    // T68: 世界书升格安全防护：私密/现场机密记忆升格显式警示知情范围扩散，并强制二次确认
    // ─────────────────────────────────────────────────────────────
    test('T68: 世界书升格安全防护：私密/现场机密记忆升格显式警示知情范围扩散，并强制二次确认', () => {
        let htmlSnippet = '';
        const listeners = {};
        let toastWarningMsg = '';

        const origToastr = global.window.toastr;
        global.window.toastr = {
            ...origToastr,
            warning: (msg) => { toastWarningMsg = msg; }
        };

        const modalEl = {
            remove: () => { htmlSnippet = ''; },
            querySelector: (sel) => {
                if (sel === '#pm-promote-acl-warning') {
                    return htmlSnippet.includes('id="pm-promote-acl-warning"') ? { id: 'pm-promote-acl-warning' } : null;
                }
                if (sel === '#pm-promote-confirm-acl-escalation') {
                    return mockCheckbox;
                }
                if (sel === '#pm-promote-target-book') return { value: '测试世界书' };
                if (sel === '#pm-promote-entry-name') return { value: '王室密约' };
                if (sel === '#pm-promote-entry-keys') return { value: '密约, 盟誓' };
                if (sel === '#pm-promote-entry-content') return { value: '不可告人的盟约正文' };
                if (sel === '#pm-promote-mark-completed') return { checked: true };
                if (sel === '#pm-promote-modal-confirm') {
                    return {
                        addEventListener: (ev, cb) => { listeners['confirm'] = cb; }
                    };
                }
                return null;
            }
        };

        const mockCheckbox = { checked: false };

        const origDocument = global.document;
        global.document = {
            querySelectorAll: () => [],
            getElementById: (id) => id === 'pm-lore-promote-modal' ? modalEl : null,
            body: {
                insertAdjacentHTML: (pos, html) => {
                    htmlSnippet = html;
                }
            }
        };

        try {
            // 场景 1: 私密记忆 (scope: 'character')
            const privateMem = {
                id: 'mem_priv_1',
                content: '不可告人的盟约正文',
                scope: 'character',
                character: '角色A',
                trigger_keys: ['密约']
            };

            let confirmedPayload = null;
            showPromoteLoreModal(privateMem, '测试世界书', (payload) => {
                confirmedPayload = payload;
            });

            // 验证 HTML 注入了权限变更预警和二次确认复选框
            assert.ok(htmlSnippet.includes('权限范围变更预警'), '受限记忆应显示权限扩散预警');
            assert.ok(htmlSnippet.includes('pm-promote-confirm-acl-escalation'), '受限记忆必须包含二次确认复选框');
            assert.ok(htmlSnippet.includes('角色A'), '预警中应明确标明原始知情角色');

            // 未勾选复选框直接点击确认
            mockCheckbox.checked = false;
            toastWarningMsg = '';
            listeners['confirm']();
            assert.strictEqual(confirmedPayload, null, '未勾选知情范围扩大确认时，严禁触发升格回调');
            assert.ok(toastWarningMsg.includes('授权知情范围扩大'), '应向用户弹出安全阻断警告');

            // 勾选复选框后再次点击确认
            mockCheckbox.checked = true;
            listeners['confirm']();
            assert.ok(confirmedPayload !== null, '勾选确认后应成功触发升格');
            assert.strictEqual(confirmedPayload.entryName, '王室密约');
            assert.strictEqual(confirmedPayload.markCompleted, true);

            // 场景 2: 公共常识记忆 (scope: 'world')
            confirmedPayload = null;
            htmlSnippet = '';
            const worldMem = {
                id: 'mem_world_1',
                content: '太阳从东方升起',
                scope: 'world',
                trigger_keys: ['日出']
            };

            showPromoteLoreModal(worldMem, '测试世界书', (payload) => {
                confirmedPayload = payload;
            });

            assert.ok(!htmlSnippet.includes('pm-promote-acl-warning'), '公共常识记忆无需权限变更预警');
            assert.ok(!htmlSnippet.includes('pm-promote-confirm-acl-escalation'), '公共常识记忆无需二次权限确认');

            // 直接确认
            listeners['confirm']();
            assert.ok(confirmedPayload !== null, '公共常识记忆可直接无阻碍升格');

        } finally {
            global.document = origDocument;
            global.window.toastr = origToastr;
        }
    });

    // ─────────────────────────────────────────────────────────────
    // T69: 世界书升格条目全生命周期溯源追溯 (lorebook_ref 完整记录原始 scope、角色与知情者)
    // ─────────────────────────────────────────────────────────────
    await testAsync('T69: 世界书升格条目全生命周期溯源追溯 (lorebook_ref 完整记录原始 scope、角色与知情者)', async () => {
        const state = getState();
        state.memories = [];

        // 构造角色私有记忆与共享机密记忆
        const privMem = {
            id: 'mem_trace_priv',
            content: '血色十字军密信原稿',
            scope: 'character',
            character: '角色A',
            trigger_keys: ['十字军密信']
        };
        const sharedMem = {
            id: 'mem_trace_shared',
            content: '刺客联盟地下暗道暗号',
            scope: 'shared',
            known_by: ['角色A', '玩家'],
            trigger_keys: ['地下暗号']
        };
        state.memories.push(privMem, sharedMem);

        let savedWorldData = null;
        mockContext.loadWorldInfo = async () => ({ entries: {} });
        mockContext.saveWorldInfo = async (name, data) => {
            savedWorldData = data;
            return true;
        };

        // 1. 升格私有记忆
        const res1 = await promoteMemoryToWorldInfo('mem_trace_priv', { bookName: '艾泽拉斯秘闻' });
        assert.strictEqual(res1.success, true);
        assert.strictEqual(privMem.lorebook_ref.promoted_from_scope, 'character');
        assert.strictEqual(privMem.lorebook_ref.original_character, '角色A');
        assert.strictEqual(privMem.lorebook_ref.book, '艾泽拉斯秘闻');
        // 验证世界书词条 comment 中携带溯源审计信息
        const entry1 = savedWorldData.entries[res1.entryUid];
        assert.ok(entry1.comment.includes('[持续记忆·私密(角色A)]'), '世界书词条必须包含原始私密归属溯源');

        // 2. 升格共享机密记忆
        const res2 = await promoteMemoryToWorldInfo('mem_trace_shared', { bookName: '艾泽拉斯秘闻' });
        assert.strictEqual(res2.success, true);
        assert.strictEqual(sharedMem.lorebook_ref.promoted_from_scope, 'shared');
        assert.deepStrictEqual(sharedMem.lorebook_ref.original_known_by, ['角色A', '玩家']);
        const entry2 = savedWorldData.entries[res2.entryUid];
        assert.ok(entry2.comment.includes('[持续记忆·机密(知情:角色A,玩家)]'), '世界书词条必须包含原始共享知情者溯源');
    });

    // ─────────────────────────────────────────────────────────────
    // T70: 世界书升格边界极端容错 (非数字 UID 过滤、只读内置世界书拦截、缺失内容防御)
    // ─────────────────────────────────────────────────────────────
    await testAsync('T70: 世界书升格边界极端容错 (非数字 UID 过滤、只读内置世界书拦截、缺失内容防御)', async () => {
        const state = getState();
        state.memories = [];

        const testMem = {
            id: 'mem_err_test',
            content: '泰坦符文之语',
            scope: 'world'
        };
        state.memories.push(testMem);

        // 1. 目标世界书中存在脏键 (字符串键、非数字 UID)
        let savedData = null;
        mockContext.loadWorldInfo = async () => ({
            entries: {
                'invalid_str': { uid: 'not_a_number' },
                '15': { uid: 15 },
                'bad_obj': null
            }
        });
        mockContext.saveWorldInfo = async (name, data) => {
            savedData = data;
            return true;
        };

        const resUid = await promoteMemoryToWorldInfo('mem_err_test', { bookName: '泰坦古籍' });
        assert.strictEqual(resUid.success, true);
        assert.strictEqual(resUid.entryUid, 16, '新 UID 应基于数值 UID 最大值 15 递增为 16');

        // 2. 空内容防御
        const resEmpty = await promoteMemoryToWorldInfo('mem_err_test', { bookName: '泰坦古籍', content: '   ' });
        assert.strictEqual(resEmpty.success, false);
        assert.strictEqual(resEmpty.reason, '词条设定正文不能为空');

        // 3. 只读角色内置世界书 (Embedded Character Book) 防御
        const prevCharacters = mockContext.characters;
        const prevMetadata = mockContext.chatMetadata;
        mockContext.chatMetadata = {};
        mockContext.characterId = 0;
        mockContext.characters = [{
            name: '角色A',
            data: {
                character_book: {
                    name: '只读内置设定书',
                    entries: [{ uid: 1, comment: 'test' }]
                }
            }
        }];

        const embedMem = {
            id: 'mem_embed_test',
            content: '内置设定测试条目',
            scope: 'world'
        };
        state.memories.push(embedMem);

        const resEmbed = await promoteMemoryToWorldInfo('mem_embed_test', { bookName: '' });
        assert.strictEqual(resEmbed.success, false);
        assert.ok(resEmbed.reason.includes('角色卡内置设定'), '只读卡片资源应明确拦截并拒绝升格写入');

        // 恢复 mockContext
        mockContext.characters = prevCharacters;
        mockContext.chatMetadata = prevMetadata;
    });

    // ─────────────────────────────────────────────────────────────
    // T71: 全工程版本标识严格一致性核验 (0.1.39)
    // ─────────────────────────────────────────────────────────────
    test('T71: 全工程版本标识严格一致性核验 (manifest, config, index 与各模块头部统一为 0.1.39)', () => {
        const currentFile = fileURLToPath(import.meta.url);
        const rootDir = path.resolve(path.dirname(currentFile), '../');

        // 1. manifest.json
        const manifestPath = path.join(rootDir, 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        assert.strictEqual(manifest.version, '0.1.39', 'manifest.json 版本号应为 0.1.39');

        // 2. src/config.js
        assert.strictEqual(EXTENSION_VERSION, '0.1.39', 'config.js EXTENSION_VERSION 应为 0.1.39');

        // 3. index.js
        const indexPath = path.join(rootDir, 'index.js');
        const indexContent = fs.readFileSync(indexPath, 'utf8');
        assert.ok(indexContent.includes('v0.1.39'), 'index.js 头部必须标注 v0.1.39');
        assert.ok(!indexContent.includes('v0.1.38'), 'index.js 严禁残留旧版本 v0.1.38 版本头');

        // 4. 各核心模块头部注释版本检查 (16 个核心模块)
        const checkModules = [
            'src/acl.js',
            'src/api.js',
            'src/apply.js',
            'src/consolidator.js',
            'src/backlog.js',
            'src/lorebook.js',
            'src/scene.js',
            'src/migration.js',
            'src/state.js',
            'src/extractor.js',
            'src/parser.js',
            'src/schema.js',
            'src/prompt.js',
            'src/injector.js',
            'src/semantic.js',
            'src/ui.js'
        ];

        for (const relPath of checkModules) {
            const filePath = path.join(rootDir, relPath);
            const content = fs.readFileSync(filePath, 'utf8');
            const first10Lines = content.split('\n').slice(0, 10).join('\n');
            assert.ok(
                first10Lines.includes('v0.1.39') || first10Lines.includes('0.1.39'),
                `${relPath} 头部注释必须包含 0.1.39 版本标识`
            );
            assert.ok(
                !first10Lines.includes('0.1.38') && !first10Lines.includes('v0.1.38'),
                `${relPath} 头部注释严禁残留旧版本 0.1.38`
            );
        }
    });

    // ─────────────────────────────────────────────────────────────
    // T72: 统一 ACL 判定层核心功能单元测试 (validateMemoryAcl)
    // ─────────────────────────────────────────────────────────────
    test('T72: 统一 ACL 判定层核心功能单元测试 (validateMemoryAcl Fail-Closed 与权限准入)', () => {
        const participants = new Set(['玩家', '角色A']);

        // 1. 非法 scope 拒绝
        const resInvalidScope = validateMemoryAcl({ scope: 'unknown_scope' }, participants);
        assert.strictEqual(resInvalidScope.allowed, false);
        assert.strictEqual(resInvalidScope.code, 'INVALID_SCOPE');

        // 2. 角色私密记忆缺失归属角色拒绝
        const resMissingChar = validateMemoryAcl({ scope: 'character', character: '' }, participants);
        assert.strictEqual(resMissingChar.allowed, false);
        assert.strictEqual(resMissingChar.code, 'MISSING_CHARACTER');

        // 3. 共享机密记忆缺少知情者拒绝
        const resEmptyKnownBy = validateMemoryAcl({ scope: 'shared', known_by: [] }, participants);
        assert.strictEqual(resEmptyKnownBy.allowed, false);
        assert.strictEqual(resEmptyKnownBy.code, 'EMPTY_KNOWN_BY');

        // 4. 角色私密记忆归属未参战角色拒绝
        const resUnauthChar = validateMemoryAcl({ scope: 'character', character: '无关路人' }, participants);
        assert.strictEqual(resUnauthChar.allowed, false);
        assert.strictEqual(resUnauthChar.code, 'UNAUTHORIZED_CHAR');

        // 5. 共享记忆包含未参战知情者拒绝
        const resUnauthKnown = validateMemoryAcl({ scope: 'shared', known_by: ['角色A', '敌方间谍'] }, participants);
        assert.strictEqual(resUnauthKnown.allowed, false);
        assert.strictEqual(resUnauthKnown.code, 'UNAUTHORIZED_KNOWN_BY');

        // 6. 空名单 Fail-Closed：受限范围记忆全拒绝
        const resEmptyPartPriv = validateMemoryAcl({ scope: 'character', character: '角色A' }, new Set());
        assert.strictEqual(resEmptyPartPriv.allowed, false);
        assert.strictEqual(resEmptyPartPriv.code, 'EMPTY_PARTICIPANTS');

        // 7. 公共记忆在空名单或有效名单下均允许
        const resWorld = validateMemoryAcl({ scope: 'world' }, new Set());
        assert.strictEqual(resWorld.allowed, true);
        assert.strictEqual(resWorld.code, 'OK');

        // 8. 规范化收敛：带有角色的 world 记忆自动收敛为 character，避免越权逃逸
        const resWorldWithChar = validateMemoryAcl({ scope: 'world', character: '角色A' }, participants);
        assert.strictEqual(resWorldWithChar.allowed, true);
        assert.strictEqual(resWorldWithChar.normalizedScope, MEMORY_SCOPE.CHARACTER);
    });

    // ─────────────────────────────────────────────────────────────
    // T73: 统一数据准入规范化流水线测试 (normalizeAndValidateMemory)
    // ─────────────────────────────────────────────────────────────
    test('T73: 统一数据准入规范化流水线测试 (normalizeAndValidateMemory 数据净化与强类型)', () => {
        const participants = new Set(['玩家', '角色A']);

        // 1. 空内容或非对象拦截
        assert.strictEqual(normalizeAndValidateMemory(null).valid, false);
        assert.strictEqual(normalizeAndValidateMemory({ content: '' }).valid, false);
        assert.strictEqual(normalizeAndValidateMemory({ content: '   ' }).valid, false);

        // 2. 超长内容安全截断 (默认 150 字符)
        const longText = 'A'.repeat(200);
        const resLong = normalizeAndValidateMemory({ content: longText, scope: 'world' }, { participants });
        assert.strictEqual(resLong.valid, true);
        assert.strictEqual(resLong.memory.content.length, 150);

        // 3. 非法类型强拦截 (Fail-Closed: 严禁自动降级为 fact)
        const resBadType = normalizeAndValidateMemory({ content: '测试正文', type: 'hacked_type' }, { participants });
        assert.strictEqual(resBadType.valid, false);
        assert.ok(resBadType.reason.includes('非法'));

        // 4. trigger_keys 清洗规范化
        const resKeys = normalizeAndValidateMemory({
            content: '触发词清洗测试',
            scope: 'world',
            trigger_keys: ['  钥匙A  ', '钥匙A', '', 123, null, '钥匙B']
        }, { participants });
        assert.strictEqual(resKeys.valid, true);
        assert.deepStrictEqual(resKeys.memory.trigger_keys, ['钥匙A', '钥匙B']);

        // 5. 权限不合规时返回 aclRejected 标志
        const resAclFail = normalizeAndValidateMemory({
            content: '角色C的秘密',
            scope: 'character',
            character: '角色C'
        }, { participants });
        assert.strictEqual(resAclFail.valid, false);
        assert.strictEqual(resAclFail.aclRejected, true);
    });

    // ─────────────────────────────────────────────────────────────
    // T74: 数据来源与可信度解耦测试 (AI提炼/备份导入/手工录入一致性门禁)
    // ─────────────────────────────────────────────────────────────
    test('T74: 数据来源与可信度解耦测试 (提炼、导入、录入三端遵循完全同一 ACL 判定边界)', () => {
        const state = getState();
        state.memories = [];
        // 当前单聊环境：仅 玩家 与 角色A 具有权限
        const maliciousItem = {
            id: 'mem_malicious_source',
            type: 'fact',
            content: '来自未参战角色B的私密日记',
            scope: 'character',
            character: '角色B'
        };

        // 入口 1: AI 提炼入口 (validateExtractedPayload)
        const digestPayload = {
            new_memories: [maliciousItem]
        };
        const digestResult = validateExtractedPayload(digestPayload, state.memories);
        assert.strictEqual(digestResult.new_memories.length, 0, 'AI 提炼入口必须拦截未参战角色的私密记忆');

        // 入口 2: 备份导入入口 (importMemoryData - merge 模式)
        const importResult = importMemoryData({
            version: '0.1.28',
            memories: [maliciousItem]
        }, 'merge');
        assert.strictEqual(importResult.imported, 0, '备份导入入口必须拒绝未参战角色的私密记忆');
        assert.strictEqual(importResult.aclRejected, 1, '备份导入入口记录 1 条 ACL 拦截');
        assert.strictEqual(state.memories.length, 0);

        // 入口 3: 手工/状态写入入口 (addMemory)
        const addResult = addMemory(maliciousItem);
        assert.strictEqual(addResult, null, 'addMemory 必须拦截未参战角色的私密记忆');
        assert.strictEqual(state.memories.length, 0, '三端入口均不可突破一致性 ACL 门禁');
    });

    // ─────────────────────────────────────────────────────────────
    // T75: checkAclEscalation 越权提权防线与继承性测试
    // ─────────────────────────────────────────────────────────────
    test('T75: checkAclEscalation 越权提权防线与继承性测试', () => {
        // 场景 1: character 私密试图提升为 world 公共
        const privMem = { id: 'mem_priv_1', scope: 'character', character: '角色A', known_by: ['角色A'] };
        const escWorld = checkAclEscalation(privMem, { scope: 'world' });
        assert.strictEqual(escWorld.violated, true);
        assert.strictEqual(escWorld.inheritedAcl.scope, MEMORY_SCOPE.CHARACTER);
        assert.strictEqual(escWorld.inheritedAcl.character, '角色A');

        // 场景 2: shared 共享试图扩大知情者范围
        const sharedMem = { id: 'mem_sh_1', scope: 'shared', known_by: ['角色A'] };
        const escKnown = checkAclEscalation(sharedMem, { scope: 'shared', known_by: ['角色A', '角色B'] });
        assert.strictEqual(escKnown.violated, true);
        assert.deepStrictEqual(escKnown.inheritedAcl.known_by, ['角色A']);

        // 场景 3: character 私密试图转移给其他角色
        const escCharTransfer = checkAclEscalation(privMem, { scope: 'character', character: '角色B' });
        assert.strictEqual(escCharTransfer.violated, true);
        assert.strictEqual(escCharTransfer.inheritedAcl.character, '角色A');

        // 场景 4: world 公共收敛为 character 私密（权限收紧，不构成越权提权）
        const worldMem = { id: 'mem_w_1', scope: 'world' };
        const tightenScope = checkAclEscalation(worldMem, { scope: 'character', character: '角色A' });
        assert.strictEqual(tightenScope.violated, false);
    });

    // ─────────────────────────────────────────────────────────────
    // T76: 统一安全审计日志环形缓冲区测试 (recordAclAudit & state.acl_audit_log)
    // ─────────────────────────────────────────────────────────────
    await testAsync('T76: 统一安全审计日志环形缓冲区测试 (recordAclAudit 容量保护与事件留痕)', async () => {
        const state = getState();
        state.memories = [];
        state.acl_audit_log = [];

        // 1. 模拟写入普通审计事件
        recordAclAudit(state, 'test_event', { detail: '测试审计' });
        assert.strictEqual(state.acl_audit_log.length, 1);
        assert.strictEqual(state.acl_audit_log[0].action, 'test_event');
        assert.ok(state.acl_audit_log[0].timestamp);

        // 2. 模拟世界书升格操作，触发 promote_world_info 审计留痕
        const testMem = {
            id: 'mem_audit_promo',
            content: '血色要塞防守图纸',
            scope: 'character',
            character: '角色A',
            known_by: ['角色A']
        };
        state.memories.push(testMem);

        mockContext.saveWorldInfo = async () => true;
        mockContext.loadWorldInfo = async () => ({ entries: {} });

        await promoteMemoryToWorldInfo('mem_audit_promo', { bookName: '测试设定集' });
        const promoAudit = state.acl_audit_log.find(a => a.action === 'promote_world_info');
        assert.ok(promoAudit, '世界书升格操作必须在 acl_audit_log 中记录审计');
        assert.strictEqual(promoAudit.details.fromScope, 'character');
        assert.strictEqual(promoAudit.details.character, '角色A');

        // 3. 环形缓冲区上限保护 (30 条硬上限)
        for (let i = 0; i < 40; i++) {
            recordAclAudit(state, 'flood_test', { i });
        }
        assert.strictEqual(state.acl_audit_log.length, 30, '审计日志必须维持在 30 条环形缓冲区硬上限内');
        assert.strictEqual(state.acl_audit_log[29].details.i, 39, '最新审计记录应始终位于缓冲区末尾');
    });

    // ─────────────────────────────────────────────────────────────
    // T77: 状态机与持久化契约验证 (ACL 变更后的状态修订与快照一致性)
    // ─────────────────────────────────────────────────────────────
    test('T77: 状态机与持久化契约验证 (ACL 变更后的状态修订与快照一致性)', () => {
        const state = getState();
        state.memories = [];
        const initialRevision = Number(state.state_revision) || 0;

        // 1. 正常入库：state_revision 自增且数据字段规范完备
        const added = addMemory({
            content: '角色A在城南采药',
            type: 'fact',
            scope: 'character',
            character: '角色A'
        });
        assert.ok(added);
        assert.strictEqual(state.state_revision, initialRevision + 1, '有效记忆入库后 state_revision 必须递增');
        assert.strictEqual(added.character, '角色A');
        assert.deepStrictEqual(added.known_by, ['角色A']);
        assert.ok(added.created_at);
        assert.ok(added.updated_at);
        assert.strictEqual(state.memories.length, 1);

        // 2. 准入拦截：违规数据绝不修改 revision，且不污染 memories 数组
        const revBefore = state.state_revision;
        const rejected = addMemory({
            content: '非法第三者角色秘密',
            type: 'fact',
            scope: 'character',
            character: '未参战角色X'
        });
        assert.strictEqual(rejected, null, 'ACL 准入拦截条目应返回 null');
        assert.strictEqual(state.state_revision, revBefore, '拦截未入库条目绝不得递增 state_revision');
        assert.strictEqual(state.memories.length, 1, '拦截条目绝不得残留在 state.memories');
    });

    // ─────────────────────────────────────────────────────────────
    // T78: 准出端 POV 访问控制单元测试 (canRecipientAccessMemory)
    // ─────────────────────────────────────────────────────────────
    test('T78: 准出端 POV 访问控制单元测试 (canRecipientAccessMemory 权限判定、在场核验与保密提示)', () => {
        const inScene = ['角色A', '角色B', '玩家'];

        // 1. world 公共记忆：任何主体或未知主体均放行
        const worldMem = { scope: 'world', content: '天下大势' };
        assert.strictEqual(canRecipientAccessMemory(worldMem, '角色A', inScene).allowed, true);
        assert.strictEqual(canRecipientAccessMemory(worldMem, null, inScene).allowed, true);

        // 2. Fail-Closed: 生成主体未知时拒绝私密与共享记忆
        const privMem = { scope: 'character', character: '角色A', content: '角色A日记' };
        const sharedMem = { scope: 'shared', known_by: ['角色A'], content: '地下密道' };
        assert.strictEqual(canRecipientAccessMemory(privMem, null, inScene).allowed, false);
        assert.strictEqual(canRecipientAccessMemory(sharedMem, null, inScene).allowed, false);

        // 3. character 私密：仅归属者本人作为 POV 且在场时放行
        assert.strictEqual(canRecipientAccessMemory(privMem, '角色A', inScene).allowed, true);
        const wrongCharRes = canRecipientAccessMemory(privMem, '角色B', inScene);
        assert.strictEqual(wrongCharRes.allowed, false);
        assert.ok(wrongCharRes.reason.includes('不匹配'));

        // 4. character 私密：归属角色不在物理现场时拒绝 (物理在场核验)
        const absentRes = canRecipientAccessMemory(privMem, '角色A', ['角色B', '玩家']);
        assert.strictEqual(absentRes.allowed, false);
        assert.ok(absentRes.reason.includes('不在物理现场名单中'));

        // 5. shared 共享：知情者在场放行，并向现场其他不知情角色计算保密提示
        const resSharedWithOutsiders = canRecipientAccessMemory(
            sharedMem,
            '角色A',
            inScene,
            { userName: '玩家' }
        );
        assert.strictEqual(resSharedWithOutsiders.allowed, true);
        assert.ok(resSharedWithOutsiders.extraWarning.includes('角色B'));
        assert.ok(resSharedWithOutsiders.extraWarning.includes('切勿透露此秘密'));

        // 6. shared 共享：不知情者作为 POV 生成时坚决拦截
        const resUnaware = canRecipientAccessMemory(sharedMem, '角色B', inScene);
        assert.strictEqual(resUnaware.allowed, false);
        assert.ok(resUnaware.reason.includes('不在知情者列表'));
    });

    // ─────────────────────────────────────────────────────────────
    // T79: 提示词注入引擎准出权限统一收敛核验 (buildAndInjectMemoryPrompt 协同)
    // ─────────────────────────────────────────────────────────────
    test('T79: 提示词注入引擎准出权限统一收敛核验 (buildAndInjectMemoryPrompt 协同路由与保密加固)', () => {
        const state = getState();
        state.memories = [];
        state.scene = {
            location: '清风寨',
            in_scene_characters: ['角色A', '角色B', '玩家']
        };

        // 录入测试记忆
        state.memories.push({
            id: 'mem_priv_a',
            content: '角色A私藏了先王玉玺',
            type: 'fact',
            scope: 'character',
            character: '角色A',
            status: 'triggered',
            lifecycle: 'active'
        });
        state.memories.push({
            id: 'mem_shared_ab',
            content: '角色A和角色B密谋起兵',
            type: 'fact',
            scope: 'shared',
            known_by: ['角色A', '角色B'],
            status: 'triggered',
            lifecycle: 'active'
        });
        state.memories.push({
            id: 'mem_world_all',
            content: '今年北方大旱粮荒',
            type: 'fact',
            scope: 'world',
            status: 'triggered',
            lifecycle: 'active'
        });

        // 场景 1: 当前生成主体为 角色A
        mockContext.characterId = 0;
        mockContext.name2 = '角色A';
        buildAndInjectMemoryPrompt();
        const injectedA = mockContext._injectedPrompt;
        assert.ok(injectedA.includes('角色A私藏了先王玉玺'), '角色A自身生成时应注入私密记忆');
        assert.ok(injectedA.includes('角色A和角色B密谋起兵'), '角色A作为知情者应注入共享秘密');
        assert.ok(injectedA.includes('今年北方大旱粮荒'), '公共记忆始终注入');

        // 场景 2: 当前生成主体切换为 角色B
        mockContext.characterId = 1;
        mockContext.name2 = '角色B';
        buildAndInjectMemoryPrompt();
        const injectedB = mockContext._injectedPrompt;
        assert.ok(!injectedB.includes('角色A私藏了先王玉玺'), '角色B生成时绝不得注入角色A的私密记忆');
        assert.ok(injectedB.includes('角色A和角色B密谋起兵'), '角色B作为知情者应注入共享秘密');
        assert.ok(injectedB.includes('今年北方大旱粮荒'), '公共记忆始终注入');

        // 场景 3: 恢复单聊 context
        mockContext.characterId = 0;
        mockContext.name2 = '角色A';
    });

    // ─────────────────────────────────────────────────────────────
    // T80: 访问控制层双向对称性契约验证 (Ingress 准入与 Egress 准出权限边界严格等价)
    // ─────────────────────────────────────────────────────────────
    test('T80: 访问控制层双向对称性契约验证 (Ingress 准入与 Egress 准出权限边界严格等价)', () => {
        // 构造一个由未参战角色持有的恶意记忆
        const rogueMem = {
            id: 'mem_rogue_shadow',
            content: '深渊刺客的密令',
            type: 'fact',
            scope: 'character',
            character: '刺客X',
            status: 'triggered',
            lifecycle: 'active'
        };

        const participants = new Set(['玩家', '角色A']);

        // 1. 准入验证 (Ingress): validateMemoryAcl 坚决拦截
        const ingressCheck = validateMemoryAcl(rogueMem, participants);
        assert.strictEqual(ingressCheck.allowed, false, '准入端必须拒绝未参战角色的私密记忆');
        assert.strictEqual(ingressCheck.code, 'UNAUTHORIZED_CHAR');

        // 2. 准出验证 (Egress): canRecipientAccessMemory 坚决拦截
        // 假设该数据被异常手段绕过写入内存，当角色A生成时
        const egressCheckA = canRecipientAccessMemory(rogueMem, '角色A', ['角色A', '玩家']);
        assert.strictEqual(egressCheckA.allowed, false, '准出端绝对禁止向无关角色注入未授权记忆');

        // 当刺客X生成时，因其不在现场或参与者名单中
        const egressCheckX = canRecipientAccessMemory(rogueMem, '刺客X', ['角色A', '玩家']);
        assert.strictEqual(egressCheckX.allowed, false, '准出端核验在场物理名单拦截刺客X');
    });

    // ─────────────────────────────────────────────────────────────
    // T81: API 端点规范化与超时/主动中止控制器单元测试 (src/api.js)
    // ─────────────────────────────────────────────────────────────
    await testAsync('T81: API 端点规范化与超时/主动中止控制器单元测试 (normalizeChatCompletionsUrl & withTimeout)', async () => {
        // 1. 端点 URL 规范化
        assert.strictEqual(normalizeChatCompletionsUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
        assert.strictEqual(normalizeChatCompletionsUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1/chat/completions');
        assert.strictEqual(normalizeChatCompletionsUrl('https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1/chat/completions');
        assert.strictEqual(normalizeChatCompletionsUrl('http://localhost:11434/v1/'), 'http://localhost:11434/v1/chat/completions');
        assert.strictEqual(normalizeChatCompletionsUrl(''), '');
        assert.strictEqual(normalizeChatCompletionsUrl(null), '');

        // 2. withTimeout 即时中止信号拦截
        const preAborted = new AbortController();
        preAborted.abort();
        await assert.rejects(
            withTimeout(() => Promise.resolve('ok'), 5000, '预先中止任务', preAborted.signal),
            /已被中止取消/
        );

        // 3. withTimeout 运行时信号主动中断
        const liveAbort = new AbortController();
        const slowPromise = () => new Promise((_, reject) => {
            setTimeout(() => liveAbort.abort(), 10);
        });

        await assert.rejects(
            withTimeout(slowPromise, 5000, '运行时中止任务', liveAbort.signal),
            /已被用户手动中止取消/
        );
    });

    // ─────────────────────────────────────────────────────────────
    // T82: 提炼网络请求分级降级调度流水线测试 (executeDigestRequest)
    // ─────────────────────────────────────────────────────────────
    await testAsync('T82: 提炼网络请求分级降级调度流水线测试 (原生 generateRaw / generateQuietPrompt 降级)', async () => {
        // 场景 1: 原生 generateRaw 存在，优先以单轮纯净 Prompt 调用
        let rawCalledWith = null;
        const mockRawContext = {
            generateRaw: async (args) => {
                rawCalledWith = args;
                return '{"scene": null, "new_memories": []}';
            }
        };

        const resRaw = await executeDigestRequest(mockRawContext, 'TEST_PROMPT_1', { useCustomApi: false });
        assert.strictEqual(resRaw, '{"scene": null, "new_memories": []}');
        assert.strictEqual(rawCalledWith.prompt, 'TEST_PROMPT_1');
        assert.strictEqual(rawCalledWith.responseLength, 2048, '必须显式指定 2048 输出上限');

        // 场景 2: generateRaw 缺失，平滑降级至 generateQuietPrompt 并剔除 reasoning
        let quietCalledWith = null;
        const mockQuietContext = {
            generateQuietPrompt: async (args) => {
                quietCalledWith = args;
                return '{"scene": null, "new_memories": []}';
            }
        };

        const resQuiet = await executeDigestRequest(mockQuietContext, 'TEST_PROMPT_2', { useCustomApi: false });
        assert.strictEqual(resQuiet, '{"scene": null, "new_memories": []}');
        assert.strictEqual(quietCalledWith.quietPrompt, 'TEST_PROMPT_2');
        assert.strictEqual(quietCalledWith.removeReasoning, true, '必须显式要求剥离思维链防格式错乱');

        // 场景 3: 外部中止信号预先触发时快速熔断拒绝
        const abortCtrl = new AbortController();
        abortCtrl.abort();
        await assert.rejects(
            executeDigestRequest(mockRawContext, 'TEST_PROMPT_3', { useCustomApi: false }, abortCtrl.signal),
            /提炼请求已被主动中止/
        );

        // 场景 4: 无可用接口时友好抛错
        await assert.rejects(
            executeDigestRequest({}, 'TEST_PROMPT_4', { useCustomApi: false }),
            /未发现可用的文本生成接口/
        );
    });

    // ─────────────────────────────────────────────────────────────
    // T83: 独立 API 连通性探测接口测试 (testCustomApiConnection & 错误隔离)
    // ─────────────────────────────────────────────────────────────
    await testAsync('T83: 独立 API 连通性探测接口测试 (testCustomApiConnection 缺少配置提示与错误自愈)', async () => {
        // 1. 缺少 URL 时的友好提示
        const resEmpty = await testCustomApiConnection({ customApiUrl: '' });
        assert.strictEqual(resEmpty.success, false);
        assert.ok(resEmpty.error.includes('请先填写 Base URL'));

        // 2. 模拟网络异常时的优雅捕获 (绝不引起未捕获崩溃)
        const resNetworkErr = await testCustomApiConnection({
            customApiUrl: 'http://127.0.0.1:99999/invalid_port',
            customApiKey: 'dummy_key'
        });
        assert.strictEqual(resNetworkErr.success, false);
        assert.ok(resNetworkErr.error);
    });

    // ─────────────────────────────────────────────────────────────
    // T84: 记忆归并子系统单元测试 (src/consolidator.js 独立性与边界控制)
    // ─────────────────────────────────────────────────────────────
    test('T84: 记忆归并引擎 (src/consolidator.js) 分组隔离与 Schema/ACL 严格校验', () => {
        // 1. buildConsolidationCandidateGroups 独立性核验
        const testMems = [
            { id: 'm1', content: '公共常识A', scope: MEMORY_SCOPE.WORLD, lifecycle: MEMORY_LIFECYCLE.ACTIVE, status: MEMORY_STATUS.TRIGGERED },
            { id: 'm2', content: '公共常识B', scope: MEMORY_SCOPE.WORLD, lifecycle: MEMORY_LIFECYCLE.ACTIVE, status: MEMORY_STATUS.TRIGGERED },
            { id: 'm3', content: '角色私密A', scope: MEMORY_SCOPE.CHARACTER, character: '角色A', lifecycle: MEMORY_LIFECYCLE.ACTIVE, status: MEMORY_STATUS.TRIGGERED },
            { id: 'm4', content: '角色私密B', scope: MEMORY_SCOPE.CHARACTER, character: '角色A', lifecycle: MEMORY_LIFECYCLE.ACTIVE, status: MEMORY_STATUS.TRIGGERED },
            { id: 'm5_inactive', content: '已结项条目', scope: MEMORY_SCOPE.WORLD, lifecycle: MEMORY_LIFECYCLE.COMPLETED, status: MEMORY_STATUS.TRIGGERED },
            { id: 'm6_pinned', content: '常驻条目', scope: MEMORY_SCOPE.WORLD, lifecycle: MEMORY_LIFECYCLE.ACTIVE, status: MEMORY_STATUS.PINNED }
        ];

        const groups = consolidatorBuildGroups(testMems);
        assert.strictEqual(groups.length, 2, '应精准构建 2 个同权限分组 (world 与 character:角色A)');
        assert.strictEqual(groups[0].items.length, 2);
        assert.strictEqual(groups[1].items.length, 2);

        // 验证非 active 或常驻条目被完全剔除
        const allCandidateIds = groups.flatMap(g => g.items.map(i => i.id));
        assert.ok(!allCandidateIds.includes('m5_inactive'), '已结项条目严禁进入归并候选');
        assert.ok(!allCandidateIds.includes('m6_pinned'), '常驻条目严禁进入归并候选');

        // 2. validateConsolidatedPayload 拦截跨组拼凑与越权提权
        const participants = new Set(['角色A']);
        const crossGroupPayload = {
            consolidated: [
                {
                    content: '跨越分组拼凑的非法事实',
                    type: 'fact',
                    scope: 'world',
                    supersedes: ['m1', 'm3'] // m1 为 world, m3 为 character:角色A
                }
            ]
        };
        const valCross = consolidatorValidatePayload(crossGroupPayload, testMems, participants);
        assert.strictEqual(valCross, null, '跨越不同知情范围/角色的归并必须被拒绝');

        // 3. 正常同组归并产出结构校验
        const validPayload = {
            consolidated: [
                {
                    content: '角色A的整合长期记忆',
                    type: 'fact',
                    scope: 'character',
                    character: '角色A',
                    supersedes: ['m3', 'm4']
                }
            ]
        };
        const valGood = consolidatorValidatePayload(validPayload, testMems, participants);
        assert.ok(valGood && valGood.consolidated.length === 1);
        assert.strictEqual(valGood.consolidated[0].character, '角色A');
        assert.strictEqual(valGood.consolidated[0].scope, 'character');

        // 4. 运行状态查询
        assert.strictEqual(isMemoryConsolidationRunning(), false);
    });

    // ─────────────────────────────────────────────────────────────
    // T85: 全量历史回溯管道单元测试 (src/backlog.js 轮次定位与任务控制器)
    // ─────────────────────────────────────────────────────────────
    test('T85: 历史回溯管道 (src/backlog.js) 轮次定位与中止控制器单元测试', () => {
        // 1. findMessageIndexByTurn 轮次定位
        const mockChat = [
            { is_user: true, mes: 'U1' },   // 0
            { is_user: false, mes: 'A1' },  // 1 (第1轮AI回复)
            { is_user: true, mes: 'U2' },   // 2
            { is_user: false, mes: 'A2' },  // 3 (第2轮AI回复)
            { is_user: true, mes: 'U3' },   // 4
            { is_user: false, mes: 'A3' }   // 5 (第3轮AI回复)
        ];

        assert.strictEqual(backlogFindTurn(mockChat, 0), 0);
        assert.strictEqual(backlogFindTurn(mockChat, -1), 0);
        assert.strictEqual(backlogFindTurn([], 1), 0);
        assert.strictEqual(backlogFindTurn(mockChat, 1), 2, '第1轮结束后的下一条消息索引应为 2');
        assert.strictEqual(backlogFindTurn(mockChat, 2), 4, '第2轮结束后的下一条消息索引应为 4');
        assert.strictEqual(backlogFindTurn(mockChat, 3), 6, '第3轮结束后的下一条消息索引应为 6');
        assert.strictEqual(backlogFindTurn(mockChat, 99), 0, '超出轮次范围安全返回 0');

        // 2. abortBacklogDigest 与 isBacklogDigestRunning 控制器状态
        assert.strictEqual(backlogIsRunning(), false, '初始状态应为 false');
        backlogAbort(); // 空任务调用不崩溃
        assert.strictEqual(backlogIsRunning(), false, '调用 abort 后状态仍为 false');
    });

    // ─────────────────────────────────────────────────────────────
    // T86: 提炼引擎分层与子系统跨模块协同测试
    // ─────────────────────────────────────────────────────────────
    test('T86: 提炼引擎分层与子系统跨模块协同测试 (src/extractor.js 导入导出与数据适配)', () => {
        // 1. 验证 extractor 统一导出的函数与各独立子系统物理一致 (透明解耦契约)
        assert.strictEqual(buildConsolidationCandidateGroups, consolidatorBuildGroups, '归并候选分组方法必须同源');
        assert.strictEqual(validateConsolidatedPayload, consolidatorValidatePayload, '归并校验方法必须同源');
        assert.strictEqual(triggerMemoryConsolidation, consolidatorTrigger, '归并触发方法必须同源');
        assert.strictEqual(findMessageIndexByTurn, backlogFindTurn, '轮次定位方法必须同源');
        assert.strictEqual(abortBacklogDigest, backlogAbort, '回溯中止方法必须同源');
        assert.strictEqual(isBacklogDigestRunning, backlogIsRunning, '回溯状态查询方法必须同源');
        assert.strictEqual(triggerBacklogDigest, backlogTrigger, '回溯触发方法必须同源');

        // 2. 验证 extractor 导出的通用工具方法
        assert.strictEqual(typeof sanitizeTriggerKeys, 'function', 'sanitizeTriggerKeys 必须成功导出');
        const cleanedKeys = sanitizeTriggerKeys(['你', '这个', '合法触发词', '超长触发词超过十五个字符的话会被安全过滤掉']);
        assert.deepStrictEqual(cleanedKeys, ['合法触发词'], '停用词与超长词应被正确过滤');

        assert.strictEqual(typeof applyExtractedData, 'function', 'applyExtractedData 必须成功导出');
        const emptySummary = applyExtractedData(null);
        assert.strictEqual(emptySummary, '无有效更新');
    });

    // ─────────────────────────────────────────────────────────────
    // T87: 世界书数据结构安全与规范化单元测试 (src/lorebook.js sanitizeLorebookRef)
    // ─────────────────────────────────────────────────────────────
    test('T87: 世界书数据结构安全与规范化单元测试 (src/lorebook.js sanitizeLorebookRef 原型防御与溯源解析)', () => {
        // 1. 非法输入与空输入安全回退
        assert.strictEqual(lbSanitizeRef(null), null);
        assert.strictEqual(lbSanitizeRef(undefined), null);
        assert.strictEqual(lbSanitizeRef('string'), null);
        assert.strictEqual(lbSanitizeRef(123), null);
        assert.strictEqual(lbSanitizeRef({}), null, '无 entry_name 且无 entry_uid 时应返回 null');

        // 2. 字段规范化与限长截断
        const longName = 'A'.repeat(120);
        const refNorm = lbSanitizeRef({
            entry_name: longName,
            entry_uid: '105',
            book: '测试世界书.json',
            file_name: '测试世界书.json'
        });
        assert.ok(refNorm);
        assert.strictEqual(refNorm.entry_name.length, 80, 'entry_name 应被截断为 80 字符');
        assert.strictEqual(refNorm.entry_uid, 105, 'entry_uid 字符串应转换为数值');
        assert.strictEqual(refNorm.book, '测试世界书.json');
        assert.strictEqual(refNorm.file_name, '测试世界书.json');

        // 3. 原型污染防御与非法字段剥离
        const maliciousObj = JSON.parse('{"entry_name":"安全词条","__proto__":{"polluted":true},"extra_junk":"foo"}');
        const cleanedRef = lbSanitizeRef(maliciousObj);
        assert.strictEqual(cleanedRef.entry_name, '安全词条');
        assert.strictEqual(Object.prototype.polluted, undefined, '原型链严禁被污染');
        assert.strictEqual(cleanedRef.extra_junk, undefined, '未定义字段应被剥离');

        // 4. 升格溯源元数据结构提取
        const provenanceObj = {
            entry_name: '神圣护符',
            entry_uid: 88,
            promoted_from_scope: 'shared',
            original_character: '角色A',
            original_known_by: ['角色A', '角色B', '', null, 123]
        };
        const provRes = lbSanitizeRef(provenanceObj);
        assert.strictEqual(provRes.promoted_from_scope, 'shared');
        assert.strictEqual(provRes.original_character, '角色A');
        assert.deepStrictEqual(provRes.original_known_by, ['角色A', '角色B'], '知情者列表应清洗并过滤非字符串');
    });

    // ─────────────────────────────────────────────────────────────
    // T88: 动态记忆差量写回与升格边界测试 (src/lorebook.js)
    // ─────────────────────────────────────────────────────────────
    await testAsync('T88: 动态记忆差量写回与升格边界单元测试 (syncMemoryDeltaToWorldInfo & promoteMemoryToWorldInfo)', async () => {
        // 1. syncMemoryDeltaToWorldInfo 边界异常测试
        const resNonExist = await lbSyncDelta('non_existent_id');
        assert.strictEqual(resNonExist.success, false);
        assert.strictEqual(resNonExist.reason, '指定的记忆条目不存在');

        // 2. 无关联条目时的防御
        mockContext.chatMetadata = {
            [MODULE_NAME]: {
                version: 3,
                memories: [{ id: 'mem_no_lb', content: '未绑定世界书的普通记忆', scope: MEMORY_SCOPE.WORLD }]
            }
        };
        loadCurrentState();
        const resUnlinked = await lbSyncDelta('mem_no_lb');
        assert.strictEqual(resUnlinked.success, false);
        assert.strictEqual(resUnlinked.reason, '该记忆未关联任何世界书条目');

        // 3. promoteMemoryToWorldInfo 不存在记忆边界
        const resPromoNonExist = await lbPromote('non_existent_id_2');
        assert.strictEqual(resPromoNonExist.success, false);
        assert.strictEqual(resPromoNonExist.reason, '指定的记忆条目不存在');
    });

    // ─────────────────────────────────────────────────────────────
    // T89: 世界书独立服务解耦与跨层重导出协同测试
    // ─────────────────────────────────────────────────────────────
    test('T89: 世界书独立服务解耦与跨层重导出协同测试 (src/lorebook.js ↔ src/state.js 同源性契约)', () => {
        // 1. 验证 state.js 重导出的世界书方法与 lorebook.js 物理同源
        assert.strictEqual(sanitizeLorebookRef, lbSanitizeRef, 'sanitizeLorebookRef 重导出必须物理同源');
        assert.strictEqual(getActiveWorldBookInfo, lbGetActiveInfo, 'getActiveWorldBookInfo 重导出必须物理同源');
        assert.strictEqual(syncMemoryDeltaToWorldInfo, lbSyncDelta, 'syncMemoryDeltaToWorldInfo 重导出必须物理同源');
        assert.strictEqual(promoteMemoryToWorldInfo, lbPromote, 'promoteMemoryToWorldInfo 重导出必须物理同源');

        // 2. 验证 state 核心方法依旧稳定独立且不受世界书模块解耦影响
        assert.strictEqual(typeof getState, 'function');
        assert.strictEqual(typeof batchUpdate, 'function');
        assert.strictEqual(typeof addMemory, 'function');
        assert.strictEqual(typeof updateScene, 'function');
        assert.strictEqual(typeof loadCurrentState, 'function');
    });

    // ─────────────────────────────────────────────────────────────
    // T90: 场景状态管理解耦与同源重导出一致性测试
    // ─────────────────────────────────────────────────────────────
    test('T90: 场景状态管理解耦与同源重导出一致性测试 (src/scene.js ↔ src/state.js 同源性契约)', () => {
        // 1. 验证 state.js 重导出的场景时光机方法与 scene.js 物理同源
        assert.strictEqual(pushSceneSnapshot, scnPushSnapshot, 'pushSceneSnapshot 重导出必须物理同源');
        assert.strictEqual(rollbackScene, scnRollback, 'rollbackScene 重导出必须物理同源');
        assert.strictEqual(restoreSceneSnapshot, scnRestoreSnapshot, 'restoreSceneSnapshot 重导出必须物理同源');
        assert.strictEqual(getSceneHistory, scnGetHistory, 'getSceneHistory 重导出必须物理同源');
        assert.strictEqual(updateScene, scnUpdateScene, 'updateScene 重导出必须物理同源');

        // 2. 验证三态 PATCH 语义
        mockContext.chatMetadata = { [MODULE_NAME]: { version: 3, scene: { location: '神策军大营', time: '黄昏', action: '点兵' } } };
        loadCurrentState();

        // 继承 (undefined): 保持原有 location
        scnUpdateScene({ time: '夜半' });
        let s = getState();
        assert.strictEqual(s.scene.location, '神策军大营', '未提供字段严格继承旧值');
        assert.strictEqual(s.scene.time, '夜半', '有效字符串覆盖旧值');

        // 显式清空 (null 或 ""):
        scnUpdateScene({ action: null });
        s = getState();
        assert.strictEqual(s.scene.action, '', 'null 显式清空 action');

        // 防污染：非字符串对象被拒绝
        scnUpdateScene({ location: { invalid: 'object' } });
        s = getState();
        assert.strictEqual(s.scene.location, '神策军大营', '非字符串对象拒绝覆盖');
    });

    // ─────────────────────────────────────────────────────────────
    // T91: 现场快照时光机栈保护与容量上限淘汰测试
    // ─────────────────────────────────────────────────────────────
    test('T91: 现场快照时光机栈保护与容量上限淘汰测试 (防空对象、防重复入栈、10次容量上限)', () => {
        const s = {
            scene: { location: '', time: '', action: '', tension: '', unresolved: '', in_scene_characters: [] },
            scene_history: []
        };

        // 1. 空内容快照拒绝入栈
        scnPushSnapshot(s, '空内容测试');
        assert.strictEqual(s.scene_history.length, 0, '空内容快照严禁入栈');

        // 2. 有效快照入栈
        s.scene.location = '长安朱雀门';
        scnPushSnapshot(s, '第一次真实变更');
        assert.strictEqual(s.scene_history.length, 1);
        assert.strictEqual(s.scene_history[0].scene.location, '长安朱雀门');

        // 3. 连续相同内容拒绝重复入栈
        scnPushSnapshot(s, '重复变更');
        assert.strictEqual(s.scene_history.length, 1, '连续完全相同快照拒绝重复入栈');

        // 4. 容量上限测试 (最多保留 10 次，FIFO 淘汰)
        for (let i = 2; i <= 15; i++) {
            s.scene.location = `地点_${i}`;
            scnPushSnapshot(s, `变更_${i}`);
        }
        assert.strictEqual(s.scene_history.length, 10, '时光机栈深严格限制为 10');
        assert.strictEqual(s.scene_history[s.scene_history.length - 1].scene.location, '地点_15', '栈顶为最新快照');
        assert.strictEqual(s.scene_history[0].scene.location, '地点_6', '最老快照已被淘汰为地点_6');
    });

    // ─────────────────────────────────────────────────────────────
    // T92: 现场回滚 (rollbackScene) 与快照恢复 (restoreSceneSnapshot) 契约测试
    // ─────────────────────────────────────────────────────────────
    test('T92: 现场回滚 (rollbackScene) 与快照恢复 (restoreSceneSnapshot) 契约与异常边界', () => {
        mockContext.chatMetadata = { [MODULE_NAME]: { version: 3, scene: { location: '初始密室' }, scene_history: [] } };
        loadCurrentState();

        // 1. 空历史时回滚优雅防御
        const rollEmpty = scnRollback();
        assert.strictEqual(rollEmpty.success, false);
        assert.strictEqual(rollEmpty.message, '暂无可回滚的历史快照');

        // 2. 越界恢复索引防御
        const restInvalid = scnRestoreSnapshot(99);
        assert.strictEqual(restInvalid.success, false);
        assert.strictEqual(restInvalid.message, '指定的历史快照索引无效');

        // 3. 执行变更并回滚
        scnUpdateScene({ location: '暴风雨中的灯塔' });
        assert.strictEqual(getState().scene.location, '暴风雨中的灯塔');
        assert.strictEqual(scnGetHistory().length, 1);

        const rollOk = scnRollback();
        assert.strictEqual(rollOk.success, true);
        assert.strictEqual(getState().scene.location, '初始密室', '回滚后地点成功恢复为初始密室');

        // 4. 多次变更后的指定索引恢复
        scnUpdateScene({ location: '地点A' });
        scnUpdateScene({ location: '地点B' });
        scnUpdateScene({ location: '地点C' });

        const history = scnGetHistory();
        assert.ok(history.length >= 2);
        const restOk = scnRestoreSnapshot(0);
        assert.strictEqual(restOk.success, true);
        assert.strictEqual(getState().scene.location, history[0].scene.location, '指定索引恢复成功');
    });

    // ─────────────────────────────────────────────────────────────
    // T93: 数据迁移与导入导出模块解耦同源契约 (src/migration.js ↔ src/state.js)
    // ─────────────────────────────────────────────────────────────
    test('T93: 数据迁移与导入导出模块解耦与同源重导出契约测试 (src/migration.js ↔ src/state.js)', () => {
        // 1. 同源导出函数存在性核验
        assert.strictEqual(typeof migSanitizeId, 'function');
        assert.strictEqual(typeof migMigrateItems, 'function');
        assert.strictEqual(typeof migMigrateState, 'function');
        assert.strictEqual(typeof migExportPackage, 'function');
        assert.strictEqual(typeof migImportPackage, 'function');

        // 2. sanitizeMemoryId 规则核验
        assert.strictEqual(migSanitizeId('valid-id_123.test'), 'valid-id_123.test');
        assert.strictEqual(migSanitizeId('  trim-me  '), 'trim-me');
        assert.ok(migSanitizeId('invalid space id').startsWith('mem-'), '非法字符 ID 自动重生成');
        assert.ok(migSanitizeId(null).startsWith('mem-'), 'null ID 自动重生成');

        // 3. migMigrateItems 纯函数过滤与归一化测试
        const dummyRaw = [
            null,
            { invalid: true },
            { id: 'custom-1', content: '测试记忆内容', type: 'unknown_type', scope: 'invalid_scope' }
        ];
        const res = migMigrateItems(dummyRaw, mockContext);
        assert.strictEqual(res.stats.total, 1, '损坏与无效项被安全剔除');
        assert.strictEqual(res.stats.upgraded, 1, '旧版无效 scope 保守升格为 character');
        assert.strictEqual(res.migratedMemories[0].id, 'custom-1');
        assert.strictEqual(res.migratedMemories[0].type, MEMORY_TYPES.FACT, '无效 type 默认回退为 FACT');
        assert.strictEqual(res.migratedMemories[0].scope, MEMORY_SCOPE.CHARACTER);
        assert.deepStrictEqual(res.migratedMemories[0].known_by, ['角色A'], '保守升级归属于当前对话角色');
    });

    // ─────────────────────────────────────────────────────────────
    // T94: 跨版本状态平滑升级与备份导入导出同源性端到端测试
    // ─────────────────────────────────────────────────────────────
    test('T94: 跨版本状态平滑升级与备份导入导出同源性端到端测试', () => {
        // 1. 模拟旧版 v2 缺失三态场景与旧记忆格式
        const legacyStored = {
            version: 2,
            scene: {
                location: '旧版客栈',
                time: '子夜'
            },
            memories: [
                { id: 'leg-1', content: '客栈地窖藏有火药', scope: 'character', character: '角色A' },
                { id: 'leg-2', content: '天下大势分久必合', scope: 'world' }
            ]
        };

        const migratedState = migMigrateState(legacyStored, DEFAULT_STATE, mockContext);
        assert.strictEqual(migratedState.version, 3, '版本成功平滑升级至 3');
        assert.strictEqual(migratedState.scene.location, '旧版客栈');
        assert.strictEqual(migratedState.scene.scene_id, 'scene_init');
        assert.strictEqual(migratedState.memories.length, 2);
        assert.strictEqual(migratedState.memories[0].lifecycle, MEMORY_LIFECYCLE.ACTIVE);

        // 2. 导出数据包结构规范性
        const exportedPkg = migExportPackage(migratedState, mockContext);
        assert.strictEqual(exportedPkg.plugin, MODULE_NAME);
        assert.strictEqual(exportedPkg.version, EXTENSION_VERSION);
        assert.strictEqual(exportedPkg.character_name, '角色A');
        assert.strictEqual(exportedPkg.memories.length, 2);

        // 3. state.js 代理导出与 migration.js 导出的一致性
        mockContext.chatMetadata = { [MODULE_NAME]: legacyStored };
        loadCurrentState();
        const stateExported = exportMemoryData();
        assert.strictEqual(stateExported.memories.length, exportedPkg.memories.length);
        assert.strictEqual(stateExported.character_name, exportedPkg.character_name);

        // 4. importMemoryData 代理调用验证
        const newBackup = {
            plugin: MODULE_NAME,
            version: '0.1.35',
            memories: [
                { id: 'new-mem-99', content: '全新引入的公共历史', scope: 'world', type: 'fact' }
            ]
        };
        const importRes = importMemoryData(newBackup, 'merge');
        assert.strictEqual(importRes.success, true);
        assert.strictEqual(importRes.imported, 1);
        assert.ok(getState().memories.some(m => m.content === '全新引入的公共历史'));
    });

    // ─────────────────────────────────────────────────────────────
    // T95: 现场快照上限与记忆 Token 预算即时持久化与防回滚恢复测试
    // ─────────────────────────────────────────────────────────────
    test('T95: 现场快照上限与记忆 Token 预算即时持久化与防回滚恢复测试', () => {
        // 1. 模拟用户通过 HUD 或原生抽屉修改快照上限与总 Token 预算
        updateSettings({
            maxSceneTokens: 280,
            maxTotalMemoryTokens: 850
        });
        const saveOk = saveSettingsImmediately();
        assert.strictEqual(saveOk, true, '立即持久化保存必须成功返回');

        // 2. 检查内存与运行期配置缓存是否即时生效
        const currentSettings = getSettings();
        assert.strictEqual(currentSettings.maxSceneTokens, 280, 'maxSceneTokens 必须即时生效为 280');
        assert.strictEqual(currentSettings.maxTotalMemoryTokens, 850, 'maxTotalMemoryTokens 必须即时生效为 850');

        // 3. 检查 localStorage 备份中是否包含修改后的 Token 预算
        const rawBackup = mockLocalStorage['ST_PM_SETTINGS_BACKUP'];
        assert(rawBackup, 'localStorage 中必须存在 ST_PM_SETTINGS_BACKUP 备份');
        const parsedBackup = JSON.parse(rawBackup);
        assert.strictEqual(parsedBackup.maxSceneTokens, 280, 'localStorage 中快照上限必须更新为 280');
        assert.strictEqual(parsedBackup.maxTotalMemoryTokens, 850, 'localStorage 中总预算必须更新为 850');

        // 4. 模拟页面刷新或宿主重启时，宿主 extensionSettings 仅载入了旧默认配置的情景 (防覆盖恢复)
        mockContext.extensionSettings[MODULE_NAME] = {
            maxSceneTokens: 150,
            maxTotalMemoryTokens: 450
        };
        // 重新调用 getSettings()，必须自动触发防御机制，从 localStorage 备份中恢复用户自定义的 280 与 850
        const restoredSettings = getSettings();
        assert.strictEqual(restoredSettings.maxSceneTokens, 280, '面对宿主旧默认值时，必须优先以 localStorage 自定义快照上限恢复');
        assert.strictEqual(restoredSettings.maxTotalMemoryTokens, 850, '面对宿主旧默认值时，必须优先以 localStorage 自定义总预算恢复');

        // 5. 现场快照内容修改与持久化验证
        updateScene({
            location: '汴京御街樊楼三层雅间',
            time: '宣和五年上元夜，华灯初上',
            action: '凭栏远眺千门灯火，暗记内廷防卫换防时辰',
            tension: '暗潮汹涌，各怀机心',
            unresolved: '接头人留下的半块玉佩尚未验看真伪'
        }, '测试现场更新');
        const s = getState();
        assert.strictEqual(s.scene.location, '汴京御街樊楼三层雅间');
        assert.strictEqual(s.scene.tension, '暗潮汹涌，各怀机心');
        assert(s.state_revision >= 1, '现场状态保存必须自增 state_revision');

        // 清理现场以便后续测试
        updateSettings({ maxSceneTokens: 150, maxTotalMemoryTokens: 450 });
        saveSettingsImmediately();
    });

    // ─────────────────────────────────────────────────────────────
    // T96: 文本清洗与容错 JSON 解析解耦契约与容错极限测试 (src/parser.js ↔ src/extractor.js)
    // ─────────────────────────────────────────────────────────────
    test('T96: 文本清洗与容错 JSON 解析解耦契约与容错极限测试 (src/parser.js ↔ src/extractor.js)', () => {
        // 1. 同源引用契约验证 (extractor.js 透明重导出必须严格全等于 parser.js 对应导出)
        assert.strictEqual(cleanAndParseJson, parserCleanAndParseJson, 'cleanAndParseJson 必须同源全等');
        assert.strictEqual(stripThinkingTags, parserStripThinkingTags, 'stripThinkingTags 必须同源全等');
        assert.strictEqual(repairTruncatedJson, parserRepairTruncatedJson, 'repairTruncatedJson 必须同源全等');
        assert.strictEqual(unwrapJsonPayload, parserUnwrapJsonPayload, 'unwrapJsonPayload 必须同源全等');
        assert.strictEqual(isQuietDigestPayload, parserIsQuietDigestPayload, 'isQuietDigestPayload 必须同源全等');

        // 2. 思维链深度清洗器极限边界测试 (stripThinkingTags)
        // 2.1 标准闭合标签清洗
        const thought1 = '<think>\nHere is the complex thought process\nStep 1... Step 2...\n</think>```json\n{"scene": {"location": "密室"}}\n```';
        assert.ok(!parserStripThinkingTags(thought1).includes('<think>'), 'stripThinkingTags 必须剥离 <think> 标签');
        assert.ok(!parserStripThinkingTags(thought1).includes('complex thought process'), 'stripThinkingTags 必须剥离思考内容');
        assert.ok(parserStripThinkingTags(thought1).includes('```json'), 'stripThinkingTags 必须保留代码块');

        // 2.2 多种标签变体 (<thought>, <thinking>, [Thinking Process: ...], ```thought ... ```)
        const thoughtVariants = [
            '<thought>internal monologue</thought>{"key":"val"}',
            '<thinking>analyzing current situation</thinking>{"key":"val"}',
            '```thought\nplanning next moves\n```\n{"key":"val"}',
            '[Thinking Process: 评估历史与在场人物] {"key":"val"}'
        ];
        for (const variant of thoughtVariants) {
            const stripped = parserStripThinkingTags(variant);
            assert.ok(!stripped.includes('internal') && !stripped.includes('analyzing') && !stripped.includes('planning') && !stripped.includes('评估历史'), '必须剥除变体思考内容');
            assert.ok(stripped.includes('{"key":"val"}') || stripped.includes('{"key": "val"}'), '必须保留有效主体');
        }

        // 2.3 未闭合思考标签但后接合法 JSON / 代码块
        const unclosedWithJson = '<think>\nThinking and token ran low but starts outputting:\n```json\n{"scene": {"location": "后花园"}}\n```';
        const strippedUnclosed = parserStripThinkingTags(unclosedWithJson);
        assert.ok(!strippedUnclosed.includes('<think>'), '未闭合思考标签必须被截断剥除');
        assert.ok(strippedUnclosed.startsWith('```json'), '未闭合思考后必须精准定位 JSON 起始');

        // 2.4 未闭合且完全没有有效 JSON 起始
        const unclosedNoJson = '<think>\nJust rambling thoughts without any json following...';
        assert.strictEqual(parserStripThinkingTags(unclosedNoJson), '', '无有效 JSON 的未闭合思考标签应整体剥除');

        // 3. 断尾截断逆序栈修复引擎 (repairTruncatedJson)
        // 3.1 键名未输入完毕截断
        const cutKey = '{"scene": {"location": "汴京御街", "incom';
        const repairedKey = parserRepairTruncatedJson(cutKey);
        assert.doesNotThrow(() => JSON.parse(repairedKey), '修补后的 JSON 必须可被标准 JSON.parse 解析');
        const parsedKeyObj = JSON.parse(repairedKey);
        assert.strictEqual(parsedKeyObj.scene.location, '汴京御街');

        // 3.2 字符串值截断
        const cutString = '{"scene": {"location": "醉仙楼", "action": "独自倚';
        const repairedStr = parserRepairTruncatedJson(cutString);
        const parsedStrObj = JSON.parse(repairedStr);
        assert.strictEqual(parsedStrObj.scene.location, '醉仙楼');
        assert.strictEqual(parsedStrObj.scene.action, '独自倚');

        // 3.3 数组与对象多层嵌套末尾截断 (带悬空逗号与不完整对象)
        // 场景 A: 第二个对象已有部分有效属性，结尾悬空逗号 -> 成功挽回第二个对象的已有属性
        const cutArrayA = '{"new_memories": [{"type": "fact", "content": "城门已关"}, {"type": "todo", ';
        const repairedArrA = parserRepairTruncatedJson(cutArrayA);
        const parsedArrObjA = JSON.parse(repairedArrA);
        assert.strictEqual(parsedArrObjA.new_memories.length, 2);
        assert.strictEqual(parsedArrObjA.new_memories[0].content, '城门已关');
        assert.strictEqual(parsedArrObjA.new_memories[1].type, 'todo');

        // 场景 B: 第二个对象仅输入了残缺首键 -> 安全剔除残缺首键，保留前序完整元素与安全闭合对象
        const cutArrayB = '{"new_memories": [{"type": "fact", "content": "城门已关"}, {"incom';
        const repairedArrB = parserRepairTruncatedJson(cutArrayB);
        const parsedArrObjB = JSON.parse(repairedArrB);
        assert.strictEqual(parsedArrObjB.new_memories.length, 2);
        assert.strictEqual(parsedArrObjB.new_memories[0].content, '城门已关');
        assert.deepStrictEqual(parsedArrObjB.new_memories[1], {});

        // 4. 顶层包装解包器 (unwrapJsonPayload)
        assert.strictEqual(parserUnwrapJsonPayload(null), null);
        assert.strictEqual(parserUnwrapJsonPayload('string'), 'string');
        const wrapped1 = { data: { scene: { location: '江夏' } } };
        assert.strictEqual(parserUnwrapJsonPayload(wrapped1).scene.location, '江夏');
        const wrapped2 = { response: { new_memories: [{ id: 'm1' }] } };
        assert.strictEqual(parserUnwrapJsonPayload(wrapped2).new_memories[0].id, 'm1');
        const unwrappedDirect = { scene: { location: '汉口' } };
        assert.strictEqual(parserUnwrapJsonPayload(unwrappedDirect), unwrappedDirect);

        // 5. 静默提炼判定 (isQuietDigestPayload)
        assert.strictEqual(parserIsQuietDigestPayload(null), false);
        assert.strictEqual(parserIsQuietDigestPayload({ summary: '闲聊平稳，无新事实沉淀', new_memories: [] }), true);
        assert.strictEqual(parserIsQuietDigestPayload({ status: 'no_change' }), true);
        assert.strictEqual(parserIsQuietDigestPayload({ no_change: true }), true);
        assert.strictEqual(parserIsQuietDigestPayload({ scene: null, new_memories: [] }), true);
        assert.strictEqual(parserIsQuietDigestPayload({ new_memories: [{ content: '发生了大事' }] }), false);

        // 6. 端到端 cleanAndParseJson 全链路容错集成测试
        const rawDeepSeekOutput = `
<think>
分析本轮对话：
- 角色A与玩家在演武场切磋完毕
- 暂时没有新的世界事实更新
</think>
\`\`\`json
{
    "scene": {
        "location": "城东演武场",
        "action": "收剑入鞘，互致敬意"
    },
    "summary": "演武比试和平收场",
    "new_memories": [
        {
            "type": "fact",
            "scope": "character",
            "character": "角色A",
            "content": "与玩家在城东演武场进行了剑术切磋",
            "significance": 2,
        },
    ]
}
\`\`\`
`;
        const parsed = parserCleanAndParseJson(rawDeepSeekOutput);
        assert(parsed, 'cleanAndParseJson 必须能成功解析带思维链与末尾尾随逗号的 JSON');
        assert.strictEqual(parsed.scene.location, '城东演武场');
        assert.strictEqual(parsed.new_memories.length, 1);
        assert.strictEqual(parsed.new_memories[0].content, '与玩家在城东演武场进行了剑术切磋');
    });

    // ─────────────────────────────────────────────────────────────
    // T97: 数据模式校验与防线准入网关解耦契约与极端边界测试 (src/schema.js ↔ src/extractor.js ↔ src/consolidator.js)
    // ─────────────────────────────────────────────────────────────
    test('T97: 数据模式校验与防线准入网关解耦契约与极端边界测试 (src/schema.js ↔ src/extractor.js ↔ src/consolidator.js)', () => {
        // 1. 同源引用契约验证 (extractor.js 与 consolidator.js 透明重导出必须严格全等于 schema.js 对应导出)
        assert.strictEqual(validateExtractedPayload, schemaValidateExtractedPayload, 'validateExtractedPayload 必须同源全等');
        assert.strictEqual(validateConsolidatedPayload, schemaValidateConsolidatedPayload, 'validateConsolidatedPayload (extractor) 必须同源全等');
        assert.strictEqual(consolidatorValidatePayload, schemaValidateConsolidatedPayload, 'validateConsolidatedPayload (consolidator) 必须同源全等');
        assert.strictEqual(sanitizeTriggerKeys, schemaSanitizeTriggerKeys, 'sanitizeTriggerKeys 必须同源全等');
        assert.strictEqual(MODEL_ALLOWED_LIFECYCLES, schemaModelAllowedLifecycles, 'MODEL_ALLOWED_LIFECYCLES 必须同源全等');

        // 2. validateExtractedPayload 拒绝型门禁极限测试
        // 2.1 根节点非对象拒绝
        assert.strictEqual(schemaValidateExtractedPayload(null), null);
        assert.strictEqual(schemaValidateExtractedPayload('not an object'), null);
        assert.strictEqual(schemaValidateExtractedPayload([1, 2, 3]), null);

        // 2.2 缺少三大核心字段整包拒绝
        assert.strictEqual(schemaValidateExtractedPayload({ other_field: 'nothing' }), null);

        // 2.3 非纯字符串字段防御 (防止隐式 toString 导致 [object Object])
        const rawWithEvilObject = {
            scene: {
                location: { evil: 'object' },
                action: '正常动作描述',
                in_scene_characters: ['角色A', 123, null, '角色B']
            }
        };
        const sanitizedEvil = schemaValidateExtractedPayload(rawWithEvilObject);
        assert(sanitizedEvil, '包含有效 action 的 payload 必须被接收');
        assert.strictEqual(sanitizedEvil.scene.location, undefined, '非字符串 location 必须被剔除防 [object Object]');
        assert.strictEqual(sanitizedEvil.scene.action, '正常动作描述');
        assert.deepStrictEqual(sanitizedEvil.scene.in_scene_characters, ['角色A', '角色B'], '非字符串角色必须被过滤');

        // 2.4 清空语义支持 (空串与空数组保留，null 角色保留)
        const clearPayload = {
            scene: {
                location: '主城',
                action: '',
                tension: '',
                unresolved: '',
                in_scene_characters: []
            }
        };
        const sanitizedClear = schemaValidateExtractedPayload(clearPayload);
        assert.strictEqual(sanitizedClear.scene.action, '');
        assert.strictEqual(sanitizedClear.scene.tension, '');
        assert.deepStrictEqual(sanitizedClear.scene.in_scene_characters, []);

        // 2.5 lifecycle_updates 拦截模型激活 active 与不存在的 ID
        const fakeMemories = [{ id: 'mem-001', lifecycle: 'active' }];
        const updatePayload = {
            lifecycle_updates: [
                { id: 'mem-001', lifecycle: 'active' }, // 企图激活 -> 必须被拒绝
                { id: 'mem-001', lifecycle: 'completed' }, // 合法终态 -> 必须被采纳
                { id: 'mem-not-exist', lifecycle: 'superseded' } // 不存在 ID -> 必须丢弃
            ]
        };
        const sanitizedUpdates = schemaValidateExtractedPayload(updatePayload, fakeMemories);
        assert.strictEqual(sanitizedUpdates.lifecycle_updates.length, 1);
        assert.strictEqual(sanitizedUpdates.lifecycle_updates[0].id, 'mem-001');
        assert.strictEqual(sanitizedUpdates.lifecycle_updates[0].lifecycle, 'completed');

        // 3. validateConsolidatedPayload 归并边界守卫测试
        const sourceMems = [
            { id: 'm1', type: 'fact', scope: 'character', character: '角色A', known_by: [], lifecycle: 'active', status: 'triggered' },
            { id: 'm2', type: 'fact', scope: 'character', character: '角色A', known_by: [], lifecycle: 'active', status: 'triggered' },
            { id: 'm3_other', type: 'fact', scope: 'character', character: '角色B', known_by: [], lifecycle: 'active', status: 'triggered' }
        ];

        // 3.1 跨角色拼凑归并尝试 -> 必须坚决拦截
        const crossCharPayload = {
            consolidated: [
                {
                    content: '跨角色试图归并',
                    type: 'fact',
                    scope: 'character',
                    supersedes: ['m1', 'm3_other']
                }
            ]
        };
        assert.strictEqual(schemaValidateConsolidatedPayload(crossCharPayload, sourceMems), null, '跨角色拼凑归并必须返回 null');

        // 3.2 归并少于 2 条 -> 必须拦截
        const singleSupersede = {
            consolidated: [
                {
                    content: '只替代1条记忆',
                    type: 'fact',
                    scope: 'character',
                    supersedes: ['m1']
                }
            ]
        };
        assert.strictEqual(schemaValidateConsolidatedPayload(singleSupersede, sourceMems), null);

        // 3.3 正常归并 -> 必须成功生成有效条目
        const goodConsolidated = {
            consolidated: [
                {
                    content: '角色A在多次探索中掌握了秘术全篇',
                    type: 'fact',
                    scope: 'character',
                    trigger_keys: ['秘术', '你', '探索'],
                    supersedes: ['m1', 'm2']
                }
            ]
        };
        const goodRes = schemaValidateConsolidatedPayload(goodConsolidated, sourceMems, new Set(['玩家', '角色A']));
        assert(goodRes, '合法归并必须校验通过');
        assert.strictEqual(goodRes.consolidated.length, 1);
        assert.strictEqual(goodRes.consolidated[0].character, '角色A');
        assert.deepStrictEqual(goodRes.consolidated[0].supersedes, ['m1', 'm2']);
        assert.ok(!goodRes.consolidated[0].trigger_keys.includes('你'), '触发词停用词必须被自动清洗');

        // 4. sanitizeTriggerKeys 过滤边界测试
        assert.deepStrictEqual(schemaSanitizeTriggerKeys(null), []);
        assert.deepStrictEqual(schemaSanitizeTriggerKeys('not an array'), []);
        const testKeys = ['你', '我', '一个词汇太长了超过十五个字符将被丢弃', 'a', '有效词汇一', '有效词汇二', '超长词汇超过十五个字符将被无情剔除', '有效词汇三', '有效词汇四', '有效词汇五', '有效词汇六'];
        const sanitized = schemaSanitizeTriggerKeys(testKeys);
        assert.ok(!sanitized.includes('你') && !sanitized.includes('我'));
        assert.ok(!sanitized.includes('a'));
        assert.ok(!sanitized.includes('一个词汇太长了超过十五个字符将被丢弃'));
        assert.ok(sanitized.length <= 5, '最多保留 5 个有效触发词');
        assert.strictEqual(sanitized[0], '有效词汇一');
    });

    // ─────────────────────────────────────────────────────────────
    // T98: 提示词模板与元指令编排解耦契约与极端边界测试 (src/prompt.js ↔ src/extractor.js ↔ src/backlog.js ↔ src/consolidator.js)
    // ─────────────────────────────────────────────────────────────
    test('T98: 提示词模板与元指令编排解耦契约与极端边界测试 (src/prompt.js ↔ src/extractor.js ↔ src/backlog.js ↔ src/consolidator.js)', () => {
        // 1. 同源引用契约验证 (extractor.js 与 consolidator.js 透明重导出必须严格全等于 prompt.js 对应导出)
        assert.strictEqual(buildDigestPrompt, promptBuildDigestPrompt, 'buildDigestPrompt 必须同源全等');
        assert.strictEqual(buildBacklogDigestPrompt, promptBuildBacklogDigestPrompt, 'buildBacklogDigestPrompt 必须同源全等');
        assert.strictEqual(buildConsolidationPrompt, promptBuildConsolidationPrompt, 'buildConsolidationPrompt 必须同源全等');
        assert.strictEqual(getActionGuidance, promptGetActionGuidance, 'getActionGuidance 必须同源全等');
        assert.strictEqual(getMemoryContentGuidance, promptGetMemoryContentGuidance, 'getMemoryContentGuidance 必须同源全等');
        assert.strictEqual(SYNC_TAG_REGEX.source, promptSyncTagRegex.source, 'SYNC_TAG_REGEX 正则源文本必须同源一致');

        // 2. 动作与记忆详略引导词自适应弹性测试
        // 2.1 快照预算在 150 Tok 默认值时
        const actionLow = promptGetActionGuidance(150);
        assert.ok(actionLow.includes('具体可观察动作'));
        assert.ok(!actionLow.includes('预算充裕约'));

        // 2.2 快照预算提升到 260 Tok 时
        const actionHigh = promptGetActionGuidance(260);
        assert.ok(actionHigh.includes('当前现场快照预算充裕约 260 Tok'));
        assert.ok(actionHigh.includes('详尽生动描写现场动态与人物动作细节'));

        // 2.3 记忆总预算在 450 Tok 默认值时
        const memLow = promptGetMemoryContentGuidance(450);
        assert.ok(memLow.includes('≤40字'));
        assert.ok(!memLow.includes('允许较详尽记录'));

        // 2.4 记忆总预算提升到 900 Tok 时
        const memHigh = promptGetMemoryContentGuidance(900);
        assert.ok(memHigh.includes('≤80字'));
        assert.ok(memHigh.includes('当前总预算充裕约 900 Tok'));

        // 2.5 异常输入安全兜底 (负数、非数字)
        assert.ok(promptGetActionGuidance(-10).includes('具体可观察动作'));
        assert.ok(promptGetMemoryContentGuidance('invalid').includes('≤40字'));

        // 3. buildDigestPrompt 结构完整性与安全隔离测试
        const prompt1 = promptBuildDigestPrompt({
            currentScene: '{"location": "长生殿"}',
            activeWbSection: '【当前会话关联世界书条目】：- [UID: 1] "大内密探"',
            activeMemList: '- (ID: m1) 两人在殿前密会',
            conversationText: '[玩家]: 密信何在？\n\n[角色A]: 已藏入梁上。',
            maxSceneTokens: 240,
            maxTotalMemoryTokens: 850
        });
        assert.ok(prompt1.includes('长生殿'), 'Prompt 必须包含当前现场状态');
        assert.ok(prompt1.includes('大内密探'), 'Prompt 必须包含世界书设定摘要');
        assert.ok(prompt1.includes('两人在殿前密会'), 'Prompt 必须包含活跃记忆库');
        assert.ok(prompt1.includes(promptUntrustedTraceHeader), 'Prompt 必须包含不可信数据安全隔离头');
        assert.ok(prompt1.includes(promptUntrustedTraceFooter), 'Prompt 必须包含不可信数据安全隔离尾');
        assert.ok(prompt1.includes(promptUntrustedSecurityNotice), 'Prompt 必须包含安全防御防注入警示');
        assert.ok(prompt1.includes('当前现场快照预算充裕约 240 Tok'), 'Prompt 必须动态渲染高预算动作指引');
        assert.ok(prompt1.includes('当前总预算充裕约 850 Tok'), 'Prompt 必须动态渲染高预算记忆指引');

        // 4. buildBacklogDigestPrompt 历史切片分批动态参数测试
        const backlogPrompt = promptBuildBacklogDigestPrompt({
            currentScene: '{"location": "宣武门外"}',
            activeWbSection: '',
            activeMemList: '（暂无活跃记忆）',
            conversationText: '[玩家]: 行动开始。',
            maxSceneTokens: 150,
            maxTotalMemoryTokens: 450,
            batchIndex: 2,
            totalBatches: 6,
            batchStart: 20,
            batchEnd: 30
        });
        assert.ok(backlogPrompt.includes('第 3/6 阶段'), '回溯提示词必须标注当前批次推进度');
        assert.ok(backlogPrompt.includes('第 21~30 条消息'), '回溯提示词必须标注当前切片消息范围');
        assert.ok(backlogPrompt.includes('宣武门外'), '回溯提示词必须包含上一阶段现场状态');

        // 5. buildConsolidationPrompt 宏观归并提示词测试
        const consolidatePrompt = promptBuildConsolidationPrompt({
            groupsPromptText: '【分组 1】(知情范围: world)\n- (ID: m1) 城东失火\n- (ID: m2) 救火受阻'
        });
        assert.ok(consolidatePrompt.includes('你是一个严谨的角色扮演剧情记忆长程归并专家'), '归并提示词必须包含专业角色定位');
        assert.ok(consolidatePrompt.includes('城东失火') && consolidatePrompt.includes('救火受阻'), '归并提示词必须包含候选分组条目');
        assert.ok(consolidatePrompt.includes('supersedes'), '归并提示词必须包含替代字段说明');

        // 6. SYNC_TAG_REGEX 伴生标签正则匹配边界
        const standardTag = '<!-- PERSISTENT_MEMORY: {"scene":{"location":"后山"}} -->';
        assert.ok(promptSyncTagRegex.test(standardTag), '标准伴随标签必须成功匹配');
        const stateTag = '```html\n<!-- STATE: {"scene":{"location":"前厅"}} -->\n```';
        assert.ok(promptSyncTagRegex.test(stateTag), 'Markdown 代码块包裹的伴随标签必须成功匹配');
        const updateTag = '<!-- MEMORY_UPDATE: {"scene":{"location":"客栈"}} -->';
        assert.ok(promptSyncTagRegex.test(updateTag), 'MEMORY_UPDATE 伴随标签必须成功匹配');
        assert.ok(!promptSyncTagRegex.test('<!-- 这是普通HTML注释，不是记忆伴随标签 -->'), '普通 HTML 注释绝不能被误判为伴随标签');
    });

    // ─────────────────────────────────────────────────────────────
    // T99: 提炼落盘与伴随协议流水线解耦契约与极端边界测试 (src/apply.js ↔ src/extractor.js ↔ src/backlog.js)
    // ─────────────────────────────────────────────────────────────
    test('T99: 提炼落盘与伴随协议流水线解耦契约与极端边界测试 (src/apply.js ↔ src/extractor.js ↔ src/backlog.js)', () => {
        // 1. 同源引用契约验证 (extractor.js 透明重导出必须严格全等于 apply.js 对应导出)
        assert.strictEqual(applyExtractedData, applyApplyExtractedData, 'applyExtractedData 必须同源全等');
        assert.strictEqual(extractAndApplySyncTag, applyExtractAndApplySyncTag, 'extractAndApplySyncTag 必须同源全等');
        assert.strictEqual(filterMemoriesForDigest, applyFilterMemoriesForDigest, 'filterMemoriesForDigest 必须同源全等');

        // 2. applyExtractedData 单元与事务行为测试
        // 2.1 空/无效 payload 处理
        assert.strictEqual(applyExtractedData(null), '无有效更新');
        assert.strictEqual(applyExtractedData(undefined), '无有效更新');
        assert.strictEqual(applyExtractedData('invalid_payload'), '无有效更新');

        // 2.2 准备独立隔离状态
        const state = getState();
        state.scene = {
            location: '原始青石阶',
            time: '清晨微风',
            action: '拾级而上',
            tension: '平静',
            unresolved: '未知前路',
            in_scene_characters: ['玩家', '小师妹']
        };
        state.memories = [
            {
                id: 'mem_t99_old_1',
                type: 'todo',
                content: '打水浇花',
                scope: 'character',
                character: '小师妹',
                lifecycle: 'active',
                status: 'triggered'
            }
        ];

        // 2.3 现场快照三态 PATCH 更新与生命周期流转
        const res1 = applyExtractedData({
            scene: {
                location: '后山幽谷',
                tension: '高度戒备'
            },
            lifecycle_updates: [
                { id: 'mem_t99_old_1', lifecycle: 'completed' }
            ],
            new_memories: [
                {
                    type: 'fact',
                    content: '发现幽谷深处藏有上古阵法残卷',
                    scope: 'world',
                    trigger_keys: ['幽谷', '阵法残卷'],
                    status: 'triggered'
                }
            ]
        }, 12);

        // 验证汇总摘要返回值
        assert.ok(res1.includes('快照更新'));
        assert.ok(res1.includes('沉淀 1 条记忆'));
        assert.ok(res1.includes('流转 1 条状态'));

        // 验证底层状态更新
        assert.strictEqual(state.scene.location, '后山幽谷', '现场位置必须 PATCH 更新');
        assert.strictEqual(state.scene.tension, '高度戒备', '现场张力必须 PATCH 更新');
        assert.strictEqual(state.scene.time, '清晨微风', '未修改的现场字段必须保持继承');
        assert.strictEqual(state.memories.find(m => m.id === 'mem_t99_old_1').lifecycle, 'completed', '目标记忆生命周期必须流转为 completed');

        const newMem = state.memories.find(m => m.content === '发现幽谷深处藏有上古阵法残卷');
        assert.ok(newMem, '新记忆必须成功沉淀入库');
        assert.strictEqual(newMem.floor, 12, '新记忆楼层号必须正确写入');
        assert.strictEqual(newMem.scope, 'world');

        // 2.4 空更新摘要分支
        const resEmpty = applyExtractedData({});
        assert.strictEqual(resEmpty, '情境稳定，无新记忆沉淀');

        // 3. extractAndApplySyncTag 同步伴随协议测试
        // 3.1 非字符串或不含标签原样返回
        assert.strictEqual(extractAndApplySyncTag(null), null);
        assert.strictEqual(extractAndApplySyncTag(12345), 12345);
        const normalText = '这是普通的聊天回复，没有任何伴随标签。';
        assert.strictEqual(extractAndApplySyncTag(normalText), normalText);

        // 3.2 正常伴随标签入库与正文剥离
        const rawWithTag = `师兄你看，这草丛里有东西！\n\n<!-- PERSISTENT_MEMORY: {
            "scene": { "action": "弯腰捡起玉佩" },
            "new_memories": [{ "type": "fact", "content": "拾得刻有龙纹的青色玉佩", "scope": "world" }]
        } -->\n这是一块成色极佳的古玉。`;

        const cleanedText = extractAndApplySyncTag(rawWithTag);
        assert.ok(!cleanedText.includes('PERSISTENT_MEMORY'), '剥离后正文绝不能残留伴随标签');
        assert.ok(cleanedText.includes('师兄你看，这草丛里有东西！'));
        assert.ok(cleanedText.includes('这是一块成色极佳的古玉。'));
        assert.strictEqual(state.scene.action, '弯腰捡起玉佩', '伴随标签中的快照更新必须生效');
        assert.ok(state.memories.some(m => m.content === '拾得刻有龙纹的青色玉佩'), '伴随标签中的新记忆必须成功入库');
        assert.strictEqual(state.last_sync_error, null, '成功入库后 last_sync_error 必须清空');

        // 3.3 畸形 JSON 标签留痕与 HUD 排错支持
        const malformedTag = '前方凶险，速退！\n<!-- PERSISTENT_MEMORY: {bad_json: "missing quote} -->';
        const cleanedMalformed = extractAndApplySyncTag(malformedTag);
        assert.strictEqual(cleanedMalformed, '前方凶险，速退！', '畸形标签必须干净剥离');
        assert.ok(state.last_sync_error, '畸形标签必须留存 last_sync_error');
        assert.ok(state.last_sync_error.error.includes('JSON 解析失败'), '错误原因必须准确识别为 JSON 解析失败');
        assert.ok(state.last_sync_error.rawSnippet.includes('bad_json'), '必须截取保留原始片段用于排错');

        // 3.4 Schema 校验失败标签留痕
        const invalidSchemaTag = '天色已晚。\n<!-- PERSISTENT_MEMORY: {"unrelated_field": "test"} -->';
        extractAndApplySyncTag(invalidSchemaTag);
        assert.ok(state.last_sync_error.error.includes('Schema 校验未通过'), 'Schema 校验失败必须准确记录');

        // 4. filterMemoriesForDigest 提炼候选记忆过滤器测试
        const testMems = [
            { id: 'm_active_world', lifecycle: 'active', scope: 'world', content: '世界公开事件' },
            { id: 'm_completed_world', lifecycle: 'completed', scope: 'world', content: '已结项事件' },
            { id: 'm_char_present', lifecycle: 'active', scope: 'character', character: '小师妹', content: '小师妹独知秘密' },
            { id: 'm_char_absent', lifecycle: 'active', scope: 'character', character: '远方掌门', content: '掌门密信' },
            { id: 'm_shared_present', lifecycle: 'active', scope: 'shared', known_by: ['小师妹', '路人甲'], content: '两人共享线索' },
            { id: 'm_shared_absent', lifecycle: 'active', scope: 'shared', known_by: ['远方掌门', '二师兄'], content: '不在场共享线索' }
        ];

        // 4.1 在场角色包含小师妹
        const filtered1 = filterMemoriesForDigest(testMems, {
            sceneParticipants: ['玩家', '小师妹']
        });
        const ids1 = filtered1.map(m => m.id);
        assert.ok(ids1.includes('m_active_world'), '活跃 world 记忆必须包含');
        assert.ok(!ids1.includes('m_completed_world'), '非 active 状态记忆必须剔除');
        assert.ok(ids1.includes('m_char_present'), '在场角色私密记忆必须包含');
        assert.ok(!ids1.includes('m_char_absent'), '缺席角色私密记忆必须排除');
        assert.ok(ids1.includes('m_shared_present'), '在场角色共享记忆必须包含');
        assert.ok(!ids1.includes('m_shared_absent'), '全员缺席共享记忆必须排除');

        // 4.2 场景参与者未定义时的回退策略
        const filteredFallback = filterMemoriesForDigest(testMems, {
            sceneParticipants: null,
            conversationParticipants: ['远方掌门'],
            fallbackParticipants: []
        });
        const fallbackIds = filteredFallback.map(m => m.id);
        assert.ok(fallbackIds.includes('m_char_absent'), '回退列表中存在的角色私知应被包含');
        assert.ok(!fallbackIds.includes('m_char_present'), '回退列表中不存在的角色私知应被排除');
    });

    console.log(`\n======================================================`);
    console.log(`  测试结果: 共 ${passed + failed} 项 | \x1b[32m${passed} 通过\x1b[0m | \x1b[31m${failed} 失败\x1b[0m`);
    console.log(`======================================================\n`);

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('测试运行异常:', err);
    process.exit(1);
});
