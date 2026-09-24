# 桌面应用方案推荐（Nexus Phase 0 调研报告）

| 项 | 内容 |
| :--- | :--- |
| 文档版本 | v1.0 |
| 调研日期 | 2026-09-24 |
| 输入依据 | 《项目立项书：Nexus — 本地AI Agent算力监控中心》（2026-09-24 v1.0）、`F:\ZCode-main` 源码实测、GitHub/crates.io/npmmirror 发布数据（2026-09-24 实时查询） |
| 结论 | **主方案：Electron（跟随 ZCode 技术栈）**；备选：Tauri 2.x |

---

## 0. 结论速览

**推荐方案 A：Electron + TypeScript 全栈**，完整复用 ZCode 已验证的桌面壳与渲染层技术栈（Electron / React 19 / Vite / Tailwind 4 / zustand），数据采集与 SQLite 汇总放在 Electron 主进程（Node 运行时）完成，图表用 Apache ECharts 6。

三条决定性理由：

1. **立项书自己的裁决条款指向它**："桌面应用框架由 AI 调研后决定，**优先参考 ZCode 源码使用的框架**"。ZCode 实测为 **Electron 41.0.3 + electron-builder 26 + Vite 8 + React 19 + Tailwind 4** 的 pnpm monorepo（证据见第 2 节）。
2. **本项目的产品就是 UI**。立项书把"可视化极尽丰富、界面精美、参考 ZCode 设计语言"列为核心价值。选 Electron 意味着 ZCode 的设计 Token、组件结构、构建配置可以**近乎原样移植**，UI 精美度上限最高、打磨成本最低；换任何其他框架，渲染层可以复用，但整个桌面壳、窗口管理、打包链都要另起炉灶且无现成参照。
3. **Windows 优先 + 单一 exe 原则下，Electron 是四个方案中运行环境确定性最高的**：自带 Chromium，不依赖系统 WebView2，在任何 Win10/11（含离线 LTSC、精简版）上渲染行为完全一致。Tauri/Wails 都要赌目标机器的 WebView2 运行时。

**备选方案 B：Tauri 2.11.x**——若后续把"安装包体积 < 20MB、内存 < 150MB"升格为硬性指标，或团队决定投入 Rust，则切换到 Tauri。切换成本被刻意控制住：本报告推荐的前端（React 19 + Vite + Tailwind + ECharts）与 Tauri 完全兼容，届时只需重写桌面壳（约几百行 Rust）与数据层。

**明确不推荐**：Wails（Go 优势在本项目用不上，v3 仍是 beta，v2 进入维护期且面临破坏性迁移）；纯 Go + webview_go / Neutralino（工具链不成熟，等于自己造 Wails）。

---

## 1. 需求约束回顾

调研前先固定评价基准，全部来自立项书：

| # | 约束 | 来源 | 对选型的含义 |
| :--- | :--- | :--- | :--- |
| C1 | **最高原则**：单一桌面软件，双击一个 `.exe` 打开一个窗口；禁止要求用户手动启动后端、打开浏览器、配置端口 | 零章 | 四个方案理论上都可达标，但达标成本不同 |
| C2 | 数据采集：读取本机多个 Agent 的 SQLite/JSONL 日志，增量解析，写入自己的 SQLite | 四章 | 需要稳定的本地文件监听 + 流式解析 + 嵌入式 SQLite |
| C3 | 前端：高数据密度仪表盘，KPI 卡片、折线/柱状/饼/环形图、7x24 热力图，桑基/雷达可选，暗色为主 | 三章 | 图表库的图表类型覆盖度是一票否决项 |
| C4 | 界面直接参考 `F:\ZCode-main` 的设计语言，严禁 AI 感 | 六章 | 与 ZCode 渲染层同栈 = Token/组件可直接迁移 |
| C5 | 后端语言倾向 Go，但明确"桌面框架由调研后决定，优先参考 ZCode 使用的框架" | 5.2 节 | Go 是"倾向"不是"约束"；框架决策的显式 tiebreaker 是 ZCode |
| C6 | Windows 优先，macOS 远期 | 1.4 节 | Windows 运行环境兼容性权重最高 |
| C7 | 启动快、内存合理、打包体积**可控**（非"最小"） | 任务背景 | 体积是软约束，不是一票否决项 |

关键判断：**C4 的权重高于 C5**。因为本项目的核心竞争力被立项书定义为"展示与精美"（C3/C4），而 C5 的 Go 倾向服务于"并发处理"——对一个只读本地日志、单用户单机器的监控工具，日增数据量在 MB 级，Node.js 的异步 I/O 与流处理完全覆盖，Go 的并发优势在此规模下没有兑现场景。

---

## 2. 事实基础：ZCode 技术栈实测确认

直接读取 `F:\ZCode-main` 源码（2026-09-24）：

**根 `package.json`**（`F:\ZCode-main\package.json`）：
- pnpm@10.33.2 monorepo，Node >= 24，TypeScript ^6.0.2，React 19.2.7（pnpm overrides 锁定）。

**`packages/desktop/package.json`**（桌面壳，桌面框架的直接证据）：

| 依赖 | 版本 | 作用 |
| :--- | :--- | :--- |
| `electron` | **41.0.3**（精确锁定） | 桌面框架：**Electron 确认** |
| `electron-builder` | ^26.8.1 | 打包（NSIS/ portable 等） |
| `electron-updater` | ^6.8.3 | 自动更新 |
| `vite` | ^8.0.2 | 渲染层构建 + dev server |
| `@vitejs/plugin-react` | ^6.0.1 | React |
| `react` / `react-dom` | ^19.2.4 | UI 框架 |
| `tailwindcss` / `@tailwindcss/vite` | ^4.2.2 | 样式体系 |
| `tsup` | ^8.5.0 | 主进程/预加载脚本打包 |
| `@electron/rebuild`、`@electron/asar`、`node-pty` | — | 原生模块与 asar 的成熟处理 |

**`packages/ui/package.json`**（组件库）：
- `zustand` ^5.0.12（状态管理）、`motion` ^12.38.0（动效）、`recharts` ^3.8.0（ZCode 自用图表）、@dnd-kit、Radix UI、xterm 等。

**dev 脚本形态**：`tsup --watch`（主进程热编译）+ `vite dev`（渲染层 HMR）+ `electron` 三路并发——这是一套已被 ZCode 生产验证的 Electron 开发工作流，可以直接照搬。

结论：立项书所说"ZCode 使用的框架"= **Electron + React + Vite + Tailwind + TypeScript**，无歧义。

---

## 3. 方案对比总表

版本数据均为 2026-09-24 通过 GitHub API / 官方发布页实时核实（详见附录 A）。

| 维度 | A. Electron（ZCode 同款） | B. Tauri 2.x | C. Wails v2/v3 | D. 纯 Go + webview_go / Neutralino |
| :--- | :--- | :--- | :--- | :--- |
| 当前版本状态 | **稳定 v44.4.5**（2026-09-23，Chromium 152 / Node 24.21），每 8 周一个大版本；ZCode 用 41.0.3 | **稳定 2.11.6**（2026-09-19）；**v3.0.0-alpha.2 已于 2026-09-21 开跑** | 稳定线 v2.14.0（2026-08-10，维护模式）；**v3.0.0-beta.25**（2026-09-22），beta 高频迭代中 | webview_go **0.10.0**（0.x 未定型）；Neutralino v6.9.0（2026-07-24） |
| 单一 exe 交付 | portable.exe（~100-120MB，双击即用）或 NSIS 单文件安装包；asar 打包 | 单 exe ~5-10MB，NSIS/MSI | v2/v3 均可单 exe ~8-15MB | 可单 exe ~5MB，但周边全靠自己 |
| Windows 系统依赖 | **无**（自带 Chromium/Node） | **WebView2 运行时**（Win11/多数 Win10 预装；离线 LTSC 需内嵌离线安装包） | **WebView2 运行时**（同左） | WebView2（webview_go）或系统 WebView |
| 进程/窗口模型 | 多进程内核，但用户视角单窗口；`requestSingleInstanceLock` 保证单实例；**主进程即"后端"**，无独立服务 | 单主进程 + WebView2 子进程；Rust core 即后端 | 单进程 + WebView2；Go 绑定即后端 | 单进程 + 系统 WebView |
| 内置 SQLite | better-sqlite3 v13.0.3（同步、WAL、极快） | rusqlite v0.40.2（bundled） | modernc.org/sqlite（纯 Go）或 mattn/go-sqlite3 v1.14.52（需 CGO） | Go 侧同左 / JS 侧 sql.js（WASM，弱） |
| 图表生态 | 浏览器全生态：**ECharts 6.1.0 全类型覆盖** | 同左（渲染层就是 Web） | 同左 | 同左 |
| 本地文件采集契合度 | ★★★★★ Node 流式读 JSONL、chokidar 监听、fs 遍历皆一等公民 | ★★★★ Rust std + notify/tantivy 生态可用，开发效率低于 TS | ★★★★★ Go 文件 I/O 与并发极强 | ★★★★★（Go 侧） |
| 与 ZCode 复用度 | **★★★★★ 壳+渲染层+构建链全套照搬** | ★★★☆ 仅渲染层复用 | ★★☆ 仅渲染层复用 | ★☆ |
| 渲染层 HMR | Vite HMR <100ms（ZCode 同款脚本照搬） | Vite HMR；改 Rust 需增量重编译（秒~十秒级） | `wails dev` 自带前后端热重载 | **无**，全手工 |
| 打包链可靠性（Win） | electron-builder 26.16.1，最成熟 | Tauri CLI 内置 NSIS/MSI，成熟 | v2 `wails build -nsis` 成熟；v3 打包仍在变动 | **无官方打包链** |
| 冷启动（典型值） | ~1-2.5s | ~0.3-1s | ~0.5-1s | ~0.5s |
| 内存占用（典型值） | 空载 ~150-250MB，满载仪表盘 ~300-400MB | ~60-150MB | ~80-150MB | ~60-120MB |
| 安装体积 | ~100-120MB | ~5-10MB | ~8-15MB | ~5MB |
| 长期维护风险 | 低（全球最大桌面框架生态）；痛点是国内下载慢（有镜像方案） | 中：v3 刚进 alpha，2.x 生命周期内将面临大版本迁移压力 | 高：v3 两年多仍在 beta；选 v2 则锁定维护期版本 | 极高：社区小、无自动更新、无安全通告渠道 |
| 综合评价 | **与立项书裁决条款、UI 优先战略、Windows 优先三者全对齐** | 体积/内存最优，但 Rust 成本 + WebView2 依赖 + v3 迁移阴影 | Go 倾向对齐，但框架本身处于版本交替的震荡期 | 不成熟，不予考虑 |

---

## 4. 方案 A：Electron（跟随 ZCode）

### 4.1 版本与生态现状（2026-09）
- 最新稳定 **v44.4.5**（2026-09-23 发布，Chromium 152.0.7977.130 / Node.js 24.21.0），每 8 周一个大版本，同日 42.x 仍在收补丁——多版本并行维护的成熟节奏。
- ZCode 生产锁定 41.0.3，说明 41→44 跨度内 API 稳定可用；electron-builder 当前 26.16.1（2026-09-07）。
- 生态位：VS Code、Slack、Discord、1Password、Obsidian 以及 **ZCode 本身**均为此栈，Windows 桌面应用的事实标准。

### 4.2 如何满足"单一软件界面"最高原则（C1）
- `electron-builder` 的 **portable target** 产出单个 `.exe`，双击直接开窗口，零安装；NSIS target 产出单文件一键安装包。两种形态都是"一个 exe"。
- 主进程内直接承载全部"后端"逻辑（适配器调度、SQLite、聚合），**不存在独立后端进程、不存在端口**；渲染层通过 `contextBridge` + IPC 取数，用户永远只看到一个窗口。
- `app.requestSingleInstanceLock()`：二次双击时唤起已有窗口而不是开新实例。
- 开发阶段的 dev server 只是工程内部细节，打包后 Vite 产物被 asar 内嵌、由 `file://` 协议加载，用户不可感知——符合立项书"开发可用热重载，交付必须是打包件"的要求。

### 4.3 SQLite 访问
- **better-sqlite3 v13.0.3**（2026-08-05）：同步 API，读多写少的仪表盘场景下是 Node 生态最快方案；开 WAL 后采集线程写入与查询互不阻塞。
- 部署位置：主进程直接持有连接；若将来解析阻塞主进程，再把采集器移入 `utilityProcess`（Electron 官方子进程机制），架构演进路径清晰。
- 原生模块 ABI：用 `@electron/rebuild` 或直接消费 better-sqlite3 发布的 Electron 预编译二进制；electron-builder 的 `asarUnpack` 处理 `.node` 文件（ZCode 的 `node-pty` 已趟平同款问题）。

### 4.4 开发体验与打包流程
- 开发：`tsup --watch`（主进程）+ `vite dev`（HMR，毫秒级）+ electron 启动器三路并发——**ZCode 现成脚本改个名就能用**。
- 打包：`electron-builder` 一条命令产出 portable/NSIS；NSIS + electron-updater 可做增量自动更新（立项书未要求，留作后续）。
- 全程不需要 Go/Rust 工具链，Windows 上零交叉编译问题。

### 4.5 已知坑与对策
| 坑 | 对策 |
| :--- | :--- |
| 国内下载 Electron 二进制/NSIS 工具慢或失败 | `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`；electron-builder 配 `electronDownload.mirror` 与 npmmirror 的 NSIS 镜像；better-sqlite3 预编译同样走 npmmirror registry |
| 原生模块 ABI 不匹配（重装 Node 后） | 锁定 Node LTS + `electron-builder install-app-deps`；better-sqlite3 有完善的 Electron 预编译 |
| 体积 ~100MB、内存 ~200-400MB | 对"AI Agent 重度用户"人群完全可接受（其 IDE 本身就是 Electron）；已在 C7 判定为软约束 |
| 未签名 exe 触发 SmartScreen | 正式发布购买代码签名证书；开发期用户点"仍要运行"一次即可 |
| portable 每次启动解压到临时目录，首帧慢 1-2s | 双产物策略：日常发 NSIS 安装包（装完秒开 + 可自动更新），同时附 portable exe 严格满足"双击即用" |

### 4.6 代价评估（诚实陈述）
- **放弃 Go 后端**：立项书第五章的 Go 目录骨架与 `AgentAdapter` 接口需翻译为 TypeScript 等价物——接口只有 6 个方法，翻译是机械劳动，模块边界（domain/application/infrastructure/transport）在 TS 中同样成立。
- 内存与体积是四方案中最重的（量化见总表），但换来的是零系统依赖与最高 UI 复用度。

---

## 5. 方案 B：Tauri 2.x（备选）

### 5.1 版本与生态现状（2026-09）
- 2.x 稳定线：**tauri-v2.11.6**（2026-09-19 发布），维护活跃。
- **重要动态：Tauri v3 已于 2026-09-21 进入 alpha（v3.0.0-alpha.2）**，且 v3 alpha 中出现了 `tauri-runtime-cef`（可选 CEF 内核）等架构级变动。这意味着：选 2.x 是安全的，但项目生命周期内大概率要做一次 2→3 迁移决策；这正是 v2 的主要长期风险。
- 2024-10 起 v2 稳定，含 iOS/Android 支持（立项书的"远期 Android"在 Tauri 生态里有官方路径——这是它相对 Electron 的一个真实加分项，仅作记录）。

### 5.2 单一 exe 与 Windows 支持
- Rust core + 系统 WebView2，release 产物单 exe 约 5-10MB，NSIS/MSI 均由官方 CLI 一键产出。体积/内存/启动是四方案中最优。
- **核心坑：WebView2 依赖**。Win11 与绝大多数已更新的 Win10 预装；但离线、LTSC、深度精简的系统可能没有。Tauri 的 bootstrapper 默认**联网从微软服务器下载**运行时，离线机器会失败；内嵌离线运行时包则把体积优势抵消大半（WebView2 离线包 ~100MB+）。立项书面向"用户本机"，无法控制目标机环境，这是结构性风险而非配置问题。
- 各机器 WebView2 版本随 Edge 自动漂移，渲染行为存在版本差异（Electron 则把 Chromium 锁死在产物里）。

### 5.3 SQLite 与数据层
- **rusqlite v0.40.2**（2026-08-08，`bundled` feature 静态编入 SQLite，成熟可靠）。
- JSONL 流式解析在 Rust 中性能极佳，但开发效率（迭代速度、错误处理样板、生态熟悉度）显著低于 TS/Go，尤其立项书要求"每个 Agent 一个适配器、未来持续新增"——适配器的**开发吞吐量**比单适配器的峰值性能更重要。

### 5.4 开发与打包
- `tauri dev` 单命令起前后端，渲染层走 Vite HMR；但每次改 Rust 代码要增量重编译（秒到十几秒），调试数据层的心流中断感明显。
- 打包链成熟（NSIS/MSI 内置）。

### 5.5 定位
技术上优秀、参数上碾压 Electron，但对本项目：Rust 是团队新增技能负担，WebView2 是不受控的外部依赖，v3 alpha 是悬在头上的迁移时钟，且**换不来 UI 复用度之外的任何本项目刚需**。故列为第一备选：若未来体积/内存成为硬指标，前端资产 100% 平移过去，只需重写壳与数据层。

---

## 6. 方案 C：Wails v2 / v3

### 6.1 版本与生态现状（2026-09）
- 稳定线 **v2.14.0**（2026-08-10）。master 分支至今活跃（2026-09-24 有提交），但活跃的是 **v3 开发**。
- **v3.0.0-beta.25**（2026-09-22）：beta 以每 1-3 天一个的速度高频发布（beta.18→beta.25 全部发生在 2026-09-08 之后）。这说明：v3 方向健康、社区兴奋，但也说明 **API 仍在剧烈变动、尚无稳定版**——v3 alpha 自 2024 年初至今历时约两年半仍未 stable。

### 6.2 与 Go 倾向的契合度——为什么"契合"不构成推荐理由
- 立项书的 Go 代码（`AgentAdapter` 接口、目录骨架）在 Wails 下确实原样成立，这是它最大的纸面优势。
- 但逐条核对 Go 倾向的实际兑现场景：跨平台单二进制（Electron 的 portable.exe 对最终用户等价）、高并发采集（单机读本地日志，无并发压力）、部署简单（本项目交付的就是桌面安装包）。**Go 的三项收益在本项目中全部落空**，而 Wails 的代价却是真实的：
  1. 选 v2 = 选一条**维护模式的线**，v2→v3 是重写级 API 变更，迁移不可避免；
  2. 选 v3 = 在 beta 上立项，打包、绑定、事件 API 随 beta 迭代漂移，违背"打包流程简单可靠"要求；
  3. 同样依赖 WebView2（同 Tauri 5.3 节的风险）；
  4. 社区规模与问题检索量级明显小于 Electron/Tauri，踩坑时可用资料少。
- SQLite：Go 侧正确选型是 **modernc.org/sqlite（纯 Go、无 CGO、交叉编译零负担）**；`mattn/go-sqlite3 v1.14.52` 需要本机 CGO 工具链（Windows 上要 gcc），徒增环境复杂度，不推荐。

### 6.3 开发与打包
- v2 的 `wails dev` 提供前后端联合热重载，体验不错；`wails build -nsis` 产单 exe。v3 的对应能力在快速演进中但未定型。
- 结论：**Wails 是"如果立项书把 Go 写成硬约束"时的答案，但立项书明确把决定权交给了调研**。在 UI 即产品、ZCode 即参照系的前提下，为一个无兑现场景的语言偏好承担框架版本震荡风险，不成立。

---

## 7. 方案 D：纯 Go + webview_go / Neutralino（简述，不推荐）

- **webview/webview_go**：最新 tag 0.10.0，仍是 0.x 库。它只是系统 WebView 的极薄绑定——窗口、资产内嵌要自己用 `go:embed` 解决，**没有 IPC 协议、没有打包链、没有自动更新、没有开发期热重载**。选它等于亲手重写一个劣化版 Wails，且无社区兜底。
- **Neutralino.js** v6.9.0（2026-07-24）：轻量（产物 ~2-5MB），但架构上是"静态资源 + 小型本地服务"的组合，扩展 API 生态、调试工具、Windows 深度能力（托盘、单实例、原生菜单）均薄弱，数据密集型桌面产品的工程实践案例少。
- 两者共同问题：**省下的是框架的学习成本，付出的是全部基础设施的自建成本**。对个人项目尚可，对要求"精美、数据密集、长期演进"的 Nexus 是净亏损。仅作为"知识储备"记录。

---

## 8. 四个专项问题的直接回答

**Q1 各方案如何满足"单一软件界面"最高原则？**
- Electron：portable/NSIS 单 exe；主进程即后端（无独立服务、无端口）；`requestSingleInstanceLock` 保证单窗口单实例。✅ 完全满足，且"后端"对用户彻底不可见。
- Tauri：单 exe；Rust 侧即后端。✅ 满足，但首启可能触发 WebView2 运行时安装/下载（取决于目标机），那一刻用户体验上出现"窗口之外的东西"。
- Wails：单 exe；Go 绑定即后端。✅ 满足，WebView2 依赖同上。
- 纯 Go webview_go：单 exe 可做到，但 IPC/资产/单实例全部手写。⚠️ 理论满足，工程上脆弱。

**Q2 SQLite 访问怎么做？**
- Electron：`better-sqlite3`（同步 API，主进程直连，WAL 模式；阻塞担忧时迁 `utilityProcess`）。
- Tauri：`rusqlite` + `bundled`（静态编入 SQLite，随 exe 走，无外部 DLL）。
- Wails/Go：`modernc.org/sqlite` 纯 Go 首选（免 CGO）；避免 `mattn/go-sqlite3` 的 CGO 工具链负担。
- 三种驱动都内置 SQLite 引擎、零外部依赖，能力上等价；差异在语言侧的开发体验而非数据库本身。

**Q3 热重载与 Windows 打包是否简单可靠？**
- Electron：Vite HMR 毫秒级 + 主进程 tsup watch 自动重启（ZCode 生产脚本照搬）；electron-builder 26 一条命令出 portable/NSIS，是四者中最成熟、踩坑资料最多的打包链。可靠性 ★★★★★。
- Tauri：`tauri dev` 一键，前端 HMR 好，Rust 改动需增量编译；NSIS/MSI 内置。可靠性 ★★★★☆。
- Wails v2：`wails dev` + `wails build -nsis` 成熟；v3 打包仍在 beta 迭代。可靠性：v2 ★★★★☆ / v3 ★★☆☆☆。
- 纯 Go/Neutralino：无官方方案。★☆☆☆☆。

**Q4 已知坑？**
- Electron（国内环境）：Electron 二进制与 NSIS 工具下载慢 → npmmirror 镜像一劳永逸；原生模块 ABI → 预编译 + `install-app-deps`；体积/内存大 → 已判定可接受；未签名 SmartScreen 警告 → 正式版上签名证书。
- Tauri：WebView2 运行时在离线/LTSC 机器缺失且 bootstrapper 需联网下载；WebView2 版本漂移导致渲染差异；Tauri 3 alpha 开跑，2.x 面临大版本迁移决策。
- Wails：v3 长期 beta、API 漂移；v2 维护模式 + 未来破坏性迁移；`mattn/go-sqlite3` 的 CGO 在 Windows 上需要 gcc；社区规模小。
- 共同坑：三套 WebView 方案都要注意暗色滚动条/字体渲染在 WebView2 与 Chromium 上的细微差异——Electron 因内核锁定而无此问题。

---

## 9. 图表库选型：ECharts vs Recharts vs Chart.js

针对立项书 3.3 节的可视化清单逐项核对（图表库均为 2026-09-24 最新版）：

| 能力 | **ECharts 6.1.0**（2026-05-19） | Recharts 3.10.1（2026-07-25） | Chart.js 4.5.1（2025-10-13） |
| :--- | :--- | :--- | :--- |
| 折线/柱状/饼/环形/KPI | ✅ 原生 | ✅ 原生 | ✅ 原生 |
| **7x24 热力图** | ✅ **原生 heatmap（坐标系网格）+ calendar**，完美匹配"GitHub 贡献图"需求 | ❌ 无原生，需手绘 rects | ❌ 需第三方 chartjs-chart-matrix 插件 |
| **桑基图**（可选） | ✅ 原生 sankey，支持节点/链路着色 | ⚠️ 有 Sankey 组件但定制能力弱 | ❌ 无 |
| **雷达图**（可选） | ✅ 原生 radar | ✅ 原生 Radar | ✅ 原生 |
| 高数据密度性能 | ✅ Canvas 渲染 + progressive/大数据模式，万级点流畅 | ⚠️ SVG 渲染，千点级明显卡顿 | ✅ Canvas，但无 progressive 体系 |
| 暗色主题 | ✅ 内置 `dark` 主题 + 主题注册表，可注入 Nexus Token | ⚠️ 全靠手动逐项传色 | ⚠️ 手动 |
| 下钻/事件交互 | ✅ 完善的 click/legend/tooltip 事件体系 | ✅ | ⚠️ 一般 |
| React 集成 | 官方推荐自封装（~50 行 wrapper）；`echarts-for-react` 对 React 19 支持滞后 | ✅ React 原生组件（这是它最大优势） | react-chartjs-2 |
| 体积 | 全量 ~1MB，**按需引入后 ~300-500KB** | 较小 | 最小（~70KB gzip） |

**结论：选 ECharts 6，按需注册模块。**
理由：热力图与桑基图是立项书点名的需求，Recharts（ZCode 自用）在这两项上恰好是短板；高密度暗色仪表盘正是 ECharts 的主场（Canvas + dark 主题 + 主题注册表直接吃 Nexus 设计 Token）。代价是放弃 Recharts 的声明式 React 写法——用一层轻封装换回，且该封装隔离了图表库依赖，未来换库只需改 wrapper。ZCode 用 Recharts 是因为它只画简单趋势线，不代表本项目的最优解。

---

## 10. 最终推荐

**主方案：方案 A —— Electron（TypeScript 全栈，跟随 ZCode）。**
**备选：方案 B —— Tauri 2.11.x**（触发条件：体积/内存升格为硬指标，或需要 Tauri 官方 Android 路线时再评估；前端资产可 100% 平移）。
**否决：Wails（C）、纯 Go webview_go / Neutralino（D）。**

决策链复盘（对照立项书条款）：
1. 5.2 节明确"框架由调研决定，**优先参考 ZCode 使用的框架**" → ZCode = Electron，条款直接命中方案 A；
2. C4 要求 UI 全面参考 ZCode 设计语言 → 同栈才能 Token/组件级复用，这是本项目核心竞争力（三章/六章）的最高杠杆；
3. C5 的 Go 倾向在其服务的场景（并发、单二进制交付）对本项目**无兑现点**，且立项书已自降其优先级；
4. C6 Windows 优先 → Electron 自带内核，是唯一对目标机环境**零假设**的方案；
5. 2026-09 的版本周期对比进一步削弱了替代项：Wails v3 仍在 beta、Tauri 3 刚进 alpha，而 Electron 稳定线已到 44 并保持 8 周节拍。

立项书第五章 Go 骨架的处置：结构保留、语言平移——`internal/adapter|aggregator|dashboard|shared` 映射为 `src/main/adapter|aggregator|dashboard|shared`（主进程内同构分层），`AgentAdapter`/`UsageRecord` 接口逐字段翻译为 TypeScript（`time.Time → Date`、`int64 → bigint` 需注意 Token 大数精度，建议存 SQLite INTEGER、TS 侧用 `bigint` 或字符串传输）。`ui/` 目录按原计划保留，直接对接 ZCode 的 Token 体系。

---

## 11. 推荐技术栈清单（方案 A 完整版）

| 层 | 选型 | 版本依据（2026-09-24） |
| :--- | :--- | :--- |
| 语言 | **TypeScript**（全栈，strict） | ^6.0（ZCode 同款） |
| 桌面框架 | **Electron** | 首选最新稳定 **44.x**（44.4.5，2026-09-23）；若 better-sqlite3 预编译 ABI 未及时跟上 44，回退 ZCode 同款 **41.0.3**（已被生产验证） |
| 主进程打包 | **tsup** | ^8.5（ZCode 同款） |
| 渲染层构建 | **Vite** + @vitejs/plugin-react | ^8（ZCode 同款） |
| 前端框架 | **React 19 + zustand 5** | ^19.2 / ^5.0（ZCode 同款，**"跟随 ZCode"与"React+Vite"在本案中是同一件事**） |
| 样式 | **Tailwind CSS 4**（@tailwindcss/vite） | ^4.2（ZCode 同款；design_tokens 从 ZCode 源码提取） |
| 动效 | motion（按需） | ^12（ZCode 同款，克制使用以符合"去 AI 感"） |
| **图表** | **Apache ECharts，按需引入（echarts/core + tree-shaking）+ 自封装 `<Chart>` wrapper** | 6.1.0（2026-05-19）；热力图/桑基/雷达全原生、Canvas 高密度、dark 主题注入 Token |
| SQLite 驱动 | **better-sqlite3**（主进程，WAL 模式） | v13.0.3（2026-08-05） |
| 数据采集 | Node 原生 `fs`/`readline` 流式解析 JSONL；**chokidar** 监听日志目录增量；适配器为纯 TS 接口（对应立项书 `AgentAdapter`） | — |
| IPC | contextBridge 预加载桥 + 类型化 invoke（只传聚合结果，不传原始日志过桥） | — |
| 打包产物 | **NSIS 安装包（主，配 electron-updater）+ portable.exe（辅，严格满足"双击即用"）** | electron-builder **26.16.1**（2026-09-07） |
| 镜像配置 | `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`；electron-builder 下载镜像同步指向 npmmirror | 国内构建必需 |
| 单实例 | `app.requestSingleInstanceLock()` | 保证"一个窗口"原则 |
| 更新（后置） | electron-updater | ^6.8（ZCode 同款） |

**典型参数预期**：安装包 ~100-120MB；冷启动 1-2.5s；空载内存 ~150-250MB、满载仪表盘 ~300-400MB；开发期 HMR <100ms。均满足 C7"可控、合理"的软约束。

---

## 附录 A：版本证据（全部为 2026-09-24 实时查询）

| 项目 | 版本 | 日期 | 来源 |
| :--- | :--- | :--- | :--- |
| Electron 最新稳定 | v44.4.5 | 2026-09-23 | GitHub API `electron/electron/releases/latest`；[releases.electronjs.org](https://releases.electronjs.org)；[endoflife.date](https://endoflife.date)（8 周大版本节拍） |
| ZCode 桌面壳 Electron | 41.0.3（锁定） | — | `F:\ZCode-main\packages\desktop\package.json` 实测 |
| Tauri 2.x 最新 tag | tauri-v2.11.6 | 2026-09-19 | GitHub API `tauri-apps/tauri` tags/releases |
| Tauri 3 | v3.0.0-alpha.2 | 2026-09-21 | 同上 |
| Wails 稳定线 | v2.14.0 | 2026-08-10 | GitHub API `wailsapp/wails/releases` |
| Wails v3 | v3.0.0-beta.25 | 2026-09-22 | 同上 |
| webview/webview_go | 0.10.0 | — | GitHub API tags |
| Neutralino | v6.9.0 | 2026-07-24 | GitHub API releases/latest |
| better-sqlite3 | v13.0.3 | 2026-08-05 | GitHub API releases/latest |
| rusqlite | v0.40.2 | 2026-08-08 | GitHub API releases/latest |
| mattn/go-sqlite3 | v1.14.52 | — | GitHub API tags |
| Apache ECharts | 6.1.0 | 2026-05-19 | GitHub API releases/latest |
| Recharts | v3.10.1 | 2026-07-25 | GitHub API releases/latest |
| Chart.js | v4.5.1 | 2025-10-13 | GitHub API releases/latest |
| electron-builder | 26.16.1 | 2026-09-07 | GitHub API releases/latest |
| zustand / motion / recharts（ZCode 内） | ^5.0.12 / ^12.38 / ^3.8 | — | `F:\ZCode-main\packages\ui\package.json` 实测 |

## 附录 B：本报告未覆盖、留给后续调研的事项

- 各 Agent 数据源本体（路径/格式/Token 字段）→《Agent 数据源调研报告》（立项书 2.2）。
- ZCode 设计 Token 清单与组件结构 →《ZCode 源码探索报告》《Nexus UI 设计规范草案》（立项书 2.1）。
- 代码签名证书选型与分发渠道（发布期再定）。
