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

1. **Trae 配额读取（代码就绪待数据）**：凭据/配额在 Trae IDE state.vscdb（键 iCubeAuthInfo://icube.cloudide / iCubeEntitlementInfo://icube.cloudide，trae_account_core_platform_storage.rs:24-28），DPAPI 链助手已落地（quotas/dpapi.ts：Local State os_crypt → PowerShell ProtectedData → AES-256-GCM v10）——本机 Trae 未留 state.vscdb，装 Trae 并登录后按 Qoder 同款接入。
2. **Qoder 实机验证**：DPAPI 本地读取已实现（secret://aicoding.auth.creditUsage），本机无 state.vscdb；装有 Qoder 并登录的机器上自动生效。
3. **Antigravity CloudCode 多步流程**：需 cockpit 凭据（加密信封）或自建 OAuth，暂以会话元数据 + Cockpit 网关提示覆盖。
4. Qoder openapi 配额窗口字段（token 已有效，待官方暴露）。


## 附：手机端 VPN 内嵌（wireguard-android 源码集成）状态与步骤

> 状态：源码已拉取（gh-proxy 镜像 → WireGuard/wireguard-android master，tunnel 模块
> 位于 apps/mobile/wireguard-android-src/tunnel/，已 gitignore）；依赖声明/服务类/Manifest
> 三处骨架就位但**禁用**（见 apps/mobile 内注释）。
> 本机被墙点：repo.wireguard.org（库 maven 仓）已绕开（源码集成），但
> **CMake 构建 libwg-go.so 需要 NDK + CMake + Go 拉取 wireguard-go 依赖**（go proxy 可达）。

集成步骤（下一批专做）：
1. settings.gradle：include ':tunnel'；gradle.properties：wireguardPackageName=app.nexus.mobile。
2. 根 build.gradle：tunnel 模块用 version catalog（libs.plugins.android.library）——需把
   wireguard-android-src/gradle/ 与 libs.versions.toml 合并进主工程，或把模块改写为
   传统 build.gradle（去除 version catalog 依赖，工作量小）。
3. 安装 NDK + CMake（Android Studio SDK Manager 或 sdkmanager "ndk;26.x" "cmake;3.22"）。
4. 恢复 app 依赖：implementation project(':tunnel')（替换注释掉的 maven 依赖行）。
5. 恢复 NexusVpnService.kt（.disabled → .kt）与 Manifest service 声明（注释已就位）。
6. PC 侧：sidecar 增加 WireGuard 服务端（golang.zx2c4.com/wireguard 或 tailscaled
   wg-listen），生成服务器/客户端密钥对，Nexus 设置面板下发手机配置（私钥/PC公钥/端点）。
7. apk 构建：cd apps/mobile/android && gradlew assembleDebug（CMake 首次构建 libwg-go 约 5-10 分钟）。

注意：tunnel 模块 build.gradle.kts 要求 compileSdk 36 + AGP 兼容（当前主工程 AGP 8.2.1 /
compileSdk 34）——要么升级主工程 compileSdk 至 36，要么将模块 compileSdk 降至 34（源码兼容性待验证）。

## 附2：集成进展（本批）

- tunnel 模块已挂载主工程：settings.gradle include + gradle.properties(wireguardPackageName) +
  模块 compileSdk 36→34、去除 version catalog/maven-publish 依赖（传统 build.gradle 化）
- app 依赖切换 implementation project(':tunnel')；NexusVpnService.kt/Manifest 已恢复
- assembleDebug BUILD SUCCESSFUL；**遗留：libwg-go.so 未打入 apk**
  （externalNativeBuild 未触发，apk 内无 .so；当前版本未暴露 VPN 开关故无运行时影响）
- 下批首项：clean 后强制 externalNativeBuild（验证 NDK+CMake 构建 libwg-go.so），
  再接 GoBackend.setState 与设置面板 VPN 开关
