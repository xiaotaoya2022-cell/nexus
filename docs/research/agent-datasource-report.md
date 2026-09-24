# Agent 数据源调研报告

> 调研日期：2026-09-24　|　平台：Windows 10 (Git Bash)　|　用户主目录：`C:\Users\xiaotao2026`
> 目的：为 Nexus 监控汇总确定各 AI Agent 本地 Token/用量数据的精确读取位置。
> 方法：全程只读调研。SQLite 一律以 `file:///...?mode=ro` URI 打开，大表查询加 LIMIT，未修改任何 Agent 数据文件。

## 总表

| Agent | 数据源路径（Windows 绝对路径） | 格式 | Token 字段 | 精确度 | 适配难度 |
|---|---|---|---|---|---|
| **ZCode** | `C:\Users\xiaotao2026\.zcode\cli\db\db.sqlite`（表 `model_usage` / `turn_usage`） | SQLite (WAL) | `input_tokens` / `output_tokens` / `reasoning_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` / `computed_total_tokens` | 精确（请求级） | 低 |
| **Codex** | `C:\Users\xiaotao2026\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl`（行类型 `event_msg`/`token_count`）；辅以 `state_5.sqlite` 的 `threads.tokens_used` | JSONL + SQLite | `payload.info.total_token_usage.{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens}` | 精确（事件级，需做差分取增量） | 低-中 |
| **CodeBuddy (CN)** | `C:\Users\xiaotao2026\AppData\Roaming\CodeBuddy CN\codebuddy-sessions.vscdb`（表 `ItemTable`，key=`session:<uuid>`） | SQLite (vscdb) | 无 token 字段（仅会话元数据；对话存云端） | 无数据 | —（仅会话列表） |
| **WorkBuddy** | `C:\Users\xiaotao2026\.workbuddy\logs\`（automation/daemon 运维日志）；`$APPDATA\WorkBuddy AI`（空） | 纯文本日志 | 无 | 无数据 | — |
| **Qoder** | `C:\Users\xiaotao2026\AppData\Roaming\com.qodercn.app.stable\logs\<run>\qodercli\sessions\<uuid>.log` | 纯文本协议日志 | 无（仅 jobToken 控制流痕迹） | 无数据 | — |
| **Antigravity** | `C:\Users\xiaotao2026\.gemini\antigravity\conversations\<uuid>.db`（`steps.step_payload` 为 protobuf blob） | SQLite + Protobuf | blob 内无明文 token 字段 | 无数据（反解 proto 后未知） | 高（不可行） |
| **Reasonix** | `C:\Users\xiaotao2026\AppData\Roaming\reasonix\projects\<编码路径>\sessions\*.jsonl` | JSONL（消息快照） | 无 token 字段；`usage-catalog/` 目录为空 | 无数据（仅对话快照） | — |
| Claude Code | `C:\Users\xiaotao2026\.claude\projects\<proj>\*.jsonl`（行内 `message.usage`） | JSONL | `usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}` | 当前无数据（本机 projects 下 0 个 JSONL，已清空） | 低（有文件即可） |
| Trae | `C:\Users\xiaotao2026\.trae`（仅 skills）、`$APPDATA\Trae CN\logs\aha_log` | — | 无 | 无数据 | — |
| Cursor | `C:\Users\xiaotao2026\.cursor\ai-tracking\ai-code-tracking.db` | SQLite | 无 token；有代码行数（`scored_commits.lines_added/deleted`）、模型名 | 可估算（代码行维度，非 token；用量在官方 dashboard 服务端） | 中（仅作辅助指标） |

附加发现：`C:\Users\xiaotao2026\.antigravity_cockpit\codex_local_access_logs.sqlite`（第三方 Antigravity Cockpit 工具）的 `request_logs` 表具备完整的 token+成本字段（见 §6），当前 0 行；若用户启用其本地代理记录，将成为可用的二级数据源。

---

## 1. ZCode（最高优先级）✅ 精确

### 1.1 主数据库

- 路径：`C:\Users\xiaotao2026\.zcode\cli\db\db.sqlite`
- 大小：约 1.4 GB，**WAL 模式**（同目录存在 `db.sqlite-shm` / `db.sqlite-wal`，正在被活跃写入）
- 打开方式（必须）：
  ```python
  sqlite3.connect(r'file:///C:/Users/xiaotao2026/.zcode/cli/db/db.sqlite?mode=ro', uri=True)
  ```
- 共 24 张表：`dwf_actor / dwf_event / dwf_node / dwf_run / input_history / local_setting / message / model_usage / part / permission / schema_migration / session / session_entry / session_input / session_target / session_task_link / sqlite_sequence / todo / tool_usage / turn_usage / workflow_activity / workflow_definition / workflow_event / workflow_run`

### 1.2 核心表结构与抽样（2026-09-24 实测）

**`model_usage`（48,764 行）— 每模型请求一条，Token 监控的事实来源：**

| 字段 | 含义 | 抽样值 |
|---|---|---|
| `id` (PK) | 用量记录 ID | `mu_...` |
| `session_id` | 会话 ID（FK→session） | `sess_subagent_agent_e787...` |
| `turn_id` | 回合 ID | `turn_ae022a67-...` |
| `trace_id` / `span_id` | 追踪 ID | uuid |
| `provider_id` | 账号/渠道 | `account:zai-individual-coding-plan`、`builtin:zai-coding-plan`、`opencode-zen-chat`、`new-provider` |
| `model_id` | 模型名 | `GLM-5.3-Flash`、`deepseek-v4.1-flash`、`LongCat-2.0`、`qwen3.8-max` |
| `agent` / `mode` / `task_type` / `query_source` | 代理/权限模式等 | `zcode-general-purpose` / `yolo` |
| `status` | running/completed/error/cancelled | `completed` |
| `started_at` | **epoch 毫秒** | `1790264378810` |
| `duration_ms` / `time_to_first_token_ms` | 时延 | 15484 |
| `finish_reason` | 结束原因 | — |
| `input_tokens` | 输入 token | 90327 |
| `output_tokens` | 输出 token | 471 |
| `reasoning_tokens` | 推理 token | 0 |
| `cache_creation_input_tokens` | 缓存写入 | 0 |
| `cache_read_input_tokens` | 缓存读取 | 88640 |
| `provider_total_tokens` / `computed_total_tokens` | 总量 | 90798 |
| `retry_count` / `retryable` / `cancelled_by_user` / `context_exceeded` | 异常维度 | 0 |
| `error_type` / `error_code` / `error_message` | 错误信息 | — |
| `raw_usage_json` / `provider_metadata_json` | 原始用量（可能较大，读取时按需） | — |

实际抽样行：
```
('sess_subagent_agent_e7873350-...', 'turn_ae022a67-...', 'account:zai-individual-coding-plan', 'GLM-5.3-Flash',
 'zcode-general-purpose', 'yolo', 'completed', 1790264378810, 15484, 90327, 471, 0, 0, 88640, 90798)
```

**`turn_usage`（1,621 行）— 回合级汇总：** 主键 `(session_id, turn_id)`；字段含 `status / started_at / completed_at / duration_ms / time_to_first_token_ms / first_token_at / model_request_count / model_retry_count / tool_call_count / tool_error_count / input_tokens / output_tokens / reasoning_tokens / cache_creation_input_tokens / cache_read_input_tokens / computed_total_tokens / error_type / error_code`。

**`session`（552 行）：** `id (sess_*) / project_id (proj_f-nexus) / directory (F:\Nexus) / title / version (0.16.9) / time_created / time_updated（epoch 毫秒）/ task_type (interactive|subagent_child)`。

**`message`（78,573 行）：** `data` 列为 JSON。assistant 消息 JSON 顶层字段含：
```
role, time.created, modelId, providerId, mode, agent, path.cwd, cost,
tokens.input, tokens.output, tokens.reasoning, tokens.cache.read, tokens.cache.write
```
（即消息级也自带 token 与 cost，可作 `model_usage` 的交叉校验。）

**`tool_usage`：** 工具调用级（`tool_name / duration_ms / output_bytes / stdout_bytes / exit_code / approval_status`），无 token。

### 1.3 其他 ZCode 数据

- `C:\Users\xiaotao2026\.zcode\cli\rollout\model-io-sess_*.jsonl`：模型 I/O 完整 dump（request body / response headers + usage），单文件可达 MB 级；行结构 `{completedAt, durationMs, requestId, attempt, model:{modelId, providerId}, request, response}`。仅当前活动子代理的少量文件，非完整历史，不作主数据源。
- `C:\Users\xiaotao2026\.zcode\cli\log\zcode-YYYY-MM-DD.jsonl`：结构化遥测日志（`timestamp/level/event/module/traceId/context`），无 token 用量。
- `C:\Users\xiaotao2026\.zcode\v2\tasks-index.sqlite`（WAL）：任务/自动化索引（`tasks / automations / automation_runs / task_groups`），含 `session_id`、`model`、`workspace_path`，无 token。可作任务维度关联。
- `C:\Users\xiaotao2026\.zcode\v2\config.json / credentials.json / provider_config.json`：配置与凭据（敏感，勿入库）。
- 未发现其他 SQLite/JSONL 会话存储。

### 1.4 结论与适配建议

- **Token 读取：`SELECT ... FROM model_usage ORDER BY started_at`** 即可得到请求级完整用量；按天/模型/项目聚合用 `session` 表 JOIN（`directory`/`project_id`）。`turn_usage` 适合回合级时延/首 token 分析。
- 难度：**低**。注意事项：
  1. 必须 `mode=ro` URI 打开（库正被写入，普通打开可能损坏或被锁）；
  2. WAL 模式下只读连接能读到已 checkpoint 的快照 + WAL，延迟秒级可接受；
  3. `raw_usage_json` 等大列在统计查询中显式排除；
  4. 时间戳为 **epoch 毫秒**；
  5. 建议对 `(started_at)`、`(session_id)` 已有索引假设下仍先 `EXPLAIN QUERY PLAN`。

---

## 2. Codex ✅ 精确（事件级）

### 2.1 会话 rollout JSONL（主数据源）

- 路径模式：`C:\Users\xiaotao2026\.codex\sessions\YYYY\MM\DD\rollout-<时间戳>-<会话id>.jsonl`（实测 38 个文件；另有 `archived_sessions\`）
- 每行一个 JSON 事件，常见 `type`：`session_meta / response_item / event_msg / turn_context` 等。
- **Token 数据在 `event_msg` 的 `token_count` 事件中**（实测样例，2026-08-23 会话）：
  ```json
  {"timestamp":"2026-08-23T15:25:04.715Z","ordinal":117,"type":"event_msg",
   "payload":{"type":"token_count",
     "info":{
       "total_token_usage":{"input_tokens":88649,"cached_input_tokens":16896,"cache_write_input_tokens":0,
                            "output_tokens":1748,"reasoning_output_tokens":0,"total_tokens":107293},
       "last_token_usage":{"input_tokens":23835,"cached_input_tokens":0,"cache_write_input_tokens":0,
                           "output_tokens":529,"reasoning_output_tokens":0,"total_tokens":24364},
       "model_context_window":1000000},
     "rate_limits":{"limit_id":"codex", ...}}}
  ```
- 字段语义：`total_token_usage` 为**会话累计值**（不是增量）；`last_token_usage` 为最近一次请求的用量。做每日/每会话增量时取 `last_token_usage` 求和，或对 `total_token_usage` 做相邻差分（注意会话恢复/compact 可能导致累计值重置）。
- 文件名与首行 `session_meta` 含会话 id、时间、cwd、模型 provider。

### 2.2 SQLite 辅助源（均 mode=ro 实测）

- `C:\Users\xiaotao2026\.codex\state_5.sqlite`：表 `threads`（38 行）含 **`tokens_used`（整型，会话累计）**、`model_provider / model / cwd / title / created_at_ms / updated_at_ms / archived / git_origin_url`。样例：`tokens_used=1076351168`（1.07B，某长会话累计）。适合会话列表与快速汇总；**无时间序列**。
  - 其他表：`thread_sections / projects / project_roots / thread_artifacts / rollout_migration_state` 等（索引/迁移，无 token）。
- `C:\Users\xiaotao2026\.codex\thread_history_1.sqlite`：`thread_turns`（102 行，`started_at / completed_at / duration_ms / rollout_byte_offset`）+ `thread_items`。回合时序可从这里取，token 仍需回 JSONL。
- `C:\Users\xiaotao2026\.codex\session_index.jsonl`：仅 `{id, thread_name, updated_at}` 索引。
- `C:\Users\xiaotao2026\.codex\logs_2.sqlite`：`logs` 表（2,000 行）为运行日志，非用量。
- `history.jsonl` 不存在（本机未生成用户输入历史）。

### 2.3 适配建议

- 难度：**低-中**。扫描 `sessions/**/*.jsonl`，过滤 `type=="event_msg" && payload.type=="token_count"`，按 `session_meta` 的会话/时间/模型归组。
- 注意：文件按日期分目录、文件名含 UUID 会话 id；老会话（7 月）与新会话事件格式一致；JSONL 逐行解析需容错（可能混入大行）；`state_5.threads.tokens_used` 可做对账。

---

## 3. CodeBuddy / CodeBuddy CN ⚠️ 无本地 Token 数据

### 3.1 目录盘点

| 路径 | 内容 |
|---|---|
| `C:\Users\xiaotao2026\.codebuddy\` | `logs\memwatch\cli-memwatch-*.log`（内存监控日志）、`diagnostics\`、`skills\` — 无会话/用量 |
| `C:\Users\xiaotao2026\.codebuddycn\` | `argv.json`、`extensions\` — IDE 启动配置 |
| `C:\Users\xiaotao2026\AppData\Roaming\CodeBuddy CN\` | VS Code fork 用户数据（Cache/GPUCache/User/workspaceStorage 等） |

### 3.2 找到的会话元数据（无 token）

- **`C:\Users\xiaotao2026\AppData\Roaming\CodeBuddy CN\codebuddy-sessions.vscdb`**（SQLite，表 `ItemTable`）：
  key 形如 `session:<uuid>`，value 实测样例：
  ```json
  {"conversationId":"40c4719f...","cwd":"f:/","userId":"3054b71d-...","title":"猜词挑战copy版",
   "customTitle":"猜词挑战copy版","status":"Completed","createdAt":1783885801284,"updatedAt":1785888398222,
   "isPlayground":false}
  ```
- `User\globalStorage\state.vscdb`：`chat.ChatSessionStore.index` 为空 `{}`；其余为 `chatInputDraft:*` 草稿密文。
- `User\globalStorage\tencent-cloud.coding-copilot\genie-history\<base64(工作区路径)>\current.json`：仅 `{conversationId, lastUpdated}`（目录名为 base64 编码的工作区路径，如 `YzovVXNlcnMveGlhb3RhbzIwMjYvQ29kZUJ1ZGR5L0NsYXc_` = `c:/Users/xiaotao2026/CodeBuddy/Claw`）。
- 结论：Craft/Genie 对话正文与用量存**腾讯云端**，本地只有会话 ID/标题/时间的索引。

### 3.3 适配建议

- 难度：—（无 token 可适配）。可做：会话数量、活跃度、标题/工作区维度统计（读 `codebuddy-sessions.vscdb` 的 `session:*` 键）。若要 token 需走 CodeBuddy 云端 API（不在本地数据源范围）。

---

## 4. WorkBuddy ❌ 无本地用量数据

- `C:\Users\xiaotao2026\.workbuddy\`：`app\`（空）、`binaries\`（registry.json）、`connectors\<uuid>\.credentials.v3.json`（仅凭证）、`logs\`。
- `logs\automation.log`：`LocalAutomationScheduler` 启动/调度日志；`logs\<日期>\`：`daemon-memory-diag.log / edge-sync.log / extension-scheduler-diag.log` 等运维日志。
- `C:\Users\xiaotao2026\AppData\Roaming\WorkBuddy AI\`：**空目录**。`$LOCALAPPDATA\WorkBuddy\`、`$LOCALAPPDATA\workbuddy-ai\`：仅 logs。
- 结论：WorkBuddy 状态云同步（`edge-sync.log` 佐证），本地无 SQLite/JSONL 会话与 token 数据。仅可统计运行/自动化触发次数。

---

## 5. Qoder ❌ 无本地用量数据

- `C:\Users\xiaotao2026\.qoder\`：仅 `skills\`。
- `C:\Users\xiaotao2026\AppData\Roaming\Qoder\`：`User\globalStorage\` 为空，`qodercli\cache\`。
- `C:\Users\xiaotao2026\AppData\Roaming\com.qodercn.app.stable\`（Electron 主数据目录）：
  - `logs\<运行戳>\<...>\qodercli\sessions\<uuid>.log`：**纯文本协议日志**（QueryRunner/WorkerTransport 控制流：initialize、fetch_job_token、工具调用名），grep 证实无 `usage/input_tokens` 字段。从中可解析 CWD、模型参数（`--model qfmodel`）、工具名。
  - `Local Storage\leveldb\`、`Partitions\*\IndexedDB\`：Chromium 内部存储，未见结构化会话/用量。
- `$LOCALAPPDATA\Qoder CN\`：仅安装器/启动器。
- 结论：Qoder（阿里系，云端 Agent）会话历史与用量存云端；本地只有协议日志与缓存。仅可解析会话启动记录作活跃度统计。

---

## 6. Antigravity ❌ 无可用 Token 数据（+ Cockpit 附加发现）

### 6.1 IDE 本体

- `C:\Users\xiaotao2026\.gemini\antigravity\`：
  - `conversations\<conversation-uuid>.db`（SQLite，WAL）：表 `trajectory_meta / steps / gen_metadata / executor_metadata / parent_references / trajectory_metadata_blob / battle_mode_infos`。**`steps.step_payload` 等均为 protobuf blob**，实测大 blob（约 2.5KB）中 0 次出现 `input_token/output_token/token_count/usage/cache` 等明文关键词 —— token 即使存在也被包在未知的 proto 消息里，反解成本高且随版本漂移。
  - `conversation_summaries.db`：`conversation_summaries(conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, project_id, agent_name, ...)` — 可做会话列表统计。
  - 其余为 `brain\ / annotations\ *.pbtxt / builtin\ skills`。
- `C:\Users\xiaotao2026\AppData\Roaming\Antigravity\`：Electron 缓存与 `app_storage.json / logs`，无 `User\globalStorage` 结构化数据。

### 6.2 `.antigravity_cockpit`（第三方账号管理工具，非 Google 官方）

- 路径：`C:\Users\xiaotao2026\.antigravity_cockpit\`
- 它是"账号切换器"，登记了各 Agent 的账号信息（`zcode_accounts / codex_accounts / qoder_accounts / trae_accounts / workbuddy_accounts / windsurf_accounts ...`，**含敏感凭据，勿读取入库**）。
- **`codex_local_access_logs.sqlite`**：表 `request_logs` 字段极全 —— `timestamp / account_id / email / model_id / gateway_mode / request_kind / success / http_status / latency_ms / input_tokens / output_tokens / total_tokens / cached_tokens / reasoning_tokens / token_breakdown_json / estimated_cost_usd / input_usd_per_million / output_usd_per_million / cached_input_usd_per_million`。**当前 0 行**（本地代理日志未启用或未产生流量）。若用户启用，它就是 Codex 代理链路的现成成本数据源。
- 另有 `logs\`、`cache\`、`instances\` 等运行数据。

---

## 7. Reasonix ❌ 无 Token 数据（仅对话快照）

- `C:\Users\xiaotao2026\.reasonix\`：仅 `locks\`、`skills\`。
- `C:\Users\xiaotao2026\AppData\Roaming\reasonix\`：
  - `projects\<编码路径>\sessions\`：每会话一组文件：`<ts>-session-<id>.jsonl`（消息快照，行类型 `replace`，整段 messages 数组重写）、`.events.jsonl`、`.jsonl.meta`（会话 id/parent/fork/workspace_root/topic_id）、`.jsonl.telemetry.json`（readFiles 列表：路径/turn/时间/limit）、`.event-index.json / .conflicts.jsonl / .recovery.json`。**全部无 token 字段**（grep `usage/input_tokens/prompt_tokens` 命中的是系统提示词文本，非用量）。
  - `usage-catalog\`、`session-catalog\`、`task-catalog\`：**空目录**（版本可能尚未落地数据）。
  - `global\desktop-topic-*.json`：标题/创建时间索引。
- `C:\Users\xiaotao2026\AppData\Local\reasonix\history-search\v1.sqlite`：`history_documents + history_fts` 全文检索索引，无 token。
- 适配建议：如需可解析 `.jsonl.meta`（会话元数据）+ 消息字符数做粗略估算；token 级数据需云端/后续版本。

---

## 8. 低优先级 Agent

### 8.1 Claude Code
- 预期路径：`C:\Users\xiaotao2026\.claude\projects\<工程编码>\*.jsonl`，行内 `message.usage = {input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`（众所周知格式）。
- **本机实测：`projects\` 下 14 个工程目录但 0 个 JSONL 文件**（记录已被清理）。适配器写好后可零成本复用（格式与 ZCode 的 message JSON 同源），当前无数据可采。

### 8.2 Trae
- `C:\Users\xiaotao2026\.trae\`：仅 `skills\`；`C:\Users\xiaotao2026\AppData\Roaming\Trae CN\logs\aha_log`。无本地会话/用量数据。

### 8.3 Cursor
- `C:\Users\xiaotao2026\.cursor\ai-tracking\ai-code-tracking.db`（SQLite）：
  - `ai_code_hashes`：每次 AI 代码变更（`hash / fileExtension / requestId / conversationId / timestamp / model`）
  - `scored_commits`：`linesAdded / linesDeleted / tabLinesAdded / tabLinesDeleted / composerLinesAdded / composerLinesDeleted / humanLines...`
  - `conversation_summaries`：`conversationId / title / tldr / model / mode / updatedAt`
- 无 token 字段（Cursor 用量在官方 dashboard 服务端）。可作为"AI 代码行数"辅助指标（可估算），难度中。

---

## 适配器优先级建议

1. **P0 — ZCode**：`model_usage` 表是全机质量最高的本地 Token 数据源（请求级、含 cache 读写与 reasoning、模型/账号/项目维度齐全）。一个只读 SQLite 适配器即可覆盖主要监控需求。注意 WAL 只读 URI + 排除大列 + epoch 毫秒。
2. **P1 — Codex**：rollout JSONL 的 `token_count` 事件精确可用；增量口径建议直接累加 `last_token_usage`。配合 `state_5.sqlite.threads` 做会话列表。扫描目录 + JSONL 流式解析即可。
3. **P2 — Cursor（辅助）**：无 token 但有模型维度的 AI 代码行数，成本低，可作为产出指标补充。
4. **P3 — Claude Code 适配器预留**：格式确定，一旦本机重新产生 `.claude/projects` JSONL 即生效。
5. **不投入 — CodeBuddy / WorkBuddy / Qoder / Antigravity / Reasonix / Trae**：本地无结构化 token 数据（云端存储或 protobuf/纯日志）。如需覆盖，应走各自的云端 API 或等待其本地格式落地（Reasonix 的 `usage-catalog` 空目录是未来可关注点；Antigravity Cockpit 的 `request_logs` 表若启用代理记录也是现成数据源）。
