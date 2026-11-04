# SillyTavern 持续记忆插件 (ST-Persistent-Memory)

基于 **现场快照（L0 Resume）**、**角色在场状态机** 与 **事件驱动分层检索** 的高性能持续记忆扩展。

---

## 核心设计理念

1. **分级驱动（分层记忆模型）**：
   - **L0 现场快照 (Scene State)**：当前时间、地点、双方动作焦点、气氛张力与未决悬念。每轮必带（约 100~150 tokens），保证即时在场感。
   - **L1/L2 关键认知库 (Active Memories)**：高保真事实、明确约定言行、角色心境演变与意图伏笔。
2. **零延迟发送（输入即出发）**：
   - 发送消息时，纯本地 JS 毫秒级匹配并组装注入，不发起任何阻断性网络请求。
3. **双模式提炼（灵活适配）**：
   - **异步后台模式 (Async Quiet)**：利用 SillyTavern 内置 `generateQuietPrompt` 在后台异步提炼，不污染主模型上下文。
   - **伴随标签模式 (Sync Tag)**：单次请求内伴生返回隐藏状态标签，零额外 API 请求。
4. **多角色在场路由 (Presence Routing)**：
   - 不在场的角色记忆自动进入冷休眠，0 Token 占用，彻底防止群聊串戏与上下文爆炸。
5. **代码自治与人在回路 (Human-in-the-Loop)**：
   - 自动沉淀，玩家在侧边栏可随时一键调整状态（📌常驻 / ⚡激活 / 💤归档）或抹除幻觉。

---

## 目录结构

```
ST-Persistent-Memory/
├── manifest.json       # 扩展清单 (注册到酒馆第三方扩展)
├── index.js            # 入口：事件绑定与生命周期接入
├── style.css           # 侧边栏仪表盘 HUD 样式
├── README.md           # 使用说明
└── src/
    ├── config.js       # 常量、数据模型 Schema 与默认配置
    ├── state.js        # 状态持久化 (chat_metadata) 与内存缓存
    ├── injector.js     # 注入引擎 (Prompt 组合与按需过滤)
    ├── extractor.js    # 提炼引擎 (同步正则剥离 + 异步后台消化)
    └── ui.js           # 抽屉面板与用户交互
```

---

## 控制台调试命令

在浏览器开发者工具 (F12) 控制台中可以直接调用：

```javascript
// 查看当前聊天元数据中的记忆状态
window.__persistentMemory.getState();

// 手动触发一次当前状态组装注入测试
window.__persistentMemory.injectNow();

// 强制立即执行一次后台静默提炼
window.__persistentMemory.digestNow();
```
