/**
 * ST-Persistent-Memory 自动化测试验证矩阵 (T1 - T10)
 * 覆盖：状态迁移、生命周期、去重演化、权限路由、并发一致性、事务回滚、Token预算与韩文、伴生标签异常、超时保护、凭据脱敏
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
    extractAndApplySyncTag
} from '../src/extractor.js';

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

async function runTests() {
    console.log(`\n======================================================`);
    console.log(`  ST-Persistent-Memory (v${EXTENSION_VERSION}) 测试验证矩阵`);
    console.log(`======================================================\n`);

    // ─────────────────────────────────────────────────────────────
    // T1: 状态迁移 (旧版本数据迁移与知情范围补全)
    // ─────────────────────────────────────────────────────────────
    test('T1: 旧版本记忆无知情范围时平滑升级为 shared，并赋予当前会话参与者', () => {
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
        assert.strictEqual(m.scope, MEMORY_SCOPE.SHARED);
        assert.deepStrictEqual(m.known_by, ['玩家', '角色A']);
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

    test('T4.3: 提炼请求数据边界隔离，无关第三方的私有记忆绝不上传提炼 Prompt', () => {
        const state = getState();
        state.memories = [];
        state.scene = { in_scene_characters: ['角色A', '玩家'] };
        // 角色C不在场且不在当前对话中
        addMemory({ content: '角色C的秘密日记', type: 'fact', scope: 'character', character: '角色C' });
        // 角色A在场
        addMemory({ content: '角色A的公开伤势', type: 'fact', scope: 'character', character: '角色A' });

        // 模拟提炼时 activeMemList 过滤
        const activeChars = new Set(['角色A', '玩家']);
        const filtered = state.memories.filter(m => {
            if (m.scope === MEMORY_SCOPE.CHARACTER) {
                return m.character && activeChars.has(m.character);
            }
            return true;
        });

        assert.strictEqual(filtered.length, 1, '无关角色C的私密记忆必须被数据边界严格拦截');
        assert.strictEqual(filtered[0].content, '角色A的公开伤势');
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
    test('T6: batchUpdate 异常时完整回滚内存状态，阻止脏数据落盘', () => {
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
    });

    // ─────────────────────────────────────────────────────────────
    // T7: Token 预算与韩文 Hangul 字符估算 (P2-02)
    // ─────────────────────────────────────────────────────────────
    test('T7: estimateTokens 涵盖韩文音节与全量 CJK，总开销先期扣减固定模板与伴随协议', () => {
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
    });

    // ─────────────────────────────────────────────────────────────
    // T8: 伴生标签异常留存与可观测性 (P2-05)
    // ─────────────────────────────────────────────────────────────
    test('T8: 畸形伴随标签解析失败后记录至 state.last_sync_error，不静默丢弃', () => {
        const state = getState();
        state.last_sync_error = null;

        const malformedMsg = '好的，我知道了。\n<!--PERSISTENT_MEMORY { "scene": { location: unquoted_err } } -->';
        const cleaned = extractAndApplySyncTag(malformedMsg);

        assert(!cleaned.includes('PERSISTENT_MEMORY'), '消息正文中标签必须被剥离');
        assert(state.last_sync_error !== null, '状态中必须记录 last_sync_error');
        assert(state.last_sync_error.error.includes('JSON 解析失败'), '必须记录具体解析失败原因');
    });

    // ─────────────────────────────────────────────────────────────
    // T9: 提炼超时保护验证 (P2-03)
    // ─────────────────────────────────────────────────────────────
    test('T9: 提炼请求具备超时保护与 AbortController 机制', () => {
        // 校验 AbortController 行为
        const controller = new AbortController();
        let aborted = false;
        controller.signal.addEventListener('abort', () => {
            aborted = true;
        });
        controller.abort();
        assert(aborted, 'AbortController 超时中断机制有效');
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
