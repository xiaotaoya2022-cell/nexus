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
| **codex** | `~/.codex/auth.json`（OAuth tokens 或 OPENAI_API_KEY） | GET `https://chatgpt.com/backend-api/wham/usage` + Bearer + 可选 ChatGPT-Account-Id（codex_quota.rs:10,141） | plan_type + rate_limit.primary/secondary_window（used_percent/reset_at/reset_after_seconds） | ✅ 完整移植。**应用内 OAuth 已实现**：PKCE S256 + 动态端口回环 + client_id `app_EMoamEEZ73f0CkXaXp7hrann`（codex_oauth.rs:16-19,123,543,603）+ refresh_token 刷新回写会话 |
| **cursor** | `%APPDATA%/Cursor/User/globalStorage/state.vscdb` ItemTable：cursorAuth/accessToken + cachedEmail（cursor_account.rs read_local_cursor_auth） | GET `https://cursor.com/api/usage-summary` + Cookie `WorkosCursorSessionToken=<jwt>::<sub>`（:1335,1426,1652） | individualUsage.plan.totalPercentUsed / autoPercentUsed / apiPercentUsed（read_usage_percent:1900）+ membershipType | ✅ 完整移植。**本机实测：成功自动导入账号 xiaotaoya2022@gmail.com**，上游返回 401（会话过期，真实状态——在 Cursor 内重新登录后即出数据） |
| **codebuddy-cn** | 无明文本地凭据（云端/加密） | POST `https://www.codebuddy.cn/v2/billing/meter/get-user-resource`（codebuddy_cn_oauth.rs:899），body ProductCode=p_tcaca 等 | data.resources/...Accounts → CycleCapacitySize/Remain/Used + PackageName + CycleResetTime | ✅ fetch + **应用内 OAuth 登录完整移植**：POST /v2/plugin/auth/state?platform=ide（:173）→ 打开浏览器 → 轮询 GET /v2/plugin/auth/token?state=（:275，1.5s 间隔 :16） |
| qoder | 无（云端；IDE 配额存 DPAPI 加密的 secret storage，vscode_inject 路线，下批） | openapi.qoder.sh（qoder_oauth.rs:19-20，设备码登录） | — | ⏳ 下一批 |
| trae | 无（cockpit 账号信封加密） | grow-normal.trae.ai 等平台 API（trae_account_platform_storage.rs:184-187） | — | ⏳ 下一批 |
| workbuddy | 无（cockpit 账号信封加密） | API=https://copilot.tencent.com（workbuddy_oauth.rs:7）；用量路径待定位 | — | ⏳ 下一批 |
| antigravity | 无 | cloudcode-pa.googleapis.com（quota.rs:10-13）+ loadCodeAssist/projectId/mainline 多步流程 | — | ⏳ 下一批（流程最重） |

## 运行链路（已验证）

```
启动 → engine.startPolling()（首轮 3s 后，之后每 5min）
  → 每平台：OAuth 会话（quotas-auth.json）+ discoverLocalCredentials()
  → fetchQuota（Electron net.fetch，走系统代理，20s 超时）
     ↳ 401/403 且有 refresh_token → refreshCredential 重试一次并回写会话
  → 视图（无凭据）→ quotas-cache.json 落盘 + webContents.send('nexus:quota-update') + remote push 'quota'
  → 告警：窗口 usedPercent ≥90% warn / ≥100% error → 系统通知 + remote push 'alert'
     （同账号同窗口 6h 去重，checkAlerts）
UI：看板「账号配额」卡（订阅推送实时更新）+ 设置「账号与配额」（支持登录的平台显示登录按钮）
```

## OAuth 登录（本轮新增，应用内完成）

- **通用回环助手**（quotas/oauth.ts）：随机端口 127.0.0.1 回调服务器 + shell.openExternal + state 校验 + 授权页中性文案；返回 {code, redirectUri}（令牌交换必须用与授权一致的 redirect_uri）。
- **Codex**：PKCE（S256）+ build_auth_url 参数与 cockpit codex_oauth.rs:543 逐项一致；授权码换 token（form：grant_type/code/redirect_uri/client_id/code_verifier）；refresh 分支回写 engine 会话。
- **CodeBuddy CN**：auth/state → 浏览器 → 1.5s 轮询 auth/token（完整登录会话内置 5min 超时）。
- 登录入口：设置 → 账号与配额 → 各平台「登录」按钮（仅 oauthSupported 的平台显示）。

本机实测（2026-09-25）：Cursor 自动导入账号成功（401 过期如实显示）；Codex API Key 被 wham/usage 拒绝属预期（该端点需订阅 OAuth 态，登录按钮即为此准备）。错误以橙色警示行展示在对应账号下，不污染其他数据。

## 下一批

1. Qoder：设备码登录（openapi.qoder.sh deviceauth 流程）+ DPAPI secret storage 读取路线评估。
2. Trae/WorkBuddy：配额端点在 cockpit 源码中的精确定位（grow.trae.ai / copilot.tencent.com 已知域名）。
3. Antigravity CloudCode 多步配额流程移植。
4. 配额告警阈值可配置（settings.quotaAlertThreshold）。
