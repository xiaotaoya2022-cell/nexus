# 混合通信架构设计草案（Nexus v2 · 任务四交付二）

| 项 | 内容 |
|---|---|
| 文档 | 《混合通信架构设计草案》 |
| 版本 | v1.0（草案，供 Phase 1 实现前评审） |
| 日期 | 2026-09-25 |
| 作者 | 子代理 T4 |
| 前置 | 《通信方案调研报告》（同目录），结论：主通道=局域网 WS 直连，备通道=Tailscale |
| 原则 | 遵守指导书§零（单一 exe/apk、零手动配置）与§七（配对/加密/审计） |

---

## 1. 设计目标与非目标

**目标**

- G1 局域网内手机开 App 即可发现并连接 PC，首次配对 ≤ 60 秒（扫码 + 一次确认）。
- G2 指令端到端体感延迟 < 500ms（LAN 内目标 < 50ms）；数据推送 1s 级。
- G3 未配对设备无法获得任何数据；已配对设备可被单独撤销授权。
- G4 全部远控指令落审计日志（谁、何时、对哪个实例、什么指令、结果）。
- G5 PC 端零常驻外部服务：通信服务内嵌于 Electron 主进程，随 App 生死。
- G6 断网/休眠/切网恢复后 10 秒内自动回到可用状态。

**非目标（v2 明确不做）**

- 不做音视频/屏幕串流通道（未来如做，再评估 WebRTC 媒体面）。
- 不做自研 NAT 打洞与自建中继服务器（RustDesk 式 hbbs/hbbr 属 v3+ 议题）。
- 不做公共 MQTT/云转发（数据不出用户控制范围）。
- 不做多用户/多租户权限体系（单用户，设备级权限二分：只读 / 只读+控制）。
- 不做 iOS（本期仅 Android；协议信封保持平台中立以便未来扩展）。

---

## 2. 总体拓扑：主通道 + 备通道组合

```
                        ┌─────────────────────────────────────────────┐
                        │              PC（Windows，单一 .exe）         │
                        │  Electron 41 主进程（Node）                   │
                        │  ┌───────────────────────────────────────┐  │
                        │  │ remote-server（内嵌）                  │  │
                        │  │  · HTTPS/WSS + WS（Hono 或裸 ws）      │  │
                        │  │  · 绑定 0.0.0.0:随机端口(port 0 分配)   │  │
                        │  │  · mDNS 广播 _nexus._tcp (port,id,fp)  │  │
                        │  │  · 配对/会话/订阅/指令/审计 五个处理器    │  │
                        │  └───────────┬───────────────────────────┘  │
                        │   zcode-manager│ remote-control             │
                        │  （多实例识别/控制，本机内对接 T2 结论）        │
                        └───────────────┼─────────────────────────────┘
              ①主通道：LAN WSS 直连      │            ②备通道：Tailscale 虚拟网
        （mDNS 发现 + QR 兜底配对）      │        （同一套 WS 协议原样复用）
                        │               │               │
        ┌───────────────┴───────────────┴───────────────┴──────────────┐
        │                     Android（单一 .apk）                      │
        │   connection 模块：NSD 发现 → 扫码/手动输入 → WSS 连接          │
        │   （Android 16+ 需运行时申请 local network 权限，拒绝则降级）    │
        └───────────────────────────────────────────────────────────────┘
```

**通道组合逻辑**

| 场景 | 通道 | 说明 |
|---|---|---|
| 手机与 PC 同一家庭 Wi-Fi | **主通道**：`wss://<PC-LAN-IP>:<随机端口>` | mDNS 自动发现；失败（AP 隔离/访客网/跨 VLAN）时扫 PC 上的二维码或手动输入 `IP:端口` |
| 手机在外（蜂窝网）/ PC 被带出门 | **备通道**：PC 与手机均已登录 Tailscale，连 `wss://<tailnet-IP或MagicDNS名>:<同一端口>` | 协议、令牌、审计**完全复用**，仅目标地址不同；App 内在"连接"页提供 Tailscale 引导与地址簿 |
| 两台设备都不在线 | — | 无通道，不引入任何云存储兜底（v2 不做"多设备同步"的云端路径） |

设计要点：**备通道不是另一套协议**。Tailscale 只是让"公网地址"变成"另一个可达的局域网地址"，WS server 本来就监听所有接口，应用层（配对、令牌、信封、审计）在两条通道上零差异——这是对比 RustDesk/公网 MQTT 后最省维护成本的组合（依据见调研报告 §1.5/§1.2）。

---

## 3. 消息流全链路（发现 → 配对 → 鉴权 → 订阅推送 → 指令下发 → 审计）

### 3.0 状态总览

```
[手机未配对] --扫码/NSD--> [发现PC] --PIN握手--> [已配对(设备信任)]
     --长期令牌--> [已鉴权会话] --订阅--> [数据推送中] --指令--> [远控执行+审计]
```

### 3.1 阶段一：发现（Discovery）

1. PC 启动 remote-server：绑定 `0.0.0.0` 的**随机端口**（`server.listen(0)`），生成/加载本机身份密钥对（Ed25519，存于 Electron `userData`）。
2. PC 通过 mDNS（`bonjour-service`）广播 `_nexus._tcp.local`，TXT 记录携带：`port`、`id`（PC 实例 ID=公钥指纹前 16 hex）、`fp`（自签证书 SPKI SHA-256）、`v`（协议版本）。
3. 手机 App 用系统 `NsdManager` 发现 `_nexus._tcp`（Android 13+ 对 `.local` 解析有平台支持；Android 16+ 需先获得 local network 运行时权限，未授权时跳过 NSD 直接走扫码）。
4. **兜底路径（第一公民）**：PC 设置页常驻展示二维码，内容：
   ```
   nexus://pair?v=1&id=<pcId>&host=<LAN IP>&port=<port>&fp=<certFp>&pin=<6位随机PIN>
   ```
   - mDNS 一旦失效（AP 隔离、访客网、多 VLAN——调研报告 §1.1 风险 3），扫码路径完全独立可用；
   - 已配对设备还可在手机"地址簿"直接选历史主机（含 tailnet 地址）。

### 3.2 阶段二：配对（Pairing，借鉴 Moonlight + SPAKE2）

1. 手机扫 QR（或 NSD 发现后手动触发配对），向 PC 发起 WSS 连接，**校验证书指纹 == QR/ TXT 中的 `fp`**（证书固定，防中间人——RustDesk/Moonlight 同款思想）。
2. 连接后进入一次性 `pair` 通道，执行 PIN 派生握手（SPAKE2 思路的最小实现）：
   - 双方以 QR 中的 6 位 PIN（PC 每 60 秒轮换；QR 失效即作废）为低熵输入，`Argon2id(PIN, salt)` 派生 32 字节临时密钥；
   - 手机发送 `{nonce_c, HMAC(k, nonce_c || pcId)}`；PC 校验后回 `{nonce_p, HMAC(k, nonce_p || deviceId)}`；手机校验——任一侧 PIN 不对即失败，连续 5 次失败锁定 5 分钟（抗在线爆破）；
   - 成功后双方用 HKDF(k, 双方 nonce) 派生 `deviceSecret`。
3. PC 弹出确认对话框："允许 xxx 设备控制本机？[只读 / 读写 / 拒绝]"（权限在配对时定级，事后可改）。
4. PC 持久化设备记录：`deviceId`（手机生成的密钥对公钥指纹）、`name`、`permission`、`pairedAt`、`deviceSecret`；手机保存 `pcId` 与 `deviceSecret`。**配对一次，长期信任**（Moonlight 证书信任模式）。

### 3.3 阶段三：鉴权（Session Auth，借鉴 Home Assistant）

1. 日常连接不再走配对：手机连 WSS 后**第一帧**发：
   ```json
   {"v":1,"type":"auth","id":"a1","ts":...,"payload":{"deviceId":"...","token":"<长期令牌>"}}
   ```
2. PC 校验 `deviceId` 在白名单且 token 有效 → 回 `{"type":"res","ok":true}`，会话建立；否则显式 401 语义并断开（HA 的 auth-首帧语义）。
3. **长期令牌**：配对成功时 PC 用 `deviceSecret` 派生并签发设备令牌（永不过期但**可撤销**、可单设备删除；每次连接与每条指令都挂 deviceId，天然可审计）。手机丢失时，PC 设置页一键撤销。

### 3.4 阶段四：订阅推送（Push，借鉴 Netdata）

1. 会话建立后手机按需订阅：
   ```json
   {"type":"req","ch":"sub","payload":{"topics":["agent.stats","system.stats"],"intervalMs":1000}}
   ```
2. PC 采集层（agent-collector / system-collector）每秒产出快照，**按 topic 聚合、节流、permessage-deflate 压缩**后以 `event` 帧推送；未订阅不推（省电）。
3. 告警在 PC 侧评估（Netdata"告警在 parent 评估"思想），只推结论事件 `alert.triggered`，不在手机算。
4. 历史查询（趋势/账单页）走一次性 `req/res`：`{"ch":"history","payload":{"metric":"tokens","from":...,"to":...,"bucket":"1h"}}`。

### 3.5 阶段五：指令下发（Control，RPC 语义）

1. 手机发请求帧（requestId 关联，`@zcode/rpc` 风格）：
   ```json
   {"type":"req","ch":"zcode.control","id":"r42","payload":{"op":"stop","target":"zcode-3"}}
   ```
2. PC 端指令流水线：**权限检查（设备 permission）→ 指令白名单检查 → 写审计（状态=received）→ 执行 → 写审计（状态=ok/err）→ 回 `res` 帧携带结果/输出片段**。
3. 白名单操作集（v2，仅 ZCode / DeepSeek Harness）：`status / list-instances / start / stop / restart / get-output`；其他 Agent 仅占位。长输出走分页 `get-output {cursor}`，不建长连通道。
4. 执行结果超时（2s）即回 `{"ok":false,"err":"TIMEOUT"}`；不做服务端排队重试（远控指令重试语义危险，由用户手动重发）。

### 3.6 阶段六：审计（Audit）

- PC 端 SQLite 表 `audit_log(id, ts, deviceId, deviceName, channel, op, target, paramsJson, result, latencyMs)`；手机端"操作历史"页经 `ch:"audit"` 只读查询。
- 审计与推送解耦：审计写盘失败时指令拒绝执行（安全优先于可用）。

---

## 4. 消息信封格式（Envelope v1）

所有帧共用一个信封；字段固定顺序参与签名，保证前向兼容（未知字段忽略，`v` 升版协商）。

```jsonc
{
  "v": 1,                          // 协议版本，整数
  "type": "req",                   // req | res | event | auth | ping | pong
  "id": "r42",                     // req/res: 请求ID（回包携带同 id）；event: 单调递增 seq
  "ch": "zcode.control",           // 通道：pair | auth | sub | agent.stats | system.stats
                                   //      | history | zcode.control | harness.control | audit
  "ts": 1769328000123,             // 发送方 epoch 毫秒
  "payload": { },                  // 各通道自定义，Zod schema 校验，两端共享定义
  "sig": null                      // 可选：HMAC-SHA256(deviceSecret, "v1|type|id|ts|ch|payloadJson")
                                   //       v2 仅对 zcode.control / harness.control 强制签名
}
```

约定：

- **type 与 id 配对**：`req` 必有 `res`（成功 `payload.ok:true`，失败 `payload.ok:false, err:"CODE"`）；`event` 无回执但 `id` 为每连接单调递增 seq，重连对账用。
- **错误码表**（`payload.err`）：`AUTH_REQUIRED / AUTH_DENIED / DEVICE_REVOKED / NO_PERM / BAD_SCHEMA / UNKNOWN_OP / TARGET_NOT_FOUND / TIMEOUT / INTERNAL`。
- **心跳**：PC 每 30s 发 `ping`，手机 10s 内未回 `pong` 即判死重连；手机侧反之亦然（websocket.org 推荐间隔与超时窗口）。
- **大小上限**：单帧 payload ≤ 256KB（get-output 分页保证），超限拒绝，防滥用。

---

## 5. 端口占用与 Windows 防火墙问题（专项评估）

### 5.1 端口占用

- **方案**：`server.listen(0)` 让 OS 分配随机端口 → 绝不与既有服务冲突；真实端口写进 mDNS TXT 与二维码（`port` 字段），手机**永远不需要知道"约定端口"**。
- PC 重启后端口变化：无影响——手机下次经 mDNS/扫码重新获取；已配对设备保存的是 `pcId` 而非地址，"地址簿"条目标注"自动发现/上次地址"。
- 回环保底：同一 server 额外在 `127.0.0.1:固定端口` 起一个仅本机 UI 用的副监听（环回监听不触发防火墙弹窗），供 Nexus 自身渲染层与未来本机工具复用。

### 5.2 防火墙弹窗的本质

Windows 防火墙对**非环回监听**按"可执行文件 × 网络配置档（专用/公用）"弹一次"允许访问"——与端口是否随机无关（Microsoft Learn 案例与 `New-NetFirewallRule` 文档）。Electron 打包后弹的是 Nexus 自己的 exe，用户允许后按 exe 记忆。

### 5.3 解法（三层降级）

1. **安装期预授权（首选）**：electron-builder NSIS 安装脚本以提权执行
   `New-NetFirewallRule -DisplayName "Nexus Remote" -Direction Inbound -Program "<安装目录>\Nexus.exe" -Action Allow -Profile Private,Domain`
   ——**只放行专用/域网络档，不放行公用档**（家庭 Wi-Fi 是专用档；咖啡馆公共 Wi-Fi 是公用档，默认拒绝暴露监听端口，属安全加分项）。
2. **运行期检测与引导**：主进程探测 `netsh advfirewall firewall show rule name="Nexus Remote"` 或直接自连 LAN IP 验证；失败时设置页展示"一键以管理员修复"按钮（触发一次 UAC 提升）。
3. **兜底 UX**：用户拒绝 UAC 时，依赖 Windows 原生弹窗让用户手动点"允许"（个人自用可接受），并在连接失败诊断页说明。
4. **Tailscale 备通道不受防火墙入站规则影响**：tailnet 上是出站建立的 WireGuard 隧道，无需入站放行——这也是备通道可靠的附带原因。

---

## 6. 断线重连与弱网策略

| 项 | 策略 |
|---|---|
| 死链判定 | 双向 ping/pong，30s 间隔 + 10s 超时；监听系统网络状态变化（手机 NetInfo/ConnectivityManager）网络恢复即刻主动重连 |
| 退避 | 指数退避 1s→2s→4s→…→30s 封顶，加 ±20% jitter，成功后复位（websocket.org/社区共识） |
| 数据补齐 | 重连鉴权后发 `{"ch":"sub","payload":{"since":<lastSeq>}}`；PC 若 seq 连续则补发窗口内事件，否则直接推一份当前快照（快照优先，不维护长补发队列） |
| 指令语义 | 断线瞬间的在途指令：PC 一律按"未执行即拒绝"处理（控制类操作不允许隐式重放），手机 UI 提示重发 |
| Android 后台 | 前台服务（常驻通知）保活 WS；Doze 下接受推送暂停，回前台即重连拉快照 |
| 通道切换 | Wi-Fi↔蜂窝/Tailnet 地址切换对上层透明：connection 模块按"地址簿顺序"重试（mDNS → 历史 LAN 地址 → tailnet 地址），任一成功即恢复会话 |

---

## 7. MVP 通道集合（v2 最小可行版本）

### 做（按实现顺序）

1. **WS/WSS server 内嵌 Electron 主进程**（Hono 或裸 ws + 自签证书，随机端口，loopback 副监听）。
2. **QR 配对**（二维码含 id/host/port/fp/60s PIN；PIN 派生握手 + 设备白名单 + 权限分级）。
3. **mDNS 发现**（`bonjour-service` 广播；手机 NsdManager 扫描；失败自动落扫码）。
4. **auth 首帧鉴权 + 设备长期令牌 + 撤销 UI**。
5. **订阅推送**（`agent.stats` / `system.stats` 两 topic，1s 节流，permessage-deflate）。
6. **指令 RPC**（ZCode/Harness 白名单 6 操作 + requestId + 2s 超时）。
7. **审计日志**（SQLite `audit_log` + 手机只读查询页）。
8. **心跳/退避重连 + 快照对账**。
9. **安装器防火墙规则**（NSIS `New-NetFirewallRule`，仅专用网络档）。
10. **Tailscale 兼容**（零专门代码；仅设置页引导文案 + 地址簿支持手动添加 tailnet 地址）。

### 明确不做（v2）

- WebRTC DataChannel、自研 NAT 打洞、自建中继（hbbs/hbbr 式）。
- 公共 MQTT broker / 任何云转发路径。
- gRPC/Protobuf 工具链（用 monorepo shared + Zod 替代；Android 端 kotlinx.serialization 消费同一 schema）。
- TLS CA 体系 / 域名证书（自签 + 指纹固定已满足个人自用威胁模型）。
- 蓝牙、NFC、Wi-Fi Direct 等近场通道。
- 多手机并发写（多手机只读可并发，控制权限默认仅授予一台主控设备）。

---

## 8. 风险与开放问题（移交后续阶段）

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| R1 | Android 16+ local network 权限拒绝后的 UX | 发现/连接全挂 | 连接页首启即请求权限；拒绝态展示"扫码仍需该权限（本地 socket 被系统门控）"说明与跳转 |
| R2 | 手机侧 Tailscale 安装引导 | 备通道可用性 | v2 只做文案+链接引导；用量数据如显示公网需求高频，v3 再考虑 Headscale 自托管 |
| R3 | 自签证书在 OkHttp 侧的指纹固定实现细节 | Android 实现成本 | 用 OkHttp `CertificatePinner` 固定 SPKI；fp 变更（重装 PC）时走重新配对 |
| R4 | Argon2id 在 Android 的可用性 | 配对握手 | Argon2(kotlin) 或降级 PBKDF2-HMAC-SHA256（≥600k 迭代）；PIN 仅存活 60s 且 5 次锁定，熵缺口可接受 |
| R5 | 多 ZCode 实例与 remote-server 的并发控制 | 指令竞态 | `zcode-manager` 内部对单实例指令加互斥锁（归 T6 方案细化） |
| R6 | PC 休眠/快速启动（Fast Startup）后的监听恢复 | 断连时长 | Electron `powerMonitor` 监听 resume 事件重启 server 并重播 mDNS |

---

## 9. 参考来源

同《通信方案调研报告》§5（rustdesk.com、moonlight-stream、learn.netdata.cloud、developers.home-assistant.io、tailscale.com、headscale.net、developer.android.com/about/versions/16/behavior-changes-16、developer.android.com/privacy-and-security/local-network-permission、learn.microsoft.com（New-NetFirewallRule）、websocket.org、rfc-editor.org/rfc/rfc9382、github.com/moscajs/aedes、github.com/jlongster/electron-with-server-example 等），此处不重复罗列。

> 本草案为 Phase 1 实现前评审稿。评审通过后，信封 JSON Schema 与通道定义应沉淀进 monorepo shared 包（`packages/shared/protocol/`），作为 PC 与 Android 两端的单一事实来源。
