# ST-Persistent-Memory 架构收敛与边界加固交接备忘录 (v0.1.44)

> **发布版本**: `v0.1.44`  
> **版本定位**: **架构收敛版本 (Architecture Convergence & Boundary Hardening)**  
> **审计响应**: 全面响应代码审计提出的 6 大维度（算法正确性、权限正确性、状态正确性、注入正确性、扩展性、测试可信度）  
> **核心原则**: 零好感度量化、零外部 API 开销、严守 ACL 权限单向流动、生产环境无旁路提权

---

## 一、版本核心收敛概览

在经历了前几个版本的跨越式功能演进后，`v0.1.44` 严格遵照收官审计指导，全面停止功能扩张，转入底层状态所有权、权限隔离门禁、数学边界防护与生产流水线闭环加固：

```mermaid
flowchart TD
    subgraph P0_State_Ownership["【P0】状态所有权与 SDK 隔离"]
        SDK[外部 SDK 外部调用] -->|structuredClone 深拷贝隔离| ReadSnap[只读快照 / Snapshot]
        SDK -->|强制剥离 bypassAcl / participants| InternalACL[权威会话参与者准入校验]
        InternalACL -->|Fail-Closed| StateCache[(内部真实状态 stateCache)]
    end

    subgraph P1_Retrieval_Fusion["【P1】双路混合检索与生产 RRF 流水线"]
        QueryCtx[现场上下文 Context] --> Channel1[稠密语义向量通道 (严格等长校验)]
        QueryCtx --> Channel2[离散 CJK Bigram 词法通道]
        Channel1 --> DualGate{双通道零分杂音门禁}
        Channel2 --> DualGate
        DualGate --> RRF[RRF 倒数排名融合 (k=60)]
        RRF --> RankAttr[详细排名归因 (rrfScore, #Rank)]
        RankAttr --> ACLLayer[POV 权限门禁 (严禁以相关度越权)]
        ACLLayer --> PromptInject[预算控制与提示词注入]
    end

    subgraph P1_Lineage_Tombstone["【P1】血缘墓碑与时光投影"]
        PurgeCmd[清理终态记忆 Purge] --> RefCheck{是否存在血缘拓扑关联?}
        RefCheck -->|孤立无关联| HardDelete[物理彻底抹除]
        RefCheck -->|前身/后继拓扑挂靠| Tombstone[Lineage Tombstone 轻量墓碑\n(清空向量/触发词，保留节点)]
        Tombstone --> LineageTree[getMemoryLineage 演化图谱不断裂]
    end
```

---

## 二、架构加固与问题修复详案

### 1. 【P0】SDK 状态所有权收敛与防原位篡改隔离 (`src/sdk.js`)
* **问题诊断**: 旧版本 `api.getState()` 与 `getMemory()` 直接透传返回内部 `stateCache` 引用，外部扩展或恶意脚本可以直接执行 `state.memories[0].scope = 'world'` 绕过全部 Schema 和 ACL 检查原位修改内部状态。此外，`addMemory` 允许外部透传 `bypassAcl` 与伪造的 `participants`。
* **架构修复**:
  1. **快照深拷贝隔离**: `getState()`、`getStateSnapshot()`、`getMemory()`、`getScene()`、`getSceneHistory()`、`getLiveSnapshot()`、`getPresets()` 全面引入 `structuredClone` (或 fallback 深拷贝)，对外只发布只读数据快照，外部对快照的原位属性篡改完全隔离在独立对象树中，对内部 `stateCache` 零影响。
  2. **权威参数强制脱敏与净化**: 外部调用 `api.addMemory(item, options)` 与 `api.updateMemory(id, patch, options)` 时，强制剔除 `bypassAcl`、`participants`、`context` 参数，统一调用底层 `getContextParticipants(getContext())` 锁定当前会话的权威可信名单，坚决拒绝凭空构造参与者实施提权。

### 2. 【P1】数学边界防御与 RRF 实体身份防碰撞 (`src/semantic.js`)
* **问题诊断**:
  1. `cosineSimilarity` 使用 `Math.min(vecA.length, vecB.length)` 计算部分点积，导致维度不匹配的向量（如 128 维与 256 维）发生截断错误计算（相似度被误判为 1）。
  2. `reciprocalRankFusion` 使用 `String(rank)` 兜底无 ID 实体，导致多通道不同候选若同处于第 2 位发生错误的身份融合；同时双通道全 0 分杂音候选仍根据输入顺序排在榜单中。
* **架构修复**:
  1. **严格等维与有限性拒止**: `cosineSimilarity` 强制要求 `vecA.length === vecB.length && vecA.length > 0`，同时对所有元素进行 `Number.isFinite` 校验，出现任何 `NaN`、`Infinity` 或空数组直接 Fail-Safe 返回 `0`。
  2. **实体身份唯一性严格约束**: `reciprocalRankFusion` 严格校验 ID 字符串（剔除纯空白和空字符），坚决拒绝无 ID 实体，杜绝以榜单位置冒充实体 ID。
  3. **双通道零分杂音候选门禁**: `rankCandidatesWithRRF` 默认过滤词法无命中且语义低于噪音阈值的无关条目，同时支持配置 `includeZeroScores: true` 保留全量排序。

### 3. 【P1】RRF 算法正式接入生产 Injector 流水线 (`src/config.js`, `src/injector.js`)
* **问题诊断**: 旧版本 RRF 仅在 SDK 中作为独立函数暴露，生产环境 `buildAndInjectMemoryPrompt` 仍仅使用旧的线性加权打分，检索链路未真正闭环。
* **架构修复**:
  1. **双检索融合通道集成**: 在 `DEFAULT_SETTINGS` 引入 `retrievalFusionMethod: 'linear' | 'rrf'` (默认保持平滑兼容的 `'linear'`，支持一键切换为 `'rrf'`)，及 RRF 阻尼常数 `rrfK: 60`。
  2. **生产注入管线对接**: 在 `injector.js` 中接入 `rankCandidatesWithRRF`，对候选记忆计算双路排名并挂载 `rrfScore`、`semanticRank`、`lexicalRank`、`semanticScore`、`lexicalScore`。
  3. **权限绝对高于排序铁律 (No Bypass)**: 明确 RRF 仅负责相关性排序，记忆能否注入必须经过严格的 POV 实体与在场角色 ACL 门禁判定。高匹配但无权限的私密记忆在 RRF 排序中排在第一位也将被坚决拦截并记录审计日志。
  4. **全链路可观测性 (Live Inspector)**: 快照中包含 `fusionMethod: 'rrf'`，并在模态窗口各激活记忆卡片中渲染诸如 `[RRF: 0.0328 | 稠密: #1 | 词法: #2]` 的诊断徽章。

### 4. 【P1】演化血缘墓碑与历史切片语义澄清 (`src/state.js`, `src/ui/modal.js`)
* **问题诊断**:
  1. `purgeArchivedMemories()` 清理终态记忆时，将已并入宏观事实的前身物理抹除，导致 `getMemoryLineage()` 血缘树断裂。
  2. 历史时光切片通过楼层筛选未区分“当时活跃状态”与“当前事实在历史楼层的投影”。
* **架构修复**:
  1. **Lineage Tombstone (血缘轻量墓碑)**: 在终态记忆清理时，检查条目是否参与演化树（作为 `consolidated_from` 归并前身或 `superseded_by` 被取代目标）。若参与，则转换为轻量墓碑保留节点（清空大体积 Embedding 向量、清空触发词、内容替换为 `[已归档结项: ...]`, 标记 `is_tombstone: true`），确保演化血缘拓扑结构永久不断裂；无任何关联的孤立条目则彻底物理抹除。
  2. **注入与检索绝对屏蔽**: 生产 Injector 新增 Rule 0，严格压制墓碑条目，绝不参与任何提示词装载与向量匹配。
  3. **切片语义明确标注**: 历史时光切片界面与文档明确标注为“第 N 轮 L0 现场快照与事实楼层投影”，并过滤内部纯墓碑条目。

### 5. 【P2】跨平台规范化打包与 POSIX 正斜杠约束 (`scripts/pack-zip.mjs`)
* **问题诊断**: Windows 环境下直接通过某些压缩工具打包可能生成带有反斜杠 `\` 的目录项，导致在 Linux/macOS 解压时破坏目录层级或把反斜杠作为文件名。
* **架构修复**: 编写专用打包脚本 `scripts/pack-zip.mjs`，采用标准 `tar -a -cf` 并自动排除 `.git` 与历史旧包，生成后通过 `tar -tf` 校验内部反斜杠计数，保证 100% 为 POSIX 正斜杠 `/`。

---

## 三、对抗性契约测试矩阵扩充 (T119 ~ T124)

本版本在 `test/test-matrix.mjs` 中新增 6 项深度对抗契约测试，测试矩阵条目由 118 项扩充至 **124 项**，全部通过 (100% Pass Rate)：

| 编号 | 测试用例名称 | 核心验证契约 | 结果 |
| :--- | :--- | :--- | :---: |
| **T119** | 外部 SDK 状态与记忆快照所有权隔离及防污染契约测试 | 外部篡改 `getState()` / `getStateSnapshot()` / `getMemory()` 返回值时，内部真实 `stateCache` 绝不发生任何原位变更 | **PASS** |
| **T120** | 外部 SDK 写入权威参与者名单绑定与越权参数净化防御测试 | 外部调用 `addMemory` 传入 `bypassAcl: true` 或伪造 `participants` 时被强制剥离，依据权威会话名单 Fail-Closed 拦截 | **PASS** |
| **T121** | 向量余弦相似度严格维度一致性与非有限数值拒止数学边界契约测试 | 验证维度不匹配向量（如 128 维对比 256 维）直接拒止返回 0；`NaN` / `Infinity` 非有限值直接拒止返回 0 | **PASS** |
| **T122** | RRF 实体身份防碰撞与双通道零分杂音候选过滤契约测试 | 验证 `reciprocalRankFusion` 严格拒止无 ID / 空白 ID 实体；`rankCandidatesWithRRF` 默认过滤双通道全 0 分杂音候选 | **PASS** |
| **T123** | 终态清理保留演化血缘墓碑 (Lineage Tombstone) 与拓扑防断裂契约测试 | 清理终态记忆时，具有血缘关联网的条目转化为轻量墓碑（清空向量与触发词），`getMemoryLineage` 祖先树不断裂且不参与注入 | **PASS** |
| **T124** | 生产环境 Injector 检索融合模式 (RRF vs 线性) 与无旁路提权契约测试 | 验证切换至 `rrf` 模式时快照记录正确融合归因；验证高相关但受限私密记忆被 ACL 坚决拦截，RRF 无法旁路提权 | **PASS** |

### 实际自动化测试执行输出
```text
======================================================
  ST-Persistent-Memory (v0.1.44) 测试验证矩阵
======================================================
...
✔ [PASS] T118: CJK Bigram 离散分词、RRF 倒数排名融合与全局开放 SDK 契约测试 (所测算法与 SDK 调用的零 fetch 请求契约)
✔ [PASS] T119: 外部 SDK 状态与记忆快照所有权隔离及防污染契约测试 (P0 状态所有权收敛)
✔ [PASS] T120: 外部 SDK 写入权威参与者名单绑定与越权参数净化防御测试 (P0 提权防御)
✔ [PASS] T121: 向量余弦相似度严格维度一致性与非有限数值拒止数学边界契约测试 (P1 数学边界防御)
✔ [PASS] T122: RRF 实体身份防碰撞与双通道零分杂音候选过滤契约测试 (P1 算法抗噪加固)
✔ [PASS] T123: 终态清理保留演化血缘墓碑 (Lineage Tombstone) 与拓扑防断裂契约测试 (P1 血缘墓碑)
✔ [PASS] T124: 生产环境 Injector 检索融合模式 (RRF vs 线性) 与无旁路提权契约测试 (P1 生产接入)

======================================================
  测试结果: 共 124 项 | 124 通过 | 0 失败
======================================================
```

---

## 四、生产交付物与校验指标

### 1. 规范化 ZIP 归档包
* **归档路径**: `D:\学习\ST-Persistent-Memory-v0.1.44.zip`
* **解压兼容性**: 经 `tar -tf` 扫描，内部所有目录路径均为 POSIX 正斜杠 `/`，包含反斜杠条目数严格为 **0**。
* **文件大小**: 约 `318 KB`
* **包含条目**: 40 项核心生产源码、交付文档与测试文件（排除 `.git` 与旧版本历史压缩包）。

### 2. SHA-256 校验哈希
```text
fca34cba45d50cc13294e6b3732b6480da2bd60ea86c121c1a7799be9658dbc2
```

### 3. 多环境双向同步核查
* **开发主仓**: `D:\jg\new\SillyTavern\public\scripts\extensions\third-party\ST-Persistent-Memory`
* **运行时环境**: `D:\jg\new\SillyTavern\data\default-user\extensions\ST-Persistent-Memory`
* **两地一致性**: 通过 `robocopy /MIR` 实施全量镜像同步，双端分别执行 `node test/test-matrix.mjs`，均呈现 **124/124 PASS**。

---

## 五、后续维护与长期路线说明

1. **版本收官定位**:
   `v0.1.44` 已达成严格意义上的架构闭环。系统具备了：
   - 权威会话参与者与单向 POV 权限防护网
   - 纯本地运行的稠密向量与离散分词混合检索及 RRF 融合
   - 基于轻量墓碑与拓扑血缘的记忆演化追踪
   - 严格状态深拷贝所有权隔离与权威环境脱敏
   - 124 项高强度对抗契约测试构筑的回归安全网
2. **生产平稳观察**:
   建议在生产环境中重点观察用户针对 `retrievalFusionMethod: 'rrf'` 与 `'linear'` 的主观体感差异，利用 Live Inspector 透视镜收集复杂会话场景下的排名归因数据。
