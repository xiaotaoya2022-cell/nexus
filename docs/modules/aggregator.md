# aggregator 模块

> 最后更新：2026-09-25 02:33:24

## 职责

Nexus 自有 SQLite 存储的 schema 与写入、适配器同步编排、看板全部只读查询。

## 基础设施层（infrastructure/store.ts）

- 驱动：`node:sqlite`（Electron 41 内建，与 ZCode 同款，零原生编译依赖）。
- 库文件：`app.getPath('userData')/nexus.db`，WAL 模式，Nexus 完全拥有。
- 表：
  - `usage_records`：请求级 Token 记录，`dedupe_key UNIQUE` 保证幂等；索引 `(ts)` / `(agent, ts)` / `(model)` / `(agent, session_id)`。
  - `sessions`：会话元数据（PK `(agent, session_id)`，upsert 合并 title/dir/model/时间）。
  - `tool_calls`：工具调用计数（dedupe_key UNIQUE）。
  - `sync_state`：各适配器增量游标（last_ts + 自由 meta JSON，存文件 offset 等）。
  - `settings`：键值设置（主题等）。
- 立项书 §4.3 中的 `agent_summary`/`daily_summary` 预聚合表**暂不建**：单机数据量（实测全量 5 万级请求行）下实时 `GROUP BY` 毫秒级返回，预聚合反而引入一致性维护成本。若未来数据量增长，在 query-service 内加缓存层或物化表即可，接口不变。

## 应用层

### sync-service.ts
- 启动即同步一次，此后每 60s 轮询；`syncNow` 支持手动触发（重入保护）。
- 逐适配器：loadSyncState → `adapter.sync(ctx)` → saveSyncState；单适配器失败不影响其余（错误记入 results 并广播）。
- 每次状态变化通过 `broadcast` 推给渲染层（`nexus:sync-progress`）；窗口 `did-finish-load` 时补发当前状态，避免渲染端错过事件。
- **保留策略**：settings 表 `retentionDays > 0` 时，每轮同步收尾清理超期的 usage_records / tool_calls / sessions；0 或未设 = 永久保留（默认）。
- **增量防漏（红队 N-01）**：ZCode 行落库时刻晚于 started_at，纯时间游标会永久漏行；三个同步循环均带 24h 安全重叠窗 + store 层 dedupe_key upsert（重叠重读幂等补漏并刷新值）。
- **外部库读取**：只读连接设 `PRAGMA busy_timeout=5000`，活动 WAL 写入下避免 SQLITE_BUSY。

### query-service.ts
- 时间口径：库内 ts 为 epoch ms；日期分桶用 SQLite `localtime`（跟随本机时区），today 起点 = JS 本地零点，两者一致。
- `getOverview/getTrend/getByAgent/getByModel/getTokenTypeBreakdown/getHeatmap/getCalendar/getToolStats/getSessions`。
- 热力图：7×24（weekday 0=周一，hour 0-23），SQL 内 strftime 分桶。
- 趋势补桶：today 按 24 小时、7d/30d 按自然日补零，保证折线时间轴连续。
- 成本估算（pricing.ts）：按模型匹配公开牌价（美元/百万 token），`cost = input*in + (output+reasoning)*out + cacheRead*cr + cacheWrite*in`；未命中走通用价。UI 明确标注"估算"。
