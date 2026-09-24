# ZCode 源码探索报告

> 调研对象：`F:\ZCode-main`（ZCode v3.14.x，只读参考，未做任何修改）
> 调研日期：2026-09-24
> 目的：为 Nexus（本地 AI Agent 算力监控中心）提供 UI 设计语言参考与 Token 消耗数据读取方案。

---

## 1. 技术栈与架构

### 1.1 总体形态

ZCode 是一个 **Electron 桌面应用 + Web 客户端 + 终端 TUI** 三形态的 AI 编程工作台，pnpm monorepo。

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 桌面框架 | **Electron 41.0.3** + electron-builder 26.8.1 | `packages/desktop/package.json`（`"electron": "41.0.3"`、`"electron-builder": "^26.8.1"`、`"productName": "ZCode"`） |
| 前端框架 | **React 19.2.7**（pnpm overrides 统一）+ TypeScript 6 + Vite 8 | 根 `package.json`（`pnpm.overrides.react = 19.2.7`）；`packages/desktop/package.json`（`vite ^8.0.2`） |
| UI 样式 | **Tailwind CSS 4.2.2**（`@tailwindcss/vite` 插件，CSS-first `@theme` 配置）+ shadcn/radix 组件源码 + cva | `packages/desktop/package.json` devDeps；`packages/ui/src/styles.css` 第 1-9 行（`@import "tailwindcss"`、`@import "shadcn/tailwind.css"`、`@plugin "@tailwindcss/typography"`） |
| 组件库 | **无预编译组件库**，shadcn 风格组件源码直接放在 `packages/ui/src/components/ui/`（radix-ui + class-variance-authority） | `packages/ui/src/components/ui/button.tsx`（`import { cva } from "class-variance-authority"`、`import { Slot } from "radix-ui"`） |
| 图表库 | **recharts 3.8.0**，shadcn `chart.tsx` 封装 | `packages/ui/package.json`（`"recharts": "^3.8.0"`）；`packages/ui/src/components/ui/chart.tsx` |
| 动画库 | tw-animate-css（Radix 进出场工具类）+ **motion/react**（数字翻页等精细动画） | `styles.css` 第 2 行；`packages/ui/src/components/ui/flip-metric-value.tsx`（`import { AnimatePresence, motion } from "motion/react"`） |
| 状态管理 | **Zustand**（`packages/ui/src/store/`） | 根 `README.md` 仓库结构表；`AGENTS.md`「Zustand 状态位于 packages/ui/src/store/」 |
| 图标 | lucide-react | `packages/ui/src/settings/usage-stats/AppUsagePanel.tsx`（`import { RefreshCcw } from "lucide-react"`） |
| 数据持久化（Agent CLI） | **Node.js 内置 `node:sqlite`（`DatabaseSync`）**，不是 better-sqlite3 / drizzle / prisma；迁移为手写 SQL 数组 | `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts` 第 1 行（`import type { DatabaseSync } from "node:sqlite"`）；`migrations.ts` 的 `SQLITE_MIGRATIONS` 数组 |
| 运行时 | Node.js 24.14.0（`engines >= 24`）、pnpm 10.33.2 | 根 `.nvmrc`（内容 `24`）、`package.json` engines、`mise.toml` |
| 工具链 | oxlint + oxfmt（非 ESLint/Prettier）、husky、架构自治检查脚本 | 根 `package.json` scripts、`architecture-policy.yaml` |

### 1.2 monorepo 结构与各包职责

（根 `README.md`「仓库结构」表 + `architecture-policy.yaml` modules 清单）

| 目录 | 职责 |
| --- | --- |
| `packages/desktop` | Electron Main / Host / Renderer 与桌面打包（electron-builder） |
| `packages/web` | Web 客户端（浏览器访问同一后端） |
| `packages/server` | HTTP / WebSocket 服务与远程连接 |
| `packages/zcode-server-cli` | 独立 Server 启动与进程管理 |
| `packages/ui` | **共享 React 组件、hooks 与 Zustand store（设计系统核心所在）** |
| `packages/services` | 业务服务与持久化（含 `src/storage` 存储治理模块） |
| `packages/shared` / `packages/rpc` / `packages/client` | 共享协议与类型、RPC 框架、Agent 客户端 SDK |
| `packages/provider` / `packages/provider-node` | Provider 公共能力与 Node 实现 |
| `packages/model-option-map` / `packages/zcode-cua` / `packages/formal-proof` | 模型选项映射 / 计算机使用代理 / 形式化证明 |
| `apps/zcode-cli` | **Agent CLI、TUI、运行时**；内部子包：`adapters`（存储/日志适配）、`bootstrap`（协议投影）、`core`（Agent 核心）、`contracts`（类型契约）、`telemetry`、`debug` 等 |
| `harness/remote` | 远程运行环境 Dockerfile（SSH/WSL 远程工作区） |
| `config/` | 随客户端发布的默认配置（`config/default.json`） |
| `scripts/`、`third-party/` | 构建维护脚本、第三方声明材料 |

### 1.3 进程与通信架构（对 Nexus 有参考价值）

- Desktop 通过 **stdio 与 Agent 进程通信**；Main 只管窗口/原生操作/进程调度，不承载业务状态（`AGENTS.md`「进程、协议与远程控制」）。
- 协议定义在 `packages/shared/src/zcode-protocol/index.ts`，严格类型 + 运行时校验。
- UI 通过 `packages/ui/src/hooks/` 访问服务，平台操作走 `IPlatformService`（`packages/shared/src/platform.ts`），禁止直接 `window.zcode`。

---

## 2. UI/UX 设计语言

设计系统的权威文档是 **`DESIGN.md`**（约 540 行，明确规定"生成 UI 前先遵守此文件"），实际 Token 落地在 **`packages/ui/src/styles.css`**（2053 行）。产品性格定义："calm, dense, and operational rather than decorative"——冷静、高密度、操作型，明确反对营销式大间距、装饰性渐变、大面积品牌色填充。

### 2.1 主题体系

四套主题：默认 fallback（`:root` / `.dark`）+ **Zai Light（`.theme-zai-light`）** + **Zai Dark（`.theme-zai-dark`）**。DESIGN.md 规定新 UI 以 Zai Light/Zai Dark 为准。全部用 CSS 变量定义，Tailwind 4 `@theme` 桥接为 `bg-*`/`text-*`/`border-*` 工具类。

**关键特征：Zai Dark 不是蓝紫暗色，而是中性灰阶（纯灰无色相）+ 语义色点缀；品牌色 `--color-brand` 在暗色下是纯白、亮色下是纯黑。** 这正是"去 AI 感"的源头。

### 2.2 Zai Dark 完整色彩 Token（精确值，摘自 `styles.css` 606-750 行）

#### 背景多层

| Token | 值 | 用途 |
| --- | --- | --- |
| `--color-background` | `#161616` | 页面/工作区最底层 |
| `--color-background-win-alt` | `#2b2b2b` | Windows 桌面窗口底层 |
| `--color-background-alt` | `color-mix(background-win-alt 60%, transparent)` | 软分区背景 |
| `--color-header` | `#202020` | 头部/面板结构面 |
| `--color-panel` | `#202020` | 面板 |
| `--color-sidebar` | `#161616` | 侧边栏 |
| `--color-surface` | `rgba(255,255,255,0.05)` | 低浮雕容器（图表容器用它） |
| `--color-surface-hover` | `rgba(255,255,255,0.10)` | surface 悬停 |
| `--color-card` | `#2b2b2b` | 标准卡片 |
| `--color-card-selected` | `var(--color-input)`（= `#2b2b2b`） | 选中卡片 |
| `--color-popover` / `--color-menu` | `#2b2b2b` / `#2b2b2b` | 浮层/菜单 |
| `--color-menu-hover` | `#363636` | 菜单项悬停 |
| `--color-input` | `#2b2b2b` | 输入框 |
| `--color-input-focused` | `var(--color-input)` | 输入聚焦（不变背景） |
| `--color-toast` / `--color-tooltip` | `#2b2b2b` / `#2b2b2b` | 通知/提示 |
| `--color-tab` / `--color-tab-active` | `#202020` / `#161616` | 标签页 |

层级逻辑：`#161616`（底/侧栏）→ `#202020`（结构面）→ `#2b2b2b`（卡片/浮层）→ `#363636`（悬停/次级元素）。**靠亮度分层，不靠阴影。**

#### 文字多层级

| Token | 值 | 用途 |
| --- | --- | --- |
| `--color-foreground` | `var(--color-neutral-300)`（≈ `#d4d4d4`） | 主文本 |
| `--color-foreground-subtle` | `color-mix(neutral-300 60%, transparent)` | 元数据/辅助说明 |
| `--color-foreground-subtlest` | `color-mix(neutral-300 30%, transparent)` | 占位符/最弱提示 |
| `--color-foreground-inverse` | `#000000` | 深色填充上的反色文字 |

#### 边框

| Token | 值 |
| --- | --- |
| `--color-border` | `rgba(255,255,255,0.10)` |
| `--color-border-hover` | `rgba(255,255,255,0.15)` |
| `--color-card-border` / `--color-popover-border` / `--color-input-border` | 均指向 `--color-border` |
| `--color-input-border-hover` | `--color-border-hover` |
| `--color-input-border-focused` | `--color-border-hover`（**聚焦不变亮**，Zai 主题刻意弱化） |

#### 强调与交互

| Token | 值 | 用途 |
| --- | --- | --- |
| `--color-brand` | `#ffffff` | 关键强调/激活指示（**克制使用，禁大面积填充**） |
| `--color-primary` / `--color-primary-foreground` | `#ffffff` / `#000000` | 主按钮（白底黑字） |
| `--color-secondary` | `#363636` | 次级按钮 |
| `--color-accent` | `#001d3d` | 弱强调色块 |
| `--color-hover` | `rgba(255,255,255,0.05)` | 通用悬停 |
| `--color-selected` | `rgba(255,255,255,0.10)` | 选中态 |
| `--color-icon-blue` | `#80beff`（terminal-bright-blue） | 浏览器式链接蓝 |

#### 状态色

| Token | Zai Dark 值 | Zai Light 值 |
| --- | --- | --- |
| `--color-success` | `#46bf72` | `#1e8a3e` |
| `--color-warning` | `#ff8a30` | `#e07b00` |
| `--color-destructive` | `#ff5c5c` | `#e03131` |
| `--color-destructive-foreground` | `#ffffff` | `#ffffff` |
| `--color-warning-foreground` | `#000000` | `#ffffff` |
| `--color-success-foreground` | `#000000` | `#ffffff` |
| `--color-idle-task`（空闲任务紫） | `#7b5ce5` / surface `#160d38` | `#9e77ed` / `#f5f3ff` |
| Diff added / removed | `#46bf72` / `#ff5c5c` | `#1e8a3e` / `#e03131` |
| Git modified / added / deleted / renamed | `#ff8a30` / `#46bf72` / `#ff5c5c` / `#4099ff` | `#e07b00` / `#1e8a3e` / `#e03131` / `#0b7fff` |

DESIGN.md 规则：语义色只用于真实语义状态，禁止借状态色"加大音量"；等待类 badge 统一用绿色确认色（`--color-interaction-confirmation-surface: rgba(70,191,114,0.16)`，前景 `#87d9a4`），不用蓝紫。

#### 图表用色（用量图表专属六色板，不复用终端 ANSI 色避免高饱和堆叠）

`--color-usage-chart-1..6`（Zai Dark）：`#4099ff`（蓝）、`#46bf72`（绿）、`#7b5ce5`（紫）、`#ff5c5c`（红）、`#ff8a30`（橙）、`#42c8c8`（青）。
（Zai Light：`#0b7fff`、`#1e8a3e`、`#9e77ed`、`#e03131`、`#e07b00`、`#0aa7a7`。）

热力图五档：`--color-usage-heatmap-0..4` = sky 蓝与 surface 按 oklab 0% / 24% / 42% / 62% / 78% 混合（暗色基准 `#4099ff`）。上下文分解七档蓝色阶：`--color-context-breakdown-1..7` 从 `#4099ff` 渐次冲白到 `#e4f1ff`。

分类标签色（file/skill/session/plugin 节点 badge，暗色）：前景 `#8fc5ef` / `#bda5e6` / `#c8cd90` / `#93d8d2` / `#efc58f`，底色为对应色 16% 透明度。

#### 终端 ANSI 色板（暗色）

black `#363636`、red `#ff5c5c`、green `#46bf72`、yellow `#ff8a30`、blue `#4099ff`、magenta `#7b5ce5`、cyan `#42c8c8`、white `#adadad`；bright 系列相应提亮（如 bright-red `#ff9999`）。

### 2.3 字体体系

- **UI 字体栈**：Tailwind 默认 sans（系统栈）。
- **等宽字体栈**（`styles.css` `@theme --font-mono`，显式插入 CJK 防落到宋体）：
  `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", monospace`
- **`text-ui-*` 专用 UI 字号刻度**（仓库级强制约束，禁止 Tailwind 内置 `text-sm` 等；全局唯一旋钮 `--ui-font-size`，默认 14px）：

| Token | 公式 | 默认值 | 语义角色 |
| --- | --- | --- | --- |
| `text-ui-xl` | +4px | 18px | Markdown h1 |
| `text-ui-lg` | +2px | 16px | h2、KPI 大数值 |
| `text-ui-base` | = | 14px | 正文、按钮、区块标题（h3-h6 同用，靠字重分层：semibold/medium/normal） |
| `text-ui-caption` | −1px | 13px | 比正文低一级的紧凑辅助文案 |
| `text-ui-sm` | −2px | 12px | 次要信息、Tooltip、行内代码 |
| `text-ui-xs` | −4px | 10px | 快捷键、badge、计数器、极弱元数据 |
| `text-ui-2xs` | −5px | 9px | **仅限图表轴刻度**（受限例外） |

- 字重规范：标题/标签最多 `font-medium`，避免重字重；数值用 `font-mono tabular-nums`（图表 tooltip 实证）。
- 界面字号设置**只改 `--ui-font-size`，不改 html 根字号**；图标/间距/圆角不随字号缩放。

### 2.4 间距体系（4px 网格）

DESIGN.md 规定的节奏：`4px` 图标-文字紧贴 / `8px` 紧凑控件内边距 / `12px` 密集列表行 / `16px` 标准卡片与面板内边距 / `20-24px` 大区块与对话框内部。要求复用少数固定间距，不引入任意值；文本 flex 加 `min-w-0`，嵌套滚动加 `min-h-0`。

### 2.5 圆角规范（嵌套递减，内容容器上限 12px）

DESIGN.md「Radius」章节核心：

- 第一个圆角容器从 **`rounded-xl`（12px）** 起；嵌套容器依次降级 `rounded-lg`(8px) → `rounded-md`(6px) → `rounded-sm`(4px)，`sm` 为下限。
- **`rounded-2xl`(16px) 是受控例外**，仅限：主聊天输入壳、会话状态浮板、Toast、品牌图标背板。普通卡片/工具块/按钮**禁止 2xl**。
- 基础控件（按钮/输入/Select 触发器）默认 `rounded-lg`，按最近圆角父容器降级。
- `rounded-full` 仅限刻意的药丸/圆形；禁止任意圆角值。
- 桌面窗口面板圆角按平台：Windows `5px`、macOS `6/12px`、Linux `12px`（`packages/ui/src/app-shell/workspaceShellWindowChrome.ts` `resolveWorkspaceShellPanelRadiusPx`）。
- 工作流图轴件等 hairline：`--color-workflow-rule: rgba(255,255,255,0.065)`。

### 2.6 阴影/海拔规范

- **分层靠背景对比 + 边框 + 圆角，不靠重阴影**。
- Base：无阴影；Surface：细微边框；Overlay（菜单/Popover/对话框）：`shadow-md`；Attention（Toast/重要浮卡）：`shadow-lg`。
- 图表 tooltip 实际用 `shadow-xl` + `border-border/50 bg-background`（`chart.tsx` 172 行）。
- 菜单 surface 必须从打开第一帧起保持 overlay 阴影。

### 2.7 动效规范（实测值）

| 场景 | 参数 | 出处 |
| --- | --- | --- |
| 按钮/输入颜色过渡 | `transition-colors`（只过渡颜色，明确禁 `transition-all` 以免批量触发非合成动画） | `button.tsx` 7-10 行注释 |
| 面板 flex-grow 动画 | `duration-200 ease-out`（fallback 240ms） | `useAnimatedResizablePanel.ts` 4-5 行 |
| 文本流入 | `900ms cubic-bezier(0.16, 1, 0.3, 1)`（expo-out 类） | `styles.css` 974-986 行 |
| 折叠收起 | `300ms ease-in-out forwards` | `styles.css` 994-998 行 |
| 数字翻页（KPI） | `0.16s` + `cubic-bezier(0.4, 0, 0.2, 1)`（Material standard），rotateX 翻页 | `flip-metric-value.tsx` 5-8 行 |
| 环境呼吸（连接中/运行中） | `1.8s / 900ms ease-in-out infinite` | `styles.css` 1126、1229 行 |
| 加载渐变流光 | `4s linear infinite` / `1s linear infinite`（仅限品牌时刻） | `styles.css` 838、862 行 |
| 热力图单元格悬停 | `transition-transform hover:scale-110` | `UsageHeatmapCells.tsx` 68 行 |
| Tooltip 进出场 | `fade-in-0 zoom-in-95` + 方向 slide（tw-animate-css） | `tooltip.tsx` 41 行 |

原则：快、低戏剧性；fade/zoom/方向性 slide 优先；**所有动画配 `prefers-reduced-motion: reduce` 关闭分支**（styles.css 多处实证）。

### 2.8 核心组件样式（可直接抄的类名）

**按钮**（`packages/ui/src/components/ui/button.tsx`）：
- 基类：`inline-flex items-center justify-center rounded-md border border-transparent text-ui-base/relaxed whitespace-nowrap transition-colors select-none disabled:opacity-50`
- 变体：primary = `bg-primary text-primary-foreground hover:bg-primary/80`；outline = `border-border text-foreground hover:border-border-hover hover:bg-input/50`；secondary = `bg-secondary text-foreground hover:bg-secondary/80`；ghost = `text-foreground hover:bg-hover`；destructive = `bg-destructive text-destructive-foreground hover:bg-destructive/90`；link = `text-primary underline-offset-4 hover:underline`。
- 尺寸：`xs h-5 / sm h-6 / default h-7 / lg h-8`，icon 方形 `size-5/6/7/8`；按钮内 svg 默认 `size-3.5`。**控件高度体系是 h-6/h-7/h-8（DESIGN.md「Control heights: h-6, h-7, h-8, h-9"）。**

**卡片**（`card.tsx`）：`rounded-xl border border-card-border bg-card py-4 gap-4`，Header/Content/Footer 水平内边距 `px-4`（sm 变体 `px-3`），CardTitle `text-ui-base font-medium`，CardDescription `text-foreground-subtle`。

**Badge**（`badge.tsx`）：`h-5 rounded-full px-2 py-0.5 text-ui-xs font-medium`；destructive 变体用 `bg-destructive/10 text-destructive`（暗色 `/20`）——**低饱和底 + 高饱和前景**的 tag 语言。运行成功 tag 实例：`bg-success/14 text-success`（`TaskListItem.tsx` 637 行）。

**输入框**（`input.tsx`）：`border border-input-border bg-input text-foreground transition-colors placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:ring-0`；尺寸 `xs h-5 / sm h-6 / default h-7 / lg h-8`，`px-2`。设计意图"平静、融合，不发光"。

**滚动条**（全局，`styles.css` 757-782 行）：

```css
* { scrollbar-width: auto; scrollbar-color: var(--color-border) transparent; }
*::-webkit-scrollbar { width: 14px; height: 14px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb {
  min-height: 32px; min-width: 32px;
  border: 3px solid transparent; border-radius: 9999px;
  background: var(--color-border); background-clip: padding-box;
}
```

**Tooltip**（`tooltip.tsx`）：`rounded-lg border border-border bg-tooltip px-3 py-1.5 text-ui-sm text-tooltip-foreground`；快捷键标签 `text-ui-xs`。

**菜单**：shell `bg-menu border border-popover-border rounded-lg p-1 shadow-md`，行项 `rounded-md px-2 gap-2 text-ui-base h-6/h-7`，行间 `gap-0.5`（固定 2px），选中用 checkmark 而非整行强填充（DESIGN.md「Menus」）。

**侧边栏任务/会话列表项**（`TaskListItem.tsx` 543-582 行）：
- 行：`group/task-item flex cursor-pointer gap-2 rounded-lg pl-2.5 pr-1 py-1 transition-[background-color,border-color,box-shadow]`；选中 `bg-selected`，悬停 `bg-surface-hover`。
- 状态指示灯：`h-1.5 w-1.5 rounded-full` 圆点——错误 `bg-destructive`、运行中 `bg-sky-500 dark:bg-sky-400`、空闲 `bg-border`。

**空状态**（`usageStatsUiParts.tsx` 90-97 行）：`rounded-xl border border-dashed border-border px-4 py-10 text-center`，标题 `text-ui-base font-medium`，描述 `text-foreground-subtle`。

### 2.9 布局尺寸

- 工作区侧边栏：**默认/最小 264px，最大为容器 50%**，折叠态 4px，宽度持久化到 localStorage（`WorkspaceShellLayout.tsx` 99-104 行常量）。
- 面板分割用百分比：会话列默认 52%、Side Pane 默认 45%（`sidePaneLayout.ts` `SIDE_PANE_DEFAULT_EXPANDED_SIZE = "45%"`），最小 35%。
- 内容区最小宽 `min-w-[320px]`；桌面 inset 布局面板间 **4px 可调间隙**（DESIGN.md「Workspace layout」）。
- 卡片水平内边距 16px；KPI 条带项 `px-4 py-3`。
- resize 手柄：透明 4px 命中区 + 悬停显示 2px `foreground-subtlest/50` 圆角指示线（DESIGN.md + `WorkspaceShellLayout.tsx` 1628 行）。

---

## 3. 本地数据存储（Token 消耗记录）

### 3.1 数据库位置与引擎

- **路径（源码确认）**：`~/.zcode/cli/db/db.sqlite`
  证据：`apps/zcode-cli/packages/adapters/src/storage/session-store/paths.ts`：
  ```ts
  export function getDefaultSessionDbPath(): string {
    return join(homedir(), ".zcode", "cli", "db", "db.sqlite");
  }
  ```
  可用 `ZCODE_DATA_BASE_DIR` 改变数据基目录（根 `README.md`）。
- **引擎**：Node.js 内置 `node:sqlite` `DatabaseSync`（同步 API），无 ORM。
- **连接配置**（`migration-runner.ts`）：`pragma journal_mode = wal`（**WAL 模式，读写可并发**）、`pragma busy_timeout = ...`、`pragma foreign_keys = on`。→ Nexus 可以在 ZCode 运行时以**只读模式**（`sqlite3` 连接串加 `?mode=ro` 或 `PRAGMA query_only=1`，配合 `busy_timeout`）安全读取。
- **迁移记账表**：`schema_migration(id, checksum, app_version, time_applied)`（`migration-runner.ts` 161 行）。当前迁移链 `0001` ~ `0022`（`migrations.ts`）。

### 3.2 与 Nexus 直接相关的三张用量表（迁移 `0010_usage_observability`，v0.15.0 起）

#### `model_usage`（每次模型请求一行，核心表）

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | text PK | 请求记录 ID（upsert 主键） |
| `logical_request_id` | text | 逻辑请求 ID（同一次重试共享） |
| `attempt_index` | integer | 重试序号，默认 0 |
| `session_id` | text FK→session | 会话 ID |
| `turn_id` / `trace_id` / `span_id` | text | 轮次/追踪/跨度 ID |
| `assistant_message_id` / `parent_user_message_id` | text | 关联消息 |
| `query_source` | text | 查询来源（`main_turn` / `subagent` / `workflow_child` 等，见 `usage.ts` `taskUsageInputBaselineSource`） |
| `provider_id` | text | 供应商标识 |
| `model_id` | text | **模型名** |
| `variant` | text | 变体（写入的是 reasoningLevel，见 `usage.ts` 29 行注释） |
| `agent` / `mode` / `task_type` | text | Agent 名 / 模式 / 任务类型 |
| `status` | text | `running / completed / error / cancelled` |
| `started_at` | integer | **开始时间（epoch ms）**；另有 `first_token_at`、`completed_at` |
| `duration_ms` / `time_to_first_token_ms` | integer | 总耗时 / 首 token 延迟 |
| `finish_reason` | text | 结束原因 |
| `tool_call_count` | integer | 工具调用数 |
| `input_tokens` | integer | **输入 token**（AI SDK v6 起已是总输入，含缓存部分，见 `usage.ts` 715 行注释） |
| `output_tokens` | integer | **输出 token** |
| `reasoning_tokens` | integer | 推理 token |
| `cache_creation_input_tokens` | integer | **缓存写入 token** |
| `cache_read_input_tokens` | integer | **缓存读取 token** |
| `provider_total_tokens` | integer (nullable) | 供应商报告的总 token（可能为 NULL） |
| `computed_total_tokens` | integer | 本地计算总量 = 输入侧（input，或 cache_creation+cache_read）+ output |
| `retry_count` / `retryable` / `cancelled_by_user` / `context_exceeded` | integer 0/1 | 重试/可重试/用户取消/上下文超限 |
| `error_type` / `error_code` / `error_message` | text | 错误信息 |
| `raw_usage_json` / `provider_metadata_json` | text | 原始用量/供应商元数据 JSON |

索引：`(started_at, provider_id, model_id)`、`(session_id, turn_id)`、`(trace_id)`、`(query_source)`。

#### `turn_usage`（每个会话轮次一行，PK `(session_id, turn_id)`）

字段与 model_usage 大体同构，另含：`model_request_count`、`model_retry_count`、`tool_call_count`、`tool_error_count`、`first_model_start_at`；token 五项同上。索引 `(started_at)`。

#### `tool_usage`（每次工具调用一行）

`session_id`、`turn_id`、`trace_id`、`tool_call_id`（unique `(session_id, tool_call_id)`）、`tool_name`、`side_effect_scope`、`read_only`、`destructive`、`approval_status`、`status`、`started_at`、`first_output_at`、`completed_at`、`duration_ms`、`time_to_first_output_ms`、`exit_code`、`output_bytes` / `stdout_bytes` / `stderr_bytes`、`truncated`、`retry_count`、错误三字段。索引 `(started_at, tool_name)`。→ Nexus 可做"工具调用统计/错误率"面板。

### 3.3 其他相关表（同一数据库）

- `session`：会话主表——`id, project_id, workspace_id, parent_id, slug, directory, path, title, version, summary_additions/deletions/files/diffs, time_created, time_updated, time_archived, task_type, trace_id, title_source` 等。Nexus 的"Agent/项目/工作区"维度来自这里。
- `message` / `part`：消息与消息部件，`data` 列存 JSON payload（含 sequence 序号与自动补齐触发器，迁移 0014/0015）。
- `session_target`：任务目标与 token 预算（`token_budget, tokens_used, time_used_seconds, status`）。
- `input_history`：用户输入历史。
- `workflow_run / workflow_activity / workflow_event / session_task_link`：工作流运行与父子会话链（`session_task_link.model` 列存子代理模型）。
- `dwf_run / dwf_actor / dwf_node / dwf_event`：dynamic-workflow 日志（`dwf_run.spent_tokens` 为 run 级 token 观测面）。
- `local_setting`：本地设置 KV。

### 3.4 关键行为约束（直接影响 Nexus 设计）

1. **用量表只保留 30 天**：`repositories/usage.ts` 第 17 行 `const USAGE_RETENTION_DAYS = 30;`，每次写入后 `pruneUsage` 删除 `started_at` 早于 30 天的三表记录。→ **Nexus 若要长期历史，必须自行定期采样入库**。
2. **token 口径**：`computed_total_tokens = inputSide + outputTokens`；`inputSide = input_tokens > 0 ? input_tokens : (cache_creation + cache_read)`（`usage.ts` `inputSideTokensFromNormalizedUsage`）。按会话累计时用 `queryTaskUsage` 的"输入基线去重"算法：对 `main_turn/subagent/workflow_child` 按 `query_source` 维护 baseline，增量输入 = `max(0, 当前输入侧 − baseline)`，避免把不断增长的上下文重复计入（`usage.ts` 620-674 行）。**Nexus 照抄该算法可保证口径与 ZCode UI 一致。**
3. **按日归桶公式**：`dayIndex = cast((started_at + tzOffsetMs) / 86400000 as integer)`，时区偏移用 Intl 计算（`usage-stats-builder.ts` `resolveTzOffsetMs`），DST 误差 ≤1 小时可接受（源码注释）。
4. **官方聚合快照**：`buildAppUsageSnapshot`（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/usage-stats-builder.ts`）输出 totals、cacheHitRate（= cacheRead/input，分母不再叠加缓存）、modelErrorRate、toolErrorRate、activeDays、currentStreak/longestStreak、peakDayTokens、heatmap（0-4 档：ratio > 0.75→4，>0.5→3，>0.25→2，>0→1）。
5. **JSONL 日志（非 Token 主数据源，但可补充诊断）**：`~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl`，按天一个文件，**保留 7 天**（`retention.ts` `LOG_RETENTION_DAYS = 7`）。每行字段：`timestamp, level, levelName, event, module, message, traceId, sessionId, turnId, spanId, parentSpanId, toolCallId, durationMs, status, context, error`（`logging/index.ts` `createEntry`）。
6. 其他路径：用户配置 `~/.zcode/cli/config.json`（`config-factory.ts` 37 行）；运行包安装目录 `~/.zcode/runtime`。

---

## 4. 可复用资产清单

### 4.1 设计 Token（可整体迁移）

| 资产 | 源码路径 | 迁移方式 |
| --- | --- | --- |
| 全量主题变量（4 套主题） | `packages/ui/src/styles.css`（`@theme` 57-306 行 + `.theme-zai-dark` 606-750 行） | 直接摘取 `.theme-zai-dark`/`.theme-zai-light` 变量块做 Nexus `theme.css` |
| 等宽字体栈（CJK 修正） | `styles.css` 140-142 行 | 原样复制 |
| `text-ui-*` 字号刻度 | `styles.css` 143-155 行 | 连同"只改 `--ui-font-size`"机制一起迁移 |
| 全局滚动条样式 | `styles.css` 757-782 行 | 原样复制 |
| 图表色板引用模式 | `packages/ui/src/settings/usage-stats/appUsageChartPalette.ts` | 6 色 CSS 变量轮询函数 |

### 4.2 UI 组件（可复用/适配，均在 `packages/ui/src/`）

| 组件 | 相对路径 | 对 Nexus 的用途 |
| --- | --- | --- |
| Button | `components/ui/button.tsx` | 直接移植（cva 变体表） |
| Card | `components/ui/card.tsx` | KPI 卡/图表卡基座 |
| Badge | `components/ui/badge.tsx` | 模型名/状态标签 |
| Input | `components/ui/input.tsx` | 筛选输入 |
| Tooltip | `components/ui/tooltip.tsx` | 悬浮说明 |
| Chart 封装（recharts） | `components/ui/chart.tsx` | 图表容器/tooltip 模板 |
| FlipMetricValue（KPI 数字翻页） | `components/ui/flip-metric-value.tsx` | KPI 数值刷新动画 |
| 用量 KPI 条带 | `settings/usage-stats/AppUsagePanel.tsx`（`AppUsageLifetimeSummaryStrip`） | Nexus KPI 卡矩阵的直接参照 |
| 每日模型趋势折线图 | `settings/usage-stats/AppUsageDailyModelTrendChart.tsx` | Token 趋势图参照（含轴标签稀疏化、tooltip 过滤） |
| 模型占比饼图 | `settings/usage-stats/AppUsageModelUsagePieChart.tsx` | 模型分布图 |
| 热力图 | `settings/usage-stats/UsageHeatmap.tsx` + `UsageHeatmapCells.tsx` | 活跃度热力图（52 周、0-4 档色） |
| 空状态/数字格式化 | `settings/usage-stats/usageStatsUiParts.tsx` + `lib/tokenNumberFormat.ts` | `Intl.NumberFormat` compact 格式化 |
| 会话列表项 | `TaskListItem.tsx` | 侧边栏 Agent 列表项参照 |
| 窗口壳/面板圆角 | `app-shell/workspaceShellWindowChrome.ts`、`app-shell/sidePaneLayout.ts` | 布局参数参照 |

### 4.3 数据采集/统计逻辑（可借鉴）

| 逻辑 | 路径 | 说明 |
| --- | --- | --- |
| DB 路径解析 | `apps/zcode-cli/packages/adapters/src/storage/session-store/paths.ts` | `~/.zcode/cli/db/db.sqlite` |
| 全量 schema（22 条迁移） | 同目录 `migrations.ts` + `migrations/00XX-*.ts` | 建表 SQL 权威来源 |
| 用量写入/upsert/30 天清理 | 同目录 `repositories/usage.ts` | `recordModelUsage` / `upsertTurnUsage` / `pruneUsage` |
| 应用级聚合查询 | 同文件 `queryAppUsage` | totals/models/tools/按日/按日分模型六组 SQL，可直接移植到 Nexus |
| 会话级口径（输入基线去重） | 同文件 `queryTaskUsage` | 增量输入 token 算法 |
| 快照组装（命中率/连击/热力档位） | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/usage-stats-builder.ts` | `buildAppUsageSnapshot`、`resolveTzOffsetMs` |
| JSONL 日志格式与滚动 | `apps/zcode-cli/packages/adapters/src/logging/index.ts`、`retention.ts` | 字段、`zcode-YYYY-MM-DD.jsonl`、7 天保留 |

### 4.4 给 Nexus 数据层的落地建议（基于以上证据）

1. 以只读方式打开 `C:\Users\xiaotao2026\.zcode\cli\db\db.sqlite`（WAL 模式允许并发读；设置 `busy_timeout` ≥ 5000ms 应对迁移瞬间写锁；绝不写该库）。
2. KPI 主查询以 `model_usage` 为源、`computed_total_tokens` 为总量口径、`started_at` 为时间轴，按 `queryAppUsage` 的 dayIndex 公式按本地日归桶。
3. 因 30 天保留策略，Nexus 需要自己的持久层做长期快照（每日聚合一行即可，复制 `days/dayModels` 结构）。
4. "会话累计消耗"若要展示，采用 `queryTaskUsage` 的基线去重，否则上下文增长会让数字虚高。
5. 表结构可能随版本演进（schema_migration 追加式），Nexus 查询应容忍新列、只依赖本文列出的稳定列。

---

## 附：证据文件索引

- 根：`package.json`、`.nvmrc`、`mise.toml`、`pnpm-workspace.yaml`、`architecture-policy.yaml`、`AGENTS.md`、`CONTEXT.md`、`DESIGN.md`
- 设计：`packages/ui/src/styles.css`、`packages/ui/src/components/ui/{button,card,badge,input,tooltip,chart,flip-metric-value}.tsx`
- 布局：`packages/ui/src/app-shell/{WorkspaceShellLayout.tsx,sidePaneLayout.ts,useAnimatedResizablePanel.ts,workspaceShellWindowChrome.ts}`
- 用量 UI：`packages/ui/src/settings/usage-stats/*`、`packages/ui/src/TaskListItem.tsx`
- 数据：`apps/zcode-cli/packages/adapters/src/storage/session-store/{paths.ts,migrations.ts,migration-runner.ts,repositories/usage.ts}`、`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/usage-stats-builder.ts`、`apps/zcode-cli/packages/adapters/src/logging/{index.ts,retention.ts}`
- 配置：`config/default.json`、`packages/desktop/package.json`、`packages/ui/package.json`
