# Nexus 模块化文档索引

> 维护规则：本文件与各模块 `.md` 同步更新，时间戳精确到秒。
> 依赖规则：`transport(IPC) → application → domain ← infrastructure`，domain 层零外部依赖。

| 模块 | 职责 | 文档 | 最后更新 |
| --- | --- | --- | --- |
| adapter | 各 AI Agent 本地数据源的定位与增量解析 | [adapter.md](adapter.md) | 2026-09-25 01:27:57 |
| aggregator | Nexus 自有 SQLite 存储、同步编排、看板查询 | [aggregator.md](aggregator.md) | 2026-09-25 01:27:57 |
| dashboard | 渲染层看板（KPI/图表矩阵/侧栏/会话明细） | [dashboard.md](dashboard.md) | 2026-09-25 01:27:57 |
| shared | 主/渲染进程共享类型契约与日志 | 见 `src/shared/types.ts`、`src/main/modules/shared/logger.ts` | 2026-09-25 01:27:57 |

## 进程结构

```
Electron 主进程 (src/main)
├── modules/adapter        # 适配器模块（domain/application/infrastructure）
├── modules/aggregator     # 存储与查询（domain/application/infrastructure）
├── modules/shared         # 日志
├── ipc/register.ts        # transport 层：ipcMain handlers
src/preload                # contextBridge 暴露 window.nexus
src/renderer               # React 看板（charts/components/lib/styles）
src/shared/types.ts        # IPC 契约与统一数据模型（UsageRecord 的 TS 形态）
```
