# Nexus — 本地 AI Agent 算力监控中心

一个本地优先的、单一窗口的桌面应用：读取本机各 AI Agent 的本地日志/数据库，把 Token 消耗、会话、工具调用汇总成一块精美看板。**纯监控，零干预**——不改任何 Agent 的配置，不干预任何 Agent 的运行。

![dark](out/board-dark.png)

## 核心特性

- **单一软件形态**：双击一个 exe → 一个窗口，无需启动后端、无需打开浏览器。
- **快照式留存**：ZCode 本地用量表仅保留 30 天，Nexus 首次同步即把全量历史快照进自有库，此后增量追加，历史永不丢失。
- **数据维度**：请求级输入/输出/推理/缓存读写 Token、会话、工具调用、按模型/Agent/项目拆分、等效 API 成本估算（UI 明确标注"估算"）。
- **看板**：KPI 卡、按模型/Agent 的 Token 趋势、7×24 活跃热力图、每日强度、Agent 占比环形图（点击下钻）、模型/工具排行、会话明细、时间范围切换（今日/近 7 天/近 30 天/全部）、暗/亮主题、看板导出 PNG。
- **隐私**：一切数据留在本机；读取用户 Agent 数据库时一律只读模式。

## 已接入的数据源

| Agent | 数据 | 精确度 |
| --- | --- | --- |
| ZCode | `~/.zcode/cli/db/db.sqlite`（请求级 token + 会话 + 工具调用） | 精确 |
| Codex | `~/.codex/sessions/**/*.jsonl`（token_count 事件） | 精确 |
| Claude Code | `~/.claude/projects/**/*.jsonl` | 精确（预留，产生数据即生效） |
| Antigravity | 会话元数据 + Antigravity Cockpit 代理日志（若启用） | 精确（启用后） |
| CodeBuddy | 会话元数据（token 存腾讯云端） | 仅会话数 |
| WorkBuddy / Qoder / Reasonix / Trae / Cursor | 仅感知安装状态（本地无结构化 token 数据，见调研报告） | — |

详见 `docs/research/agent-datasource-report.md`。

## 开发

```bash
npm install        # Node 22+（Electron 41 内含 node:sqlite）
npm run dev        # 开发模式（热重载）
npm run typecheck  # 双 tsconfig 类型检查
npm run build      # 构建主进程/preload/渲染层到 out/
npm run dist       # electron-builder 打包 NSIS 安装版 + 便携版
```

### 验证工具

```bash
npx electron out/main/smoke.js   # 冒烟：真实同步全部适配器 + 全量查询自检
NEXUS_DEBUG=1 npm run dev        # 转发渲染进程 console 到终端
```

## 架构

模块化单体（Electron 主进程），`transport(IPC) → application → domain ← infrastructure`，domain 零外部依赖；渲染层 React 19 + Tailwind 4 + ECharts 6，主题 Token 对标 ZCode Zai Dark。存储用 Electron 内建 `node:sqlite`（与 ZCode 同款，零原生编译）。详见 `docs/modules/`。

## 治理

- 文档同步：`docs/modules/index.md` + 各模块 md，秒级时间戳。
- 红蓝对抗审计：AI 子代理循环审计直至通过，结论见 `PROJECT_LAUNCH_REPORT.md`。

---
负责人/作者：xiaotaoya2022 ｜ 版本：v0.1.0 ｜ 仓库：`xiaotaoya2022-cell/nexus`（私有）
