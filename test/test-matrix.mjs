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
    batchUpdate,
    saveCurrentState
} from '../src/state.js';

import {
    estimateTokens,
    getGeneratingEntity,
    buildAndInjectMemoryPrompt,
    SYNC_PROTOCOL_TEXT
} from '../src/injector.js';

import {
    validateExtractedPayload,
    extractAndApplySyncTag,
    filterMemoriesForDigest,
    withTimeout,
    buildConsolidationCandidateGroups,
    validateConsolidatedPayload,
    triggerMemoryConsolidation
} from '../src/extractor.js';
import { renderMemoryCard } from '../src/ui.js';

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
        assert.strictEqual(worldGroup.items.length, 2, '仅 active 且非 pinned 的两项纳入');

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
            { id: 'comp1', content: '已完成的约定', status: 'archived', lifecycle: 'completed' },
            { id: 'sup1', content: '已被替代的历史细节', status: 'archived', lifecycle: 'superseded' },
            { id: 'ref1', content: '已被推翻的猜想', status: 'archived', lifecycle: 'refuted' }
        ];

        const res = purgeArchivedMemories();
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.removed, 3, '应清理 3 条终态记忆');
        assert.strictEqual(res.remaining, 2, '剩余 2 条正常记忆');
        assert.deepStrictEqual(state.memories.map(m => m.id), ['p1', 'act1'], '仅置顶与活跃记忆完好保留');
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
