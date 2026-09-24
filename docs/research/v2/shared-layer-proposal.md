# 共享层抽象建议（v2 补强项目 · 任务一姊妹篇）

> 调研子代理：T1 ｜ 报告日期：2026-09-25 ｜ 前置：《Nexus 现状调研报告》（`nexus-status-report.md`）
> 目标：为「PC 端（Electron/TS）+ Android 端（框架待 T5 定）」确定共享层的形式、内容清单与落地步骤，使其同时服务 v2 的远控通信、双端看板与 13 个补强项。

---

## 一、原则与现状差距

**原则**：共享层只放"两端都必须一致的东西"——数据形状、口径算法、协议消息、设计 Token；两端各自的实现（SQL、图表渲染、平台 API）不进共享层。

**现状差距**（对应现状报告第五、六章）：
1. 唯一的共享物是 `F:\Nexus\src\shared\types.ts`（135 行），且**数据形状与 Electron IPC 契约（NexusApi）混居**——Android 端不能背着一个写着 `ipcRenderer` 语义的接口走。
2. 同一口径散落两份实现：Token 总量求和在 SQL（`store.ts:18-19` TOTAL_EXPR）与 TS（`query-service.ts:135`、`options.ts` tooltip）各一份；格式化算法（compactNumber/fixedUnitFormatter）只在渲染层，Android 端要显示一致就必须重写一份且无人保证一致。
3. 不存在通信协议层：通道名字符串（`nexus:getOverview` 等 21 个）硬编码在 preload 与 ipc/register.ts 两侧。

---

## 二、共享层内容清单（按包内模块划分）

建议新建 npm workspace 包 `packages/shared`（PC 端零迁移成本，`@shared` alias 直接改指过去），内部四个模块：

### 2.1 `shared/model` —— 数据模型类型（搬运自 `src/shared/types.ts`）

| 迁移物 | 现位置 | 说明 |
| --- | --- | --- |
| `RangeKey` `TimeRange` | `types.ts:4,107-111` | 传输枚举 |
| `TokenTotals` `Overview` `TrendPoint` `NamedStat` `TokenTypeStat` `HeatmapData` `CalendarDay` `ToolStat` `AgentInfo` `SessionRow` | `types.ts:8-92` | 看板全部数据形状，Android 端逐字段对应 |
| `SyncProgress` | `types.ts:94-101` | 天然是远控推送事件形状 |
| `DashboardData` | `useDashboard.ts:18-27`（上移） | Android 端"一次拉全看板"的载荷 |
| v2 新增 | — | `SystemStats`（CPU/内存/磁盘/网络/GPU）、`ZcodeInstance`（多开实例）、`RemoteCommand`/`RemoteEvent`（反控指令/回执）——先占形状，T4/T6 调研后填充 |

**保留在 PC 端不上移**：`NexusApi`（`types.ts:113-135`）、`Settings`——它们是 Electron 绑定层契约，迁移到 `src/main/ipc/contract.ts` 即可（见 §4 步骤 1）。

### 2.2 `shared/kit` —— 口径与纯函数（两端显示一致的保证）

| 迁移物 | 现位置 | Android 侧重实现方式 |
| --- | --- | --- |
| `compactNumber` `fullNumber` `formatCost` `formatTime` `formatDayLabel` `relativeTime` `shortDir` `shortId` | `src/renderer/src/lib/format.ts`（全纯函数，零 DOM） | Kotlin 重写 + 金样对拍 |
| `fixedUnitFormatter` 的"按可见峰值统一单位"算法 | `options.ts:73-83` | 抽成 `pickUnit(values): {unit, divisor}`，两端各自格式化 |
| `rangeStartMs` | `query-service.ts:24-45`（已导出纯函数） | today/month/year 边界口径必须两端一致 |
| `estimateCostUsd` + `PRICING` 定价表 | `src/main/modules/aggregator/application/pricing.ts` | 定价表建议同时输出 JSON 数据文件，两端共享数据、各持实现 |
| Agent 状态阈值（15min/24h）与判定 | `ipc/register.ts:14-15,98-103`（抽成 `resolveAgentStatus(now, lastActivityAt, ...)`） | 纯函数化后两端一致 |
| 热力 weekday 归一 `(w+6)%7` | `query-service.ts:291` | 若 PC 端下发已归一数据则 Android 免实现（推荐） |
| 趋势补零桶规则 | `query-service.ts:198-219` | **推荐 PC 端服务端补齐后再下发**，Android 免实现（现状渲染层已假设数据连续） |

### 2.3 `shared/protocol` —— 通信协议消息定义（v2 新建，PC/Android 唯一协调点）

现状没有协议层，建议一次定义到位：

```
// 信封：所有 WS 消息统一
interface NexusEnvelope { v: 2; id?: string; type: string; ts: number; payload: unknown }
// 三类 type：
//  ① req/resp：'dashboard.get'（入参 RangeKey+agent → DashboardData）、
//             'system.stats'、'instances.list'、'cmd.send'（反控）
//  ② push：   'sync.progress'（=SyncProgress）、'system.tick'、'cmd.result'、'alert.raised'
//  ③ 控制：   'pair.hello'/'pair.confirm'（配对）、'auth.challenge'（鉴权）、错误码表
```

要点：
- 协议版本号进信封（`v` 字段），为多端版本错峰留余地；
- 错误码集中定义（现状 `exportBoard` 的 `{ok, path?, canceled?, error?}` 形状可推广为统一 `Result<T>`）；
- `RangeKey`/`AgentStatus` 等枚举在协议文档中标注白名单值——补救现状 IPC 无枚举校验的缺口（WS 面必须校验）；
- **明确排除**：`exportBoard`/`openPath`/`getDataDir` 等桌面通道永不进协议。

### 2.4 `shared/tokens` —— 设计 Token JSON（可选，视觉一致用）

`styles/tokens.css` 的语义色板（背景 4 层/前景 3 层/6 系列色/热力 5 档，dark+light 两套）导出为 `tokens.json`，Android 端直接加载；`options.ts:20-33` 的 HEAT_DARK/HEAT_LIGHT rgba 值一并入内（ECharts 不解析 color-mix 的教训对 Android 图表库同样适用——给最终色值而非混合表达式）。

---

## 三、形式选型：TypeScript 共享包 vs JSON Schema vs Protobuf

### 3.1 三方案对照

| 维度 | A. TS 共享包 | B. JSON Schema 单一源 | C. Protobuf |
| --- | --- | --- | --- |
| PC 端接入成本 | 零（同语言，alias 改指） | 低（导出脚本 + 生成 TS） | 中（引 protobufjs，替换现有 JSON IPC） |
| Android 原生 Kotlin 消费 | 不可直接消费 | jsonschema2pojo/kotlinx 生成 data class | 官方 protobuf-kotlin/lite，成熟 |
| 与现有代码一致性 | 最高——现状契约就是 TS 类型 | 高（类型可由 schema 生成） | 需把 135 行契约重写为 .proto |
| 运行时校验 | 需另配 zod（WS 面需要） | ajv（PC）/ kotlinx 校验 | 解码即校验 |
| 调试可读性 | JSON，最好 | JSON，最好 | 二进制，需解码工具 |
| 载荷体积 | JSON | JSON | 小 30-50% |
| 演进/版本化 | 依赖纪律 | schema 版本字段 + 兼容规则清晰 | 字段编号机制最严格 |
| 对 WebSocket 流式推送 | 原生 JSON 友好 | 原生 JSON 友好 | 需 framing 约定 |

### 3.2 结论与理由

**倾向：A+B 组合——TypeScript 包为单一事实源，脚本导出 JSON Schema 供 Android 端生成；线上协议用 JSON over WebSocket。** Protobuf 不作首选。

理由：
1. **PC 端现状的引力**：`src/shared/types.ts` 已是两端契约的事实源，React 渲染层、IPC、smoke 全部消费 TS 类型；方案 A 让 PC 端改造只剩"搬文件"。若直接上 Protobuf，Electron 侧 ipc/preload/渲染层全链路要换序列化，收益（体积）却很小——看板数据是聚合结果（KB 级 TrendPoint 数组），不是海量原始帧。
2. **数据量不支持二进制收益**：DashboardData 全量 ~几十 KB；系统状态 tick 若 1s 一条 JSON 也不足 1KB。真正对体积敏感的场景（以后若直传截图/日志流）再局部引入二进制不迟。
3. **Android 原生端的缺口由 B 补**：若 T5 选原生 Kotlin，TS 类型无法直接用；由 `packages/shared` 的构建脚本（`typescript-json-schema` 或 zod→JSON Schema）产出 `schema/*.json`，Kotlin 侧 jsonschema2pojo 生成 data class + kotlinx.serialization 解析。schema 生成进 CI，类型漂移在构建期暴露。
4. **金样对拍兜底纯函数**：`shared/kit` 中 Android 需重实现的算法（compactNumber/estimateCostUsd/rangeStartMs），在共享包加 `__fixtures__/` 金样输入输出（TS 生成 JSON 快照），Android 侧跑同一组 fixture 做单元测试——口径一致有了机器保证。
5. **保留 Protobuf 升级路径**：协议信封已有 `v` 字段；若远控出现强版本兼容或高频二进制流需求，只对那类消息局部切换，不动看板面。

**备选说明**：若 T5 最终选 React Native/WebView 方案，则方案 B 可省略——TS 包直接成为双端唯一源，成本进一步降低。这也是"先建 TS 包、后补 schema 导出"分两步走的原因（无论选型结果，第一步都不浪费）。

---

## 四、落地步骤（与现状报告第六章的改造配套）

1. **拆契约**：`src/shared/types.ts` → `packages/shared/src/model.ts`（数据形状）+ `src/main/ipc/contract.ts`（NexusApi + Settings 保留 Electron 侧）；`@shared` alias 指向共享包，`tsconfig.*` 的 paths 同步（现有 `electron.vite.config.ts:8-25` 三处 alias）。
2. **搬纯函数**：`format.ts`、`fixedUnitFormatter`、`pricing.ts`、`rangeStartMs`、Agent 状态判定入 `shared/kit`；渲染层与 main 改 import；顺带按现状报告 6.2 把 `getAgents` 下沉 QueryService（`shared/kit` 只放判定纯函数，不放 SQL）。
3. **建协议层**：`shared/protocol` 定义信封/三类消息/错误码/枚举白名单；PC 端 WS façade 实现 `NexusDataApi` 同语义通道（复用 QueryService）；渲染层可暂不走 WS（IPC 保留），避免一次性大改。
4. **schema 导出 + 金样**：加 `zod`（或 json-schema 生成）与导出脚本；为 `shared/kit` 生成金样 fixtures；CI 中 PC typecheck + Android（后续）codegen 对拍。
5. **tokens 导出**：`tokens.css` → `tokens.json` 生成脚本。
6. **每步都跑现有质量门**：`npm run typecheck` + `smoke.ts` 冒烟 + `NEXUS_CAPTURE` 截图——现有验证体系对重构的回归保护是现成的（现状报告第七章）。

## 五、风险与边界

- **共享层不要长出逻辑**：禁止引入 node:sqlite、electron、React 依赖；`logger` 因依赖 `electron app`（`src/main/modules/shared/logger.ts:1`）不进共享层，Android 用自己的日志门面。
- **协议面必须校验**：现状 IPC 无枚举校验的宽松习惯不能带进 WS（现状报告 6.7）；协议层定义白名单后，WS 入口用 schema 校验，`openPath` 类通道永不暴露。
- **schema 迁移先行**：instance 维度（现状报告 6.4）会改动 `usage_records/sessions/sync_state` 与 `AgentInfo` 形状——共享层落地与 schema 迁移应同批进行，避免 Android 端对着一版即将变形的模型开发。
- **时区口径写进协议文档**：bucket 是 PC 本地时区字符串（现状报告 3.1），Android 端展示时需知道这一点；v2 建议协议下发 `tz` 元信息或统一 UTC+偏移量。
