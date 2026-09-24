# DeepSeek Harness（DSH）调研报告

> 调研子代理 T3 · 2026-09-24 · 服务于 Nexus v2「有限反控」能力（Nexus 能力补强指导书 v2 §2.3）
> 所有结论均附本机路径或命令证据；含密钥的文件内容已脱敏。

---

## 1. 结论摘要

| 问题 | 结论 |
|---|---|
| 它是什么 | **DeepSeek 官方开源**的 Agent Harness（代理运行时/宿主），npm 包 `@deepseek-ai/dsh`，MIT 协议，仓库 `github.com/deepseek-ai/deepseek-harness` |
| 是否开源且插件化 | 是。基于 cordis 插件框架，"一切皆插件"：200+ 官方包全部以插件/服务形式组合，配置即组合（YAML patch 层叠） |
| 本机是否安装 | 是。`C:\Users\xiaotao2026\.dsh\`（下称 `~/.dsh`），版本 **0.1.1-rc.2**（用户有意 pin 住，见 §9），web profile 完整可用 |
| 是否在运行 | 调研时点（2026-09-24）未运行（`netstat` 无 3080/3081/8787 监听） |
| 有无远程控制接口 | 有，且非常完整：HTTP RPC（`POST /api/<method>`）+ SSE 事件流（`GET /api/events.mux`）+ WebSocket 桥（`/ext/bridge`）+ 发现端点（`GET /ext/bridge-config`）+ CLI（`dsh web` / `dsh --profile headless`） |
| Nexus 反控可行性 | **高**。同机场景下 Electron 主进程可直接 HTTP 调 `/api/*`（回环无鉴权），状态/启停/取输出三类需求全部有现成接口 |
| 最大风险 | 版本兼容：0.1.2-rc.1 曾移除 apiProxy 服务导致生态断裂，本机脚本已 pin 0.1.1-rc.2；npm latest 已到 0.1.5-rc.3 |

---

## 2. 定位过程（搜索路径实录）

1. `ls /f/` → 发现 `F:\DeepSeek Harness Mobile`（用户自研安卓客户端，见 §3.3）、`F:\DeepSeek casual chat`、`F:\DeepSeek本地部署`。**无名为 "DeepSeek Harness" 的独立目录——本体不是用户的开发目录，而是安装在用户主目录下的运行时**。
2. 依据移动端 README 指引（`F:\DeepSeek Harness Mobile\docs\新手指南-PC配置与连接.md`："启动 DSH 主机 = `npx -y @deepseek-ai/dsh web`，浏览器打开 `http://127.0.0.1:3080`"）→ 检查 `~/.dsh` → **命中完整安装**。
3. 协议级细节来自本机已装源码：`~/.dsh/profiles/node_modules/@deepseek-ai/*`（200+ 包，各包自带 README）。

## 3. 项目性质判定

### 3.1 官方开源（结论：DeepSeek 官方，非用户自研、非第三方魔改）

证据：

- npm 包清单（`~/.dsh/profiles/node_modules/@deepseek-ai/dsh/package.json`）：
  - `"name": "@deepseek-ai/dsh"`，`"version": "0.1.1-rc.2"`，**`"license": "MIT"`**
  - `"repository": "git+https://github.com/deepseek-ai/deepseek-harness.git"`
- npm registry 实查（`npm view @deepseek-ai/dsh`，2026-09-24）：
  - `latest = 0.1.5-rc.3`，`next = 0.1.7-rc.2`，`alpha = 0.1.7-alpha.2`，`time.modified = 2026-09-24`（**昨日仍在发版，生态活跃**）
- WebSearch 佐证：DeepSeek 于 2026-08 开源 agent harness（dsh），MIT，定位"一切皆插件"的 harness，内置 MCP，接受任意 OpenAI 兼容端点（来源：[claude-code-deepseek-quickstart](https://github.com/yzfly/claude-code-deepseek-quickstart) 等社区资料；搜索结果为二手转述，权威度一般，但与 npm/GitHub 元数据一致）。

### 3.2 核心架构（来自本机源码 README）

- **cordis 插件框架**（`@deepseek-ai/cordis ^4.0.1`）：Context/provide/inject 服务注入模型，插件 = 一个 ES 模块（`export const name` / `inject` / `apply(ctx)`）。
- **运行形态** = "配置组合出来的插件树"：`dsh.profile.bundles`（有序 bundle 列表）→ 各 bundle 自带 patch → 用户 patch 层 → `--patch` 命令行覆盖（`~/.dsh/profiles/node_modules/@deepseek-ai/dsh/README.md`）。
- 官方 monorepo 内即有 **200+ 个包**（`ls ~/.dsh/profiles/node_modules/@deepseek-ai/`），关键承载包：
  - `dsh-host-webserver`：node:http 服务器，`ctx.webServer.register()/registerUpgrade()` 路由注册 API
  - `dsh-host-apiproxy`：`/api` RPC 网关 + SSE mux + `/api/respond`
  - `dsh-bridge-browser`：`/ext/bridge` WebSocket 桥插件（本机装的是 Lum1104/dsh-browser 源码构建版）
  - `dsh-headless`：一次性任务运行器（无端口、stdout 输出）
  - `dsh-mcp-client`、`dsh-webhook`/`dsh-webhook-github`、`dsh-schedule`、`dsh-jobs-local`、`dsh-acp` 等

### 3.3 与 `F:\DeepSeek Harness Mobile` 的关系

- 该目录是**用户自研**的 DSH 安卓三模客户端（DSH Trimode：Chat/Remote/Workbench，git 仓库、MIT、README 自述"社区独立项目，与 DeepSeek 官方无隶属关系"）。
- 其 `gateway-plugin/`（`dsh-trimode-gateway`）是**用户自研的 cordis 插件**，已装进本机 web profile 并在用——它就是"给 DSH 写一个监控/控制插件"的现成范例（详见 §6.3）。
- 对 Nexus 的意义：**插件范式已被用户本人验证过一遍**，Nexus 照抄该范式即可，风险极低。

---

## 4. 运行方式与进程结构

### 4.1 启动命令（本机实际在用）

| 方式 | 命令 | 证据 |
|---|---|---|
| 官方推荐 | `npx -y @deepseek-ai/dsh web` | `docs\新手指南-PC配置与连接.md` 第 24 行 |
| 本机一键脚本 | `npx --prefer-offline @deepseek-ai/dsh@0.1.1-rc.2 web %*` | `~/.dsh/start-dsh-web-0111rc2.cmd` |
| 带修复的脚本 | 先起会话头注入代理(127.0.0.1:8787)→打配置补丁→`NO_PROXY=127.0.0.1,localhost` 再启动 dsh | `~/.dsh/start-dsh-web-patched.cmd` |
| 一次性任务 | `dsh --profile headless "任务文本"`：新建一个持久化会话跑完，**最终回答打到 stdout，exit 0/1，不监听端口** | `@deepseek-ai/dsh/README.md` + `dsh-headless/README.md` |
| 插件管理 | `dsh plugin --profile web <pnpm args>`（转发 pnpm 到 profile 目录） | `@deepseek-ai/dsh/README.md` |
| 配置检视 | `dsh --dump-default-config` / `--dump-config`（不启动即可看组合结果） | 同上 |

- web 应用参数跟在 launcher 参数后：`dsh web --port 8080`、`--host 127.0.0.1|0.0.0.0`（webserver README：**host 只接受这两个值**，默认回环）。
- 停止 = 杀进程 / Ctrl+C（cmd 脚本自述）。端口冲突时脚本用 `netstat -ano | findstr :3080` 找 PID 再 `taskkill /PID <pid> /T /F`（`start-dsh-web-patched.cmd` 内置此逻辑，可直接借鉴给 Nexus）。

### 4.2 进程与端口

- **单进程 Node 服务**：webserver(3080) 内承载 SPA 静态资源、`/api`、`/client`、`/ext/*`、HMR 等全部路由（`dsh-host-webserver/README.md`："This server serves browsers only; Electron loads dist over file:// and carries fetch over an IPC bridge"——**官方明确设想过 Electron 宿主**）。
- 固定端口 3080 来自 `~/.dsh/settings.yaml` 的 `dsh-desktop.port: 3080`（注释："浏览器桥扩展自动发现 3080（DISCOVERY_PORTS 首位）"）。
- 历史端口记录：扩展探测表 `DISCOVERY_PORTS = [3080, 3081, 3090, 16473, 18121, 58883]`（`~/.dsh/dsh-browser/extensions/dsh-browser/src/background/index.ts:89`，注释注明 16473 曾是 DSH Desktop GUI 端口）。
- 当前运行状态：`netstat -ano | grep :3080` 无 LISTEN（调研时未运行）。

### 4.3 数据落盘位置

- 会话持久化：`dsh-session-persistence-jsonl` + `dsh-session-query-sqlite`（包名证据），归档导出走 `GET /api/session.export`（ZIP，见 §5.2）。
- 浏览器桥生成的会话默认落在 `~/.dsh/browser-sessions/` 工作区（桥插件 README）。

---

## 5. 控制接口盘点（核心章节）

### 5.0 发现与健康检查（Nexus 探活的现成方案）

```
GET http://127.0.0.1:<port>/ext/bridge-config   → 200 {"wsUrl": "ws://127.0.0.1:3080/ext/bridge"}
```

- 证据：`~/.dsh/dsh-browser/extensions/dsh-browser/src/background/index.ts:93-107`（`discoverBridge()`：逐端口 fetch `/ext/bridge-config`，1.5s 超时，取 `wsUrl`）。**官方扩展就是这么找 DSH 的，Nexus 照抄即可。**
- 该端点无需 token（回环探测免令牌，桥 README："Loopback connections are discovered automatically and require no token entry"）。

### 5.1 HTTP RPC：`POST /api/<method>`（同机无鉴权）

契约（`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-host-apiproxy/README.md` §Contract layer）：

- 必须 `Content-Type: application/json`，否则 415（防 CSRF"简单请求"盲打）；
- 响应回显 `rpcId`；业务错误走 `RpcResult` 的 error 分支（HTTP 状态只表达载体层）；
- Zod 双层校验（信封 + 业务载荷）；
- **信任模型：`/api` 的信任栅栏是"回环 + 同源"**（dsh-client-connection），敏感方法（settings/credentials/host.openPath/pickDirectory）钉死回环。Nexus Electron 主进程发请求即回环来源 → 全量可用；Node fetch 无 CORS 限制，同源约束只约束浏览器载体。
- 另有 `POST /api/respond`（应答宿主向客户端的提问）、`GET /api/events.mux`（SSE 下行）、`GET|HEAD /api/session.export?sessionId=…&includeDescendants=true`（会话日志 ZIP 流式下载，含子代理与媒体文件）。

### 5.2 RPC 方法表（`RpcMethodMap` + 协议备忘录 §3，加粗 = Nexus 反控直接可用）

| 域 | 方法 | 用途 |
|---|---|---|
| 会话 | **`session.create`** `{workspaceId?, cwd?, sessionId?, agentPreset?}` → `{sessionId}` | 开任务 |
| | **`session.prompt`** `{sessionId, mode:'queue'\|'steer', content:[{type:'text',text}\|{type:'image',…}], clientTimeZone?}` | 下发任务/继续对话 |
| | **`session.history`** `{sessionId, maxMessages?, beforeSeq?}`（尾页带 `projections` 块） | 取输出（落库后的完整消息） |
| | **`session.cancel`** | 停止当前轮次（保留排队输入） |
| | **`session.list`** | 会话清单（含 blank/updatedAt，重连基线） |
| | `session.models` / `session.selectModel` | 模型查看/切换（selectModel 同时改部署默认） |
| | `session.rename` / `session.fork` / `session.search`（全局限 20 条命中） / `session.attachment` / `session.updateQueue` | 辅助 |
| 工作区 | `workspace.list/create/delete/rename/archiveSession/insertBefore` | 工作区管理 |
| 后台任务 | `session/jobs` 事件帧（`JobView`：注册/停止中/结算/移除全生命周期推送） | **任务状态机**（保留缝：`job.list` 方法未实现，只有事件快照） |
| 命令/技能 | `command.list` / `command.execute`（斜杠命令宿主侧执行，回执 `commandId`，结果走 `command/run`/`command/done` 事件）；`skill.list` | 扩展触发面 |
| 预设 | `agentPreset.list/select/read/copy/openDocument/remove` | Agent 预设 |
| 设置 | `settings.describe/update/replace/mutate/openDocument`；`credentials.describe/set/unset`；`llm.providers/models/discoverModels` | 配置面（回环限定） |
| 宿主 | `host.describe` / `host.listDirectory` / `host.createDirectory` / `host.openPath` / `host.pickDirectory` | 主机信息/目录（回环限定） |
| 子代理 | `subagent.prompt`（README 提及） | 子代理任务 |

> 已知坑：桥插件 `deferSessionCreate` 默认 true → `session.create` 先返回内存暂定 ID，首次 `session.prompt` 才落库；落库前调 `session.models` 会 `session-not-found`（`docs\协议备忘录-2026-09-15.md` §7）。

### 5.3 事件流（`GET /api/events.mux` SSE，或桥的 `event` 帧，形态相同）

来自协议备忘录 §4 + apiproxy README：

- **流式输出**：`session/event` 内 `assistant/chunk`：`text-delta`（增量文本）、`block-start/block-end`（text/reasoning 块，block-end 带整块文本）、`usage`（token 用量）、`finish`（stop/error）；
- **完整消息**：`assistant/message`（含 `source{kind,provider,model}`）、`user/message`；
- **轮次/步骤**：`turn/start`、`step/start`、`step/end`、`turn/end`（`reason.kind = completed|error`）；
- **审批**：`approval/requested` / `approval/resolved`（配合 `respond` 帧或 `/api/respond` 应答 `{sessionId, approvalId, outcome:'allowed-once'|'rejected'}`）；
- **状态机**：`host/session-status`（running 翻转）、`session/queue`（排队输入快照）、`session/jobs`（后台任务快照）、`session/projection`（标题等活推送）、`session/disposed`；
- **宿主级**：`host/session-added|removed`、`host/workspace-changed|removed|order-changed`、`host/agent-error`。
- 断线恢复：`session.list`/`workspace.list` 是重连基线；`events.mux` 重开时会重放仍挂起的提问（apiproxy README Known Limitations）。

### 5.4 WebSocket 桥 `/ext/bridge`（远程/移动端通道）

帧协议（JSON per WS message，按 `t` 判别；来源：协议备忘录 §2 + 桥 README，单一事实源 `~/.dsh/dsh-browser/packages/browser/bridge-browser/src/protocol.ts`）：

| 方向 | 帧 | 说明 |
|---|---|---|
| C→S | `{t:"hello", token, caps}` | 首帧 5s 内认证，token 恒时比较 |
| S→C | `{t:"hello.ok", caps}` | 回显协商 caps |
| C→S | `{t:"rpc", id, method, payload}` | 网关方法透传（等价 `/api`） |
| S→C | `{t:"rpc.result", id, ok, result}` | **两层信封：业务载荷在 `result.result.value`** |
| C→S | `{t:"respond", id, rpcId, result}` | 应答审批/提问 |
| S→C | `{t:"event", frame:{rpcId, method, payload}}` | 网关事件信封 |
| 双向 | `ping`/`pong` | 30s 心跳 |

安全语义：token 在 `~/.dsh/ext-bridge-token`（0600，65 字节，本机已存在）或 `DSH_EXT_TOKEN`；**同一时刻仅一个活动连接，新认证连接顶替旧连接**；非回环来源即使 token 正确也拒绝 settings/credentials/openPath/pickDirectory。

> **对 Nexus 的警示**：手机 App 与 Chrome 扩展都连 `/ext/bridge`，且是单连接顶替语义——Nexus 若也挤这条通道会把手机顶下线。同机场景请优先直连 `/api`（§5.1），WS 桥仅作远程中继备选（见集成方案 §4）。

### 5.5 CLI 面

| 命令 | 能力 | 反控适用性 |
|---|---|---|
| `dsh web [--port N] [--host H]` | 启动常驻服务 | Nexus 可代为拉起（进程启停） |
| `dsh --profile headless "task"` | 一次性任务：stdout=最终回答，exit code=成败，无端口 | 适合"发射后不管"型任务，无流式 |
| `dsh plugin --profile web add|remove <pkg>` | 装/卸插件（pnpm 转发） | 插件管理自动化 |
| `dsh --dump-config` | 检视组合配置，不启动 | 诊断 |

---

## 6. 插件化机制

### 6.1 插件 = npm 包 + bundle 声明 + patch 层

1. **包形态约定**：`package.json` 里带 `dsh.bundle` 清单（桥插件实例，`~/.dsh/dsh-browser/packages/browser/bridge-browser/package.json`）：
   ```json
   "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
   ```
2. **插件本体**：ES 模块导出 cordis 插件（gateway-plugin 实例，`F:\DeepSeek Harness Mobile\gateway-plugin\lib\index.js`）：
   ```js
   export const name = 'trimode-gateway'
   export const inject = ['webServer']   // 注入宿主 webserver 服务
   // apply(ctx) 内: ctx.webServer.registerUpgrade({ path:'/ext/trimode', … })
   ```
3. **注册进 profile**：`~/.dsh/profiles/web/package.json` 的 `dependencies` 加依赖 + `dsh.profile.bundles` 数组加包名（本机清单现装 22 个 bundle，含 15+ 个第三方社区插件）。
4. **配置覆盖**：`~/.dsh/profiles/web/cordis.patch.yml`（按 id 覆盖 config / `disabled: true` / `- insert:` 插入新插件，支持 `!!js` 表达式）；层叠顺序 = bundles 顺序 → profile patch → `~/.dsh/cordis.patch.yml` → `--patch`。
5. **启停语义**：增删 `dsh.profile.bundles` 成员 = 停用/启用，**重启 DSH 生效**（gateway-plugin README"启停语义"节）。
6. **市场**：`dshmarket` 插件（npm 包，本机已装、已启用）+ profile 下 `~/.dsh/profiles/web/.dsh-market/`（state.json + log.ndjson）——DSH 有插件市场生态。
7. **HMR**：`cordis-plugin-hmr`，改 patch 配置可触发插件重载（本机 cordis.patch.yml 中 vision-log 配置注释为证）。

### 6.2 第三方生态实证（本机 web profile 已装的社区插件，均来自 npm/GitHub）

`@liustack/modlens`、`@liustack/modsearch`、`@linxin666/dsh-web-ui-all`、`@hytime/dsh-thinking-effort`、`@anionex/dsh-vision-toolkit`、`@magiczerowxy/dsh-balance|modef|ocgo-usage`、`@openviking/dsh-memory-plugin`（volcengine/OpenViking）、`@tt-a1i/archify-dsh`、`dsh-ego-browser`、`dsh-talk-map`、`@dsh-external/workflow`、皮肤包 `@dsh-external/dsh-client-ui-skin-maid-atelier` 等（`~/.dsh/profiles/web/package.json` dependencies）。
→ **"开源 + 插件化"属实，且生态已相当繁荣，Nexus 以插件形式进入是生态常规操作。**

### 6.3 插件的能力边界（重要）

- `RpcMethodMap` 是**编译期封闭接口**：插件**无法**新增 `session.*` 风格的网关方法（协议备忘录 §6.5 明确记录）。
- 插件可做的：往 `ctx.webServer` 挂**自己的 HTTP/WS 路由**（`/ext/<name>`）、注册设置面板（`settings.describe` 名空间自动出现）、注入服务、注册 agent 工具/技能/命令、挂 UI 模块。
- **现成范例**：`dsh-trimode-gateway`（用户自研）挂在 `/ext/trimode`，帧协议与 `/ext/bridge` 完全同形，token 复用 `~/.dsh/ext-bridge-token`，零第三方依赖手写 WS 握手，附 7 个纯函数单测（`gateway-plugin/test/manifest.test.mjs`）。

### 6.4 Nexus 能否以插件形式嵌入？

**能，且有两条路**：
1. **薄插件**：Nexus 出一个 `dsh-nexus-gateway` cordis 插件（抄 gateway-plugin 范式），挂 `/ext/nexus` 端点，暴露 Nexus 需要的聚合状态——适合"DSH 侧主动推送、Nexus 被动收"。
2. **不装插件，纯外挂**（推荐首选）：Nexus 主进程直连 `/api` + `events.mux`，**零侵入、零安装、不依赖 DSH 重启**。插件路线作为增强项（如需要"插件启停管理"则直接复用已装好的 `dsh-trimode-gateway`，它已提供 `trimode.plugins.list` / `trimode.plugins.setEnabled`）。

---

## 7. 安全模型（与 Nexus 相关的部分）

- webserver 本体**无鉴权无 TLS**，安全靠"默认只绑 127.0.0.1"（webserver README Known Limitations；`--host 0.0.0.0` 是显式裸奔选项）。
- `/api` 信任栅栏：回环 + 同源；敏感方法（settings/credentials/openPath/pickDirectory）钉死回环（apiproxy README + 桥 README）。
- 桥 `/ext/bridge`：bearer token（`~/.dsh/ext-bridge-token`，0600）+ 恒时比较 + 5s 握手期限 + 单连接顶替 + 非回环降权。
- `/api` POST 强制 `application/json`（415 拒绝其他），防跨站"简单请求"盲打副作用。
- **Nexus 含义**：Nexus 在同一台机器上 = 回环可信方，可直接调用全部 `/api`；Nexus 自身不得把 DSH 端口代理给局域网（红线与移动端项目一致：不提供云中继、不直暴端口）。token 文件读取需注意权限（同用户进程可读，Nexus 与 DSH 同用户，无障碍）。

---

## 8. 配置文件格式速查

| 文件 | 格式 | 作用 | 证据 |
|---|---|---|---|
| `~/.dsh/settings.yaml` | YAML，按插件名空间分节（`dsh-desktop:`、`llm-deepseek:`、`agent-default-model:`、`llm-pi-ai.providers[]`…） | 运行时设置（端口/模型/密钥/主题） | 本机文件实读（已脱敏） |
| `~/.dsh/profiles/web/package.json` | JSON | profile 清单：`dependencies` + `dsh.profile.bundles` | 本机文件实读 |
| `~/.dsh/profiles/web/cordis.yml` | YAML 数组（空根 `[]`） | 组合树根（注释明言"编辑 cordis.patch.yml 而非本文件"） | 本机文件实读 |
| `~/.dsh/profiles/web/cordis.patch.yml` | YAML 数组 | 用户 patch 层（id 定向覆盖/停用/insert） | 本机文件实读 |
| `~/.dsh/ext-bridge-token` | 单行 hex | 桥配对令牌 | 本机文件存在（65B） |
| `~/.dsh/profiles/web/.dsh-market/` | JSON/NDJSON | 插件市场状态 | 目录实读 |

---

## 9. 版本状态与本机安装细节（坑位）

- 本机 **pin 在 0.1.1-rc.2**，原因写在 `~/.dsh/start-dsh-web-0111rc2.cmd` 注释里：
  > "0.1.2-rc.1 removed the apiProxy service and broke the client module table; upgrade only after the @linxin666 plugin ecosystem ships 0.1.2-compatible releases."
  → **DSH 升级会破坏接口面，Nexus 必须做版本探测与特性降级，不能假设 `/api` 永远存在。**
- npm latest 已 0.1.5-rc.3（2026-09-24 更新），说明上游迭代很快（约每月多个 rc）。
- 辅助脚本（可参考其逻辑）：`pin-dsh-0111rc2.ps1`、`restore-dsh-full-0111rc2.ps1`、`dsh-web-restart.out.log`（`~/.dsh/`）。
- 单实例约束：启动脚本明言 "ledger is already owned by process XXXX" → **DSH 是单实例锁**，重复启动报错；Nexus 拉起前必须先探活。
- 会话导出、搜索、jobs 等能力依赖可选插件组合（apiproxy README 各节"deployment without X"分支），特性探测应逐方法降级。
- 移动端项目沉淀的完整坑位表见 `F:\DeepSeek Harness Mobile\docs\协议备忘录-2026-09-15.md` §7（信封两层、429/524 限频、IME 等）。

---

## 10. 证据文件索引

| 证据 | 路径 |
|---|---|
| DSH 主包清单（官方 repo/MIT/bin） | `C:\Users\xiaotao2026\.dsh\profiles\node_modules\@deepseek-ai\dsh\package.json` |
| CLI 语义（profile/headless/plugin/dump-config） | `…\@deepseek-ai\dsh\README.md` |
| `/api` 契约、方法/事件全集 | `…\@deepseek-ai\dsh-host-apiproxy\README.md` |
| webserver 路由注册 API、host 限制 | `…\@deepseek-ai\dsh-host-webserver\README.md` |
| headless 一次性任务 | `…\@deepseek-ai\dsh-headless\README.md` |
| 桥插件 README + 协议源码 | `C:\Users\xiaotao2026\.dsh\dsh-browser\packages\browser\bridge-browser\{README.md,src\protocol.ts}` |
| 端口发现表 + `/ext/bridge-config` 探测 | `C:\Users\xiaotao2026\.dsh\dsh-browser\extensions\dsh-browser\src\background\index.ts`（L89–107） |
| profile 清单（bundles 全集） | `C:\Users\xiaotao2026\.dsh\profiles\web\package.json` |
| patch 层实例 | `C:\Users\xiaotao2026\.dsh\profiles\web\cordis.patch.yml` |
| 启动脚本（含单实例/端口占用处理） | `C:\Users\xiaotao2026\.dsh\start-dsh-web-0111rc2.cmd`、`start-dsh-web-patched.cmd` |
| 协议备忘录（中文，帧表+方法表+坑位） | `F:\DeepSeek Harness Mobile\docs\协议备忘录-2026-09-15.md` |
| 新手指南（运行方式） | `F:\DeepSeek Harness Mobile\docs\新手指南-PC配置与连接.md` |
| 自研控制插件范例 | `F:\DeepSeek Harness Mobile\gateway-plugin\{README.md,lib\index.js,lib\manifest.js}` |
| npm 线上版本 | `npm view @deepseek-ai/dsh`（latest 0.1.5-rc.3，2026-09-24） |
| Web 佐证 | [yzfly/claude-code-deepseek-quickstart](https://github.com/yzfly/claude-code-deepseek-quickstart) 等社区资料 |
