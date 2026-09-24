# ZCode 远控源码分析报告

- 调研对象：`F:\ZCode-main`（ZCode v3.14.0 源码，Electron 41 + TypeScript pnpm monorepo，**只读分析，未做任何修改**）
- 调研目标：为 Nexus v2「对本机运行的 ZCode 实例做有限反向控制 + 多开实例管理」摸清 ZCode 现有的远控/远程访问/进程控制组件
- 调研时间：2026-09-24
- 结论速览：**ZCode 没有面向第三方的"手机伴侣/远程控制面板"式独立远控组件，但内置了四层可直接利用的远程/控制通道**：①VS Code 式 RPC 栈（WebSocket/TCP/stdio 上的 Channel RPC）+ Web 远程服务；②独立远端 Core 服务（Supervisor + 命名管道控制协议）；③CLI `app-server --stdio` 的 ZCode Protocol（JSON 面向任务/会话/模型的完整控制面）；④SQLite 共享数据面（WAL）。Bot 通道（Telegram/飞书/企微等 7 种）承担"任务结果外送"职责，v4 线协议已为 `mobileRemote`/`mobileApp` 客户端留位但无手机端源码。

---

## 1. 远控 / 远程访问组件盘点

### 1.1 RPC 基础栈（packages/rpc）——所有远程通道的底座

VS Code 同构的分层 RPC 实现，支持 TCP / WebSocket / Electron MessagePort / stdio 四种物理传输：

| 层 | 文件 | 说明 |
|---|---|---|
| 帧协议 SocketProtocol | `packages/rpc/src/protocol.ts` | 二进制分帧 ISocket |
| 可靠层 PersistentProtocol | `packages/rpc/src/persistent-protocol.ts` | ACK + 断线重放（`replaceSocket` 换 socket 后自动重放未确认消息） |
| Channel RPC | `packages/rpc/src/channelServer.ts` / `channelClient.ts` | 按频道名注册/调用服务（请求/响应/事件三种消息类型，见 `channels.shared.ts:18-25` 的 `RequestType/ResponseType`） |
| IPC 复用 | `packages/rpc/src/ipc.ts` | IPCClient 把 protocol 包装成可调远端 channel 的客户端 |
| 远程抽象 | `packages/rpc/src/remote.ts` | RemoteAuthority（如 `ssh+myserver`）→ Resolver → `{host, port, connectionToken}` → SocketFactory（WebSocket/TCP）→ PersistentProtocol → IPCClient；断线重连退避 `[0,5,5,10,10,10,10,10,30]` 秒（`remote.ts:247`），token 以 `?token=` 查询串下发（`remote.ts:284,313`） |

消息格式为二进制帧（`VSBuffer`）内嵌 JSON channel 消息；上层全部服务以"频道名"暴露，频道名注册表在 `packages/shared/src/channels.ts:75` 的 `ServiceChannels`（`file`/`terminal`/`git`/`setting`/`credential`/`zcode-task`/`broadcast` 等）。

### 1.2 Web 远程服务（packages/server）——浏览器远程访问 ZCode

- 入口 `packages/server/src/entry-http.ts`：`PORT`（默认 3030）、`ZCODE_SERVER_HOST`、`ZCODE_SERVER_AUTH_TOKEN`（设置后 `authRequired: true`）、`ZCODE_WEB_STATIC_ROOT`（托管 Web 前端静态资源）。
- HTTP/WS 路由 `packages/server/src/http.ts`：
  - 鉴权中间件：token 走 `?token=` 查询串，校验后种 HttpOnly Cookie `zcode_lite_token`（`http.ts:187,227-236`）；`/ws`、`/ws/*`、`/api/*` 属受保护路径（`http.ts:245`）。即 **Bearer-token 式简单鉴权，无 PIN/配对码**；TLS 依赖部署层（反代），协议本身明文。
  - WS 升级后跑 `ChannelServer`，把整套本地服务（`IZCodeAgentService`、`IFileService`、`IGitService`、`ISystemService`、`ITerminalService`、`IBotsService` 等）暴露给远端浏览器（`http.ts:27-33` 导入列表）。
  - 两种客户端模式（`http.ts:89`）：`desktop-continuous`（可信宿主中继，role=`trusted-host-relay`）与 `web-remote-replayable`（终端网页客户端）。可信模式才可调用 Provider Provisioning 写接口，普通 Web 客户端被显式降级拒绝（`http.ts` setupChannelServer 中 overrides 抛错逻辑）。
  - Host capability：`ZCODE_RPC_HOST_CAPABILITY_HEADER` 头携带 TTL 一次性令牌，消费型 store 校验（`packages/server/src/hostCapability.ts`、`http.ts:172` 的 `/api/rpc-host-capability` 签发）。
- 协议版本常量 `SERVER_REMOTE_PROTOCOL_VERSION = 1`（`packages/shared/src/server-remote.ts:3`）。

### 1.3 独立远端 Core 服务（packages/zcode-server-cli）——"远端机器上的常驻 Agent 服务"

这是 ZCode 最完整的"服务生命周期远控"组件（NOTICE.md 称"独立远端服务核心仅接受本机回环监听"）：

- 进程模型：`zcode-server-cli` CLI 的 `serve --daemon --supervisor` 启动 **Supervisor（父）+ Core（子）** 双进程；Supervisor 负责 OS 服务注册、崩溃预算（5 分钟窗口，退避 1/2/4/8/16s，`contracts.ts:5-6`）、代际（generation）管理与更新回滚（`src/supervisor/supervisor.ts`）。
- 监听：`src/server-core/http.ts:115-195`，Hono + `@hono/node-ws`：
  - **强制 loopback**：host 非 `127.0.0.1/::1/localhost` 直接抛错拒绝监听（`http.ts:126-132`，"fail-closed"，尚无 token middleware）。
  - `GET /api/server-info`：返回 `ServerRemoteInfo`（serverId 默认 hostname、version、protocolVersion、authRequired、capabilities）。
  - `GET /ws`：Web 远程可回放客户端（`web-remote-replayable`）。
  - `GET /ws/host`：桌面可信常驻通道（`desktop-continuous`），必须携带 `ZCODE_RPC_HOST_CAPABILITY_HEADER`，否则 401（`http.ts:157-163`）；`POST /api/rpc-host-capability` 签发。
- **Supervisor 控制管道（Windows 命名管道 / Unix domain socket）**：
  - 端点：Win32 `\\.\pipe\zcode-server-<8位路径哈希>`，POSIX `<root>/run/control.sock`（`src/runtime/paths.ts:43-46`；哈希为 FNV-1a 的 `stablePathId`，避免泄露家目录路径）。
  - 帧：**JSON Lines**（`src/ipc/framing.ts` 的 `encodeJsonLine`/`JsonLineDecoder`，单帧上限 64KB）。
  - 请求集（zod 判别联合，`src/contracts.ts:85-94`）：`ping` / `status` / `stop` / `restart` / `prepare-update` / `apply-update{force}` / `prepare-uninstall` / `confirm-uninstall{confirmation}`；响应 `{id, ok, result?, error?{code,message,retryable}}`。
  - Core→Supervisor 事件（`contracts.ts:114-135`）：`ready{host,port,version,generation}`、`heartbeat{at,runningTaskCount}`、`task-activity{runningTaskCount}`、`shutdown-ack`、`fatal`、`exit`。
  - 状态持久化：`<root>/run/status.json`，schema 见 `serverStatusSchema`（state 枚举 starting/ready/stopping/stop-failed/stopped/crashed/crash-loop-stopped/updating/uninstalling/uninstalled、pid、port、version、generation、runningTaskCount、crashBudget、`contracts.ts:29-45`）；CLI 命令 `status/stop/restart/update/uninstall --json` 直接消费（`src/cli.ts:92-107`）。
  - 鉴权：命名管道本身无 token，靠 OS 用户边界 + `chmod 0o600`（POSIX，`controlServer.ts:54`）；`--server-root` 隔离多套安装（`paths.ts:28-51`），并按真实路径收敛避免符号链接旁路（`cli.ts:87-91`）。
  - 数据根：`~/.zcode/server/`（或 `$ZCODE_DATA_BASE_DIR/.zcode/server`，`paths.ts:23-26`），布局含 `releases/ run/ bin/ service/` 等。

### 1.4 桌面端与远程工作区（packages/desktop + packages/server/src/remote）

- 桌面 Host（Node utilityProcess，见第 2 章）通过 `packages/server/src/remote/` 的 `IRemoteBackend` 抽象把 Agent 部署/运行到 **SSH / WSL / Docker** 远端（`ssh-backend.ts`、`wsl-backend.ts`、`docker-backend.ts`、`zcodeAgentDeploy.ts` 等），桌面主进程负责端口转发与附件路由（`packages/desktop/src/main/desktopRemoteSessions.ts`）。
- 桌面端"continuous"通道：`packages/desktop/src/host/index.ts:651,958` 等处，Host 以 `clientMode: "desktop-continuous"` 建立对话通道；`packages/desktop/src/main/desktopHostProcess.ts:242` 中该模式经 MessagePort/WS 由 main 中继。

### 1.5 Bot 通道与移动端预留

- Bot 提供方枚举：`telegram / webhook / feishu / lark / weixin / discord / wecom`（`packages/shared/src/bots.ts:24-31`）。Bots 服务（`packages/services/src/bots/bots.ts`）含 **bind code（配对码 + TTL 过期）**（`BotCreateBindCodeParams/BotBindCodeResult`）、webhook secret、入站/出站消息（`BotInboundMessage/BotOutboundMessage`）；定时任务结果可经 `ZCodeAutomationBotDeliveryTarget` 回推聊天（`packages/desktop/src/host/cronBotDelivery.ts`）。这是 ZCode 实际在用的"把任务输出送到手机/IM"的通道。
- 移动端：v4 线协议 `clientHello` 的 `clientKind` 枚举已含 `"mobileRemote" | "mobileApp"`（`packages/shared/src/zcode-protocol-v4/transport.ts:73`），但仓库内**没有手机端应用源码**，仅有协议预留位。

### 1.6 结论（第 1 章）

ZCode 的"远控"由三块拼成：**Web 远程（HTTP+WS Channel RPC，token 鉴权，明文）**、**Core 服务生命周期管道（loopback HTTP + 命名管道 JSONL）**、**Bot IM 外送（bind code 配对）**；没有独立的手机伴侣 App，也没有面向第三方进程的本地控制 API。传输加密（TLS/WSS）一律依赖部署层，协议面默认明文；Core HTTP 强制 loopback 是其安全兜底。

---

## 2. 进程 / 实例模型

### 2.1 桌面端进程树

```
ZCode.exe (Electron main, process.title=runtimeApplicationName)
 ├─ GPU / Renderer 等 Chromium 子进程（process 名约定 zcode-gpu / zcode-renderer-main）
 ├─ Host（utilityProcess.fork，process 名 zcode-host-<workspace标签>）
 │    └─ zcode agent（每 workspace 一个）：[Electron Helper --ELECTRON_RUN_AS_NODE=1] zcode.cjs app-server --stdio
 └─ 其他 helper（CUA、浏览器导入等）
```

- 单实例：`app.requestSingleInstanceLock(...)`，未拿到锁直接 `app.quit()`，第二个实例转为 `second-instance` 事件（聚焦窗口/处理 `zcode://` 深链工作区打开）（`packages/desktop/src/main/index.ts:1886-1916`）。锁的粒度是 **Electron userData 路径** → 换 userData 即可多开。
- userData/home 运行时覆盖（多开隔离的关键开关，`packages/desktop/src/main/index.ts:262-273`、`packages/desktop/src/main/desktopRuntimeEnv.ts:61-75`）：
  - `ZCODE_DESKTOP_HOME_DIR` → `app.setPath("home", ...)`（连带改变 `~/.zcode` 解析）
  - `ZCODE_DESKTOP_USER_DATA_DIR` → `app.setPath("userData", ...)`；`ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA` 控制是否用默认 userData
  - 业务数据根 `ZCODE_DATA_BASE_DIR`（`packages/services/src/paths.ts:11,33-40`），`ZCODE_HOME` 用于 helper 隔离场景（`desktopRuntimeEnv.ts:498`）。
- 进程命名约定（Windows 识别线索）：`packages/shared/src/process-names.ts:12-57`，统一前缀 `zcode-`，如 `zcode-main`、`zcode-gpu`、`zcode-host-<label>`、`zcode-renderer-main`/`zcode-renderer-<workspace标签>`；窗口标题形如 `ZCode` / `ZCode - <workspace>`（`process-names.ts:50-57` 的标题分支）。

### 2.2 CLI（apps/zcode-cli）

- 入口 `apps/zcode-cli/packages/cli/src/main.ts` → `run.ts` 分发；进程标题 `zcode-cli`（`packages/cli/src/process-name.ts:2,7-9`）。
- 全局参数（`packages/cli/src/arguments.ts:3-109`）：`-p/--prompt`（headless 单次任务）、`--output-format`、`--json`、`--resume <id>`、`-c/--continue`、`--mode`（headless 默认 `yolo`，见 NOTICE.md）、`--cwd`、`--target`、`--stdio`、`--surface`、`--prepare-storage` 等。
- 协议命令：`zcode app-server` / `zcode agent-server`（`isProtocolServerInvocation`，`arguments.ts:112-126`）→ stdout 是**严格的 ZCode Protocol NDJSON 帧通道**，所有 console 输出被强制改道 stderr（`main.ts:30-34`、`protocol-console.ts`）。桌面 Host 正是以 `app-server --stdio` 子进程方式消费它（见第 3 章）。
- 退出码：`normalizeProcessExitCode` 仅规范化为整数 0/1（`main.ts:106-115`）；协议模式还有 `createProtocolProcessLifecycle` 管理 stdin EOF 优雅退出（`protocol-lifecycle.ts`、`zcodeStdioTransport.ts:20` 的 STDIO_EOF_EXIT_WAIT_MS=1800ms）。

### 2.3 数据目录与多实例并发

- 目录布局（`packages/services/src/paths.ts`）：
  - 根：`~/.zcode`（可被 `ZCODE_DATA_BASE_DIR` / 桌面设置 `dataBaseDir` 整体改根）
  - 应用配置：`~/.zcode/v2/`：`tasks-index.sqlite`（`paths.ts:185-188`）、`sessions/{workspaceHash}/`（workspaceHash = workspaceKey 的 SHA-256 前 12 位，`paths.ts:195-206`）、`provider_config.json`、`setting.json`（原子写 + lock/tmp 兄弟文件）
  - CLI 会话库：`~/.zcode/cli/db/db.sqlite`（`apps/zcode-cli/packages/adapters/src/storage/session-store/paths.ts:6-8`）
  - Core：`~/.zcode/server/`
- SQLite 并发：全部使用 Node 内置 `node:sqlite` 的 `DatabaseSync`（`taskIndexRepo.ts:25-26`）；`tasks-index.sqlite` 显式 `PRAGMA journal_mode = WAL`（`packages/services/src/session/taskIndexRepo.ts:529`、`tasksDatabase/startup.ts:70`）；CLI 会话库迁移器设 `busy_timeout` 并强制 WAL（`session-store/migration-runner.ts:66,140-144`）。→ **多个实例默认共享同一个 `~/.zcode`，靠 WAL + busy_timeout 并发共存；这是"共享写入"而非隔离**。真正隔离需改变数据根（`ZCODE_DATA_BASE_DIR` / `ZCODE_DESKTOP_HOME_DIR`）。
- 实例标识：
  - 工作区级：`workspaceHash`（SHA-256 前 12 位）+ `workspaceIdentity`（远程优先，`paths.ts:190-201`）
  - 服务级：Core `serverId`（默认 hostname）+ `generation`；主机级 `deviceMid`（Host 初始化下发，`desktopHostProcess.ts:56`）；连接级 `connectionId`（randomUUID）
  - **没有全局 machineId/installId 主键**；多实例识别需组合进程/管道/目录线索（第 6 章给出操作方案）。

---

## 3. 任务控制面（可编程接口）

### 3.1 桌面端的真实控制链

桌面 UI → (Electron MessagePort / WS) → Host 内 `ServiceCollection` RPC → `IZCodeAgentService` → 每 workspace 的 `zcode app-server --stdio` 子进程（NDJSON ZCode Protocol）。三层都可复用：

- spawn 参数与候选链（`packages/services/src/zcode-agent/zcodeAgentProcessManager.ts:354-460`）：
  1. 环境变量直配：`ZCODE_AGENT_SERVER_COMMAND` + `ZCODE_AGENT_SERVER_ARGS_JSON`（默认 `["app-server","--stdio"]`）+ `ZCODE_AGENT_SERVER_CWD`
  2. monorepo dev：`process.execPath apps/zcode-cli/packages/cli/dist/zcode.cjs app-server --stdio`，`ELECTRON_RUN_AS_NODE=1`
  3. 桌面打包态：Electron Helper 以纯 Node 模式运行 resources 里的 zcode bundle
  4. 部署态原生二进制：`GLM_BINARY_PATH` / `~/.zcode/server/agents/glm` 等，spawnArgs 恒为 `["app-server","--stdio"]`（`packages/shared/src/zcode-agent-runtime.ts:26-41`）
- 传输（`packages/services/src/zcode-agent/zcodeStdioTransport.ts`）：**LF 定界的 NDJSON**（明确不用 readline，防 U+2028/2029 切帧，`:62-64`），消息经 `zcodeProtocolMessageSchema`（zod）校验；正常退出边界 = stdin EOF。
- 进程树终止：`terminateProcessTree` + Windows taskkill 兜底（`zcodeStdioTransport.ts:10-14`、`processTreeTerminator.ts`），是停任务时"杀干净"的现成实现。

### 3.2 ZCode Protocol（legacy 主协议，`zcodeProtocolMethods`）

定义于 `packages/shared/src/zcode-protocol/index.ts:3564-3673`，JSON-RPC 风格（`id/method/params` ↔ `result|error{code,message,data}`，错误码沿用 -32602/-32603，`server-types.ts:163-269`）。方法全表（节选，完整见源码）：

- 会话/任务：`session/create`、`session/resume`、`session/list`、`session/read`、`session/messages`、`session/events`、`session/subscribe`、`session/send`、`session/stop`、`session/cancelBackgroundTask`、`session/fork`、`session/compact`、`session/goal`、`session/close`、`session/subagents`
- **模型/模式**：`session/setModel`、`session/setThoughtLevel`、`session/setMode`、`provider/testModelConnectivity`、`provider/updateAccountConfig`
- 自动化：`automation/create|update|list|delete|checkTaskBinding`、`offPeak/create|list`
- 周边：`plugins/*`（16 个）、`workflows/list|get|updateMeta|delete|runs|move`、`mcp/list`、`process/childProcesses`（MCP 子进程 pid 采样）、`usage/stats`、`interaction/*`（权限/用户输入反向请求）、`workspace/*`（偏好、hook 信任、演示投影）
- 服务端实现：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts` + `server-operations.ts`（约 4000 行，含 `setModel`/`stopSession`/`cancelBackgroundTask` 等 op）。

### 3.3 v4 conversation 通道（桌面新主链，功能最全）

- 握手：`hello{protocolVersion:3, clientMode, deliveryProfile, serverTime, capabilities{binaryFrames, compression, ...}}` ↔ `clientHello{clientId, clientKind(desktop|web|mobileRemote|mobileApp), appVersion}`（`packages/shared/src/zcode-protocol-v4/transport.ts:28-100`）。
- 帧：topic 信封 `complete | fragment`（大帧分片、seq 原子序、checksum、deliveryKind initial/online/recovery）（`zcode-protocol-v4/wire.ts`）。
- 命令集（`packages/shared/src/zcode-protocol-v4/command.ts:46-235`）：`createSession`、`createSelectionSideSession`、**`sendText`**（含附件、排队、模型选择、automationId）、`sendGoalCommand`、**`stop`**、`compact`、`forkAssistant`、`retryTurn`、`applyFileRewind`、`editUserQuery`、队列五件套（`sendQueuedNow/editQueueItem/reorderQueueItem/deleteQueueItem/setAutoDrain`）、`resolveInteraction`（远程应答权限/提问）、`respondWorkspaceHookReview` 系、**`switchModelConfig`**、`switchCollaborationMode`、**`cancelBackgroundWork`**、`startSavedWorkflow`、`resumeWorkflowRun`。

### 3.4 Host 内服务面 `IZCodeAgentService`（TS API，最易被 Nexus 复用）

`packages/services/src/zcode-agent/zcodeAgent.ts:569-760+`：`createSession/resumeSession/listSessions/readSession*(messages/events/subagents)`、`sendPrompt/compactSession/goalSession/closeSession`、**`setModel/setThoughtLevel/setMode`**、`testModelConnectivity`、`getTaskTokenUsage/getAppUsageStats`、automation 全套（`list/create/update/delete/setAutomationEnabled/restartAutomation/runAutomationNow/listAutomationRuns`）、workflows/plugins 全套、`collectLocalRuntimeChildProcesses`（枚举本 Host 内全部本地 Agent 进程）、v4 conversation 订阅/分页/工作流事件。该服务经 `ServiceChannels.ZCodeAgent`（"zcode-agent"）频道在 WS/MessagePort 上暴露（`server-core/http.ts:97-108`、`packages/server/src/http.ts` setupChannelServer）。

### 3.5 任务索引库（只读投影面）

`~/.zcode/v2/tasks-index.sqlite` 的 `task_index` 行结构（`packages/services/src/session/taskIndexRepo.ts:59-82`）：`workspace_key/path/identity、task_id、title、task_status、provider、mode、model、cron_automation_id、off_peak_task_id、created_at/updated_at/unread_at、pinned/archived/deleted、meta_json`。任务列表服务 `zcodeTaskService`（`packages/services/src/session/zcodeTaskService.ts`：`createTask/listTasks/rename/archive/delete/分组`）。→ **外部进程可以只读打开该库（WAL 允许并发读）得到"有哪些任务、状态、模型、最近活跃"**。注意桌面调度器（desktop 定时任务）在 `packages/desktop/src/main/desktopCronScheduler.ts` 与 `packages/desktop/src/scheduler/`，其会同时打开 tasks-index（`main/index.ts:1949-1951` 注释），数据库准备流程见 `packages/shared/src/database-startup.ts`。

### 3.6 Core 生命周期控制（服务级启停）

见 1.3：`status/stop/restart` 命令 + `run/status.json` 快照 + 命名管道，是"重启 ZCode 服务实例"的现成协议。桌面 App 本体没有等价控制管道（只有 Electron 单实例锁 + 深链）。

---

## 4. 模型 / Provider 配置与切换

- **配置文件**：
  - 个人 provider 配置：`~/.zcode/v2/provider_config.json`（常量 `PERSONAL_PROVIDER_CONFIG_FILE_NAME`，`packages/provider-node/src/runtime-paths.ts:5`；落盘路径 `packages/services/src/node.ts:2245`：`join(getAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME)`）。路径可用 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` / `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 覆盖（`runtime-paths.ts:1-4`）。
  - CLI 原生配置：`~/.zcode/cli/config.json`（`packages/shared/src/zcode-agent-runtime.ts:32-33`）。
- **热载**：`NodeProviderConfigRuntime` 支持 `personalPollingIntervalMs` 轮询个人配置文件变更（`packages/provider-node/src/provider-config-runtime.ts:28-31` 的 `watch`/轮询选项），Host 在 spawn agent 前先 `providerConfigRuntime.start()`（`packages/services/src/node.ts:2222`）。→ **改 `provider_config.json` 会被运行中的 Host 按轮询周期吸收，无需重启**；协议层另有 `provider/updateAccountConfig` 显式推送进程级账号配置（`zcode-protocol/server.ts:70` 导入 `updateAccountProviderConfig`）。
- **运行中切模型**（不改配置文件）：
  - 会话级：legacy `session/setModel`（仍被桌面旧链路 `zcodeAgentService.ts` 消费，`packages/shared/src/zcode-protocol/index.ts:3630-3633` 注释）；v4 命令 `switchModelConfig{provider, model, thought...}` 与 `switchCollaborationMode`（`command.ts:208-219`）；`session/setMode`、`session/setThoughtLevel`。
  - 新会话默认模型：`session/create` params 带 `modelSelection{provider, model, thought}`（`command.ts:31-40`）；冷恢复绑定 `restoredModelSelection`（`server-types.ts:117`）。
  - 连通性验证：`provider/testModelConnectivity`（`workspace-model-runtime.ts`）。

---

## 5. 多开识别（Windows 可操作线索）

| 线索 | 证据 | 操作建议 |
|---|---|---|
| 进程名约定 | `packages/shared/src/process-names.ts`（`zcode-main` / `zcode-host-<ws>` / `zcode-renderer-...`），CLI `process.title="zcode-cli"`（`cli/src/process-name.ts`） | `tasklist`/WMI `Win32_Process` 按 exe 名（ZCode.exe / ZCode Helper*）+ `process.title` 过滤不可靠时，按命令行匹配 |
| 命令行特征 | Host agent 子进程命令行含 `app-server --stdio`（`zcodeAgentProcessManager.ts:369`）；electron helper 带 `ELECTRON_RUN_AS_NODE=1` | WMI `CommandLine LIKE '%app-server --stdio%'` 精确枚举所有 agent；其父进程链即桌面实例 |
| cwd = 工作区 | spawn `cwd: context.workspacePath`（`zcodeAgentProcessManager.ts:378` 等） | 用 agent 进程的 cwd 区分"哪个实例在跑哪个项目" |
| 窗口标题 | `ZCode` / `ZCode - <workspace>`（`process-names.ts:50-57`）；`process.title = runtimeApplicationName`（`main/index.ts:276`） | `EnumWindows` 标题匹配，辅助定位主窗口 |
| 单实例锁 | `app.requestSingleInstanceLock`（`main/index.ts:1886`）——默认 **同 userData 只允许 1 个实例** | 多开必须设置不同 `ZCODE_DESKTOP_USER_DATA_DIR`（`desktopRuntimeEnv.ts:72`）；识别"是否多开"＝检查启动 env/不同 userData 路径的锁文件 |
| Core 管道 | `\\.\pipe\zcode-server-<8hex>`（`server-cli/runtime/paths.ts:43-46`），`<root>/run/status.json`、`<root>/run/server.lock`（DataRootLock） | 枚举 `\\.\pipe\` 下 `zcode-server-*` 前缀即知装了几套 Core；读 `~/.zcode/server/run/status.json` 拿 pid/port/state |
| 数据根指纹 | `~/.zcode/v2/`、`~/.zcode/cli/db/db.sqlite`；数据根可被 `ZCODE_DATA_BASE_DIR` 改写（`services/src/paths.ts:11,33`） | 扫描各候选 home 的 `.zcode/v2` 存在性 + `tasks-index.sqlite` mtime 判断活跃实例 |
| 深链 | `zcode://workspace/open?path=...`（`desktopFinderOpenFolderWorkflow.ts:25`、`desktopOAuthDeepLink.ts:398-426` `setAsDefaultProtocolClient`） | 可作为"唤起/聚焦已有实例并打开工作区"的官方入口（带确认 gate，`main/index.ts:1874-1881`） |

---

## 6. 可复用性评估（License 与模块边界）

- **License**：Apache-2.0（根 `package.json` `"license": "Apache-2.0"`、`LICENSE`），非 MIT；`NOTICE.md` 为中文功能边界与第三方声明，`THIRD-PARTY-NOTICES.md` 汇总第三方。复用需保留 LICENSE/NOTICE 声明，Apache-2.0 允许闭源衍生（带声明）。
- 可直接 import 的包（workspace 内均 `"private"`/Apache-2.0）：
  - `@zcode/rpc`：无外部重依赖的 RPC 栈，最干净的可复用件
  - `@zcode/shared`：全部协议 zod schema（`zcodeProtocolMethods`、v4 wire、`ServerRemoteInfo`、`ServiceChannels`）——协议对齐的单一代价是引入此包
  - `@zcode/services`：`createLocalServices`/`IZCodeAgentService`（Node 侧，含 sqlite 仓储）
  - `@zcode/server`：`createHttpServer`（自带 token 鉴权与 WS ChannelServer）
  - `@zcode/zcode-server-cli`：`requestControl` + `contracts.ts` schema（命名管道控制客户端可直接拷用）
  - `packages/zcode-cua`：**占位不可用**（NOTICE.md 明示调用返回不可用错误，`packages/zcode-cua/index.js:3`）
- 需适配的：Core（面向"远端服务"而非"桌面实例"）；Web 远程服务（默认未随桌面启动，需自行拉起 `@zcode/server` entry-http）。
- 不存在、需 Nexus 自研的：对**已在运行的桌面 ZCode 实例**的跨进程注入式控制通道（桌面 Host RPC 只经 Electron MessagePort，第三方进程无法直接挂接）；实例发现/注册中心；手机伴侣端（仅协议留位）。

---

## 附：关键文件索引

| 主题 | 路径 |
|---|---|
| RPC 栈 | `F:\ZCode-main\packages\rpc\src\{protocol,persistent-protocol,channelServer,channelClient,remote}.ts` |
| Web 远程服务 | `F:\ZCode-main\packages\server\src\{entry-http,http,hostCapability}.ts` |
| Core 服务 | `F:\ZCode-main\packages\zcode-server-cli\src\{cli.ts,contracts.ts,server-core\http.ts,ipc\{controlServer,controlClient,framing}.ts,runtime\paths.ts,supervisor\supervisor.ts}` |
| 桌面单实例/多开 env | `F:\ZCode-main\packages\desktop\src\main\index.ts`(L1886,L262-276)、`desktopRuntimeEnv.ts`(L61-75)、`desktopSecondInstanceDeepLink.ts` |
| 桌面 Host 进程 | `F:\ZCode-main\packages\desktop\src\main\desktopHostProcess.ts`、`packages\desktop\src\host\index.ts` |
| Agent 子进程管理 | `F:\ZCode-main\packages\services\src\zcode-agent\zcodeAgentProcessManager.ts`(L340-460)、`zcodeStdioTransport.ts` |
| 协议方法表 | `F:\ZCode-main\packages\shared\src\zcode-protocol\index.ts`(L3564-3673)、`zcode-protocol-v4\{transport,command,wire}.ts` |
| 协议服务端 | `F:\ZCode-main\apps\zcode-cli\packages\bootstrap\src\zcode-protocol\{server,server-operations,server-types}.ts` |
| CLI 入口/参数 | `F:\ZCode-main\apps\zcode-cli\packages\cli\src\{main,run,arguments,process-name}.ts` |
| 数据路径/SQLite | `F:\ZCode-main\packages\services\src\paths.ts`、`session\taskIndexRepo.ts`、`session\tasksDatabase\startup.ts`、`apps\zcode-cli\packages\adapters\src\storage\session-store\{paths,migration-runner}.ts` |
| Provider 配置 | `F:\ZCode-main\packages\provider-node\src\{runtime-paths,provider-config-runtime,personal-provider-config-repository}.ts`、`packages\services\src\node.ts`(L2245) |
| 进程命名 | `F:\ZCode-main\packages\shared\src\process-names.ts` |
| Bot 通道 | `F:\ZCode-main\packages\shared\src\bots.ts`、`packages\services\src\bots\bots.ts`、`packages\desktop\src\host\cronBotDelivery.ts` |
