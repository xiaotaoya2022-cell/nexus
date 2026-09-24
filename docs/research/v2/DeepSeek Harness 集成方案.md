# DeepSeek Harness × Nexus 集成方案

> Nexus v2 补强 · 调研子代理 T3 · 2026-09-24
> 前置文档：《DeepSeek Harness 调研报告》（同目录，接口证据均在彼处，本文只引用不重复）
> 范围对齐《Nexus 能力补强指导书 v2》§3.3：**有限反控 = 查看运行状态、启停任务、获取输出**；不做任务调度、不做 Agent 切换、不提供云中继。

---

## 1. 需求 → 接口映射（先给答案）

| Nexus 反控需求 | 用什么接口 | 鉴权 | 证据（调研报告 §） |
|---|---|---|---|
| 进程发现/健康检查 | `GET http://127.0.0.1:{端口表}/ext/bridge-config` | 无需 | §5.0 |
| 查看运行状态 | `session.list`（会话清单+运行态）+ SSE `host/session-status` / `session/jobs` 事件 | 回环免鉴权 | §5.2/§5.3 |
| 启动任务 | `session.create` + `session.prompt`（流式下发） | 回环免鉴权 | §5.2 |
| 停止任务 | `session.cancel`（停当前轮次）；后台任务随 `session/jobs` 生命周期推送 | 回环免鉴权 | §5.2/§5.3 |
| 获取输出（实时） | SSE `GET /api/events.mux`：`assistant/chunk(text-delta)` 增量、`turn/end` 收尾 | 回环免鉴权 | §5.3 |
| 获取输出（历史/归档） | `session.history`（分页）；`GET /api/session.export`（ZIP 全量含子代理） | 回环免鉴权 | §5.1/§5.2 |
| 审批交互（增强） | `approval/requested` 事件 + `POST /api/respond` | 回环免鉴权 | §5.3 |
| 插件启停管理（增强） | 复用已装自研插件 `/ext/trimode`：`trimode.plugins.list` / `setEnabled` | WS + `~/.dsh/ext-bridge-token` | §6.3 |
| DSH 进程启停（本机） | 拉起：spawn `npx --prefer-offline @deepseek-ai/dsh@<pin> web`；停止：`taskkill /PID <pid> /T /F`（端口→PID） | 本机权限 | §4.1/§4.2 |
| 一次性任务（备选） | `dsh --profile headless "task"` 子进程，stdout=结果、exit code=成败 | 本机 | §5.5 |

**核心结论：同机场景下不需要给 DSH 装任何东西**。`/api` 网关 + SSE 已经把三类反控需求全覆盖，且对回环来源免鉴权；插件路线只作为增强项。

## 2. 总体架构

```
┌─ Nexus (Electron, F:\Nexus) ──────────────────────────────┐
│ renderer (React/zustand)                                   │
│   ▲ ipcRenderer.invoke / 事件推送                           │
│   │                                                        │
│ main: DshBridgeService（新增，主进程单例）                  │
│   ├─ DshLocator      进程发现/健康检查/端口表探测            │
│   ├─ DshProcessCtl   拉起/停止 DSH 进程（可选开关）          │
│   ├─ DshApiClient    POST /api/<method>（Node fetch，无CORS）│
│   ├─ DshEventStream  GET /api/events.mux（SSE 重连+基线对账）│
│   ├─ DshPluginCtl    WS /ext/trimode（可选，插件启停）       │
│   └─ DshOneShot      dsh --profile headless（备选发射器）    │
└──────────────┬─────────────────────────────────────────────┘
               │ 127.0.0.1:3080（回环 only）
        ┌──────▼───────────────────────────────┐
        │ DSH web（单实例 Node）                │
        │  /api(RPC) · /api/events.mux(SSE)     │
        │  /ext/bridge(WS) · /ext/trimode(WS)   │
        └───────────────────────────────────────┘
```

放置层：`src/main/services/dsh-bridge/`（electron-vite 主进程）；renderer 通过 `ipcMain.handle` + `webContents.send` 消费。**禁止在 renderer 直连**（端口/进程信息不该进渲染层，且便于集中重连与脱敏）。

## 3. 进程发现与健康检查（DshLocator）

1. **端口表探测**：对 `DISCOVERY_PORTS = [3080, 3081, 3090, 16473, 18121, 58883]` 逐个 `GET /ext/bridge-config`（1.5s 超时，取 `wsUrl` 判活）——与官方 Chrome 扩展完全同款（调研报告 §5.0）。另读 `~/.dsh/settings.yaml` 的 `dsh-desktop.port` 作为首位提示（存在则跳过盲扫）。
2. **状态模型**：`stopped → probing → running(端口,wsUrl) → degraded(端口活但 /api 不可用)`。探活节流：稳态 30s 一次，非稳态 3s 退避。
3. **降级探针**：`POST /api/host.describe`（无副作用方法）作为 `/api` 层健康检查；若 404/`internal`（版本差异）→ 标记 degraded，UI 提示"DSH 版本可能不兼容"。
4. **未运行时**（可配置，默认关闭自动拉起）：
   - 拉起命令：`npx --prefer-offline @deepseek-ai/dsh@0.1.1-rc.2 web`（与本机 `start-dsh-web-0111rc2.cmd` 一致；版本号从 Nexus 配置读，默认随本机 pin）。
   - 先查端口占用：`netstat -ano` 找 LISTEN→PID（抄 `start-dsh-web-patched.cmd` 的幂等逻辑）；**DSH 有单实例锁**，禁止盲启（调研报告 §9）。
   - `spawn(..., { detached: false, windowsHide: true })`，Nexus 退出策略 = 不杀用户进程（Nexus 只是监控者，退出不连带停 DSH）。
   - 明确 UI 文案：这是"代为启动 DSH"，不是"启动 Nexus 的子任务"。

## 4. 通道选型（决策记录）

| 通道 | 优点 | 缺点 | 判定 |
|---|---|---|---|
| **A. 直连 `/api` + SSE**（主通道） | 零安装零侵入；回环免鉴权；官方一等公民接口；Node fetch 无 CORS 问题 | 若上游未来给 `/api` 加鉴权需适配 | ✅ **采用** |
| B. WS 桥 `/ext/bridge` + token | 与移动端范式一致，远程可复用 | **单连接顶替语义：会挤掉用户手机/Chrome 扩展的连接**；两层信封坑 | ⛔ 同机不用；仅当未来 Nexus 做远程中继时再评估 |
| C. 自研 cordis 插件挂 `/ext/nexus` | 可做聚合推送、不受 `/api` 演进影响 | 需随 DSH 启动装载、升级要重启 DSH；维护两套 | ⏸ 增强项，v2 先不做 |
| D. `dsh --profile headless` 子进程 | 最简单，天然隔离 | 无流式、无状态查看、每次新会话 | ✅ 作为"一次性发射"备选入口 |
| E. `/ext/trimode` 插件管理 | 用户自研、已在装、7/7 单测 | 只管插件启停，需重启 DSH 生效 | ✅ 插件管理页直接复用 |

> B 通道的关键否决理由必须写进代码注释：`/ext/bridge` 是"同一时刻仅一个活动连接，新认证顶替旧连接"（调研报告 §5.4），Nexus 常驻连接 = 把用户的手机和浏览器扩展顶下线。

## 5. 反控指令集（v2 落地清单）

### 5.1 查看运行状态
- 拉取：`session.list` → 会话卡片（workspace 分组、blank/updatedAt）；`workspace.list` → 工作区树。
- 订阅：`host/session-status`（running 翻转）、`host/session-added|removed`、`session/queue`、`session/jobs`（后台任务状态机：注册→停止中→结算→移除）。
- 汇总指标（供 Nexus 看板）：活跃会话数 = `host/session-status(running:true)` 集合大小；排队输入数 = `session/queue` 长度；token 用量 = `assistant/chunk(usage)` 事件累加（会话内）。

### 5.2 启停任务
- 启动：`session.create {cwd?}` → `session.prompt {sessionId, mode:'queue', content:[{type:'text',text}]}`。注意 `deferSessionCreate`：create 返回的暂定 ID 在首次 prompt 后才落库，**prompt 前不要调 `session.models`**（调研报告 §5.2 坑位）。
- 停止：`session.cancel {sessionId}`（只停当前轮次，保留排队输入——语义如实呈现给用户，不要叫"杀任务"）。
- 不做：任务调度、Agent/预设切换（`agentPreset.select` 属指导书红线外，且 blank 会话限制多）。

### 5.3 输出流回传
- 实时：`GET /api/events.mux` SSE 常驻连接（主进程），按 `sessionId` 过滤后经 `webContents.send('dsh:event', …)` 推 renderer；`text-delta` 增量拼接、`block-end` 整块兜底、`turn/end(completed|error)` 收尾。
- 断线重连：指数退避；重连后用 `session.list`（重连基线）+ `session.history {sessionId, maxMessages:N}` 对账补漏（官方设计即如此，调研报告 §5.3）。
- 历史：`session.history` 分页（`beforeSeq`）；全量导出走 `GET /api/session.export?sessionId=…`（流式 ZIP，Nexus 落到临时目录后由 shell.openPath 交付）。
- 只读边界：Nexus 默认**只订阅不注入**；"注入观察者消息"类能力（`session.prompt(mode:'inject')` 是保留缝，未实现）不碰。

### 5.4 审批（可选开关，默认关）
- `approval/requested` 事件 → Nexus 弹卡片 → `POST /api/respond {sessionId, approvalId, outcome:'allowed-once'|'rejected'}`。
- 注意与手机端竞争：审批谁先应答谁生效；默认关闭的理由即"避免双遥控歧义"。

## 6. 版本兼容与降级策略（必做）

1. **版本 pin**：Nexus 配置默认 `@deepseek-ai/dsh@0.1.1-rc.2`（与本机脚本一致）；npm latest 已 0.1.5-rc.3，**0.1.2-rc.1 曾移除 apiProxy 服务**（调研报告 §9）→ 接口面随版本漂移是现实风险。
2. **特性探测**：启动时打一遍能力探针（`host.describe`、一次无害 `session.list`、`GET /ext/bridge-config`），结果缓存为 `DshCapabilities`；缺失方法在 UI 置灰而非报错。
3. **适配层**：所有方法调用走 `DshApiClient.call(method, payload)` 单点，便于未来按版本路由差异；监听 `npm view` 不现实，改为"探测失败→提示用户选择已安装版本号"。
4. **不做的事**：不自动升级 DSH、不改 `~/.dsh/settings.yaml`（配置面只读；写设置走 DSH 自己的 UI）。

## 7. 安全设计

- 只绑定回环：Nexus 不代理、不转发 3080 到局域网；Android 端经 Nexus 中继属 v3+ 议题（届时走用户自托管隧道，红线：不提供云中继，与移动端项目一致）。
- token 使用范围最小化：仅插件管理通道（`/ext/trimode`）读 `~/.dsh/ext-bridge-token`；文件读取失败（权限/不存在）→ 插件管理功能置灰，不阻塞主功能。
- 日志脱敏：`settings.*`/`credentials.*` 相关载荷一律不入 Nexus 日志。
- 进程控制防护：`taskkill` 仅允许命中"监听 DSH 端口且命令行含 `@deepseek-ai/dsh`"的 PID（启动前 `wmic process where processid=<pid> get commandline` 校验），防误杀。

## 8. 实现里程碑

| 批次 | 内容 | 验收 |
|---|---|---|
| B1 | `DshLocator` + `DshApiClient`：探活、`session.list` 只读卡片 | DSH 启停前后 Nexus 正确反映 stopped/running |
| B2 | `DshEventStream`：SSE 订阅 + 重连 + 状态事件入 zustand | 会话运行态实时翻转；断 DSH 进程后自动恢复 |
| B3 | 启停任务：create/prompt/cancel + `text-delta` 输出窗 | 从 Nexus 下发一个"列出目录"任务并看到流式输出与 cancel 生效 |
| B4 | `session.history` / `session.export` 输出留存 | 历史分页与 ZIP 导出可用 |
| B5（增强） | `DshPluginCtl`（/ext/trimode 插件启停）+ headless 发射器 + 审批开关 | 插件列表与启停（提示 restartRequired）；headless 任务回显 stdout |

## 9. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| DSH 升级破坏 `/api`（0.1.2 先例） | 反控失效 | §6 特性探测 + 版本 pin + 单点适配层 |
| `/api` 未来加鉴权 | 直连失效 | 降级到 B 通道（WS 桥 + token），代码预留 `DshTransport` 接口双实现 |
| `/ext/bridge` 单连接顶替 | 挤掉手机/扩展 | 不使用该通道；注释说明 |
| 单实例锁下误启动 | 启动报错/端口冲突 | 探活先行 + 端口→PID 校验 |
| DSH 未运行 | 功能不可用 | UI 明示"DSH 未运行"+ 可选代为拉起（默认关闭自动） |
| 上游接口语义变化（queue/jobs 快照等） | 状态展示失真 | 以事件快照为准做全量对账（不做增量猜测），对账失败降级为只读 |

---

## 10. 结论

DeepSeek Harness 是官方开源、cordis 插件化的成熟 Agent 宿主，本机已装且运行方式明确；其 `/api` 网关 + SSE 事件流对同机回环免鉴权开放，**Nexus 以"主进程外挂桥接层"即可完成指导书 §3.3 全部反控需求，无需改动 DSH 任何配置**；插件路线（复用用户自研 `dsh-trimode-gateway` 范式）仅作插件管理增强。唯一需要严肃对待的工程风险是上游版本演进（apiProxy 曾被整体移除），用"版本 pin + 特性探测 + 单点适配层"覆盖。
