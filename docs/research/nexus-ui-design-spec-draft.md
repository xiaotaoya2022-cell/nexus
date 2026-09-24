# Nexus UI 设计规范草案

> 依据：ZCode 设计语言（`F:\ZCode-main\DESIGN.md` + `packages/ui/src/styles.css`），详见同目录《ZCode 源码探索报告》。
> 适用对象：Nexus —— 本地 AI Agent 算力监控中心（桌面应用，三栏布局，KPI 卡片 + 图表矩阵）。
> 版本：draft v0.1（2026-09-24）

---

## 0. 设计原则（从 ZCode 继承 + 去 AI 感清单）

Nexus 与 ZCode 同属"长时间盯着看、高信息密度、操作型"的工具，视觉性格定为：**冷静、致密、仪表化（calm / dense / operational）**。

**禁止清单（硬约束）：**
1. 禁紫蓝渐变、禁一切装饰性渐变背景；品牌强调只用单色。
2. 禁超大圆角：内容容器圆角上限 **12px（rounded-xl）**，禁止 16px+（ZCode 中 rounded-2xl 是受控例外，Nexus 无此例外场景）。
3. 禁玻璃态（glassmorphism / backdrop-blur 面板）、禁发光标题、禁霓虹描边。
4. 禁营销词汇与营销式排版：界面文案不出现"赋能/极速/强大/重新定义"，无 hero 大标题、无大间距营销卡片。
5. 禁大面积品牌色填充；语义色（绿/橙/红）只用于真实状态。
6. 禁 raw 色值散落组件——一切颜色走语义 Token（`bg-card`/`text-foreground-subtle` 这一层）。

**正向原则：**
- 分层靠背景亮度阶梯 + 1px 边框 + 圆角，不靠阴影与毛玻璃。
- 信息密度优先：先用文字层级（字号/颜色/字重）表达主次，再加边框和颜色。
- 数字是主角：一切指标用 `font-mono tabular-nums`。
- 所有动效尊重 `prefers-reduced-motion`。

---

## 1. 色彩 Token 表

采用 ZCode 同构的 CSS 变量命名，方便组件类名直接照搬。默认深色为主（监控看板长时驻留），同时定义亮色表以支持 System 跟随。

### 1.1 深色主题（基准主题，源自 Zai Dark）

```css
:root.theme-dark {
  /* ── 背景四层阶梯 ── */
  --color-background: #161616;        /* 页面底层、侧栏 */
  --color-panel: #202020;             /* 结构面：顶栏、分区底 */
  --color-card: #2b2b2b;              /* 卡片/浮层/输入框 */
  --color-raised: #363636;            /* 悬停、次级按钮、菜单 hover */

  /* ── 表面（叠加在任意层级上的半透明层）── */
  --color-surface: rgba(255, 255, 255, 0.05);        /* 图表容器、KPI 条带底 */
  --color-surface-hover: rgba(255, 255, 255, 0.10);
  --color-hover: rgba(255, 255, 255, 0.05);
  --color-selected: rgba(255, 255, 255, 0.10);

  /* ── 文字 ── */
  --color-foreground: #d4d4d4;                 /* 主文本 (neutral-300) */
  --color-foreground-subtle: #d4d4d499;        /* 60% 辅助说明 */
  --color-foreground-subtlest: #d4d4d44d;      /* 30% 最弱元数据 */
  --color-foreground-inverse: #000000;         /* 白/亮填充上的字 */

  /* ── 边框 ── */
  --color-border: rgba(255, 255, 255, 0.10);
  --color-border-hover: rgba(255, 255, 255, 0.15);
  --color-hairline: rgba(255, 255, 255, 0.065);  /* 图内网格、重复分隔线 */

  /* ── 强调与交互 ── */
  --color-brand: #ffffff;             /* 激活指示、关键链接（克制使用） */
  --color-primary: #ffffff;           /* 主按钮底 */
  --color-primary-foreground: #000000;
  --color-secondary: #363636;
  --color-focus-blue: #4099ff;        /* 键盘焦点环、链接蓝 */

  /* ── 状态 ── */
  --color-success: #46bf72;
  --color-warning: #ff8a30;
  --color-destructive: #ff5c5c;
  --color-success-foreground: #000000;
  --color-warning-foreground: #000000;
  --color-destructive-foreground: #ffffff;
  --color-idle: #7b5ce5;              /* 空闲/暂停专用紫，禁挪作装饰 */

  /* ── 状态底色（badge 用，低饱和）── */
  --color-success-surface: rgba(70, 191, 114, 0.16);
  --color-warning-surface: rgba(255, 138, 48, 0.14);
  --color-destructive-surface: rgba(255, 92, 92, 0.14);
  --color-idle-surface: rgba(123, 92, 229, 0.16);

  /* ── 图表序列色板（六色，模型/Agent 维度轮询）── */
  --color-chart-1: #4099ff;  /* 蓝 */
  --color-chart-2: #46bf72;  /* 绿 */
  --color-chart-3: #7b5ce5;  /* 紫 */
  --color-chart-4: #ff5c5c;  /* 红 */
  --color-chart-5: #ff8a30;  /* 橙 */
  --color-chart-6: #42c8c8;  /* 青 */

  /* ── 热力图五档（对 chart-1 与 surface 做 oklab 混合）── */
  --color-heat-0: rgba(255,255,255,0.05);          /* 空 */
  --color-heat-1: color-mix(in oklab, #4099ff 24%, var(--color-surface));
  --color-heat-2: color-mix(in oklab, #4099ff 42%, var(--color-surface));
  --color-heat-3: color-mix(in oklab, #4099ff 62%, var(--color-surface));
  --color-heat-4: color-mix(in oklab, #80beff 78%, var(--color-surface));

  /* ── 终端/日志色（输出窗口用）── */
  --color-term-bg: #161616;
  --color-term-red: #ff5c5c;
  --color-term-green: #46bf72;
  --color-term-yellow: #ff8a30;
  --color-term-blue: #4099ff;
}
```

### 1.2 亮色主题（对照，源自 Zai Light）

`background #f8f8f8`、`panel #ffffff`、`card #ffffff`、`raised #f0f0f0`、`surface rgba(13,13,13,0.03)`、
`foreground neutral-800(#262626)` 及其 60%/40% 透明派生、`border rgba(13,13,13,0.10)`、
`brand/primary #000000`（主按钮黑底白字）、
状态：success `#1e8a3e`、warning `#e07b00`、destructive `#e03131`、idle `#9e77ed`、focus-blue `#0b7fff`、
图表六色：`#0b7fff #1e8a3e #9e77ed #e03131 #e07b00 #0aa7a7`。

### 1.3 用色规则

1. 页面根 = `bg-background`；结构面/顶栏 = `bg-panel`；一切内容容器 = `bg-card` 或 `bg-surface`，二选一，同一视图内不混用（除非表达真实层级）。
2. 同一 Agent/模型在所有图表、图例、列表中的颜色**由索引决定**（`color = chart[(i) % 6]`），全局稳定，不按好看程度随机分配。
3. 语义色只表示状态：绿=运行中/成功，橙=告警/等待确认，红=错误/超限，紫=空闲/暂停。禁止用状态色给普通区块"上色提神"。
4. 品牌色只用于：激活 tab 下沿、选中项指示、关键链接。全页出现频次应个位数。
5. 图表内网格线用 `--color-hairline`（比 border 更弱），坐标轴文字用 `--color-foreground-subtlest`。

---

## 2. 字体规范

### 2.1 字体栈

```
UI:   系统默认 sans（Tailwind font-sans，跟随 OS）
Mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
      "Liberation Mono", "Courier New", "Microsoft YaHei UI",
      "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", monospace
```

等宽用于：一切数值、token 数、模型名、路径、命令、时间戳、表格数字列。**KPI 数值、图表 tooltip 数值一律 `font-mono tabular-nums`**（ZCode 图表 tooltip 实证做法）。

### 2.2 字号刻度（`--ui-font-size` 单旋钮，默认 14px）

| Token | 值 | Nexus 中的用途 | 字重 |
| --- | --- | --- | --- |
| `text-ui-xl` 18px | +4 | 页面级标题（如"算力总览"），每屏 ≤1 个 | font-medium |
| `text-ui-lg` 16px | +2 | KPI 大数值、区块标题 | font-medium（数值可 normal） |
| `text-ui-base` 14px | 基准 | 正文、按钮、卡片标题、表格主体 | normal（标题 medium） |
| `text-ui-caption` 13px | −1 | 表格次级列、紧凑说明 | normal |
| `text-ui-sm` 12px | −2 | 图表轴刻度外的辅助文字、tooltip、行内代码 | normal |
| `text-ui-xs` 10px | −4 | badge、计数器、图例、图表轴刻度、时间戳 | font-medium |
| `text-ui-2xs` 9px | −5 | 仅图表轴单位后缀（受限） | normal |

规则：
- 界面字号设置只改 `--ui-font-size`，字号、间距、圆角几何量用 px/calc 派生，不随根字号缩放。
- 标题层级优先用字重（medium）与颜色区分，超过 base 的字号只留给真正的"数"与"页标题"。
- 大数值加单位时：数值 `text-ui-lg font-mono`，单位 `text-ui-sm text-foreground-subtle`，基线对齐 `items-baseline gap-1`。

---

## 3. 间距 / 圆角 / 尺寸

### 3.1 间距（4px 网格，只允许 4/8/12/16/20/24 及其组合）

| 值 | 用途 |
| --- | --- |
| 4px | 图标与文字紧贴、badge 内间隙、面板拼接缝 |
| 8px | 控件内边距、行内 gap、卡片内元素组间 |
| 12px | 表格行高内距、密集列表行、KPI 卡内部纵向节奏 |
| 16px | **卡片标准水平内边距（px-4）**、卡片间 gap（space-y-4 / gap-4） |
| 20-24px | 页面级边距、对话框内部 |

三栏布局骨架建议：外层 `gap-1`（4px，ZCode 工作区面板缝隙规格）+ 每栏自持 `bg-panel` 底与 `border-border`；或简化为整页 `bg-background` + 栏间 `gap-4`（二选一，不混用）。

### 3.2 圆角（嵌套递减，上限 12px）

| 级别 | 值 | 用途 |
| --- | --- | --- |
| `rounded-xl` 12px | 首层圆角容器：KPI 卡、图表卡、弹窗内容区、侧栏分组容器 | 卡片一律从这级起 |
| `rounded-lg` 8px | 卡内按钮、输入框、列表项、图表 tooltip | xl 容器内的控件 |
| `rounded-md` 6px | xl 内再嵌套的小控件、chip | |
| `rounded-sm` 4px | 最内层小元素（图例色块方点 `rounded-sm`、迷你按钮） | 下限 |
| `rounded-full` | 仅限：状态圆点、药丸 tab（range 切换器） | 禁止用于普通按钮/卡片 |

### 3.3 尺寸基线

- 图标：`size-3 / 3.5 / 4 / 5`，默认 `size-4`。
- 控件高：`h-6 / h-7 / h-8`（默认 h-7），KPI 卡刷新按钮等用 `size-7` 方形。
- 表格/列表行高：密集 28px（h-7）、标准 32px（h-8）。
- 侧边栏：默认/最小 **264px**（ZCode 实测值），可拖拽至容器 50%，可折叠到 4px 拼缝。
- 图表容器高：趋势图 `h-60`（240px，ZCode 实测）、迷你 sparkline `h-8~h-12`、热力图单元格 `aspect-square` 列宽 `1fr` 均分。

---

## 4. 组件样式规范

### 4.1 KPI 卡片

参照 ZCode `AppUsageLifetimeSummaryStrip`（`rounded-xl bg-surface` 的指标条）与 `card.tsx`，按 Nexus 需要改为独立卡。

**结构（单卡）：**

```
┌────────────────────────────┐ ← rounded-xl bg-card border border-card-border
│ ● Token 消耗（24h）    ↻   │ ← 标签行: text-ui-xs text-foreground-subtle + 状态点 + size-7 ghost 刷新钮
│ 12.4 M                     │ ← 数值: text-ui-lg font-mono tabular-nums text-foreground
│ ↑ 8% vs 昨日               │ ← 对比行: text-ui-xs, 涨跌用状态色三角+数值
└────────────────────────────┘
```

- 容器：`flex flex-col gap-2 rounded-xl border border-card-border bg-card px-4 py-3`
- 标签：`text-ui-xs font-medium text-foreground-subtle`，左侧可挂 `h-1.5 w-1.5 rounded-full` 状态点。
- 数值：`text-ui-lg font-mono tabular-nums`；单位后缀 `text-ui-sm text-foreground-subtle`。
- 数值刷新用 ZCode `FlipMetricValue` 同款翻页（0.16s，见 §5），不用弹跳/发光。
- 卡矩阵栅格：`grid grid-cols-2 md:grid-cols-4 gap-4`；一屏 KPI 控制在 4-8 个。
- 选中/对比高亮：`bg-card-selected` 或左侧 2px `--color-brand` 内边条，不用阴影。

**KPI 条带变体**（总览行，ZCode 原样复用）：`flex rounded-xl bg-surface`，项间 `h-7 w-px bg-border` 分隔，每项 `px-4 py-3 text-center`，值 `text-ui-lg font-medium`、标签 `mt-1 text-ui-base text-foreground-subtle`。

### 4.2 图表卡片

参照 ZCode 趋势图容器（`AppUsageDailyModelTrendChart`：`space-y-3 rounded-xl bg-surface p-4`）。

- 容器：`rounded-xl bg-surface p-4 space-y-3`（surface 半透明层 + 12px 圆角 + 16px 内边距；**无边框**，与 KPI 卡的 `bg-card+border` 形成可区分的两级容器）。
- 标题：`text-ui-base font-medium text-foreground`；右上角操作区放 ghost icon 按钮。
- 图例：卡片标题下一行 `flex flex-wrap gap-x-3 gap-y-2`，项 = `size-2.5 rounded-sm` 色块 + `text-ui-sm text-foreground-subtle` 文本。
- 图表（recharts，经 chart.tsx 封装）：
  - 网格：`<CartesianGrid vertical={false} strokeDasharray="3 3" />`，线色 `--color-hairline`。
  - 轴：`tickLine={false} axisLine={false}`，刻度文字 `text-ui-xs` 色 `--color-foreground-subtlest`；>14 点时按 5/7 步进稀疏标注（照抄 ZCode `shouldShowDailyChartAxisLabel`）。
  - 折线：`strokeWidth={2}`、`dot={false}`、`activeDot={{ r: 4 }}`、`type="monotone"`；Y 轴上限取**可见序列单点峰值**而非总量和（ZCode 实测修正，防止多序列压扁曲线）。
  - Tooltip：`rounded-lg border border-border/50 bg-card px-2.5 py-1.5 text-ui-sm shadow-xl`；行 = `size-2 rounded-full` 色点 + 名称(subtle) + 数值(`font-mono font-medium tabular-nums`)；过滤 0 值序列。
  - margin：`{ top: 8, right: 24, left: 24 }`（防止首尾日期文字被裁）。
  - 图表按需 lazy 加载 + 局部加载边界（ZCode 因 Electron 启动性能这样做的，Nexus 直接受益）。
- 空状态：`rounded-xl border border-dashed border-border px-4 py-10 text-center`，标题 `text-ui-base font-medium` + 描述 `text-foreground-subtle`（ZCode `UsageEmptyState` 原样）。
- 热力图：52 列 `repeat(52, minmax(0,1fr))`，单元格 `aspect-square w-full rounded-[4px] border transition-transform hover:scale-110 hover:border-border-hover`，五档 heat-0..4，tooltip 显示日期+数值。

### 4.3 侧边栏 Agent 列表项

参照 ZCode `TaskListItem.tsx` 行样式。

- 行：`group flex cursor-pointer items-center gap-2 rounded-lg pl-2.5 pr-1 py-1 transition-[background-color,border-color,box-shadow]`；高 32px 左右。
- 状态：选中 `bg-selected`；悬停 `bg-surface-hover`；普通透明。
- 内容三段式：
  1. 状态指示灯（见 §4.4）
  2. 名称 + 副行：名称 `text-ui-base text-foreground truncate`（flex 容器加 `min-w-0`）；副行 `text-ui-xs text-foreground-subtlest`（模型名/最近活动时间，`font-mono`）
  3. 右侧 trailing：token 计数 `text-ui-xs font-mono text-foreground-subtle`，或迷你 badge。
- badge（模型名/标签）：`h-5 rounded-full border-transparent px-2 text-ui-xs font-medium`，低饱和底+高饱和字，如运行中 `bg-success-surface text-success`。
- 悬停浮现的行内操作（置顶/定位）：ghost icon 按钮 `size-6 rounded-md text-foreground-subtle hover:bg-hover hover:text-foreground`，仅在 `group-hover` 显示。
- 分组标题（按项目/工作区分组）：`px-2.5 py-1 text-ui-xs font-medium text-foreground-subtlest`，sticky 可选。
- 侧栏底色 `bg-background`（与主内容 `bg-panel` 拉开一级亮度），与 ZCode `--color-sidebar: #161616` 的层级一致。

### 4.4 状态指示灯（Agent/任务状态）

ZCode 语言：`h-1.5 w-1.5 rounded-full` 实心圆点（`TaskListItem.tsx` 573-582 行）。

| 状态 | 颜色 | 附加动效 |
| --- | --- | --- |
| 运行中 | `--color-chart-1`（`#4099ff`，ZCode 用 sky-500/400） | 外圈 900ms 呼吸（`breathe` keyframe，opacity 0.4↔1）或外扩 halo；`prefers-reduced-motion` 时静态 |
| 空闲 | `--color-idle`（`#7b5ce5`） | 无 |
| 等待确认 | `--color-warning`（`#ff8a30`） | 慢闪 1.8s（可选） |
| 错误 | `--color-destructive`（`#ff5c5c`） | 无（列表行可加 `text-destructive` 计数） |
| 已完成/正常 | `--color-success`（`#46bf72`） | 无 |
| 离线/停止 | `--color-border`（灰点） | 无 |

规则：指示灯永远配文字状态（tooltip 或副行），不允许只靠颜色表义（ZCode a11y 原则）。

### 4.5 其他基础控件（直接沿用 ZCode 变体表）

- 按钮：primary `bg-primary text-primary-foreground hover:bg-primary/80`；secondary `bg-secondary text-foreground hover:bg-secondary/80`；ghost `hover:bg-hover`；outline `border-border hover:border-border-hover hover:bg-surface`；destructive `bg-destructive text-white hover:bg-destructive/90`。默认 `h-7 rounded-lg px-2 text-ui-base`，图标按钮方形 size-7。一屏内只允许一个 primary。
- 输入框：`h-7 rounded-lg border border-border bg-card px-2 text-ui-base placeholder:text-foreground-subtlest hover:border-border-hover focus-visible:border-border-hover focus-visible:ring-0`（Zai 主题聚焦不变亮，保持"平静"）。
- 药丸范围切换器（7d/30d/24h）：`flex h-7 rounded-full bg-surface p-0.5`，激活项 `rounded-full bg-card px-2.5 text-ui-sm font-medium text-foreground`，未激活 `text-foreground-subtle`（ZCode `USAGE_STATS_TABS_*` 原样）。
- 滚动条：全局 14px 宽、透明轨道、`--color-border` 圆角 thumb（`border-radius:9999px; border:3px solid transparent; background-clip:padding-box`），最小可视 32px（styles.css 757-782 行原样复制）。
- Tooltip：`rounded-lg border border-border bg-card px-3 py-1.5 text-ui-sm`，快捷键部分 `text-ui-xs`。
- 表格：表头 `text-ui-xs font-medium text-foreground-subtlest` 大写可选（配 `tracking-wider`）；数字列右对齐 + `font-mono tabular-nums`；行分隔用 `--color-hairline`，行悬停 `bg-surface`。

---

## 5. 动效规范

总原则：快、低戏剧性、只用于澄清状态变化（ZCode Motion 原则）；一切无限循环动画必须提供 `prefers-reduced-motion` 关闭分支。

| 场景 | 时长 | 缓动 | 说明 |
| --- | --- | --- | --- |
| 按钮/链接/列表项 hover | 150ms | `ease`（transition-colors） | **只过渡颜色**，禁 transition-all |
| 面板/卡片进出场 | 200ms | `ease-out` | fade + 4px 位移 |
| 折叠展开（分组、详情区） | 300ms | `ease-in-out` | 高度 + fade |
| KPI 数值刷新翻页 | 160ms | `cubic-bezier(0.4, 0, 0.2, 1)` | rotateX 翻页（FlipMetricValue 同款），数字槽宽固定 `0.66em` 防抖动 |
| 图表数据切换 | 200ms | `ease-out` | 曲线重排；禁弹跳 |
| 热力图单元格 hover | 100ms | `ease-out` | `scale-110` + 边框提亮 |
| 运行中状态呼吸 | 900ms | `ease-in-out infinite` | opacity 脉冲；reduced-motion 时静态 |
| 等待确认慢闪 | 1.8s | `ease-in-out infinite` | 同上 |
| 流式文本/日志追加 | 900ms | `cubic-bezier(0.16, 1, 0.3, 1)` | fade+slide-in，仅日志流场景 |
| 骨架屏 | 1.5-1.8s | linear infinite | shimmer；reduced-motion 时改静态 8% 白块 |

触发场景纪律：
- 动效只出现在**状态变化**处（新数据到达、状态切换、面板开合）；静态数据永远静态展示。
- 监控看板自动刷新（如 5s 轮询）时，只有**发生变化的数值**翻页，未变化的保持不动，避免整屏闪动。
- 禁止：视差、弹跳、发光扫过、大距离位移、入场装饰动画。

---

## 6. 三栏布局规格

```
┌──────────────────────────────────────────────────────────────┐
│ 顶栏 h-12 bg-panel border-b：页标题(text-ui-base medium) + 全局刷新 + 时间范围切换器 │
├───────────┬──────────────────────────────────┬───────────────┤
│ 侧栏 264px │        主内容区（flex-1）          │  详情栏 320-45% │
│ bg-bg     │  bg-panel, p-4                    │  bg-panel      │
│ Agent 列表 │  ① KPI 矩阵 grid-cols-4 gap-4     │  选中 Agent    │
│ (§4.3)    │  ② 图表矩阵 grid-cols-2 gap-4      │  明细/日志      │
│ 可折叠 4px │   · Token 趋势(24h/7d/30d) h-60   │  (可关闭)      │
│           │   · 模型分布 · 工具调用 · 热力图     │               │
└───────────┴──────────────────────────────────┴───────────────┘
```

- 栏间缝：4px（露出 `--color-background`），或无缝 + 每栏 `border-border` 竖线，二选一全局统一。
- 侧栏与详情栏可拖拽（透明 4px 命中区 + 悬停 2px `foreground-subtlest/50` 圆角指示条）。
- 主内容滚动：外层固定视口，KPI 区 sticky 或随滚，图表区 `min-h-0` 滚动。
- 响应式：主内容图表矩阵 `grid-cols-1 → 2` 断点降级；三栏在窄窗口收敛为两栏（详情栏转浮层）。语义不随断点变化。

---

## 7. 验收 Checklist（对照"去 AI 感"与 ZCode 一致性）

- [ ] 全文件无 `bg-gradient-*`、无 `backdrop-blur`、无 `rounded-2xl`（除对话框壳若明确保留）、无 `text-white/60` 类 raw 透明色。
- [ ] 所有颜色引用语义 Token；grep 无十六进制散落在 tsx。
- [ ] 所有数值/时间戳为 `font-mono tabular-nums`。
- [ ] 卡片圆角 = 12px，控件圆角 ≤ 8px。
- [ ] 一屏 primary 按钮 ≤ 1；语义色只出现在状态语义处。
- [ ] 每个循环动画有 `prefers-reduced-motion` 分支；每个颜色状态有文字伴随。
- [ ] 图表轴刻度 10px、图内网格弱于全局边框、tooltip 数值 mono。
- [ ] 界面文案无营销词汇；空状态为虚线框 + 双行文案。

---

## 附：Token → ZCode 源码对照表（便于审计）

| Nexus Token | 来源（ZCode） |
| --- | --- |
| 背景/卡片/文字/边框全套 | `packages/ui/src/styles.css` `.theme-zai-dark`（606-750 行） |
| 状态色/状态底色 | 同上 + `DESIGN.md` Semantic feedback colors |
| 图表六色/热力五档 | `--color-usage-chart-1..6`、`--color-usage-heatmap-0..4`（styles.css 667-684 行） |
| text-ui-* 刻度 | styles.css `@theme`（143-155 行）+ `DESIGN.md` Typography |
| mono 字体栈 | styles.css 140-142 行 |
| 间距节奏/圆角嵌套 | `DESIGN.md` Spacing / Radius |
| 控件高度 h-6/7/8、图标 size-3~5 | `DESIGN.md` Sizing |
| 按钮变体表 | `packages/ui/src/components/ui/button.tsx` |
| 卡片结构 | `packages/ui/src/components/ui/card.tsx` |
| badge 低饱和底语言 | `badge.tsx` + `TaskListItem.tsx` 637 行 |
| 列表项行样式/状态点 | `TaskListItem.tsx` 543-582 行 |
| 药丸切换器 | `settings/usage-stats/usageStatsUiParts.tsx` 6-9 行 |
| 图表规格（网格/轴/线宽/margin） | `AppUsageDailyModelTrendChart.tsx` |
| 空状态 | `usageStatsUiParts.tsx` `UsageEmptyState` |
| 数字翻页动画 | `components/ui/flip-metric-value.tsx` |
| 滚动条 | `styles.css` 757-782 行 |
| 呼吸/流式动画参数 | `styles.css` 900-1248 行 keyframes |
| 侧栏 264px / 缝隙 4px / 手柄 | `app-shell/WorkspaceShellLayout.tsx` 99-117 行、`workspaceShellWindowChrome.ts` |
