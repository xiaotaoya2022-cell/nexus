# 多开 ZCode 实例识别与管理方案（T6 实测调研）

> 调研时间：2026-09-25 凌晨（实测快照）
> 环境：Windows 10/11 x64，Git Bash，ZCode 桌面版安装于 `E:\EXEapp\ZCode`
> 调研方式：全程只读（tasklist / PowerShell CIM 查询 / SQLite `mode=ro` URI / 文件枚举），未 kill、未写任何 ZCode 数据。

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 实例数量 | 当前运行 **3 个 Electron 桌面实例**（非 5 个）；"5 个"对应磁盘上 5 个实例目录（2 个未运行） |
| 实例唯一指纹 | **进程树回溯 + 子进程 `--user-data-dir`**（主进程自身命令行是裸 exe，看不出差异） |
| 窗口标题 | 3 个窗口标题全部是 `ZCode`，**无法用标题区分实例**，必须用 PID |
| agent 数据隔离 | **不隔离**：所有实例共享全局 `~/.zcode/cli/db/db.sqlite`（1.4GB, WAL）；仅凭据/任务索引按实例隔离在 `~/.antigravity_cockpit/instances/zcode/<id>/data/.zcode/v2/` |
| 用量记录归属实例 | **DB 层面无实例标识列，无法精确归属**；推荐"聚合视图为主 + 工作区目录近似拆分 + 运行期进程树辅助" |
| 远控指定目标 | 首选：**只读数据库巡检**（可行性最高、风险最低）+ **按 PID 定位窗口**；cua-helper 命名管道存在但协议需逆向 |

**实例归属主键推荐**：进程侧 = `Electron 主进程 PID`（以任意子进程命令行中的 `--user-data-dir` 指纹回溯到主进程）；数据侧 = `user-data-dir 路径`（含实例 id `243a413f411aa795` / `72a93d16b0a02394` / 默认 `%APPDATA%\ZCode`）。**会话与用量数据不要试图归属到实例，以 workspace（session.directory）为一级归属键。**

---

## 1. 进程盘点

### 1.1 数量与角色分类

`tasklist` 检出 **62+ 个 ZCode.exe**——这是 Electron 多进程架构的正常形态，不是 62 个实例。按命令行分类：

| 角色 | 数量（快照） | 识别特征 | 说明 |
|---|---|---|---|
| **Electron 主进程（=桌面实例）** | **3** | 命令行恰为裸 `"E:\EXEapp\ZCode\ZCode.exe"`（无 `--type=`、无 cjs 参数） | PID 65832（14:50:10 启动）、110888（15:48:11）、119232（15:48:12） |
| utility `node.mojom.NodeService` | 每实例 1~2 | `--type=utility --utility-sub-type=node.mojom.NodeService` | **命令行携带 `--user-data-dir`，是区分实例的指纹**；由它派生 agent 进程 |
| `app-server --stdio` | 每实例 4~8，动态增减 | `ZCode.exe E:\EXEapp\ZCode\resources\glm\zcode.cjs app-server --stdio [--surface desktop]` | **每个活跃会话/任务一个进程**，随会话开关动态拉起/退出（实测观察期间从 12 个增长到 16 个） |
| `__zcode-plugin-host <mcp server.js>` | 每活跃会话 1~3 | 挂在各 app-server 下 | 插件 MCP server（android-emulator、ios-simulator、node-repl 等） |
| `cua-helper windows-helper.js` | 每实例 1 | `--socket \\.\pipe\zcode-cua-helper-<16位hash> --parent-pid <NodeService PID>` | **管道哈希是实例级稳定标识** |
| renderer / gpu / crashpad / network / audio / video_capture | 每实例若干 | `--type=renderer|gpu-process|...` | 常规 Electron 子进程 |

### 1.2 实例→userData 指纹（关键）

| 主进程 PID | 启动时间 | user-data-dir（子进程携带） | 启动器 |
|---|---|---|---|
| 65832 | 09-24 14:50:10 | `C:\Users\xiaotao2026\AppData\Roaming\ZCode`（默认） | 父进程已退出 |
| 110888 | 09-24 15:48:11 | `C:\Users\xiaotao2026\.antigravity_cockpit\instances\zcode\243a413f411aa795\electron` | **`E:\EXEapp\Cockpit Tools\cockpit-tools.exe`** |
| 119232 | 09-24 15:48:12 | `C:\Users\xiaotao2026\.antigravity_cockpit\instances\zcode\72a93d16b0a02394\electron` | 同上（cockpit-tools.exe） |

注意：**主进程自己的命令行不带 `--user-data-dir`**（三个主进程命令行完全相同），必须沿进程树看子进程（renderer/gpu/utility 任一）的 `--user-data-dir` 才能区分。算法：任取 ZCode 进程 → 沿 `ParentProcessId` 上溯到无 `--type=` 的主进程 → 取该主进程**任一子进程**的 `--user-data-dir` 作为实例指纹。

### 1.3 多开机制

多开由第三方启动器 **Antigravity Cockpit**（`~/.antigravity_cockpit/`）实现：每个实例 = cockpit 分配的实例 id 目录 + 独立 Electron userData（`.../instances/zcode/<实例id>/electron`，内含 `lockfile`）+ 独立账号数据（`.../data/.zcode/v2/`）。磁盘上现有 5 个实例目录：`243a413f411aa795`、`72a93d16b0a02394`、`72caee3f86898133`、`8e296a067a375633`（无 data，疑似废弃）、`新实例`。其中前两个正在运行；`72caee3f86898133`、`新实例` 最后活跃 09-20（未运行）。

---

## 2. 窗口盘点

```
PID=65832  TITLE=[ZCode]
PID=110888 TITLE=[ZCode]
PID=119232 TITLE=[ZCode]
```

- 3 个实例各只有 1 个顶层窗口，标题**全部是纯 `ZCode`**，不含工作区名/实例名。
- 结论：**`MainWindowTitle` 匹配（含 AppActivate 按标题）无法区分实例**；窗口操作必须走 `Process.MainWindowHandle`（按 PID 定位）。
- 实例"当前打开的项目"可从其 `setting.json` 的 `recentProjects` 第一项近似读取（实测：实例 A→`F:\Nexus`、实例 B(243a)→`F:\SemanticFS`、实例 C(72a9)→`F:\HyperFrames\hf-studio`），可作为窗口/实例的**展示别名**。

---

## 3. 数据隔离性（实测）

### 3.1 三层数据，隔离程度不同

| 层 | 位置 | 隔离？ | 实测证据 |
|---|---|---|---|
| Electron userData（缓存/lockfile） | 每实例独立：`%APPDATA%\ZCode`、`.../<实例id>/electron` | ✅ 隔离 | 各目录有独立 `lockfile`；实例目录互不串写 |
| **agent 会话/用量数据（CLI 层）** | **全局唯一** `C:\Users\xiaotao2026\.zcode\cli\`（db.sqlite 1,486,761,984 字节 + WAL/SHM；另有 sessions、exec、agents、log、rollout） | ❌ **所有实例共享读写** | 各实例 `data/.zcode/` 下只有 `v2/workspace/plugin-workspace`，**没有 `cli` 目录**；全局 db 中同时存在 Nexus/API SPACE/hf-studio/longcat 等不同实例打开的项目会话 |
| 实例元数据（v2 层） | 默认实例在 `~/.zcode/v2/`；cockpit 实例在 `.../<实例id>/data/.zcode/v2/` | ✅ 按实例隔离 | credentials.json、provider_config.json、setting.json、tasks-index.sqlite、bot-config、logs、telemetry-state 均为实例私有 |

### 3.2 db.sqlite（全局共享库）关键字段实测

- 表：`session`(572 行)、`message`(8 万)、`part`(29.7 万)、`model_usage`(5 万，**含 `session_id`+`provider_id`+各 token 列**)、`turn_usage`、`tool_usage`、`session_entry`、`local_setting`、`todo`、`session_task_link`、`dwf_*`（workflow）等 24 张表。
- `session`：`id` 形如 `sess_<uuid>`（主会话）/ `sess_subagent_agent_<uuid>`（子代理）、`project_id`（`proj_<路径slug>`）、`directory`（项目根绝对路径）、`workspace_id`（样本中均为 NULL）、`time_created/time_updated`。**无实例标识列。**
- `model_usage.provider_id`：值为 `account:zai-individual-coding-plan`、`builtin:zai-coding-plan`、`opencode-zen-chat`、`new-provider`、`qwen-alibaba-model-studio-cn` 等 —— 是**供应商/套餐标识，不带账号 UUID**，不能区分实例（B、C 两实例用同一套餐时完全无法区分）。
- `started_at` 等 epoch-ms；按日聚合可行（实测当日按目录拆分成功：Loci/Mosaic/SemanticFS/hf-studio/Nexus/API SPACE 各有今日 token 数）。

### 3.3 实例 v2 层实测

- **credentials.json（账号隔离）**：默认实例 A → zai-individual-coding-plan（账号 `c6f99be9…`）+ zai-team-coding-plan；实例 B → zai-individual-coding-plan（账号 `b232a784…`）+ bigmodel（`27291743970482796`）；**实例 C 与 B 完全同账号**；`72caee` → bigmodel（`76161784256237743`）；`新实例` → zai-individual（`89938f0b…`）。**账号可做分组维度但不能唯一标识实例（B/C 冲突）。**
- **tasks-index.sqlite（实例私有但内容镜像）**：表结构 `tasks(workspace_key, workspace_path, task_id, title, task_status, provider, mode, model, created_at, updated_at, …)`，其中 **`task_id` 就是 `sess_<uuid>`**，与全局 db 的 session id 直接对上。另有 `automations`、`off_peak_tasks`（含 `workspace_path`+`session_id`+prompt，可做"定时任务"视图）。
  - 但实测 **task_id 高度重叠**：A(全局) 95 条 ⊇ B(17) ⊇ B∩C=16。即任务索引也在实例间镜像/同步，**不能把 tasks-index 当作"本实例独有任务"的归属依据**，只能当"该实例可见/可操作任务"清单。

---

## 4. 实例 → 数据归属方案

### 4.1 可行键与置信度评估

| 候选键 | 能否归属实例 | 置信度 | 说明 |
|---|---|---|---|
| Electron 主进程 PID + user-data-dir | ✅ 唯一确定"实例身份" | 高 | 但只覆盖**运行期**；进程退出即失联 |
| cua-helper 管道哈希 | ✅ 每实例 1 条，稳定 | 高 | 也可作实例指纹（`\\.\pipe\zcode-cua-helper-<hash>`） |
| `model_usage.provider_id` | ❌ | 低 | 只有套餐名无账号 UUID；B/C 同套餐不可分 |
| credentials.json 账号 UUID | ⚠️ 分组 | 中 | A 独立、72caee/新实例 独立，但 B=C 共用 |
| `session.directory` → 实例 | ⚠️ 近似 | 中 | 同一目录可能被多个实例打开（B/C 的 workspace 集合几乎重合）；只回答"哪个项目"，不回答"哪个窗口" |
| tasks-index `task_id` | ⚠️ 弱 | 中低 | 任务在实例间镜像，同一 task 出现在多个实例索引中 |
| app-server 进程 ↔ session | ✅ 理论可行 | — | 每个 app-server 进程服务特定会话且必属某实例（进程树可证），但**没有只读途径拿到 PID↔session_id 映射**（需运行时 API/日志匹配，log jsonl 有 sessionId 但无实例标签） |

### 4.2 推荐模型：聚合为主 + 工作区近似 + 运行期投影

> **"工作区（项目目录）是一级实体，桌面实例只是它的运行时投影。"**

1. **聚合视图（100% 准确）**：所有用量/会话直接读全局 `~/.zcode/cli/db/db.sqlite`（`model_usage` × `session` JOIN）。这是唯一无歧义的数据源，且天然覆盖全部实例（含未来新增实例，零适配）。
2. **工作区拆分视图（高准确，非实例语义）**：按 `session.directory` / `project_id` 拆分今日 token、会话数、最近活跃。用户心智模型("我在 Nexus 上花了多少")与此完全对齐。
3. **实例视图（运行期元数据，不做数据归属）**：实例列表 = 枚举 Electron 主进程（PID、user-data-dir、启动时间、cockpit 实例 id、窗口句柄、cua 管道）+ 实例 v2 元数据（账号 UUID 脱敏指纹、recentProjects、tasks-index 的 updated_at 作"最近活跃"）。实例视图展示"活着没、在哪个项目、最近是否活跃、账号分组"，**不承诺**"这个实例今天花了多少 token"。
4. **（可选增强，中置信度）**：将实例 recentProjects ∩ 当日活跃目录做交集，给出"推测归属"标签并明示置信度；B/C 同项目时标"多实例共用"。

### 4.3 明确的局限（如实声明）

- **历史用量无法归属到具体实例窗口**：单库共享、无实例列、provider_id 无账号 UUID、任务索引镜像。任何宣称能精确归属的方案都需 ZCode 上游在 `model_usage` 中加实例/host 标识（可给官方提 feature request）。
- 单库 + WAL 多写并发（3 实例 + Nexus 读）存在锁竞争隐患：实测 WAL 仅 ~4MB、SHM 正常，当前负载健康；Nexus 侧务必 `mode=ro` + 短查询 + 失败重试，**绝不能写该库**。

---

## 5. 远控指定目标的通道评估

| # | 通道 | 做法 | 可行性 | 风险 | 结论 |
|---|---|---|---|---|---|
| 1 | **只读数据库巡检**（推荐主通道） | Python/任何 SQLite 客户端 `mode=ro` 读全局 db.sqlite（会话/用量/任务）+ 各实例 `data/.zcode/v2/tasks-index.sqlite`（任务/工作区/自动化） | ★★★★★ 已验证（本次全程此方式） | 低（只读；注意 1.4GB 大库查询要带 LIMIT/索引列；WAL 下 ro 连接安全） | **Nexus 首选**：发现、监控、统计 |
| 2 | **按 PID 操作窗口** | `Win32_Process` 枚举主进程 → `(Get-Process -Id <pid>).MainWindowHandle` → `SetForegroundWindow` / `ShowWindow` / `PostMessage`（标题全部重复，禁止用标题匹配） | ★★★★☆ 标准 Win32 | 中低（抢焦点干扰用户；关窗=杀会话，慎用） | 需要把"用户视线"切到某实例时用 |
| 3 | **cua-helper 命名管道** | 每实例 1 条 `\\.\pipe\zcode-cua-helper-<hash>`（实测 3 条，对应 3 实例），配 `E:\EXEapp\ZCode\resources\tools\cua-helper` | ★★☆☆☆ 管道存在且实例级绑定，但协议未公开 | 中（协议逆向成本；误操作即真实 UI 操作） | 二期探索；CUA/UI 自动化专用 |
| 4 | **启动新 CLI 会话（headless）** | 无 PATH 中的 `zcode` 命令、无 npm 全局包；入口是 `E:\EXEapp\ZCode\ZCode.exe E:\EXEapp\ZCode\resources\glm\zcode.cjs app-server --stdio`（实测运行的 16 个 app-server 均此形态） | ★★★★☆ 形态已验证 | 低（新会话共享全局库与全局账号凭据 `~/.zcode`；不能"附加"到某个桌面实例的已有会话） | 批量/无人值守任务的通道；**无法定向"某个桌面实例"**，只能定向"某个 cwd" |
| 5 | node-repl 管道（`\\.\pipe\zcode-node-repl-<uuid>`，实测 21 条） | 会话级 MCP host | ★☆☆☆☆ | 中 | uuid 无实例语义，绑定困难，不推荐 |
| 6 | 向进程发信号 | Windows 无 POSIX 信号；仅 `taskkill`（=杀进程） | ★☆☆☆☆ | 高（不可逆） | 仅作"停止实例"的最终手段，禁止用于管理 |
| 7 | 文件系统活性探测 | 实例 `tasks-index.sqlite-wal` / `v2/logs` mtime 变化 = 活跃 | ★★★★☆ | 低 | 轻量"最近活跃"判定（实测：B 02:05、C 02:28、A 02:43 均在当晚更新） |

**推荐的远控分层**：日常用通道 1（读）+ 通道 7（活性）；定向交互用通道 2（窗口）+ 通道 4（headless 新会话）；通道 3 列为二期。

---

## 6. Android 端展示设计输入

### 6.1 实例列表（InstanceList）

```jsonc
{
  "instances": [{
    "id": "243a413f411aa795",            // cockpit 实例 id 或 "default"
    "name": "实例-243a (SemanticFS)",     // recentProjects[0] 或用户自定义别名
    "kind": "cockpit|default",
    "userDataDir": "C:\\Users\\...\\electron",
    "pid": 110888,                        // null = 未运行
    "running": true,
    "startedAt": "2026-09-24T15:48:11",
    "accountFingerprint": "b232a784…",    // credentials.json 账号 UUID 前 8 位（分组用，脱敏）
    "accountPlans": ["zai-individual-coding-plan", "bigmodel-individual-coding-plan"],
    "currentProject": "F:\\SemanticFS",   // recentProjects[0]
    "workspaceCount": 6,                  // tasks-index DISTINCT workspace_key
    "lastActiveAt": "2026-09-25T02:05",   // tasks-index MAX(updated_at) 或 v2/logs mtime
    "openTaskCount": 17,
    "windowHandle": 132600,               // 可选，远控用
    "cuaPipe": "\\\\.\\pipe\\zcode-cua-helper-3b79fdedc9819c9c"  // 可选
  }],
  "discoveredOffline": [ /* 磁盘有实例目录但未运行：72caee…、新实例 等，同样给 name/lastActiveAt */ ]
}
```

要点：`running` 用"存在无 `--type=` 的 ZCode.exe 主进程且其子进程 user-data-dir 匹配"判定；`lastActiveAt` 用 tasks-index WAL mtime 或 `MAX(tasks.updated_at)`；刷新建议 ≥10s 轮询。

### 6.2 聚合视图（AggregatedOverview，App 首页）

```jsonc
{
  "today": {                              // 全局 db，epoch-ms 过滤，100% 准确
    "totalTokens": 647099404,             // SUM(input+output+reasoning)
    "inputTokens": ..., "outputTokens": ..., "cacheReadTokens": ...,
    "requestCount": 1776,                 // COUNT(model_usage)
    "activeSessions": 23,
    "costEstimate": null                  // 依赖单价配置，可后续加
  },
  "byProvider": [ { "providerId": "account:zai-individual-coding-plan", "tokens": 433819620, "requests": 1368 }, ... ],
  "byWorkspace": [ { "directory": "F:\\Loci", "tokens": 131539101, "requests": 365, "lastActiveAt": ... }, ... ],  // Top N + 折叠
  "byHour": [ { "hour": "2026-09-25T02:00", "tokens": ... }, ... ],
  "runningInstances": 3, "diskInstances": 5,
  "dbHealth": { "dbSizeMb": 1418, "walMb": 4.1, "lastWriteAt": ... }   // 共享库健康度（多开风险提示）
}
```

### 6.3 交互原则

- 首页=聚合（总量/按项目/按供应商）；实例页=运行状态与控制（存在性/活跃/账号/打开项目/远控按钮），**不展示"实例 token 消耗"或明确标注"近似"**。
- 同一 workspace 被多实例打开时（B/C 场景），项目条目显示 `multi-instance` 徽标。
- token 数值全部来自全局库单源，避免"实例页数字之和 ≠ 总量"的观感问题。

---

## 附录 A：复现命令（全部只读）

```bash
# 主进程枚举（区分角色）
powershell -File dump_zcode_procs.ps1   # Get-CimInstance Win32_Process + 命令行分类
# 实例指纹：子进程 --user-data-dir 回溯主进程
# 窗口
powershell -Command "Get-Process ZCode | Select Id,MainWindowTitle,MainWindowHandle"
# 只读 SQLite（Python）
python -c "import sqlite3;c=sqlite3.connect('file:C:/Users/xiaotao2026/.zcode/cli/db/db.sqlite?mode=ro',uri=True)"
# 管道枚举（注意 Git Bash 转义，需在 PS1 内用 [char]92 构造 \\.\pipe\）
# 今日按目录拆分
# SELECT s.directory, COUNT(*), SUM(m.input_tokens+m.output_tokens) FROM model_usage m
# JOIN session s ON s.id=m.session_id WHERE m.started_at >= <今日0点epoch-ms> GROUP BY 1
```

## 附录 B：本次快照关键数据（2026-09-25 03:00）

- 运行实例：3（A=默认/`%APPDATA%\ZCode`/PID 65832；B=`243a413f411aa795`/PID 110888；C=`72a93d16b0a02394`/PID 119232）
- app-server 进程：16（A:8、B:4、C:4+，动态）；zcode 管道：24（cua-helper×3 + node-repl×21）
- 全局 db.sqlite：1.42GB + WAL 4.1MB；session 572、model_usage 50385（今日 1776 次、6.47 亿 token）
- 实例 tasks-index：A 95 任务/16 工作区、B 17/6、C 19/6、72caee 24/5（未运行）、新实例 23/5（未运行）；B∩C 任务重叠 16
- 账号：A=`c6f99be9…`(+team)、B=C=`b232a784…`+bigmodel `27291743970482796`、72caee=bigmodel `76161784256237743`、新实例=`89938f0b…`
