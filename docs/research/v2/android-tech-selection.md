# Android 端技术选型建议（Nexus v2 · 任务五）

| 项 | 内容 |
|---|---|
| 文档 | 《Android 端技术选型建议》 |
| 版本 | v1.0 |
| 日期 | 2026-09-25 |
| 调研人 | 子代理 T5 |
| 依据 | 《Nexus 能力补强指导书 v2》§2.5 |
| 关联 | 《共享层抽象建议》（T1）、《通信方案调研报告》《混合通信架构设计草案》（T4）、《多开 ZCode 管理方案》（T6） |

---

## 0. 结论速览

> **主推方案：Capacitor 8.5.x + React 19 + ECharts 6.1 —— 复用路线，不重写。**
>
> 一句话结论：在「个人项目 + 重度 TypeScript/React 开发者 + PC 端图表代码复用价值高 + 交付物必须是单一 .apk」四重约束下，Capacitor 是唯一能让 Android 端以"移植"而非"重写"方式成立的方案；RN/Flutter/原生三条路都要求把已调优的 ECharts 看板（尤其 7×24 热力图）推倒重做，而它们的性能优势在本场景（局域网秒级 JSON 仪表盘）没有用武之地。

完整技术栈清单见 §7，关键论证见 §5。

---

## 1. 决策输入（背景与硬约束）

### 1.1 PC 端现状（本地实证，读自 `F:\Nexus\package.json` 与 `src/shared/types.ts`）

| 项 | 值 |
|---|---|
| 壳 | Electron 41.0.3 |
| UI | React 19.2 + react-dom 19.2 |
| 图表 | **echarts ^6.0.0**（npm latest 已核实为 **6.1.0**） |
| 状态 | zustand ^5.0.0 |
| 样式 | tailwindcss ^4.1.0 |
| 语言/构建 | TypeScript ^5.9.0 + electron-vite 4（Vite 7） |
| 共享类型 | `src/shared/types.ts`（135 行，纯数据结构 + IPC 契约 `NexusApi`，零 Node 依赖） |

渲染层跑在 Chromium 里，图表均为 ECharts options 配置（折线、环形、7×24 热力图、日历热力图、柱状、KPI 卡），暗色为主。

### 1.2 硬约束（指导书 §零 + 任务书）

1. **单一 `.apk`**：点图标即用，禁止"起服务/开浏览器/配端口"形态；
2. 连接 PC（局域网 WebSocket + JSON 协议，T4 结论），秒级推送/轮询，无音视频串流；
3. 看板：KPI 卡、折线、环形、**7×24 热力图**、柱状、多实例视图、有限远控操作界面（按钮/表单级）；
4. 暗色为主；
5. 开发者单人、重度 TS/React；Windows + 已装 Android SDK，本地出 debug apk 即可，**无 iOS 目标、不上架商店（侧载）**；
6. T1 已规划 `packages/shared`（model / kit / protocol 三模块），Android 端选型必须与之兼容。

---

## 2. 2026 年现状核实（全部经网络核实，来源见 §9）

| 框架/库 | 最新版（核实于 2026-09-25） | 要点 |
|---|---|---|
| React Native | **0.85**（2026-04 起为最新稳定线） | 新架构（JSI/Fabric/TurboModules）已成**唯一运行时，无法关闭**；Expo SDK 54 是最后一个允许关闭新架构的 SDK |
| Expo | **SDK 57**（2026-07 起，npm `expo@57.0.24`） | SDK 55（2026-02）起内置 RN 0.83.2 + React 19.2；SDK 56（2026-05）；本地 `prebuild` + gradle 构建路径完全可用，EAS 云构建非必需 |
| Flutter | **3.47.0 stable**（2026-08，官方文档已整体切至 3.47） | 版本节奏改为每版 +3 个 minor（3.44 → 3.47） |
| fl_chart | **1.2.0**（约 2026-03 发布，7.2k likes） | 支持 line/bar/pie/scatter/radar/candlestick，**不支持热力图** |
| graphic | **2.7.0**（约 2026-02，900 likes） | 语法驱动图表库，文档未列热力图 |
| Capacitor | **8.5.2**（2026-09-11 发布） | 维护活跃，补丁节奏正常 |
| Vico（Compose 图表） | **3.3.1**（2026-08-28） | line / column / candlestick，**无热力图** |
| victory-native | **42.0.1**（npm） | NearForm 接手维护，XL 版基于 RN Skia；2025-08 仍有"debug 正常、release 空白"的公开 issue；无内建热力图 |
| react-native-gifted-charts | **1.4.78**（2026-08 仍在更新） | 折线/柱状/饼图/区域图，**无热力图** |
| Kotlin | **2.4.20** | KMP 官方宣布生产就绪；Compose Multiplatform 对 Android/iOS/desktop 稳定（web 为 beta） |
| echarts | **6.1.0** | PC 端同款，WebView（Chromium 内核）直接运行 |

一个贯穿全部候选的原生/跨平台图表生态事实：**除 ECharts 外，没有任何一家主流图表库"开箱"支持 7×24 热力图**（RN 三库、fl_chart、graphic、Vico 均不支持），热力图在非 WebView 方案里都要自绘。这是本选型最重要的单点事实。

---

## 3. 候选方案总览

| 维度 | ① RN 0.85 + Expo 57 | ② Flutter 3.47 | ③ Kotlin + Compose | ④ **Capacitor 8（主推）** | ⑤ KMP / PWA / Tauri |
|---|---|---|---|---|---|
| TS 类型/协议直用 | 部分（逻辑层可） | 否，需 JSON Schema 生成 | 否，需生成 | **100% 直用** | KMP 否；PWA 是 |
| 看板图表复用（含热力图） | ~0%（需换库重写或内嵌 WebView） | ~0%（fl_chart 无热力图） | ~0%（Vico 无热力图） | **~90%（ECharts 原样）** | 同左列 |
| 样式复用（Tailwind 4） | 部分（NativeWind 子集） | 无 | 无 | **直接用** | PWA 是 |
| WS/MQTT | 内建 WS + mqtt.js（需少量 polyfill 配置） | web_socket_channel / mqtt_client | OkHttp WS / Paho | **WebView 原生 WS + mqtt.js 零配置** | 各异 |
| 后台保活 | 难（headless JS 受限） | 难（同受平台限制） | 可行但受 Android 15/16 限制 | 前台即可（见 §6） | — |
| apk 体积（估算） | 8–15MB | 6–10MB/ABI | 4–8MB | **3–6MB** | PWA 无 apk |
| 冷启动（估算） | 0.5–1.5s | 0.2–0.5s | 0.2–0.4s | 0.4–1.0s（WebView init） | — |
| 内存（估算） | 100–200MB | 100–180MB | 70–120MB | 100–180MB | — |
| 单人开发效率（TS/React 熟手） | 中（学 RN 生态+构建链） | 低（学 Dart + 全新 UI 栈） | 低（学 Kotlin + Compose） | **高（零新语言/新范式）** | — |
| 单一 .apk 交付 | 是 | 是 | 是 | **是** | PWA 否 / TWA 勉强 |

> 体积/启动/内存为社区常见量级的估算区间，非本机实测；对本项目决策不构成区分度（见 §5 论证 1）。

---

## 4. 逐方案详评

### 4.1 React Native 0.85 + Expo SDK 57（新架构）

**现状**：0.85 起新架构（JSI/Fabric/TurboModules）强制启用，旧桥已死；Expo SDK 57（2026-07）为当前推荐起点，`prebuild` 后就是标准 gradle 工程，本地 `gradle assembleDebug` 可行。生态本身健康。

**共享层集成**：`packages/shared` 的 TS 类型与纯函数（口径/协议编解码）可直接复用，这是 RN 相对 Flutter/原生的真实优势。

**图表（致命伤）**：
- victory-native 42（Skia）性能好但无热力图，7×24 热力图要用 Skia Rect 手绘 + 手势/坐标轴全自管，等于重写一个图表库切片；且有 release 包渲染空白的已知 issue；
- gifted-charts 1.4.78 无热力图，且风格与 PC 端不一致；
- 若坚持复用 ECharts，唯一路径是 `react-native-webview` 内嵌 ECharts —— 也就是"在 RN 里再造一个 Capacitor"。

**样式**：NativeWind（Tailwind for RN）只支持 Tailwind 子集，且与 PC 端 Tailwind 4 配置/插件生态不完全同步，两端样式无法真正共享。

**否决理由汇总**：本项目只有 Android 一个目标平台，RN 的核心卖点（一套代码双平台）价值为零；为拿到这零价值付出了图表全重写 + NativeWind 样式分叉 + RN 原生构建链（gradle/AGP/Kotlin 插件版本矩阵）三重成本。个人项目里"多一套会腐烂的工具链"是净负资产。

### 4.2 Flutter 3.47

**现状**：3.47 stable（2026-08），框架本身健康，渲染性能是所有候选里最好的。

**共享层集成**：TS 类型不可直用。需把 `packages/shared/model` 导出 JSON Schema 再生成 Dart 类（quicktype / `json_serializable`），`shared/kit` 口径算法（成本估算、单位选择、时间边界）要在 Dart 侧重写并做金样对拍——T1 报告已明确这是"两端显示一致"的高风险点，Dart 重写直接踩中。

**图表（致命伤）**：fl_chart 1.2.0（7.2k likes）不支持热力图；graphic 2.7.0 亦未列出。7×24 热力图 + 日历热力图必须 `CustomPainter` 自绘，含坐标轴、tooltip、色标。折线/环形/柱状虽可做，但所有 options 需从 ECharts 语义翻译成 fl_chart API，视觉回归风险高、工时不可控。

**其他**：Dart 为全新语言；Vite/TS 工具链经验完全不可迁移。

**否决理由汇总**：性能最强但本场景不需要（§5 论证 1）；为了"更好的帧率"付出"热力图自绘 + 口径算法双实现 + 新语言"三重代价，方向性错误。

### 4.3 原生 Kotlin + Jetpack Compose

**现状**：Kotlin 2.4.20 + Compose（BOM 2026.x）成熟；Vico 3.3.1（2026-08-28）提供 line/column/candlestick，无热力图；coil 负责图片。热力图需 Compose `Canvas` 自绘（可行，Compose 自绘体验不差，但仍是自绘）。

**优势**（如实承认）：启动最快、内存最低、包最小；桌面小组件（Glance）、前台服务、系统集成为一等公民；若未来要做"息屏常驻监控"或精致 widget，这是唯一顺畅的路线。

**否决理由汇总**：全量重写（UI + 图表 + 交互 + 样式 + 导航），且 TS 熟练度归零；`packages/shared` 的 TS 类型/口径需经 JSON Schema codegen 或手写 Kotlin data class 维持双份。对单人维护的仪表盘，这是长期维护成本最高的选项。它的独特能力（widget/常驻）当前需求清单里只是"可选加分"，不值得为此买下整个重写。

### 4.4 Capacitor 8 —— 主推

**现状**：8.5.2（2026-09-11）维护活跃。原理：原生壳 + 系统 WebView（Chromium 内核，与 Electron 渲染层同源）加载构建好的静态前端；`npx cap add android` 生成标准 Android gradle 工程，之后就是常规 Android 开发（可随时写 Kotlin 原生插件）。

**共享层集成（满分项）**：`packages/shared` 三个模块（model / kit / protocol）零改动直用——它本来就是纯 TS 零 DOM 的包；WS 协议编解码、口径算法、类型契约与 PC 端字面同源，不存在"两端一致性"问题，只存在"一份代码"。

**图表（满分项）**：ECharts 6.1 在 WebView 内原样运行，PC 端已调优的 options（7×24 热力图、日历热力图、渐变折线、环形）几乎原样迁移，唯一工作是响应式布局。这是所有候选中唯一"图表不重写"的方案（见 §2 单点事实）。

**WS/MQTT**：WebView 原生 `WebSocket`（浏览器标准 API），T4 方案的 `ws://<PC-IP>:<port>` + JSON 协议直连；如后期切 MQTT over WebSocket，`mqtt.js 5.x` 在浏览器环境零 polyfill 可用。对比：RN 需要额外 polyfill 配置，Flutter/Kotlin 需换生态库。

**样式**：Tailwind 4 配置与 PC 共享，暗色主题（`dark` class 策略）直接成立。

**构建与产物**：`vite build`（mobile 入口）→ `webDir: dist` → `npx cap sync android` → Android Studio/gradle `assembleDebug` → **单一 `app-debug.apk`**（侧载）。发布版 `assembleRelease` + 自签 keystore 同样是单 apk。全程本地，不依赖云构建。

**缺点（如实列出并给出缓解）**：
1. 内存与冷启动劣于原生/Flutter（WebView init + JS 执行）——对本场景可接受（§5 论证 1），缓解：图表按需 init/dispose、路由懒加载；
2. 无原生手感（列表回弹、转场）——看板类应用用户感知弱；
3. 后台保活没有好方案——**但本应用不需要**（§6 专节论证）；
4. WebView 版本随设备系统（Play 系统更新自动升级，Android 8+ 基本都在现代 Chromium）——缓解：minSdk 取 24+，Browserslist 锁定现代目标；
5. 桌面小组件/深链等原生能力需写 Kotlin 插件——当前非需求，留作 §8 展望。

### 4.5 其他候选

- **Kotlin Multiplatform（KMP 2.4.20）**：生产就绪属实，但 KMP 共享的是 **Kotlin 代码**——它解决的是"Kotlin 逻辑跨 Android/iOS"，而本项目要共享的是 **TS 逻辑跨 Electron/Android**，KMP 对前者无解，且无 iOS 目标。比原生还多一层工具链，**否决（比 4.3 更早出局）**。
- **纯 PWA**：没有 .apk 产物，直接违反指导书 §零"单一 .apk"原则；局域网自签/HTTP 场景下 Service Worker 限制多。**否决**。
- **TWA（Bubblewrap）**：能出 apk，但内容托管在 URL 上（要求 PC 端常驻 HTTP 服务且手机侧 URL 可达），与"点开即用的单 apk、离线壳可撑住断连态"的目标形态不符。作为 Capacitor 的劣化变体**否决**。
- **Tauri 2 mobile**：Rust 核心 + 系统 WebView，体积小；但 Android 侧生态比 Capacitor 更年轻、社区插件更少、且引入 Rust 工具链对 TS 开发者是纯增量成本，相对 Capacitor 无任何本项目需要的优势。**否决**。

---

## 5. 关键论证：Capacitor 复用 vs RN 重写 vs 原生

### 论证 1：性能不是本场景的约束，因此"更原生"没有可兑换的收益

数据面：局域网 WS，JSON 文本，秒级推送；单看板同时活跃的 ECharts 实例 4–8 个，单图数据点量级 10²–10³（TrendPoint 按天/小时分桶，热力图固定 168 格）。这是 WebView + Canvas 的舒适区下限。手机端只做"展示 + 轮询 + 按钮下发"，不做流式渲染、不做动画密集型交互。**RN 的桥性能、Flutter 的 Impeller、Compose 的首帧优势，在本场景全部没有可感知的兑现场景。** 当性能不构成区分度时，决策就回到"复用率 × 单人维护成本"，而这正是 Capacitor 的主场。

### 论证 2：图表复用是本项目最大的既有资产，重写即纯损耗

PC 端 ECharts options 是几十处调优的产物：热力图 weekday 归一（`(w+6)%7`）、"按可见峰值统一单位"的 yAxis 格式化、日历热力图、渐变面积、暗色主题适配。§2 已核实：RN 三大图表库、fl_chart、graphic、Vico **无一开箱支持热力图**。选非 WebView 方案 = 7×24 热力图 + 日历图自绘 + 其余图表语义翻译，估算仅图表一项就是数周级工时，且视觉与 PC 端出现永久性分叉。**在"图表复用价值高"这一约束下，任何非 ECharts 运行时的方案都自动出局。**

### 论证 3：RN 存在"悖论形态"，其终局就是 Capacitor 加价版

RN 方案若想保留 PC 图表（论证 2 的要求），社区标准做法是 `react-native-webview` 嵌 ECharts——即最终形态 = RN 运行时（Hermes、桥、NativeWind）+ WebView + ECharts。相比直接 Capacitor，多付了整层 RN 运行时与构建链，换来的只有"未来可以顺便出 iOS"——本项目无 iOS 目标。**既然终局是 WebView 跑 ECharts，就应该直接选最薄的 WebView 壳。**

### 论证 4：三人对比表

| 项 | Capacitor + 复用 | RN 重写 | Kotlin 原生 |
|---|---|---|---|
| 图表工作量 | 移植 + 响应式适配（天级） | 换库重写或嵌 WebView（周级） | Vico + Canvas 自绘热力图（周级） |
| 逻辑层 | 共享包直用 | 共享包直用 | codegen/双实现 |
| 样式层 | Tailwind 直用 | NativeWind 子集分叉 | 全新 |
| 新增工具链 | gradle（不可避免，四案等同） | gradle + RN 生态 | gradle + Kotlin/Compose |
| 两端视觉一致性 | 高（同 CSS/ECharts） | 低 | 低 |
| 单人长期维护 | 只维护一份前端 | 两套渲染代码 | 两套全栈 |

**结论：约束条件下 Capacitor 是被论证 pinned 的解，而非偏好性选择。** 换用原生的正当触发条件（记录在案，供未来复审）：① 需要桌面小组件/息屏常驻监控成为一级需求；② 应用要上架商店面向他人分发；③ 单图表数据量进入 10⁴ 点级且 WebView 掉帧。届时建议以原生 Compose 补 widget、其余保持 WebView 的混合形态，而非整体重写。

---

## 6. 后台保活判断：不需要，也不要做

**判断：Nexus Android 端按"前台使用、回到前台自动重连"设计，不做任何后台常驻。**

理由：
1. 用法是"打开手机看一眼 PC 状态、点一下远控"，属前台短会话型；看板的实时性靠前台 WS 推送已足够；
2. 平台不鼓励常驻且持续收紧：Android 15 对 `dataSync` 型前台服务引入约 6 小时/天的运行上限（Android 16 继续收紧），保活方案（前台服务 + 电池白名单引导）对个人工具是纯摩擦，无收益；
3. 断连体验用工程手段抹平：`App` 生命周期监听回前台 → 检测 WS 断开 → 自动重连 + 全量快照刷新（协议里本就有快照接口，T4 草案已含 heartbeat/reconnect）；
4. 若 v2 后期需要"PC 侧告警触达手机"，正确做法是推送通道（FCM 或自托管 ntfy）而非客户端保活——留给告警补强项另行决策。

---

## 7. 主推方案：完整技术栈清单

### 7.1 仓库布局（与 T1 共享层方案对齐）

```
F:\Nexus（pnpm workspace）
├─ apps/desktop/        # 现有 Electron 41 PC 端（迁移自 src/）
├─ apps/mobile/         # 新增：Capacitor Android 壳
│  ├─ src/              # 移动端 React 入口（复用 PC 图表组件 + 移动布局）
│  ├─ dist/             # vite build 产物（webDir）
│  └─ android/          # cap add android 生成的 gradle 工程
└─ packages/shared/     # T1 方案：model / kit / protocol（两端直用）
```

### 7.2 依赖与版本

| 层 | 选型 | 版本 | 说明 |
|---|---|---|---|
| 原生壳 | `@capacitor/core` / `@capacitor/android` / `@capacitor/cli` | 8.5.x | 2026-09 现行稳定 |
| UI | `react` / `react-dom` | 19.2.x | 与 PC 同版本 |
| 图表 | `echarts` | 6.1.x | 按需 `echarts/core` 引入，减包体 |
| 状态 | `zustand` | 5.x | 与 PC 共享 store 形状 |
| 样式 | `tailwindcss` | 4.1.x | 共享 theme token（T1 §设计 Token） |
| 语言/构建 | `typescript` + `vite` | 5.9.x + 7.x | mobile 独立 vite 配置 |
| 通信 | `packages/shared/protocol`（原生 `WebSocket` 封装） | — | T4 JSON 协议；可选 `mqtt.js` 5.x over ws |
| 插件 | `@capacitor/network` `@capacitor/app` `@capacitor/status-bar` `@capacitor/preferences` | 8.x 兼容版 | LAN 检测/返回键/暗色沉浸/配对信息存储 |
| 配对 | `@capacitor-mlkit/barcode-scanning` | latest | 扫 PC 端二维码配对（与 T4 方案衔接） |
| Android | AGP 8.x + Gradle 8.x；minSdk 24+；targetSdk 35+ | 以 `npx cap add android` 模板为准 | WebView 随系统 Play 更新 |

### 7.3 构建与产物路径

```bash
# 开发
pnpm --filter mobile dev            # vite dev server（浏览器快速迭代）
npx cap sync android                # 同步 web 资产 + 插件
# 出包（Windows 本地，无需云构建）
pnpm --filter mobile build          # vite build → apps/mobile/dist
npx cap sync android
cd apps/mobile/android && ./gradlew assembleDebug
# 产物（单一 apk）
# apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
# 发布：./gradlew assembleRelease（自签 keystore）→ app-release.apk
```

### 7.4 性能预算（自查线，估算口径）

| 指标 | 预算 | 手段 |
|---|---|---|
| 冷启动到首屏 | ≤ 1.5s（中端机） | 路由懒加载、ECharts 按需 init |
| 常驻内存 | ≤ 200MB | 非当前图表 dispose、数据窗口截断 |
| apk 体积 | ≤ 8MB | echarts 按需引入、无图片重资产 |
| 远控指令回执 | < 500ms 体感 | LAN WS 直连天然满足（T4） |

---

## 8. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| WebView 内存随图表实例数增长 | 中 | 单活跃图表策略：页面仅保留可见图表实例，切换页签即 `dispose`；ECharts `dataset` + `sampling: 'lttb'` |
| 小屏响应式布局返工 | 中 | 首版即按移动断点重排信息架构（KPI 卡两列、图表单列全宽），复用 PC 的 ECharts options 但布局层重写——这是唯一计划内的新增 UI 工作 |
| 旧设备 WebView 过旧 | 低 | minSdk 24+；启动时 `userAgent` 探测，过旧则提示升级"Android System WebView" |
| Capacitor 大版本升级 | 低 | 壳层代码量极小（无自定义插件时），升级成本≈依赖升级 |
| 未来小组件/常驻需求 | 记录在案 | 触发条件见 §5 论证 4；届时以 Kotlin 补 Compose Glance widget，主界面不动 |

---

## 9. 参考资料（核实于 2026-09-25）

**框架现状**
- React Native 新架构（唯一运行时）：https://reactnative.dev
- RN 0.85（2026 最新稳定）：https://www.bacancytechnology.com/blog/react-native-0-85
- Expo SDK 55 升级说明（RN 0.83.2 / React 19.2）：https://expo.dev ；Expo 新架构文档（SDK 54 为最后可关闭版本）：https://docs.expo.dev
- Flutter 3.47 stable 与版本列表：https://docs.flutter.dev/release/release-notes ；https://flutter.dev/blog/whats-new-in-flutter-3-47
- Capacitor 8.5.2（2026-09-11）：https://github.com/ionic-team/capacitor/releases
- Kotlin 2.4.20 / KMP 生产就绪 / CMP 稳定范围：https://kotlinlang.org/multiplatform/ ；https://github.com/JetBrains/kotlin/releases/tag/v2.4.20

**图表库核实**
- fl_chart 1.2.0（无热力图）：https://pub.dev/packages/fl_chart
- graphic 2.7.0：https://pub.dev/packages/graphic
- Vico 3.3.1（2026-08-28）：https://github.com/patrykandpatrick/vico/releases
- victory-native 42.0.1（NearForm 维护；release 空白 issue）：https://github.com/FormidableLabs/victory-native
- react-native-gifted-charts 1.4.78（2026-08 更新）：https://github.com/Abhinandan-Kushwaha/react-native-gifted-charts
- echarts 6.1.0：https://www.npmjs.com/package/echarts

**平台行为**
- Android 15 行为变更（dataSync 前台服务 6 小时上限）：https://developer.android.com/about/versions/15/behavior-changes-15
- 前台服务类型：https://developer.android.com/develop/background-work/services/fg-service-types
- RN 内建 WebSocket：https://reactnative.dev/docs/network

**内部关联文档**
- `docs/research/v2/shared-layer-proposal.md`（T1，`packages/shared` 三模块设计）
- `docs/research/v2/communication-solution-research.md`（T4，LAN WS + JSON + mDNS/QR）
- `Nexus 能力补强指导书 v2：全量补强与远控扩展.md`（§零 单一 apk 原则；§2.5 本任务依据）
