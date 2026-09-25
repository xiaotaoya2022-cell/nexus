# 配额集成规格（Nexus 原生实现）

> 依据：cockpit-tools 本地源码（F:\cockpit-tools-main，v1.3.59）逐文件移植 ｜ 2026-09-25
> 架构：`modules/quotas/` —— types.ts（平台契约）+ engine.ts（凭据存储/轮询/缓存/推送）+ http.ts（Electron net.fetch，走系统代理）+ platforms/*（每平台一个集成文件）+ platforms/registry.ts

## 凭据模型（两条来源，一条红线）

1. **本地导入**：轮询时读取各 Agent 官方本地存储中的登录态（只读），**仅在内存使用，绝不写入 Nexus 任何文件**。
2. **应用内 OAuth**：engine 持久化到 `userData/quotas-auth.json`（chmod 600 尽力而为）；设置面板「账号与配额」触发 `quotaLogin`。
3. 红线：cockpit 自身的账号文件是**加密信封**（accounts/*.json：algorithm/key_id/nonce/ciphertext），不可读也不读；视图/缓存/日志永不含 token。

## 平台契约与状态

| 平台 | 本地凭据发现 | 配额端点（证据：cockpit 文件:行） | 解析 | 状态 |
| --- | --- | --- | --- | --- |
| **codex** | `~/.codex/auth.json`（OAuth tokens 或 OPENAI_API_KEY） | GET `https://chatgpt.com/backend-api/wham/usage` + Bearer + 可选 ChatGPT-Account-Id（codex_quota.rs:10,141） | plan_type + rate_limit.primary/secondary_window（used_percent/reset_at/reset_after_seconds） | ✅ 完整移植。本机实测：发现 API Key → 上游需 OAuth 态，且该域走系统代理后超时（错误行如实显示） |
| **cursor** | `%APPDATA%/Cursor/User/globalStorage/state.vscdb` ItemTable：cursorAuth/accessToken + cachedEmail（cursor_account.rs read_local_cursor_auth） | GET `https://cursor.com/api/usage-summary` + Cookie `WorkosCursorSessionToken=<jwt>::<sub>`（:1335,1426,1652） | individualUsage.plan.totalPercentUsed / autoPercentUsed / apiPercentUsed（read_usage_percent:1900）+ membershipType | ✅ 完整移植。**本机实测：成功自动导入账号 xiaotaoya2022@gmail.com**，上游返回 401（会话过期，真实状态——在 Cursor 内重新登录后即出数据） |
| **codebuddy-cn** | 无明文本地凭据（云端/加密）——待应用内 OAuth | POST `https://www.codebuddy.cn/v2/billing/meter/get-user-resource`（codebuddy_cn_oauth.rs:899），body ProductCode=p_tcaca 等 | data.resources/...Accounts → CycleCapacitySize/Remain/Used + PackageName + CycleResetTime | ✅ fetch 移植完成，等凭据 |
| qoder | 无（云端） | openapi.qoder.sh（qoder_oauth.rs:19-20，设备码登录）；专用配额端点待定位 | — | ⏳ 下一批 |
| trae | 无（加密/平台存储） | 待定位（trae_account* 模块） | — | ⏳ 下一批 |
| workbuddy | 无 | API=https://copilot.tencent.com（workbuddy_oauth.rs:7）；用量路径待定位 | — | ⏳ 下一批 |
| antigravity | 无（cockpit 经 CloudCode 伪装官方 IDE） | cloudcode-pa.googleapis.com（quota.rs:10-13）+ loadCodeAssist/projectId/mainline 多步流程 | — | ⏳ 下一批（流程最重） |

## 运行链路（已验证）

```
启动 → engine.startPolling()（首轮 3s 后，之后每 5min）
  → 每平台：OAuth 会话（quotas-auth.json）+ discoverLocalCredentials()
  → fetchQuota（Electron net.fetch，走系统代理，20s 超时）
  → 视图（无凭据）→ quotas-cache.json 落盘 + webContents.send('nexus:quota-update') + remote push 'quota'
UI：看板「账号配额」卡（订阅推送实时更新）+ 设置「账号与配额」（登录按钮/账号数）
```

本机实测（2026-09-25）：Cursor 自动导入账号成功（401 过期如实显示）；Codex API Key 被 wham/usage 拒绝属预期（该端点需订阅 OAuth 态）。错误以橙色警示行展示在对应账号下，不污染其他数据。

## 下一批（按价值排序）

1. **应用内 OAuth 登录**：移植 cockpit `codex_oauth.rs`（PKCE+回环）与 `codebuddy_cn_oauth.rs` 登录流程 → 引擎 oauthLogin 已就位，平台补 start 实现。
2. antigravity CloudCode 配额（多步流程移植）。
3. qoder/trae/workbuddy 配额端点定位移植。
4. 配额数据接告警引擎（预算/超限通知，remote alert 通道已就绪）。
