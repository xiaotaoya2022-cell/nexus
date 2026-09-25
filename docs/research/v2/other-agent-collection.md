# 其他 Agent 采集源调研报告（cockpit-tools 源码分析）

> 调研人：主线 AI ｜ 时间：2026-09-25 04:10:00 ｜ 依据：用户提供的本地源码 `F:\cockpit-tools-main`
> 项目身份：**cockpit-tools**（GitHub `jlcodes99/cockpit-tools`，本机源码版本 v1.3.59，Tauri 2 + React + Rust core `crates/cockpit-core` + Go sidecar `sidecars/cockpit-cliproxy`）
> 支持平台（README）：Antigravity IDE、Codex、GitHub Copilot、Windsurf、Kiro、Cursor、Grok CLI、CodeBuddy、CodeBuddy CN、Qoder、Trae、TRAE SOLO、Trae CN、TRAE SOLO CN、Zed、**ZCode** —— 共 16 平台的账号管理/多开/配额监控

## 一、cockpit-tools 的两类数据是怎么拿的（源码证据）

### 1. Codex token 级用量 = 本地网关中继（`request_logs` 的来源）

- Rust 侧 `src-tauri/src/modules/codex_local_access*.rs` 管理"**API 服务**"（UI 名称，locale key `.codex.localAccess.title = API 服务`，开关 `.codex.localAccess.enableService = 启用服务`）。
- 开启后由 Go sidecar `cockpit-cliproxy`（`relay_server.go` / `provider_gateway.go`）在本地端口监听（配置文件里 `port`，本机 60634），把 Codex 的 API 流量重定向到网关并中继上游。
- 每个请求的 token/成本由 Rust 侧写入 `~/.antigravity_cockpit/codex_local_access_logs.sqlite` 的 `request_logs`（建表语句见 `codex_local_access_request_logs.rs:151`）。
- 网关配置存于 `~/.antigravity_cockpit/codex_local_access.json`：本机实测 `enabled: false`（所以 request_logs 当前 0 行）、`gatewayMode: "sidecar"`、`accessScope: "localhost"`。
- **结论：Nexus 的 antigravity 适配器已经在读 request_logs——用户在 Cockpit 的「API 服务」页点「启用服务」后，Codex 用量自动接入 Nexus，零代码增量。**

### 2. 各平台配额监控 = cockpit 自己做 OAuth，再用登录态调平台 API

- `crates/cockpit-core/src/modules/` 下每平台一组 `*_oauth.rs / *_account.rs / *_instance.rs`（codebuddy、codebuddy_cn、qoder、trae、workbuddy、cursor、windsurf、zed、github_copilot、codex、antigravity 等），OAuth 凭据由 cockpit 管理并存放在 `~/.antigravity_cockpit/` 的账号文件（**含 token，Nexus 不读**）。
- 拉配额的端点证据（源码内常量）：
  - Codex：`codex_quota.rs:7 → https://chatgpt.com/backend-api/wham/usage`
  - Antigravity：`quota.rs:10-13 → https://cloudcode-pa.googleapis.com`（prod/daily/autopush 三套 CloudCode 端点，伪装官方 IDE UA/metadata）
  - CodeBuddy CN：`codebuddy_cn_oauth.rs:8 → https://www.codebuddy.cn`
  - 其余平台同理各自有 API 端点 + 配额字段（`qoder_account.rs` 有 `quota_query_last_error` 等字段）。
- 配额结果缓存：`quota_cache.rs:11 → data_dir/cache/quota_api_v1_desktop/<source>/<hash(email)>.json`（本机现有 `authorized/` 下 2 个文件，内容为 Antigravity 模型清单/配额类 payload）。

## 二、Nexus 的分工决策（不做 16 家 OAuth）

在 Nexus 里复刻 16 个平台的 OAuth + 配额 API 是一个持续对抗版本演进的巨型维护面（cockpit 自己也在频繁适配）。**分工定案：cockpit-tools 做"账号/登录态/配额"引擎，Nexus 做"本机 token 用量的聚合与可视化"**：

| 路径 | 结论 | 状态 |
| --- | --- | --- |
| A. cockpit `request_logs`（Codex token 级） | 零成本接入：Nexus 适配器已就绪，用户启用「API 服务」即生效 | ✅ 本轮加"状态感知 + 精确引导"（见 §三） |
| B. 读 cockpit 配额缓存（`cache/quota_api_v1_desktop/`） | 可行但注意：账号记录文件混有凭据；缓存目录仅配额/模型数据。可作为"各账号剩余配额"面板的数据源（P2，需 cockpit 在运行且拉过配额） | 🕒 后续（先做 A 验证链路） |
| C. Nexus 自研本地网关（仿 cockpit-cliproxy 采集 ZCode） | ZCode 的 provider 配置支持自定义 baseUrl，技术上可行；但 Go/Rust 网关 + 协议适配 + 证书问题 ≈ 5-8 人日，且 ZCode 已有本地 `model_usage` 精确数据——收益仅覆盖"多实例归属"一个点 | ⏸ 暂缓（记录于路线图） |
| D. Nexus 直接实现各平台 OAuth | 反对该路线：凭据保管责任重、端点随版本漂移、cockpit 已做得更好 | ⏸ 不做 |

## 三、本轮落地（代码）

1. **Cockpit 感知桥**（`src/main/modules/cockpit/bridge.ts`）：
   - 只读 `codex_local_access.json` 的**白名单字段**（`enabled/port/gatewayMode`，凭据字段不触碰）+ `request_logs` 行数（只读 COUNT，5s 缓存）。
2. **侧栏精确引导**（`ipc/register.ts` buildAgentInfos）：Antigravity 的 note 动态化——
   - 网关已启用且有数据 → 正常显示最近活动；
   - 已启用无流量 → "Cockpit API 服务已启用 · 产生流量后自动接入"；
   - 未启用 → "Cockpit 已装 · 在其「API 服务」页启用服务后自动接入"。
3. 用户操作指引：**打开 Cockpit Tools → Codex → API 服务页 → 启用服务**（其后 Codex 的每个请求 token/成本都会进入 request_logs，Nexus 60s 内自动同步上板）。

## 四、各平台采集结论表（Nexus 视角）

| 平台 | token 用量 | 配额/余额 | 结论 |
| --- | --- | --- | --- |
| ZCode | ✅ 本地 `model_usage`（已接入，最快最准） | cockpit 可查套餐配额 | 维持现状 |
| Codex | ✅ 本地 JSONL（已接入）＋ cockpit 网关 request_logs（启用即接入，含成本字段） | cockpit 拉取 | A 路径引导 |
| Claude Code | ✅ 本地 JSONL（适配器就绪，产生数据即接入） | — | 维持现状 |
| Antigravity | ❌ protobuf（不可行） | cockpit CloudCode API | 仅会话元数据（已接入） |
| CodeBuddy/CN | ❌ 云端 | cockpit OAuth（codebuddy.cn API） | B 路径 P2 |
| Qoder | ❌ 云端 | cockpit OAuth | B 路径 P2 |
| Trae/SOLO | ❌ 云端 | cockpit OAuth | B 路径 P2 |
| WorkBuddy | ❌ 云端 | cockpit OAuth | B 路径 P2 |
| Cursor | ❌ 服务端 | cockpit OAuth；本地另有 ai-code-tracking.db（代码行维度，非 token） | B 路径 P2 |
| Windsurf/Kiro/Zed/Copilot/Grok | ❌（Nexus 未接） | cockpit OAuth | B 路径 P2（如需） |

## 五、后续路线

1. P2：读 cockpit 配额缓存 JSON（`cache/quota_api_v1_desktop/`，白名单解析，只取配额字段），在 Nexus 加"账号配额"面板（依赖 cockpit 运行中）。
2. P2：request_logs 有数据后，把 `estimated_cost_usd` 等成本字段接入 Nexus 成本估算（替代/校准公开牌价估算）。
3. 记录：cockpit 的多开实例（`instances/zcode/<id>/electron`）与本模块实例发现的对接点。
