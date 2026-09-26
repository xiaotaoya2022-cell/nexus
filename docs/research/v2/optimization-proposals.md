# Nexus 优化与增强提案清单 v1

> 产出时间：2026-09-26 ｜ 依据：四维并行审计（安全/正确性/性能/UX）+ 主线通读
> 状态口径：✅ 本轮已修 / 🔜 提案（≥30 条，按优先级排序）

## 一、本轮审计已修复（7 项，commit 7311a1e）

1. ✅ Codex token 口径归一（total_tokens 判别，消除 564 万双计喵）
2. ✅ reload 并发竞态守卫喵
3. ✅ getTrend groupBy 白名单喵
4. ✅ 导航锁定（will-navigate + setWindowOpenHandler）喵
5. ✅ WS 未鉴权 60s 超时喵
6. ✅ retention 清理事务化喵
7. ✅ dsh.* 成功审计 + 错误不外泄喵

## 二、优化/增强提案（32 条）

### A. 修复类（审计遗留，P2 喵）
1. 🔜 Codex 存量双计修正 SQL（迁移语句，随下批）喵
2. 🔜 codex meta 清理（文件不存在时回收 offsets/models/sessionIds）喵
3. 🔜 codex 文件截断检测（offset>size 归零重读）喵
4. 🔜 zcode session 分页 keyset 化（同 usage 的 ts+id 双键喵）
5. 🔜 antigravity 无时间戳行保留落库（不丢弃）喵
6. 🔜 getSessions limit NaN 防护下沉 query-service 喵
7. 🔜 reload 失败 toast + 重试按钮喵
8. 🔜 同步失败态 UI（顶栏红点 + 每 Agent 结果展开）喵

### B. 布局/体验类（UX 审计 P1/P2 喵）
9. 🔜 首屏重排：SystemCard 压缩为单行条带（KPI 条带变体），KPI 提为第一屏喵
10. 🔜 QuotaCard 默认折叠为摘要行（"N 平台 · N 账号 · N 告警"），点击展开喵
11. 🔜 设置面板容器化：改居中模态/右抽屉（420-480px），max-h + 滚动 + 手风琴分组喵
12. 🔜 顶栏 6 pill 收纳为 3 + "更多"下拉，避让窗控区（pr-140px）喵
13. 🔜 会话明细全尺寸可达：<2xl 浮层化 + 顶栏开关；头部计数改"共 N · 显示前 120"喵
14. 🔜 配对二维码 60s 倒计时 + 过期置灰 + 重新生成；PIN 加复制按钮喵
15. 🔜 toast z-index 提升避免被面板遮挡喵
16. 🔜 SystemCard 加载韧性：shimmer 骨架 → 超时错误态 + 重试；GPU 空时隐藏整块喵
17. 🔜 单位修复：formatBytes（GB）/formatRate（KB/s）替换 SystemCard 万 MB/无单位喵
18. 🔜 已导入配额账号行加"登出/移除"入口喵
19. 🔜 全局 focus-visible 焦点环（focus-blue token 启用）喵
20. 🔜 设置面板无障碍：Esc 关闭 + X 按钮 + aria-modal + backdrop 半透明喵
21. 🔜 QuotaCard 色阶读取告警阈值设置（联动）喵
22. 🔜 planLabel 徽章改中性配色（紫色仅限空闲语义）喵
23. 🔜 主题设置加"跟随系统"项喵
24. 🔜 LegendItem/KPI sub 数值段补 font-mono tabular-nums 与千分位喵

### C. 功能增强类（新能力喵）
25. 🔜 DSH 反控按钮进实例/设置页（prompt 下发/会话取消，桥已就绪）喵
26. 🔜 Tailscale 内嵌引擎接线 UI（启用开关/登录/IP 展示，探测模块已就绪）喵
27. 🔜 远程审计日志查看入口（设置内 jsonl 查看器）喵
28. 🔜 数据保留"立即清理"按钮（联动 retention 设置）喵
29. 🔜 getCalendar 通道复用：月度热力视图（通道已保留）喵
30. 🔜 Cursor 代码行维度接入（ai-code-tracking.db，产出指标补充）喵
31. 🔜 Qoder 设备码登录补全（openapi 轮询已就绪，登录页流程固化）喵
32. 🔜 性能护栏：getSessions 物化视图（50 万行级预案）+ data 分通道刷新喵

### D. 战略项（记录喵）
33. 🔜 WireGuard 手机内嵌启用（网络恢复后三步，见 build.gradle 注释）喵
34. 🔜 Antigravity CloudCode 多步配额移植（流程已定位）喵
35. 🔜 多实例 ZCode 归属视图（数据模型加 instance 维度，见现状报告 §六）喵
36. 🔜 CI（typecheck+smoke+截图四门自动跑）喵

## 三、已知取舍（文档化，不列为提案喵）
- WS 明文 + 0.0.0.0 绑定：鉴权设计使嗅探无凭据收益，跨网推荐 Tailscale 喵
- 手机端 token localStorage：应用沙箱内 + allowBackup=false 喵
- cockpit 凭据信封不读：Nexus 只消费其 request_logs 产物喵
