/**
 * ST-Persistent-Memory 自动化测试验证矩阵
 * 覆盖：状态迁移、权限路由、ACL 边界、提炼数据最小化、事务提交/回滚、Token 预算、错误重载、超时和凭据脱敏。
 */

import assert from 'assert';

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
    DEFAULT_STATE
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
    applyInactivitySleep
} from '../src/state.js';

import {
    estimateTokens,
    getGeneratingEntity,
    buildAndInjectMemoryPrompt,
    SYNC_PROTOCOL_TEXT
} from '../src/injector.js';

import {
    cleanAndParseJson,
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
    findMessageIndexByTurn
} from '../src/extractor.js';
import { renderMemoryCard } from '../src/ui.js';
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
    });

    test('T3.3: character 私知不可借相似条目转移给另一角色', () => {
        const state = getState();
        state.memories = [];
        addMemory({ content: '角色A看过密诏原件', type: 'fact', scope: 'character', character: '角色A' });
        const attemptedTransfer = addMemory({ content: '角色A看过密诏原件', type: 'fact', scope: 'character', character: '角色B' });

        assert.strictEqual(attemptedTransfer.character, '角色A', '相似私知条目不得更换所属角色');
        assert.deepStrictEqual(attemptedTransfer.known_by, ['角色A']);
        assert.strictEqual(state.memories.length, 1);
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
                { id: 'ext_mem_1', content: '藏在壁画后的地图', type: 'fact', scope: 'shared', known_by: ['角色A', '角色B'] }
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
