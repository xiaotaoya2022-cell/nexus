# Nexus Android 端实现报告（apps/mobile）

日期：2026-09-24
范围：从零搭建 Capacitor + React 单 APK 应用，连接 PC 端（Electron）Nexus 远程服务，展示双看板 + 有限反控。
本文由 Android 端实现代理产出，对应指导书 v2 远控扩展。

## 1. 结论速览

| 项 | 结果 |
| --- | --- |
| 技术栈 | Vite 7.3.6 + React 19.3 + TypeScript 5.9.3 + @capacitor/*@6.2.2 + echarts 6.1.0 + zustand 5.0.15 |
| 构建验证 a | `npm run build`（tsc --noEmit + vite build）**通过，0 错误** |
| 构建验证 b | `npx cap add android` **成功** |
| 构建验证 c | `gradlew.bat assembleDebug` **BUILD SUCCESSFUL**，产物 `F:\Nexus\apps\mobile\android\app\build\outputs\apk\debug\app-debug.apk`（4.08 MB） |
| 共享契约 | vite alias `@shared` → `F:\Nexus\src\shared`，协议信封/类型单一事实源 |
| 根目录侵入 | 仅在根 `.gitignore` 追加 mobile 条目（允许项）；未改任何其他现有文件 |

**Capacitor 版本决策**：首选 Cap 7.6.9（最新稳定 7.x），但 Cap 7 的 capacitor-android 模块硬编码
`JavaVersion.VERSION_21`，本机仅有 JDK 8 / 17（无 Android Studio JBR 21），assembleDebug 报
`invalid source release: 21`。任务允许 Cap 6/7，故降级至 **Cap 6.2.2**（JDK 17 官方兼容，
compileSdk 34 / minSdk 22 / AGP 8.2.1）后构建通过。后续若升级 Cap 7+，需先安装 JDK 21。

## 2. 目录结构

```
F:\Nexus\apps\mobile\
├── package.json               # 独立 package.json（不动根 package.json）
├── vite.config.ts             # alias @shared → ../../src/shared
├── tsconfig.json              # paths @shared/*，strict + noUnusedLocals
├── index.html
├── capacitor.config.ts        # appId app.nexus.mobile / webDir dist
│                              # server.androidScheme='http' + allowMixedContent（局域网 ws:// 直连）
├── dist\                      # vite 构建产物
├── android\                   # cap add android 生成 + 本地小改（见 §6）
│   └── app\build\outputs\apk\debug\app-debug.apk
└── src\
    ├── main.tsx / App.tsx     # 入口 + 底部 5 Tab 壳
    ├── theme.css              # 单文件手写 Zai Dark 主题（无 tailwind/组件库）
    ├── lib\
    │   ├── conn.ts            # 连接层（见 §4）
    │   ├── store.ts           # zustand：设置持久化 + 状态桥接 + 推送落库
    │   ├── api-types.ts       # ZcodeInstance/DshSessionInfo/DshStatus 镜像（未进 shared 的主进程结构）
    │   └── format.ts          # 数值/时间格式化（等宽 tabular-nums 展示）
    ├── components\
    │   ├── Chart.tsx          # echarts 按需注册 + 通用 Chart 容器（ResizeObserver）
    │   └── PullRefresh.tsx    # 触屏下拉刷新
    └── pages\
        ├── OverviewPage.tsx   # 总览
        ├── SystemPage.tsx     # 系统
        ├── InstancesPage.tsx  # 实例
        ├── ControlPage.tsx    # 控制
        └── SettingsPage.tsx   # 设置
```

## 3. 页面（底部 5 Tab）

- **总览**：今日 Token KPI 卡 ×2（今日 Token / 输出 Token，含请求·成本副行）+ 7 天趋势折线
  （`agent.trend {range:'7d'}`，总量实线 + 输出虚线）+ Token 类型环形（输入/输出/推理/缓存读/缓存写，
  中心总数）+ 今日会话 Top10（`agent.sessions {range:'today', limit:10}`）。
  KPI 与环形由 `agent.overview` 推送驱动（PC 端约 2s 一推，实时）。
- **系统**：CPU / 内存 / 磁盘 / 网络 四卡，全部由 `system.snapshot` 推送驱动（2s）：
  CPU 大数字 + 90 点滚动折线；内存已用/总量 + 使用条；网络 ↓/↑ 速率 + 滚动热力图
  （HeatmapChart，下行/上行 × 时间列，3 分钟窗口）；磁盘使用率横向 BarChart（≥90% 红 / ≥75% 橙）；
  GPU 只读行（数据存在时显示）。
- **实例**：ZCode 实例列表（`zc.instances`，运行态徽标/项目/活跃时间）+ DSH 会话列表
  （`dsh.sessions` + `dsh.status` 可用性徽标），支持下拉刷新。
- **控制**：目标选择（DSH 会话下拉 + “新建会话”）→ 文本框下发 `dsh.prompt`
  （不选会话时由 PC 端自动创建，60s 超时）→ `dsh.cancel` 按钮（仅选中会话可用）；
  每次操作在“操作结果”卡显示结果行（时间 + op + ok/err + 摘要）。
- **设置**：服务器地址/端口/设备名输入（localStorage 持久化）、PIN 配对流程
  （6 位 PIN → `pair` → 保存 deviceId/token → 自动连接）、已配对凭据展示与清除、
  连接状态指示灯（绿=在线/橙=进行中/灰=断开/红=错误）+ 重连倒计时提示 + 手动连接/断开。

## 4. 连接流程（src/lib/conn.ts）

- 帧格式与 PC 端共用 `@shared/protocol`：请求 `{v:1,type:'req',id,method,payload}`，
  响应 `{v:1,type:'res',id,ok,error?,payload?}`，推送 `{v:1,type:'push',ch,ts,payload}`。
- **配对**：`pairOnce()` 独立短连接发 `pair {pin, deviceName}` → `{deviceId, token}`，
  一次性 PIN（60s），成功后凭据写入 localStorage 并自动用长期凭据建连。
- **鉴权**：每条新连接 open 后先发 `auth {deviceId, token}` → `{capabilities}`；
  失败分类：UNAUTHORIZED/鉴权类 → 停止自动重连并置 error（等待重新配对）；其他 → 进入退避。
- **重连退避**：1s → 2s → 5s → 10s 封顶，鉴权成功清零；断线时 reject 全部在途请求。
- **请求 Promise map**：客户端生成 id，Map 关联 resolve/reject + 超时定时器（默认 10s，可按调用覆盖）。
- **订阅缓存**：store 层注册 `agent.overview`、`system.snapshot` 两个通道；
  离线期注册只进缓存，重连鉴权成功后自动重发 `subscribe`；通道无人订阅时发 `unsubscribe`。
- **状态广播**：conn 用监听器广播 `{status, detail, retryInMs}`，store.ts 桥接进 zustand，
  推送 payload 也统一落 store（页面切换不断流）。

## 5. 契约复用与例外

- `@shared/protocol`：帧信封、RemoteMethod/PushChannel、PairRequest/PairResult、SystemSnapshotLike。
- `@shared/types`：Overview、SessionRow、TrendPoint 等看板数据结构。
- 例外：`ZcodeInstance`、`DshSessionInfo`、`DshStatus` 目前定义在 PC 主进程
  （src/main/modules/zcode/manager.ts、src/main/modules/dsh/bridge.ts，依赖 node 模块，不宜进 shared），
  Android 端在 `src/lib/api-types.ts` 按其导出接口逐字段镜像。后续若要做 v3 插件市场，建议把这三个结构
  提升进 src/shared 以恢复单一来源。

## 6. Android 工程改动（cap add 之后）

- `android/local.properties`：`sdk.dir=C:/Users/xiaotao2026/AppData/Local/Android/Sdk`（本机 SDK）。
- `android/app/src/main/AndroidManifest.xml`：`<application>` 增加 `android:usesCleartextTraffic="true"`
  （允许 ws:// 明文连局域网 PC）。
- 其余为 Capacitor 模板原样；web 资产更新用 `npm run cap:sync`（vite build + cap sync）。

## 7. 构建产物

- Web：`F:\Nexus\apps\mobile\dist\`（index.html + assets，gzip 后约 285KB，echarts 按需引入）
- APK：`F:\Nexus\apps\mobile\android\app\build\outputs\apk\debug\app-debug.apk`（assembleDebug，4.08 MB）
  - 环境：JDK Temurin 17.0.20.1 + Android SDK（`%LOCALAPPDATA%\Android\Sdk`，AGP 8.2.1）

## 8. 已验证项

1. `npm run build`：tsc --noEmit 0 错误 + vite build 成功（vite 7.3.6，含 Cap 6 降级后的最终依赖集复跑）。
2. `npx cap add android`：成功，android 平台目录生成（Cap 6.2.2）。
3. `gradlew.bat assembleDebug --no-daemon`：BUILD SUCCESSFUL（82 tasks），app-debug.apk 产出；
   打包的 web 资产与最终 dist 一致（构建 hash 相同：index-De_5ha3v.js）。
4. 协议面与 PC 端 server.ts（src/main/modules/remote/server.ts）逐 method 对齐：
   pair/auth/subscribe/agent.overview/agent.byModel/agent.sessions/agent.trend/system.snapshot/
   zc.instances/dsh.status/dsh.sessions/dsh.prompt/dsh.cancel；推送通道 agent.overview/system.snapshot。

## 9. 未做项（留待后续）

- 真机/模拟器端到端联调（本机无设备在环；PC 端远程服务已有 e2e，协议面一致，建议实机验证配对与推送节奏）。
- 应用图标/启动屏定制（当前为 Capacitor 默认图标；可用 @capacitor/assets 生成）。
- 二维码扫码配对（当前为手输 IP/端口 + PIN；PC 端 QR 内容为 `nexus-pair://host:port?n=nonce#pin`，
  移动端可后续接 zxing 解码直填）。
- token 指纹校验（配对结果未展示 HMAC 指纹比对，防中间人增强项）。
- zc.startHeadless / zc.stopHeadless 反控（协议已留位，PC 端深链方案未定，移动端未实现入口）。
- mDNS 自动发现 PC 地址（当前手输）。
