# PROJECT_LAUNCH_REPORT — Nexus v0.1.0

**项目**：Nexus — 本地 AI Agent 算力监控中心
**分支**：`feature/nexus-init-20260924` ｜ **仓库**：`xiaotaoya2022-cell/nexus`（私有）
**报告时间**：2026-09-25 02:33:24 ｜ **负责人/作者**：xiaotaoya2022
**状态**：✅ Phase 0-3 全部完成，红蓝对抗审计通过（蓝队放行），可打包交付

---

## 一、交付概览

单一桌面软件（Electron 41 + React 19 + Tailwind 4 + ECharts 6 + node:sqlite），双击一个 exe 打开一个窗口，满足立项书零章"单一软件界面"最高原则。应用读取本机各 AI Agent 的本地数据源（全程只读），把 Token 消耗、会话、工具调用汇总为自有 SQLite，并以 ZCode 同源设计语言（Zai Dark/Light）呈现高密度看板。

**核心价值实证**（本机实测，2026-09-25）：
- ZCode 全量首同步 50,137 条请求级用量 / 564 会话 / 60,179 条工具调用，约 2 秒；全时段累计 166 亿+ tokens、576 会话、12 个模型。
- ZCode 本地用量表仅保留 30 天，Nexus 同步即快照——历史自此永久留存。

## 二、Phase 0 调研交付物（docs/research/）

| 交付物 | 要点 |
| --- | --- |
| ZCode 源码探索报告 | Electron 41 + React 19 + Tailwind 4 + node:sqlite；Zai Dark 全套 Token；`model_usage` 表结构；**用量表仅留 30 天**的关键约束 |
| Agent 数据源调研报告 | 10 个 Agent 逐一实测：仅 ZCode/Codex/Claude Code 有本地精确 token；其余云端/protobuf/无字段 |
| 桌面应用方案推荐 | 对比 Electron/Tauri/Wails/纯 Go webview → 选 Electron 全栈（跟随 ZCode，立项书 5.2 裁决条款），否决 Wails（v3 beta） |
| Nexus UI 设计规范草案 | Zai Dark/Light Token 表、字号/间距/圆角/组件/动效规范、三栏布局规格、8 条验收 Checklist |

## 三、功能实现对照（立项书第三章）

- **必须指标**：Token 总量/明细（输入/输出/推理/缓存读写五字段互斥拆分）✓；会话数（并集口径）✓；工具调用分布 ✓
- **时间筛选**：今日 / 近 7 天 / 近 30 天 / 本月 / 今年 / 全部 ✓（覆盖 §3.1 日/周/月/年）
- **可视化**：KPI 卡 ×4、Token 趋势折线（按模型/Agent）、7×24 活跃热力图、每日强度条形、Agent 占比环形（点击下钻）、Token 类型环形、模型排行、工具调用排行、会话明细栏 ✓；雷达/桑基（立项书标注可选）未做
- **交互**：范围切换 ✓、扇区下钻 ✓、导出 PNG ✓、暗/亮切换（默认暗）✓
- **数据策略**：适配器 ×5（ZCode/Codex/Antigravity/Claude Code/CodeBuddy）+ presence-only ×5；dedupe_key 幂等增量；retentionDays 保留策略 ✓
- **已记录的有依据偏离**：Go 后端 → Electron/TS（调研报告 C5 论证：跟随 ZCode 框架的裁决条款优先）；agent_summary/daily_summary 预聚合表以实时聚合替代（数据量毫秒级，决策见 docs/modules/aggregator.md）；§4.4 文本估算适配器未实现（调研实证：无精确 token 的 Agent 本地均无可估算的文本源，presence-only + 文档交代）

## 四、质量门

| 门 | 结果 |
| --- | --- |
| 类型检查 | `tsc` node + web 双配置 0 错误 |
| 冒烟测试 | `electron out/main/smoke.js` PASS：真实同步 5 适配器 + 全查询通道自检 |
| 真机数据对账 | 重叠窗修复实测找回 ZCode 漏行 700+ / 工具 1000+（修复前游标漏行即永久丢失） |
| 打包验证 | `electron-builder --dir` exit 0（win-unpacked 产出；NSIS/便携配置就绪，`npm run dist` 出双产物） |
| 视觉验收 | 双主题 × 顶/底 4 张截图经视觉验收代理评审；首轮 4 页 fail 的 8 项问题（空缺列/轴刻度重叠/日历不可读/热力行序/样条假归零/B-M 混排/跨图配色/胶囊对比度）全部修复并复验通过 |

## 五、红蓝对抗审计（循环结论：通过）

- **红队（第 1 轮）**：16 项发现 —— 1×P0（ZCode 增量游标永久漏行，实测已丢 343 万 input tokens）、3×P1（会话双计 2 倍、reasoning 双计、codex 会话 id 畸形回退）、12×P2（启动失败静默、openPath 防御、busy_timeout、主题 system 歧义、单实例锁、配色跨面板不一致、死数据通道等）。结论：不放行。
- **修复**：提交 `083dfa1` 全量修复 P0/P1/P2，并补齐立项书缺口（月/年范围、retentionDays）。
- **蓝队（第 2 轮）**：14/14 逐项复核 ✓（含 N-01 三循环游标推进与 upsert 幂等专项回归、13/13 动态探针、typecheck/冒烟通过，无修复引入的新缺陷）。结论：**放行**。
- **遗留（P3，不阻断）**：F1 单毫秒 >5000 行的理论分页墙（实际数据分布不可触发，且 24h 重叠窗可自愈）；F2 antigravity 会话查询超 2 万行时 LIMIT 截断（预存在，建议补 ORDER BY）；F4 codex 存量被旧正则污染的历史 session id 无迁移（新数据已正确）。
- **安全声明**：本报告不做"项目安全"的整体断言（Mimosa 完整扫描因仓库规模限制未出全量结论）；已落实的防线为：外部库只读打开 + 参数绑定 SQL（无注入面）+ contextIsolation/sandbox + 单实例锁 + showItemInFolder 降级 + CSP 决策记录（file:// 下 'self' 误伤自身脚本，故不设 meta CSP，渲染层不加载任何远程内容）。

## 六、运行与验证命令

```bash
npm install
npm run dev        # 开发
npm run dist       # 打包 NSIS + 便携 exe（release/）
npx electron out/main/smoke.js          # 冒烟
NEXUS_CAPTURE=out/board.png npm start   # 看板自动截图（视觉验收辅助）
```

## 七、后续路线（建议）

1. 会话数趋势图、Token 燃烧速率仪表、趋势预测（立项书 §3.2 扩展项）
2. Codex 存量 session id 一次性迁移（F4）与 antigravity ORDER BY 补齐（F2）
3. 设置页（主题/保留天数/适配器开关的 UI 化，当前 retentionDays 经 settings 表配置）
4. macOS 打包（立项书远期）；桑基图/雷达图
