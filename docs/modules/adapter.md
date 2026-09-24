# adapter 模块

> 最后更新：2026-09-25 01:27:57

## 职责

定位每个 AI Agent 在本地的数据源，把 Token/会话/工具调用记录增量解析为统一数据模型后写入 aggregator 的存储。纯监控、零干预：全部数据源以只读方式打开，绝不写用户数据库。

## 领域层（domain/types.ts）

- `AgentAdapter`：`id / label / detect() / sync(ctx)`。`sync` 必须幂等（dedupe_key 唯一约束兜底）。
- `UsageRecordInput / SessionRecordInput / ToolCallRecordInput`：写入 store 的行形态。
- 统一 Token 口径：**input 不含缓存**，`total = input + output + reasoning + cacheRead + cacheWrite`（五字段互斥）。
- `PresenceOnlyAgent`：仅感知安装、本地无结构化用量数据的 Agent（WorkBuddy/Qoder/Reasonix/Trae/Cursor），用于侧栏状态展示。

## 基础设施层（infrastructure/）

| 适配器 | 数据源 | 口径处理 | 增量策略 |
| --- | --- | --- | --- |
| zcode | `~/.zcode/cli/db/db.sqlite` 的 `model_usage`/`session`/`tool_usage`（readOnly） | 源 input 已含缓存 → 扣减 cacheRead/cacheWrite | `started_at >= lastTs` + dedupe `zcode:mu:{id}`；session/tool 各自 lastTs |
| codex | `~/.codex/sessions/**/*.jsonl` 的 `event_msg/token_count` | input 不含 cached，天然互斥 | 文件字节 offset 续读 + dedupe `codex:tc:{session}:{ordinal}`；模型取最近 `turn_context` |
| antigravity | `~/.gemini/antigravity/conversation_summaries.db`（会话）+ `~/.antigravity_cockpit/codex_local_access_logs.sqlite` 的 `request_logs`（token，本机暂 0 行） | input 不含 cached | `last_modified_time` / `rowid` 游标 |
| claude-code | `~/.claude/projects/**/*.jsonl`（`message.usage`） | input 不含缓存 | 文件 offset + dedupe `claude:ln:{file}:{uuid}` |
| codebuddy | `$APPDATA/CodeBuddy CN/codebuddy-sessions.vscdb` 的 `ItemTable`（仅会话元数据，无 token） | — | 全量 upsert 幂等 |

- `util.ts`：`openReadonlyDb`（readOnly: true）、`readJsonlIncremental`（Buffer 级 \n 切分，offset 只推进到完整行尾，半行下次重读）、`parseTimestampMs`（秒/毫秒/微秒/ISO 容错）、`collectFiles`、`tableColumns/tableExists`（schema 探测，ZCode 版本演进时自动适配列）。

## 关键决策

1. **ZCode 用量表仅保留 30 天**（源码探索报告结论）：Nexus 同步即快照，历史在自有库中永久留存——这是 Nexus 的核心价值之一。
2. schema 探测优先于硬编码列名：`model_usage`/`tool_usage` 先 `PRAGMA table_info` 再拼 SELECT 常量列（无用户输入拼接）。
3. tool_usage 首次导入循环分批（5000/批）直到不足一批，避免单批上限截断；同毫秒兜底防死循环。
