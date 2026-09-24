# ZCode 远控复用方案（Nexus v2）

- 前置文档：《ZCode 远控源码分析报告》（同目录），本文所有路径证据均见该报告，不再重复展开。
- 目标：Nexus v2 在 Windows PC 端对**本机运行的 ZCode 实例**实现有限反向控制（查看状态、启停任务、查看输出、切换模型、重启实例）与多开实例管理。

---

## 1. 可复用性总判

| 类别 | 结论 | 依据 |
|---|---|---|
| License | Apache-2.0，可商用闭源衍生（保留 LICENSE/NOTICE 声明） | `F:\ZCode-main\LICENSE`、`package.json`、`NOTICE.md` |
| 可直接 import | `@zcode/rpc`、`@zcode/shared`（协议 zod schema）、`@zcode/zcode-server-cli`（控制管道客户端）、`@zcode/server`（HTTP+WS 服务）、`@zcode/services`（服务实现） | 各包 `package.json` 均为 workspace 内私有包，无许可冲突 |
| 需协议适配 | Core 生命周期管道（面向"远端服务"）、Web 远程服务（桌面默认不启动） | `zcode-server-cli/src/server-core/http.ts`（强制 loopback） |
| 需 Nexus 自研 | ①发现/枚举本机 ZCode 实例；②对"已在运行的桌面实例"的跨进程控制通道（ZCode 未开放）；③实例注册中心与凭据管理 | 桌面 Host RPC 只经 Electron MessagePort，第三方进程无法挂接（`desktopHostProcess.ts`） |
| 不可复用 | `packages/zcode-cua`（占位实现，调用即报不可用） | `NOTICE.md`、`packages/zcode-cua/index.js:3` |

---

## 2. 替代路径评估（ZCode 无现成"第三方远控组件"时的四条路）

### 路径 A：CLI 子进程控制（`zcode app-server --stdio`）——功能最强

**原理**：桌面端自己就是用这条链控制任务的（`packages/services/src/zcode-agent/zcodeAgentProcessManager.ts:369`：`[node/electron-helper] zcode.cjs app-server --stdio`，cwd=工作区）。Nexus 用完全相同的方式拉起并持有协议子进程，即获得与桌面 UI 同级的控制面。

- 协议：LF 定界 NDJSON，JSON-RPC 风格（`id/method/params` → `result|error`），消息 schema 全部在 `@zcode/shared` 的 `zcodeProtocolMessageSchema` 下，可整体 import 做编解码校验（`packages/services/src/zcode-agent/zcodeStdioTransport.ts` 是参考实现，仅约 300 行）。
- 可落地的指令集（对照 Nexus 需求）：

| Nexus 指令 | 协议方法（legacy） | v4 命令 | 备注 |
|---|---|---|---|
| 启动任务/会话 | `session/create`（params 带 `modelSelection{provider,model,thought}`、`mode`、toolAllow/Denylist） | `createSession` | v4 为桌面新主链 |
| 发送输入 / 续跑 | `session/send` / `session/resume` | `sendText` / `resumeWorkflowRun` | v4 sendText 支持排队/打断语义（`requestedDelivery`） |
| 停止任务 | `session/stop`、`session/cancelBackgroundTask` | `stop` / `cancelBackgroundWork{workId}` | |
| 查看状态 | `session/read`、`session/list` | v4 snapshot/sessions-index 帧 | |
| 查看输出 | `session/messages`、`session/events`、`session/subscribe`（事件流） | `conversationRowsRangeV4` + topic 订阅 | |
| 切换模型 | `session/setModel`、`session/setMode`、`session/setThoughtLevel` | `switchModelConfig` / `switchCollaborationMode` | 会话级即时生效，无需重启 |
| 退出实例 | 关闭 stdin（正常退出边界=stdin EOF，1.8s 宽限）+ 进程树终止 | — | 复用 `processTreeTerminator` 思路（Windows taskkill /T） |

- **局限**：控制的是 Nexus 自己 spawn 的实例；对"用户已打开的桌面 ZCode"无能为力（它已有自己的 app-server 子进程，协议无 attach 通道）。
- 单次任务也可用更简单的 headless：`zcode -p "<任务>" --output-format json --mode <mode>`（`apps/zcode-cli/packages/cli/src/arguments.ts`；headless 默认 `yolo` 模式，见 NOTICE.md，**需显式收紧 `--mode`**），退出码 0/1（`cli/src/main.ts` `normalizeProcessExitCode`）。

### 路径 B：共享数据库只读监控——多开状态面

- 读 `~/.zcode/v2/tasks-index.sqlite`（WAL，`node:sqlite` 可多进程并发读；行结构含 `task_status/provider/model/cron_automation_id/meta_json`，`packages/services/src/session/taskIndexRepo.ts:59-82`）+ `~/.zcode/v2/sessions/{workspaceHash}/` 快照。
- 用 Node `DatabaseSync` 以 `file:...?mode=ro` 只读打开即可，零侵入。
- **局限**：只有持久化投影（任务列表/状态/元数据），拿不到实时输出流，也下不发指令；桌面正在运行但未落库的 turn 状态不可见。
- 定位：与 A 互补的"发现 + 巡检"面，也是多开识别的数据源。

### 路径 C：Core 生命周期管道——服务级启停/重启

- 若目标机器装有独立远端 Core（`~/.zcode/server/`），直接复用 `@zcode/zcode-server-cli` 的 `requestControl`（Windows 命名管道 `\\.\pipe\zcode-server-<fhash8>`，JSONL，`ping/status/stop/restart`，`contracts.ts:85-94`），加读 `~/.zcode/server/run/status.json`。
- **局限**：只覆盖 Core 服务形态，不覆盖桌面 App 进程；管道无 token 鉴权，Nexus 调用方应保持本机同用户边界。

### 路径 D：Electron 窗口消息 / remote——不可行

- 桌面 Host RPC 依托 Electron `utilityProcess` + `MessageChannelMain`（`desktopHostProcess.ts:11-14`），渲染层走 preload IPC；Electron 41 已无 `remote` 模块，第三方进程没有任何受支持的挂接点。仅 `zcode://` 深链可"唤起/聚焦/打开工作区"（`desktopOAuthDeepLink.ts:398-426`，带确认 gate），可作为辅助交互，不能承载指令。

### 路径 E（改造路线）：给桌面 ZCode 打补丁开放本地控制端口

- ZCode 已内置全部积木：`packages/server` 的 `createHttpServer`（token 鉴权 + WS ChannelServer + `IZCodeAgentService` 频道暴露）+ `hostCapability` TTL 令牌（`/api/rpc-host-capability` 签发、`ZCODE_RPC_HOST_CAPABILITY_HEADER` 消费）。理论上在桌面启动流程里加一条 loopback 监听即可让 Nexus 以 `web-remote-replayable`/`desktop-continuous` 客户端接入。
- 但这要求维护一个 ZCode fork 分支，升级即冲突；仅当 Nexus 允许"受控版 ZCode 分发"时采用。

---

## 3. 主方案推荐

> **主方案：以「路径 A（CLI 子进程 `zcode app-server --stdio`，NDJSON ZCode Protocol）」为唯一控制通道，以「路径 B（tasks-index.sqlite 只读）」为多开发现与状态巡检面，以「路径 C（命名管道 requestControl）」为可选的服务级启停；对"已运行的桌面实例"只做只读监控与深链唤起，不承诺写入控制。**

理由：
1. 协议、schema、参考实现、进程管理/终止代码在源码中全部现成（`@zcode/shared` + `zcodeStdioTransport.ts` + `processTreeTerminator.ts`），Nexus 只需实现 spawn/帧解析/重连，风险最低；
2. 该通道正是桌面官方链路，升级兼容性由 ZCode 自身的降级重试机制背书（如 `zcodeAgentService.ts:375-390` 对旧 app-server 的 omittedFields 降级）；
3. 模型切换、输出流、启停、任务创建全在这一条通道内闭环，无需第二套协议。

### 3.1 Nexus 有限指令集（v2 建议冻结为以下 9 条）

| # | 指令 | 实现 | 对应 ZCode 协议 |
|---|---|---|---|
| 1 | `instance.start(workspace, opts)` | spawn `<zcode 入口> app-server --stdio`，cwd=workspace；入口探测顺序：`ZCODE_NEXUS_ZCODE_COMMAND` → `where zcode` → `%LOCALAPPDATA%\Programs\ZCode\resources` 下 bundle → `~/.zcode/server/agents/glm` 原生二进制 | — |
| 2 | `instance.status` | hello/initialize 握手 + `session/list`；进程存活探测 | `runtime/capabilities`、`session/list` |
| 3 | `task.create(prompt, model?)` | `session/create` + `session/send`（或 v4 `createSession`+`sendText`） | 同左 |
| 4 | `task.stop(taskId)` | `session/stop` / `session/cancelBackgroundTask` | 同左 |
| 5 | `task.output(taskId, since)` | `session/messages` / `session/subscribe` 增量 | 同左 |
| 6 | `model.switch(sessionId, provider, model)` | `session/setModel`（legacy 通道即可，桌面仍在用）或 v4 `switchModelConfig` | 同左 |
| 7 | `task.list()`（跨实例） | 读 `~/.zcode/v2/tasks-index.sqlite`（mode=ro）+ 各实例 `session/list` 合并 | B 路径 |
| 8 | `instance.stop` | stdin EOF + `terminateProcessTree`（Windows taskkill /T 兜底，参照 `zcodeStdioTransport.ts:20-24` 常量） | — |
| 9 | `service.restart`（可选，仅 Core 形态） | `requestControl(pipe, {command:"restart"})` | C 路径 |

### 3.2 消息帧示例（对齐源码 schema）

```jsonc
// → 请求（NDJSON 一行）
{"id":"8f2…","method":"session/create","params":{"workspace":{"path":"F:\\demo"},"modelSelection":{"provider":"zcode","model":"GLM-5.3"}}}
// ← 响应
{"id":"8f2…","result":{"sessionId":"sess_…","state":{…}}}
// ← 通知（输出流）
{"method":"session/event","params":{"sessionId":"sess_…","seq":12,"event":{…}}}
```

字段细节以 `packages/shared/src/zcode-protocol/index.ts` 的 zod schema 为准（建议 Nexus 直接依赖该包做编码/解码/校验，避免手写漂移）。

### 3.3 多开实例管理设计要点

1. **发现**：
   - WMI `Win32_Process` 过滤命令行含 `app-server --stdio` 的进程 → 每个 agent 进程即一个"任务运行实例"，取其 cwd 作为工作区身份、PPID 链定位宿主（桌面实例或 Nexus 自己的）；
   - 扫描 `~/.zcode/server/run/status.json` 与 `\\.\pipe\zcode-server-*` → Core 形态实例（`stablePathId` 由 server root 推导，见 `zcode-server-cli/src/runtime/paths.ts:89-98`）；
   - 扫描各候选数据根的 `~/.zcode/v2/tasks-index.sqlite` mtime → 活跃数据根。
2. **隔离多开**（Nexus 自管实例，互不串数据）：为每个实例注入独立环境 `ZCODE_DATA_BASE_DIR=<nexus>/instances/<id>/home`（`packages/services/src/paths.ts:11,33-40`）——CLI 侧无锁冲突；若多开的是**桌面 App**，还需同时设 `ZCODE_DESKTOP_USER_DATA_DIR` 与 `ZCODE_DESKTOP_HOME_DIR`（否则 `requestSingleInstanceLock` 直接退出第二实例，`main/index.ts:1886-1889`）。
3. **实例唯一标识**：ZCode 无全局 machineId；Nexus 侧以 `数据根路径哈希 + workspaceHash`（SHA-256 前 12 位规则同 `services/src/paths.ts:195-201`）合成稳定 ID，并记录 spawn 时的 pid/启动时间做生命周期核对。
4. **并发写库**：多实例默认共享同一数据根时依赖 WAL + busy_timeout（`migration-runner.ts:66,140-144`），Nexus 自身对该库只读，避免成为写入方。

### 3.4 风险与边界（须写入 Nexus 设计文档）

- **权限模式**：CLI headless 默认 `yolo`（NOTICE.md 明示）；Nexus spawn 时必须显式传安全 `--mode`（如 `build`/`plan`）或配置 allowlist，防止远控接口被滥用为无审批执行面。
- **协议无鉴权**：`app-server --stdio` 面向父进程，无 token；Nexus 通道安全 = 进程边界。若未来把控制面暴露到网络（如 Nexus 远程页），必须自加鉴权与 TLS，不可复用 ZCode 的裸 stdio。
- **版本兼容**：`SERVER_REMOTE_PROTOCOL_VERSION=1`、CLI 协议 `ZCODE_PROTOCOL_VERSION=1`、v4 wire=3（`zcode-protocol/index.ts:10-13`）；ZCode 对旧客户端采取 strict schema + omittedFields 降级，Nexus 侧建议同样做"未知方法忽略、缺字段重试"的容错。
- **不碰桌面私有通道**：不要尝试注入桌面 Electron（路径 D），升级必碎。
- **调度边界**：桌面定时任务调度器在桌面 App 内（`desktopCronScheduler.ts`），CLI 无持久调度服务（NOTICE.md）；Nexus 需要定时任务时自行排程再调用 `task.create`。

---

## 4. 分阶段落地建议

1. **Phase 1（只读，1 周）**：tasks-index.sqlite 只读投影 + 进程枚举（WMI）+ Core status.json 读取 → 实例/任务状态面板。
2. **Phase 2（受控写入，2-3 周）**：spawn `app-server --stdio`，移植 `zcodeStdioTransport` 帧层，实现指令集 #1-#8；协议 schema 直接依赖 `@zcode/shared`。
3. **Phase 3（可选）**：Core 管道接入 `requestControl`（#9）；评估路径 E（受控版桌面开放 loopback WS）仅当产品决定维护 fork。
