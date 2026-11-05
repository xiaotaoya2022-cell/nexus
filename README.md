# Nexus — 本地 AI Agent 算力监控中心

一个本地优先的、单一窗口的桌面应用：读取本机各 AI Agent 的本地日志/数据库与官方用量接口，把 Token 消耗、真实花费、会话、工具调用汇总成一块精美看板。**纯监控，零干预**——不改任何 Agent 的配置，不干预任何 Agent 的运行。

![dark](out/board-dark.png)

## 核心特性

- **单一软件形态**：双击一个 exe → 一个窗口，无需启动后端、无需打开浏览器。
- **快照式留存**：各 Agent 本地用量表普遍只保留有限天数，Nexus 首次同步即把全量历史快照进自有库，此后增量追加，**历史永不丢失、永久本地**。
- **账号级真实消耗**：直连平台官方用量接口，回溯账号全历史 Token 与真实花费（¥/$），与官网账单逐条对账一致；应用内独立账号配额面板，不与看板混排。
- **平台登录**：区分国内版 / 国际版入口，普通 / 无痕两种登录方式，凭据仅存本机。
- **数据维度**：请求级输入/输出/推理/缓存读写 Token、会话、工具调用、按模型/Agent/厂商拆分、等效 API 成本估算（UI 明确标注"估算"）+ 官方账单实付。
- **看板**：KPI 卡、按模型/Agent 的 Token 趋势（分组可切换）、7×24 活跃热力图、每日强度、Agent 占比环形图（点击下钻）、模型/工具排行、会话明细（敏感信息一键遮罩）、时间范围切换（今日/近 7 天/近 30 天/全部/**自定义——精确到分钟**）、暗/亮主题、看板导出 PNG。
- **侧栏双分类**：Agent / 厂商两种视图切换，全部使用各平台官方 Logo。
- **多开感知**：ZCode 等支持多实例并存的应用，侧栏直接透出存活实例数。
- **性能**：单遍聚合 + 看板缓存预热，13 万+ 用量记录下切换时间范围/Agent 依然即时响应。
- **隐私**：一切数据留在本机；读取用户 Agent 数据库时一律只读模式。

## 已接入的数据源

| Agent / 平台 | 数据 | 精确度 |
| --- | --- | --- |
| ZCode | `~/.zcode/cli/db/db.sqlite`（请求级 token + 会话 + 工具调用，多实例感知） | 精确 |
| Codex | `~/.codex/sessions/**/*.jsonl`（token_count 事件） | 精确 |
| Claude Code | `~/.claude/projects/**/*.jsonl` | 精确（产生数据即生效） |
| Antigravity | 会话元数据 + Antigravity Cockpit 代理日志（若启用） | 精确（启用后） |
| CodeBuddy（国内版 / 国际版） | 本地 history 逐请求 usage + vscdb 会话关联 + 官方账单 | 精确 |
| WorkBuddy | `~/.workbuddy-ai` 转录 + traces + 本地库 | 精确 |
| Reasonix | stats 每日 jsonl | 精确 |
| OpenCode | `opencode.db` | 精确 |
| DSH（DeepSeek Harness） | 会话多帧 zstd 档案逐帧解压（含 per-model 细分与压缩上下文用量） | 精确 |
| DeepSeek 官方平台 | usage API 全历史分段滚动回溯 | 精确（与官网对账一致） |
| Qoder / Trae / Cursor | 本地无结构化 token 数据（见调研报告） | 仅感知安装状态 |

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
负责人/作者：xiaotaoya2022 ｜ 版本：v0.2.24 ｜ 仓库：`xiaotaoya2022-cell/nexus`（私有）
