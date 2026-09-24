# Nexus 现状调研报告（v2 补强项目 · 任务一）

> 调研子代理：T1 ｜ 报告日期：2026-09-25 ｜ 对象：Nexus v0.1.0 全量源码（F:\Nexus）
> 结论先行：代码库小而整洁（约 30 个源文件，分层清晰，红蓝审计后质量较高），**采集管道与查询服务是 v2 最有价值的可复用资产**；但整条链路（IPC 契约、同步广播、设置、窗口生命周期）与 Electron 单机单窗口形态深度耦合，v2 的远程通信服务、多开实例维度、系统状态采集需要在抽共享层的同时做**六处结构性改造**（见第六章）。

---

## 一、技术栈与模块划分

### 1.1 技术栈清单（证据：`F:\Nexus\package.json`）

| 层 | 技术 | 版本 | 备注 |
| --- | --- | --- | --- |
| 桌面壳 | Electron | ^41.0.3 | 内建 `node:sqlite`（DatabaseSync，同步 API），零原生编译 |
| 构建 | electron-vite | ^4.0.0 | 主/preload/renderer 三段构建；alias `@shared` `@main` `@renderer`（`electron.vite.config.ts`） |
| 渲染 | React 19 + zustand 5 | — | 无路由库（单页看板），无数据请求库（直连 IPC） |
| 样式 | Tailwind 4（@tailwindcss/vite） | ^4.1.0 | 语义 Token 全在 `src/renderer/src/styles/tokens.css`（`@theme inline` 映射） |
| 图表 | ECharts 6 | ^6.0.0 | 唯一的 runtime dependencies |
| 语言 | TypeScript 5.9 strict | — | 双 tsconfig：`tsconfig.node.json`（main/preload/shared）、`tsconfig.web.json`（renderer/shared） |
| 打包 | electron-builder 26 | — | win x64：NSIS 安装版 + 便携版（`electron-builder.yml`），`npmRebuild: false` |

**注意**：项目无 lint、无单元测试框架、无 CI；验证体系 = `npm run typecheck`（双配置 tsc）+ `src/main/smoke.ts` 冒烟 + `NEXUS_CAPTURE` 截图视觉验收（见第七章）。

### 1.2 模块划分与依赖方向（证据：`F:\Nexus\docs\modules\index.md`、各源文件头部注释）

```
src/main/index.ts                 # 入口：窗口创建、依赖装配（手工 DI）、同步循环启动、一次性迁移
src/main/ipc/register.ts          # transport 层：21 个 ipcMain.handle + 1 个推送通道
src/main/modules/adapter/
  ├── domain/types.ts             # AgentAdapter 接口 + 三个写入行类型（零外部依赖）
  ├── application/registry.ts     # createAdapters() + PRESENCE_ONLY_AGENTS + detectPresence()
  └── infrastructure/             # zcode / codex / antigravity / claude-code / codebuddy + util.ts
src/main/modules/aggregator/
  ├── application/sync-service.ts # 同步编排：60s 轮询、状态广播、retention 清理
  ├── application/query-service.ts# 看板全部只读查询
  ├── application/pricing.ts      # 模型定价表 + 成本估算（纯函数）
  └── infrastructure/store.ts     # NexusStore：node:sqlite 封装（建表/幂等写入/settings）
src/main/modules/shared/logger.ts # JSONL 文件日志（依赖 electron app）
src/main/smoke.ts                 # 冒烟入口（独立 rollup 入口）
src/preload/index.ts              # contextBridge 暴露 window.nexus: NexusApi
src/renderer/src/                 # App / store / useDashboard / charts / components / lib / styles
src/shared/types.ts               # 唯一共享文件：数据形状 + NexusApi IPC 契约（135 行）
```

**依赖方向**（代码注释与文档一致声明，实际验证属实）：`transport(IPC) → application → domain ← infrastructure`；domain 层（`adapter/domain/types.ts`）零外部依赖；infrastructure 依赖 domain 接口（`NexusStore implements StoreWriter`，`store.ts:73`）。渲染层唯一出口是 `window.nexus`（`src/renderer/src/lib/api.ts:9`），不触碰 Node/Electron API。

**依赖方向上仅有的三处破格**（v2 改造点）：
1. `ipc/register.ts:26-123` 的 `buildAgentInfos()` 直接写 SQL 查 `deps.store.db` —— 聚合逻辑泄漏进 transport 层；
2. `sync-service.ts:104-111` 的 `cleanup()` 直接 `store.db.prepare(...)` 执行清理 SQL —— 越过 StoreWriter；
3. `main/index.ts:22-28` 的 `remigrateCodexIfFlagged()` 同样直接操作 `store.db`。

---

## 二、数据采集架构

### 2.1 AgentAdapter 接口（`src/main/modules/adapter/domain/types.ts`）

```ts
interface AgentAdapter {
  id: string; label: string
  detect(): boolean
  sync(ctx: SyncContext): Promise<SyncResult>   // 必须幂等
}
interface SyncContext { state: AdapterSyncState; now: number }  // state = { lastTs, meta }
interface SyncResult  { records; sessions; tools; lastTs; meta }
interface StoreWriter { insertUsage(rows); upsertSessions(rows); insertToolCalls(rows) }
```

关键设计：适配器**自己落库**（持有 `StoreWriter`），返回计数与游标，由 SyncService 统一持久化 `sync_state`。幂等由 store 层 `dedupe_key UNIQUE` + upsert 兜底，不依赖游标精确。

**统一数据模型 — Token 五字段互斥口径**（`domain/types.ts:6-19`、`docs/modules/adapter.md`）：
- `inputTokens / outputTokens / reasoningTokens / cacheReadTokens / cacheWriteTokens` 五字段互斥，`input 不含缓存`；
- `total = 五字段之和`（store 层常量 `TOTAL_EXPR`，`store.ts:18-19`）；
- 各数据源口径归一化在适配器内完成：ZCode 源 `input_tokens` 含缓存 → 扣减 `cacheRead + cacheWrite`，且实测 `reasoning` 已含于 `output` → 归并入 output 后置 0（`zcode/index.ts:82-93`）；Codex/Claude/Antigravity 源字段天然互斥直取；
- 去重键命名规约：`{agent}:{table}:{stable-id}`（如 `zcode:mu:{id}`、`codex:tc:{session}:{ordinal}`、`claude:ln:{file}:{uuid}`），**回退键不得含读取位置**（offset/rowid 例外，见红队 N-05 结论，`claude-code/index.ts:109-110`）。

### 2.2 五个适配器增量策略对比（`src/main/modules/adapter/infrastructure/*/index.ts`）

| 适配器 | 数据源 | 增量策略 | 去重键 |
| --- | --- | --- | --- |
| zcode (P0) | `~/.zcode/cli/db/db.sqlite` 的 model_usage/session/tool_usage（`readOnly:true` + busy_timeout 5s） | keyset 分页 `(ts, id)` + **24h 安全重叠窗**（`OVERLAP_MS`，`zcode/index.ts:22`）；session/tool 在 `sync_state.meta` 内各自维护游标 | `zcode:mu:{id}` / `zcode:tool:{id}` |
| codex (P1) | `~/.codex/sessions/**/*.jsonl` 的 `event_msg/token_count` | 文件字节 offset 续读（`readJsonlIncremental`）；模型取最近 `turn_context`，offset 存 `meta.offsets/models/sessionIds` | `codex:tc:{session}:{ordinal}` |
| antigravity | 会话库 + Cockpit 代理日志库 | TEXT 时间列按字典序游标 + `rowid` 游标（`antigravity/index.ts:23-28`） | `agx:req:{rowid}` |
| claude-code (预留) | `~/.claude/projects/**/*.jsonl` | 文件 offset 续读 | `claude:ln:{tag}:{uuid}` |
| codebuddy | `$APPDATA/CodeBuddy CN/codebuddy-sessions.vscdb` ItemTable | 全量 upsert（幂等），仅会话元数据 | —（无 usage） |

另有一批 `PRESENCE_ONLY_AGENTS`（workbuddy/qoder/reasonix/trae/cursor，`registry.ts:26-63`）：仅探测安装路径用于侧栏状态。

**util.ts 公共能力**（可整体复用）：`openReadonlyDb`（readOnly + busy_timeout）、`tableColumns/tableExists`（PRAGMA schema 探测，ZCode 版本演进自适应）、`parseTimestampMs`（秒/毫秒/微秒/ISO 容错）、`collectFiles`（限深扫描）、`readJsonlIncremental`（Buffer 级 `\n` 切分、offset 只推进到完整行尾、32MB 巨行跳过）。

### 2.3 NexusStore 表结构（`src/main/modules/aggregator/infrastructure/store.ts:21-71`）

| 表 | 关键列 | 约束/索引 |
| --- | --- | --- |
| `usage_records` | agent, model, provider, ts(epoch ms), 五 token 字段, session_id, is_estimated | `dedupe_key TEXT UNIQUE`；索引 `(ts)` `(agent,ts)` `(model)` `(agent,session_id)` |
| `sessions` | agent, session_id, title, project_dir, model, started_at, updated_at | PK `(agent, session_id)`；upsert 用 COALESCE 合并非空字段、MAX 取 updated_at（`store.ts:105-114`） |
| `tool_calls` | agent, tool_name, ts, session_id | `dedupe_key UNIQUE`；索引 `(ts)` |
| `sync_state` | agent(PK), last_ts, meta(JSON 文本), updated_at | meta 存文件 offset 等自由游标 |
| `settings` | key(PK), value | 纯字符串 KV，无类型、无默认值、无版本 |

- 库文件：`app.getPath('userData')/nexus.db`，WAL 模式；写入全部走预编译 upsert + 显式事务（begin/commit/rollback，`store.ts:122-132`）。
- 建表尾部带一条幂等口径修正：`UPDATE usage_records SET reasoning_tokens=0 WHERE agent='zcode'`（`store.ts:69-70`）。
- **无预聚合表**：决策记录在 `docs/modules/aggregator.md`——单机 <100 万行下实时 GROUP BY 毫秒级，宁可实时算避免一致性维护。
- `db` 属性为 `readonly` 公开（`store.ts:74`），QueryService 与 ipc 层都直接拿它写 SQL。

### 2.4 增量同步机制（`src/main/modules/aggregator/application/sync-service.ts`）

- 启动即同步一次，此后 `setInterval` 60s（`SYNC_INTERVAL_MS`，`sync-service.ts:9`）；`syncNow()` 有重入保护（`syncing` 布尔）。
- 顺序遍历适配器：未 `detect()` 直接记 0；单适配器抛错被捕获记入 `results[].error`，不影响其余（`sync-service.ts:79-84`）。
- 每次状态变化经构造注入的 `broadcast` 回调推给渲染层（`nexus:sync-progress` 推送通道）。
- **24h 重叠窗原理**（红队 N-01）：ZCode 行落库时刻晚于 started_at，纯 `>= lastTs` 游标会永久漏行；读取统一从 `lastTs - 24h` 起，配合 dedupe upsert 幂等补漏并刷新值。
- **keyset 分页**（蓝队 F1）：`(started_at, id)` 双键游标消除同毫秒 >5000 行的分页墙；带"无进展兜底 break"（`zcode/index.ts:105`）。
- 保留策略：`settings.retentionDays > 0` 时每轮同步收尾清理三表超期数据（`sync-service.ts:100-113`）；0/未设 = 永久。

---

## 三、查询与看板

### 3.1 QueryService 通道（`src/main/modules/aggregator/application/query-service.ts:73-351`）

| 方法 | 返回（shared/types.ts） | 要点 |
| --- | --- | --- |
| `getOverview(range, agent)` | `Overview` | 五字段求和 + 成本按模型逐项估算（pricing.ts）+ 会话数（DISTINCT session_id）+ 工具数 + 活跃模型数 |
| `getTrend(range, agent, groupBy)` | `TrendPoint[]` | SQLite `strftime ... localtime` 分桶（today 按小时、其余按日）；`series[分组键]=token`；**补零桶**：today 恒 24 点、7d/30d 按自然日补齐（`query-service.ts:198-219`） |
| `getByAgent / getByModel` | `NamedStat[]` | 按 token 降序 |
| `getTokenTypeBreakdown` | `TokenTypeStat[]` | 中文 label 硬编码在查询层（"输入/输出/推理/缓存读取/缓存写入"） |
| `getHeatmap` | `HeatmapData` | 7×24，weekday 归一 `(strftime('%w')+6)%7` → 0=周一（`query-service.ts:291`） |
| `getCalendar` | `CalendarDay[]` | **死通道**：看板已改用 trend 呈现每日强度，仅契约保留（红队 N-16，`useDashboard.ts:44` 注释） |
| `getToolStats` | `ToolStat[]` | LIMIT 12 |
| `getSessions` | `SessionRow[]` | sessions LEFT JOIN usage 聚合，按 token 降序 |

时间口径：`rangeStartMs`（`query-service.ts:24-45`，纯函数已导出）——today/month/year 取 JS 本地零点起；7d/30d 为滚动窗口；**分桶依赖 PC 本机时区**（SQL localtime），bucket 是字符串日期/小时。

### 3.2 IPC 契约（`src/shared/types.ts:113-135` 的 `NexusApi` + `src/main/ipc/register.ts` + `src/preload/index.ts`）

- 21 个 `invoke` 通道（`nexus:getOverview` ... `nexus:openPath`）+ 1 个主→渲推送通道 `nexus:sync-progress`；preload 用 contextBridge 逐通道手写桥接，返回类型由 `NexusApi` 约束（无运行时校验）。
- `getAgents` 不在 QueryService——`buildAgentInfos()` 在 ipc 层现算（`register.ts:26-123`）：状态机 `active`(15min 内有活动)/`idle`(24h 内)/`offline`/`nodata`，阈值常量硬编码（`register.ts:14-15`）；会话数取 sessions 表与 usage_records 的 UNION 去重（红队 N-02）。
- 桌面特有通道：`exportBoard`（capturePage + saveDialog 导出 PNG）、`openPath`（`shell.showItemInFolder` 防御性降级，红队 N-09）、`getDataDir`。
- 参数防御薄弱：`range`/`agent` 未做枚举校验（仅靠 SQL 参数绑定防注入；未知 range 落入 30d 分支），`limit` 有 1..200 clamp（`register.ts:154`）。v2 把查询暴露给局域网时必须补白名单校验层。

### 3.3 渲染层结构

- **布局**（`App.tsx:193-431`）：顶栏 48px（范围胶囊切换 + 同步/主题/导出/设置按钮 + 设置下拉浮层）+ 左侧 AgentSidebar 264px + 中部图表矩阵 + 右侧 SessionsPanel 320px（仅 2xl 显示）。KPI×4 → 趋势(2/3)+Token类型 → Agent占比+模型排行 → 热力图+工具排行 → 每日强度。
- **数据流**（`useDashboard.ts`）：`[range, agent, trendGroup]` 变化 → `Promise.all` 并行拉 9 个通道 → `DashboardData`；订阅 `onSyncProgress`，`phase==='done'` 时整页 reload。**每次全量重拉，无增量/缓存层**。
- **UI 状态**（`store.ts`）：zustand 单 store——range('7d')/agent(null)/theme('dark')/sync。
- **图表**（`charts/`）：`EChart.tsx` 薄封装（init/dispose/ResizeObserver/onClick）；`options.ts` 为 6 个 option 工厂 + `chartTokens()`（启动时从 CSS 变量读色，`getComputedStyle`）+ `fixedUnitFormatter`（**Y 轴按可见峰值统一单位**，全 B 或全 M，`options.ts:73-83`）+ `TOKEN_TYPE_COLORS`。主题切换靠 `themeEpoch` 强制重建 option（`App.tsx:66-72`）。
- **格式化**（`lib/format.ts`）：`compactNumber`（K/M/B，<1e4 保留 2 位）、`formatCost`、`formatDayLabel`、`relativeTime`、`shortDir/shortId` —— 全部纯函数，零 DOM 依赖。
- **主题**（`styles/tokens.css`）：Zai Dark/Light 全套语义 Token（背景 4 层、前景 3 层、边框 3 层、6 系列色、热力 5 档），`@theme inline` 映射 Tailwind 工具类；ECharts 不解析 `color-mix()`，热力色在 TS 里按主题给 rgba（`options.ts:20-33`）。

---

## 四、配置管理现状

### 4.1 settings 表现有键（全库检索证实仅 3 个）

| 键 | 写入位置 | 消费位置 | 语义 |
| --- | --- | --- | --- |
| `theme` | `ipc/register.ts:166-171`（setTheme，归一为 dark/light） | `main/index.ts:137-138`（启动设 nativeTheme）、`register.ts:161-165` | 'dark'\|'light'；存量 'system' 读时归一为 dark（红队 N-13） |
| `retentionDays` | `ipc/register.ts:177-181` | `sync-service.ts:101`（每轮清理） | '0'=永久；UI 仅 0/90/180/365 四档 |
| `codexRemigratedV2` | `main/index.ts:21-28`（一次性迁移标记） | 同左 | '1' 表示 codex 存量数据已清空重读 |

### 4.2 设置 UI 现状（`App.tsx:111-125, 218-251`）

设置不是页面，是顶栏齿轮按钮弹出的 **272px 下拉浮层**：仅两项——数据保留 select + "打开数据目录"按钮。主题切换在顶栏独立图标。`Settings` 类型只有 `{theme}` 一个字段（`shared/types.ts:103-105`），retentionDays 走独立 getter/setter 通道，未纳入 Settings 类型。

**评估**：v2 要加系统采集开关、通信配对、告警阈值、远控授权等大量配置，现有"字符串 KV + 逐键手写 handler + 浮层 UI"模式会迅速失控；且**无 schema 版本与迁移机制**（一次性迁移靠 flag 字符串，`codexRemigratedV2` 是孤例范式），多了一个键就多一处手工同步（IPC handler + Settings 类型 + UI）。

---

## 五、可复用/需抽象到共享层的清单（详细论证见姊妹篇《共享层抽象建议》）

| 类别 | 内容 | 现位置 | 可复用度 |
| --- | --- | --- | --- |
| 数据模型类型 | TokenTotals/Overview/TrendPoint/NamedStat/TokenTypeStat/HeatmapData/CalendarDay/ToolStat/AgentInfo/SessionRow/SyncProgress/RangeKey | `src/shared/types.ts`（已与 NexusApi 混居） | 高，可直接搬出 |
| 看板聚合载荷 | `DashboardData`（9 通道合集） | `src/renderer/src/useDashboard.ts:18-27` | 高——Android 端"一次拉全看板"的天然载荷形状 |
| 格式化算法 | compactNumber/fullNumber/formatCost/formatDayLabel/relativeTime | `src/renderer/src/lib/format.ts` | 高，纯函数 |
| 轴单位算法 | fixedUnitFormatter（按峰值统一 B/M/K） | `src/renderer/src/charts/options.ts:73-83` | 高，纯函数 |
| 成本估算 | pricing.ts 定价表 + estimateCostUsd | `src/main/modules/aggregator/application/pricing.ts` | 高，纯数据+纯函数 |
| 时间范围 | rangeStartMs | `query-service.ts:24-45` | 高，纯函数（已导出） |
| 状态判定 | active/idle/offline/nodata 阈值逻辑 | 硬编码在 `ipc/register.ts:14-15, 98-103` | 中，需先抽成纯函数 |
| 推送事件形状 | SyncProgress | `shared/types.ts:94-101` | 高，天然是远控推送事件 |
| 设计 Token | Zai Dark/Light 色板/热力五档 | `styles/tokens.css` + `options.ts:20-33` | 中，可导出 JSON 给 Android |
| 采集管道 | AgentAdapter/StoreWriter/24h 重叠窗/keyset 分页/readJsonlIncremental | `src/main/modules/adapter/` | 高（PC 端内部），Android 不直接复用但其**产物数据形状**复用 |
| 通信协议 | 目前不存在独立协议层 | — | 需新建（v2 核心工作） |

---

## 六、可能阻碍 v2 扩展的设计点（逐条 + 改进建议）

### 6.1 NexusApi 与 Electron IPC 强耦合（最大阻碍）
`src/shared/types.ts:113-135` 虽名为"契约"，但每个方法签名隐含 `Promise` IPC 语义，且唯一实现是 preload 的 `ipcRenderer.invoke` 逐通道手写（`preload/index.ts`）。Android 端无法复用这个接口，也没有任何传输无关的抽象。
**建议**：把 `NexusApi` 拆成两层——`NexusDataApi`（纯数据查询接口，传输无关）与 Electron 绑定层；远控服务实现同一接口的 WebSocket/JSON-RPC façade（详见共享层建议 §3）。

### 6.2 查询聚合逻辑泄漏在 transport 层
`buildAgentInfos()`（`ipc/register.ts:26-123`）与 SyncService 的 `cleanup()`（`sync-service.ts:100-113`）直接写 SQL 越层访问 `store.db`。远控服务要复用 `getAgents` 语义时只能复制代码。
**建议**：`getAgents()` 下沉 QueryService；清理下沉 NexusStore（`purgeBefore(cutoff)`）；并以架构守护规则禁止 application/transport 直接触碰 `store.db`（现状 `db` 是 public readonly 属性，建议改为 private + 显式查询方法）。

### 6.3 单窗口假设贯穿推送与导出
`broadcastSyncProgress(win, p)` 只发给单例 `mainWindow`（`ipc/register.ts:216-223`）；`main/index.ts:142` 构造 SyncService 时把 broadcast 直接绑死渲染窗口；`exportBoard` 依赖 `capturePage`。`window-all-closed → app.quit()`（`index.ts:167-169`）意味着**关窗即进程退出**——v2 若要求 Android 随时可连，PC 端必须能窗口关闭后继续服务。
**建议**：引入进程内事件总线（`sync-events` EventEmitter），渲染层/远控服务各自订阅；窗口生命周期与服务生命周期解耦（托盘常驻或 `window-all-closed` 不退出，需产品决策）。

### 6.4 数据模型无实例/设备维度（多开 ZCode 的硬阻碍）
`usage_records.agent`、`sessions` PK `(agent, session_id)`、`sync_state` PK `agent` 都以 agent 字符串为唯一维度。5 个 ZCode 实例的数据若都写 `agent='zcode'` 将无法拆分（会话 id 冲突、来源不可分）。
**建议**：v2 加 `instance_id` 列（默认 `default`），三个表 + sync_state 全部纳入；ZCode 适配器按实例配置目录/数据库路径多份实例化（registry 工厂从单例数组改为按发现结果生成）。这是**必须做的 schema 迁移**，与 6.5 一并设计。

### 6.5 settings 无类型、无迁移机制、无监听
字符串 KV，无 schema 版本（未用 `PRAGMA user_version`），无变更推送（渲染层改设置后其他订阅者无感知）。一次性迁移的 `codexRemigratedV2` 范式不可扩展。
**建议**：建 `schema_migrations`（或启用 `PRAGMA user_version`）+ 迁移 runner（有序脚本数组）；Settings 定义为带默认值的强类型对象 + 单通道 get/set 全量合并；设置变更走事件总线广播。

### 6.6 同步循环与 UI 耦合、主进程阻塞
SyncService 的 broadcast 回调在装配点直连窗口（见 6.3）；`node:sqlite` 是同步 API，全量首同步 ~2 秒会阻塞主进程事件循环（v0.1 可接受；v2 加入 WS 服务与系统采集定时器后，卡顿会直接影响远控响应）。
**建议**：把"采集+入库"移入 `utilityProcess`（Electron 官方子进程通道）或至少把大首次同步分片让出事件循环；WS 服务独立模块持有自己的 store 连接（WAL 允许多连接读）。

### 6.7 IPC 层无输入校验，不能直接对外网暴露
`range` 等参数无枚举白名单（靠 SQL 绑定防注入），`NexusApi` 返回类型无运行时验证。局域网 WS 服务若直接复用 handler，恶意/畸形帧会进入 SQL 参数。
**建议**：v2 为共享层类型补 JSON Schema（或 zod），WS 入口统一校验；`openPath` 这类通道绝不进入 WS 面。

### 6.8 死通道与契约漂移风险
`getCalendar` 已无人消费仍保留（`useDashboard.ts:44`）；`Settings` 类型缺 retentionDays；中文 label（TokenTypeBreakdown、热力星期标签 `options.ts:145`）硬编码在查询/图表层，Android 端要么照抄要么自行维护。
**建议**：v2 清理死通道；label 改为 key + i18n 表进共享层。

### 6.9 平台耦合杂项
`logger.ts` 依赖 `electron app`（共享层不可引用）；路径全部依赖 `homedir()`/`APPDATA`（多实例、便携模式需参数化）；`parseTimestampMs`/`readJsonlIncremental` 等纯能力埋在 adapter/infrastructure 下，v2 的 system-collector 也用得上，应上移到 shared-utils。

---

## 七、现有构建/打包/验证体系可否复用到 Android 端开发流

| 体系 | 现状 | 复用判断 |
| --- | --- | --- |
| `npm run typecheck` 双 tsconfig（`package.json:10`） | main/preload 与 renderer 分离，`@shared` 双向引用 | **可复用**：抽共享包后 typecheck 天然覆盖共享层；建议补 lint + vitest（当前没有） |
| `src/main/smoke.ts` 冒烟（独立 rollup 入口，`electron.vite.config.ts:16-19`） | 临时库 → 真实同步 5 适配器 → 全查询通道自检 → PASS 退出 | **模式可复用**：v2 为 WS 服务写 `smoke-remote.ts`（起服务→JSON-RPC 全通道对拍→PASS）；"临时库+全链路自检"范式同样适用于 Android 端的 Mock Server 联调 |
| `NEXUS_CAPTURE` 截图验收（`main/index.ts:69-110`） | 启动→延时→滚动→capturePage→写 PNG→退出；`NEXUS_PROBE` DOM 探针；截图时禁 GPU 合成 | **理念可复用**：Android 端对应 `adb exec-out screencap` / instrumentation 截图 + UI 层级 dump；NEXUS_CAPTURE 的"环境变量驱动、零侵入"设计值得照搬 |
| `NEXUS_DEBUG=1` 渲染层 console 转发（`main/index.ts:52-62`） | 诊断辅助 | Android 对应 logcat 过滤，理念一致 |
| electron-builder（`electron-builder.yml`） | win x64 NSIS+portable | 与 Android 无关；但 v2 双端发布建议统一版本号与 changelog 流程 |
| 红蓝对抗审计 + `docs/modules/` 文档同步（`PROJECT_LAUNCH_REPORT.md`） | 循环审计至放行 | **直接沿用**为 v2 治理流程 |

---

## 八、给后续调研任务（T2-T7）的输入要点

1. **给 T4（通信方案）**：PC 端已有可复用的查询服务与推送事件形状（SyncProgress），WS/JSON-RPC 只需做 façade；注意 6.3/6.6/6.7 三个前提改造。
2. **给 T5（Android 选型）**：若选 RN/WebView 则共享层可直接吃 TS；若选原生 Kotlin 则依赖《共享层抽象建议》的 schema 生成路线。
3. **给 T6（多开管理）**：6.4 的 instance 维度缺失是第一位阻碍；`sync_state.meta` 自由 JSON 已预留多游标扩展位。
4. **给 T7（补强项评估）**：历史趋势/时间机器受益于"快照留存"既有设计（usage_records 永久留存）；告警/健康度需要新增定时任务层（当前唯一定时器是 60s 同步）；成本估算已就绪（pricing.ts）；赛博账单需要成本通道下沉为独立查询。
