# ENHANCEMENT_REPORT — Nexus 能力补强 v2.0

**项目**：Nexus — 本地 AI Agent 算力监控中心（能力补强 v2：全量补强与远控扩展）
**分支**：`feature/nexus-enhance-v2-20260925`（自 v0.1.1 基线切出）
**报告时间**：2026-09-25 03:30:00 ｜ **负责人/作者**：xiaotaoya2022
**状态**：✅ Phase 0/1/2 完成 + 红蓝审计一轮修复完成（1×P1 已修复并端到端验证）；补强项按评估分批落地（详见 §四）

---

## 一、Phase 0：七项调研（docs/research/v2/，已提交 dcb1e84）

| 任务 | 报告 | 关键结论 |
| --- | --- | --- |
| T1 现状调研 | nexus-status-report.md + shared-layer-proposal.md | 分层干净；9 个扩展阻碍点（无 instance 维度、NexusApi/IPC 强耦合、settings 无迁移等）；共享层倾向 TS 单一事实源 + JSON over WS |
| T2 ZCode 远控 | ZCode远控源码分析报告.md + 复用方案.md | **无现成手机远控组件**；四层可用通道（@zcode/rpc、packages/server、zcode-server-cli 命名管道、Bot IM）；主方案 = CLI `app-server --stdio`（Apache-2.0）；多开经 `--user-data-dir` env 隔离 |
| T3 DeepSeek Harness | 调研报告.md + 集成方案.md | **DeepSeek 官方开源**（npm @deepseek-ai/dsh，MIT），本机已装 pin 0.1.1-rc.2；回环 `POST /api/<method>` + SSE `events.mux` 免鉴权全覆盖反控需求；纯外挂零侵入 |
| T4 通信方案 | communication-solution-research.md + hybrid-communication-architecture-draft.md | 主通道 = 局域网 WS 直连（mDNS/QR 发现 + 一次性配对）；公网备通道 = Tailscale 复用同协议；信封 Envelope v1 |
| T5 Android 选型 | android-tech-selection.md | **Capacitor + React + ECharts 复用路线**（RN/Flutter/Compose 图表库均无热力图，重写即纯损耗）；前台使用不做常驻保活 |
| T6 多开管理 | 多开ZCode管理方案.md | 实测 3 个运行实例；**agent 数据不按实例隔离**（共享全局库）→ 聚合视图为主 + `session.directory` 工作区归属；实例视图只做运行期元数据 |
| T7 补强评估 | enhancement-assessment.md | 8 项落地 + 2 项简化 + 3 项延后（多设备同步/插件市场/AI 洞察引擎，理由成文） |

## 二、Phase 1：PC 端扩展（d7eda3b + 本轮 P1 修复）

- **protocol.ts**：信封 v1（req/res/push、capability 协商、pair/auth.hello/auth.verify）。
- **remote-server**：WS 随机端口监听、一次性配对会话（60s PIN + QR 内 pairingSecret）、订阅推送、120 req/min 限流、审计 jsonl、并发连接上限 32、maxPayload 256KB、浏览器 Origin 握手拒绝、远程吊销硬拒。
- **system-collector**：systeminformation 采样；静态信息 5min 缓存（规避无窗口 Electron 下 WMI 慢查询）。
- **zcode-manager**：白名单 userData 实例发现（WAL 新鲜度判活、setting.json recentProjects、tasks-index mtime），全程只读。
- **dsh-bridge**：回环 RPC 桥（host.describe / session.list / create / prompt / cancel / history）。
- **渲染层**：系统状态卡（PC 端同样可见）+ 设置面板「远程访问」（开关 / QR+PIN 配对 / 设备撤销）。
- **验证**：`scripts/remote-client-v2.js` 端到端 12 项断言全过（未鉴权拒绝/错误 PIN 拒绝/配对/挑战式鉴权/重放拒绝/订阅/推送/取数/实例发现），`scripts/remote-client-test.js` 已被 v2 版替代。

## 三、Phase 2+3：Android 端（1c60c7c + 协议升级提交）

- **单一 apk**：`apps/mobile`（Capacitor 6.2.2 + React 19 + Vite 7 + ECharts 按需），`gradlew assembleDebug` 产出 app-debug.apk（4.08MB）。
- **5 页布局**：总览（KPI+趋势+类型环形+会话 Top10）/ 系统（CPU/内存/磁盘/网络 + 图表）/ 实例（ZCode 多开 + DSH 会话）/ 控制（DSH prompt/cancel）/ 设置（地址、配对、凭据、状态灯）。底部 Tab，Zai Dark token 手写 CSS，数值等宽 tabular-nums，无渐变/玻璃态/emoji。
- **连接层**：重连退避 1/2/5/10s、订阅缓存重发、请求 Promise map、断线广播。
- **共享契约**：vite alias `@shared` → PC 端 `src/shared`，协议/类型单一事实源。

## 四、红蓝对抗审计（本轮）

- **红队合并审计**（v2 增量）：P1×1 —— **明文 ws 传输下设备令牌可被局域网被动嗅探**（配对响应/重连鉴权帧携带 token），偏离设计文档 WSS 要求；另 P2×2（PIN 无全局失败预算/无连接上限；无 Origin 校验+maxPayload 默认 100MiB）、P3×9（审计覆盖度/pairNonce 死代码/allowBackup 等）。结论：不放行。
- **修复（本轮提交）**：P1-1 采用「**令牌永不上线**」方案——pairingSecret 仅存于二维码（摄像头通道，不经网络）；pair 证明 = sha256(pairingSecret:nonce:pin)，响应只回 deviceId；token = sha256(pairingSecret:deviceId:nonce) 由两端独立推导；重连鉴权 = auth.hello 挑战 + sha256(token:challenge) 校验，挑战单次有效防重放。P2 全修：PIN 失败预算（≥10 次作废会话）、连接上限 32、maxPayload 256KB、浏览器 Origin 握手拒绝、limit NaN 兜底。P3：allowBackup=false、limit NaN、审计注记。
- **修复后端到端验证**：scripts/remote-client-v2.js 全部断言通过，新增安全断言（配对响应无 token ✓、挑战重放拒绝 ✓）。
- **遗留（后续项）**：P3 realpathSync 加固 junction、成功读数审计、审计日志轮转、UPSTREAM_ERROR 信息脱敏、protocol 中未实现方法的契约清理（zc.startHeadless 等，随 Phase 3 反控增强落地）、Android token 的 localStorage 沙箱内存储（已接受）。
- **安全声明**：Mimosa 完整扫描因仓库规模限制未出全量结论，本报告不做整体安全断言。

## 五、补强项落地状态（对照 enhancement-assessment.md）

| 状态 | 项 |
| --- | --- |
| ✅ 本轮已落地 | 成本估算基础（v0.1.0 已有）、预算追踪与告警通道（远程 alert 通道就绪）、会话数据通道（Android 会话 Top10）、实例多开发现（PC+Android）、系统状态双端看板、健康度数据源（turn_usage 已同步） |
| 🕒 Phase 3 下一批（评估通过、按序实现） | 异常检测规则引擎+告警推送、预算设置 UI、搜索筛选、会话详情抽屉、月度赛博账单页、CSV 导出、健康提醒（系统通知）、健康评分卡、区间对比、拟人化文案池、ZCode stdio 反控增强（按 T2 方案，受写入门约束延后） |
| ⏸ 延后（理由成文） | 多设备同步、插件市场、AI 洞察引擎（LLM 版；规则洞察随告警先行） |

## 六、运行与验证

```bash
# PC 端
npm run dev / npm run dist
npx electron out/main/remote-smoke.js                    # 远控服务自测（服务端）
NEXUS_TEST_INFO="$(cat <info.json>)" node scripts/remote-client-v2.js   # 协议端到端客户端
# Android 端
cd apps/mobile && npm run build && npx cap sync android && android/gradlew.bat assembleDebug
```

## 七、后续路线

1. Phase 3 剩余补强项按 §五 顺序落地（PC 端规则引擎优先）。
2. ZCode 反控增强：CLI `app-server --stdio` 指令集（T2 方案已冻结指令清单）。
3. WSS + 证书指纹固定（若部署到不可信网络；当前威胁模型 = 可信局域网 + 令牌不上线 + 可撤销设备）。
4. 设置页结构化（预算/工作区白名单/适配器开关）。
