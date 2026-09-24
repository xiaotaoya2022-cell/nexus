# 通信方案调研报告（Nexus v2 · 任务四）

| 项 | 内容 |
|---|---|
| 文档 | 《通信方案调研报告》 |
| 版本 | v1.0 |
| 日期 | 2026-09-25 |
| 调研人 | 子代理 T4（远程监控/远控通信方案） |
| 依据 | 《Nexus 能力补强指导书 v2》§2.4 |
| 关联 | 《混合通信架构设计草案》（同目录） |

---

## 0. 需求约束回顾

从指导书与本任务书提取的硬约束（所有方案评估以此为基准）：

| 约束 | 说明 |
|---|---|
| 通信两端 | PC 端 Electron 41（TypeScript，Node 主进程） ↔ 本机局域网内 Android App（偶尔跨公网） |
| 数据内容 | ① 手机查看 PC 采集的监控数据（Agent token 消耗 + PC 系统状态）；② 下发有限远控指令（ZCode / DeepSeek Harness 的状态查看/启停） |
| 数据量 | 小：JSON 文本，秒级推送或轮询，无音视频串流 |
| 延迟 | 指令体感延迟 < 500ms（数据推送 1s 级可接受） |
| 形态 | 单一 `.exe` + 单一 `.apk`，**禁止**要求用户手动起服务/配端口（指导书§零） |
| 安全 | 配对、加密、操作审计（指导书§七：端到端加密、设备配对、操作审计、权限最小化） |
| 用户 | 个人自用（1 PC + 1~2 手机），不承担多租户复杂度 |

---

## 1. 候选方案逐项分析

### 1.1 局域网 WebSocket 直连（PC 内嵌 ws server + 自定义 JSON 协议 + mDNS/QR 配对）

**形态**：Electron 主进程用 Node 起 HTTP/WS 服务（`ws` 或 `hono` + `@hono/node-ws`），手机 App 作为 WS 客户端直连 `ws://<PC-IP>:<port>`；mDNS（`_nexus._tcp`）做自动发现，二维码做兜底与配对。

| 维度 | 评估 |
|---|---|
| TS/Node 生态成熟度 | **极高**。`ws`（v8.x）是事实标准——值得注意：ZCode 源码自身服务端就用 `hono + @hono/node-ws + ws@^8.20`（`F:\ZCode-main\packages\server\package.json`，本地实证）。mDNS 侧 `bonjour-service`（纯 JS）可用；`mdns` 包需原生编译，Electron 下易踩 ABI 坑，建议避开。 |
| Android 接入难度 | **低**。OkHttp/内建 `WebSocket` 即可；发现用系统 `NsdManager`（官方文档：[Device discovery](https://developer.android.com/training/connectivity/device-discovery)），Android 13 起平台原生支持 `.local` 解析（[Esper](https://www.esper.io)）。 |
| NAT 穿透 | 局域网内不需要。**跨公网时为最大短板**：手机在蜂窝网无法直连家庭 NAT 后的 PC，必须另配通道（见 §1.5）。 |
| 加密 | 可选 WSS（自签证书 + QR 携带指纹 pinning，Moonlight 模式）或 WS + 应用层加密（NaCl，RustDesk 模式）。两种都有成熟库（`tweetnacl` / `libsodium-wrappers`）。 |
| 断线重连 | 自研但模式成熟：心跳 30–45s + pong 超时判定 + 指数退避 + jitter（[websocket.org 心跳指南](https://websocket.org)）。 |
| 延迟 | **最优**。同网段 TCP 直连一跳，指令 RTT 实测通常 1–20ms，远低于 500ms 要求。 |
| 维护成本 | **低**。零外部服务、零第三方依赖、数据不出本网。协议/类型可用 monorepo shared 包 + Zod 校验共享。 |

**平台级风险（关键事实）**：

1. **Windows 防火墙弹窗**：任何 exe 在非环回接口开监听端口，Windows 都会弹"允许访问"——与随机/固定端口无关，按"可执行文件 × 网络配置档"弹一次（[Microsoft Learn：Node 监听被拦案例](https://learn.microsoft.com)；规则创建：[`New-NetFirewallRule`](https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallrule)）。解法见草案 §5.3。
2. **Android 局域网权限收紧**：Android 16 起引入 Local Network Protection，mDNS/NSD、SSDP、到局域网地址的原始 socket 全部被新运行时权限门控（[官方行为变更说明](https://developer.android.com/about/versions/16/behavior-changes-16)、[Local network permission](https://developer.android.com/privacy-and-security/local-network-permission)）。App 必须声明并在运行时请求该权限，拒绝时需优雅降级。
3. **mDNS 天生局限**：基于链路本地多播（224.0.0.251:5353），不跨 VLAN；AP 隔离 / 访客网络下直接失效（[Mist 文档](https://www.mist.com)、[SNBForums 讨论](https://www.snbforums.com)）。因此 mDNS 只能是"便利路径"，**QR 扫码手动配对必须是第一公民**（Home Assistant 移动端同样是"自动发现失败→手动输入地址"兜底）。

**结论：局域网场景下的最优主通道，复杂度/延迟/安全可控性全面占优。**

---

### 1.2 MQTT（本地 broker 或公共 broker）

**形态**：PC 内嵌纯 JS broker（Aedes）或本机 Mosquitto；手机与 PC 经 topic 发布/订阅。

| 维度 | 评估 |
|---|---|
| TS/Node 生态成熟度 | **高**。客户端 [MQTT.js](https://github.com/mqttjs/MQTT.js)；内嵌 broker [Aedes](https://github.com/moscajs/aedes) 提供 `authenticate` / `authorizePublish` / `authorizeSubscribe` 钩子实现用户鉴权与 topic ACL，可挂 Node TLS server（[HiveMQ 指南](https://www.hivemq.com)、[Cedalo/Mosquitto 指南](https://www.cedalo.com)）。 |
| Android 接入难度 | 中。需引入 MQTT 客户端库（Eclipse Paho / hivemq-mqtt-client），比原生 WebSocket 多一层依赖与协议栈。 |
| NAT 穿透 | LAN 内不需要。公网路线有二：公共 broker（`test.mosquitto.org` 或商业免费档）——**监控数据与远控指令出第三方，个人自用不可接受**；自建 VPS broker——违背"单一 exe、零部署"形态。 |
| 加密 | TLS + 用户名/密码 + topic ACL，成熟。但 topic 级 ACL 对"单用户单设备"场景属于过度设计。 |
| 断线重连 | **协议内建**（QoS 0/1/2、会话保持、遗嘱消息），这是 MQTT 相对裸 WS 的真正优势。 |
| 延迟 | LAN 内多一跳 broker，一般仍 <50ms，满足要求但不如直连。 |
| 维护成本 | 中。多一个 broker 组件（内嵌也要管其生命周期、持久化、ACL）；发布/订阅模型与"指令要确认、要审计"的 RPC 语义不匹配，还得在 topic 上再叠一层 request/response 约定（MQTT 5 的 response topic 能做，但复杂度回流）。 |

**结论**：MQTT 的核心卖点（海量低功耗设备、不可靠网络 QoS、多对多扇出）与本场景（1对1、可靠局域网、RPC 型指令）不匹配；其断线重连优势可被 WS 心跳+退避+序号对账低成本复刻。**不推荐作为主通道**，仅当未来出现"多 PC/多手机扇出"需求时再评估。

---

### 1.3 gRPC / ConnectRPC（强类型 + 多语言生成）

**形态**：`.proto`（或 Buf module）定义服务，Buf 生成 connect-es（TS）与 connect-kotlin（Android）代码，两端共享同一 schema。

| 维度 | 评估 |
|---|---|
| TS/Node 生态成熟度 | **高**。[connect-es](https://github.com/connectrpc/connect-es)（基于 Protobuf-ES，实现 gRPC / gRPC-Web / Connect 三协议）；服务端可在 Node 跑，也可走 Connect 协议用普通 HTTP handler。 |
| Android 接入难度 | 中。[connect-kotlin](https://github.com/connectrpc/connect-kotlin) 生成惯用 Kotlin 客户端（依赖 Connect-Kotlin runtime + Google Java Protobuf）。 |
| 强类型共享 | **本方案最大优势**：单一 Protobuf schema 为全部平台生成确定性代码（[Buf：Announcing Connect-Kotlin](https://buf.build)、[connectrpc.com 代码生成文档](https://connectrpc.com)），与指导书"共享层"诉求天然契合。 |
| NAT 穿透 | 与裸 WS 同样的问题：公网仍需直连通道或组网，gRPC 本身不解 NAT。 |
| 加密/重连 | 依赖底层 HTTP/2 + TLS；流断开后自动重连/重订阅需自行封装（gRPC 有 keepalive，但移动端弱网下的会话语义不如 MQTT 内建）。 |
| 延迟 | 优秀（HTTP/2 多路复用、bidi streaming 做 server push）。 |
| 维护成本 | **偏高（对本项目）**：引入 protoc/Buf 工具链、两端 codegen 步骤、Electron 打包额外产物；每次改协议需重新生成。2025 年的回顾也指出 Connect 的价值主要在中大型多端 API（[kmcd.dev：ConnectRPC Where is it now](https://kmcd.dev)）。对"一个人 + 一个 schema 只有十几个消息"的项目是重炮打蚊子。 |

**结论**：强类型共享层的目标用「monorepo shared 包 + Zod schema + JSON 信封」即可达成（Android 端用 kotlinx.serialization 消费同一 JSON Schema），无需承担完整 protobuf 工具链。**v2 不采用；若 v3 协议面扩大（>50 个消息类型、多端）可重评。**

---

### 1.4 WebRTC DataChannel（P2P + NAT 穿透）

**形态**：DataChannel 跑 JSON 消息；需要信令通道交换 SDP，ICE/STUN 完成 NAT 穿透，严格 NAT 落到 TURN 中继。

| 维度 | 评估 |
|---|---|
| TS/Node 生态成熟度 | 中。两条路线：`node-datachannel`（libdatachannel 的 Node 绑定，C++ 原生模块，内置 libjuice 支持 STUN/TURN，[npm](https://www.npmjs.com/package/node-datachannel)）；`werift`（纯 TypeScript WebRTC 实现，零原生依赖，[GitHub](https://github.com/shinyoshiaki/werift-webrtc)）。Electron 下原生模块存在重编译/打包成本；纯 TS 的 werift 则牺牲部分性能与成熟度。 |
| Android 接入难度 | **高**。官方 `org.webrtc` 库重、API 复杂，仅为收发小 JSON 引入整套 WebRTC 栈不成比例。 |
| NAT 穿透 | **本方案唯一核心优势**：真 P2P，可穿越多数家用 NAT；严格 NAT 需公网 TURN。 |
| 加密 | 内建 DTLS-SRTP 体系，安全基线好。 |
| 断线重连 | ICE 状态机 + 重新协商，弱网切换（Wi-Fi↔蜂窝）时重连体验一般，需自建 ICE restart 逻辑。 |
| 延迟 | 通道建立后极低（SCTP 可 unordered）；但**连接建立慢**（信令+ICE 通常 1–3s 起），移动网络下更差。 |
| 维护成本 | **高**。信令服务、STUN/TURN 基础设施、两端状态机调试，都是长期负担。 |

**结论**：WebRTC 解决的正是"跨公网 P2P"问题，但代价与本项目规模严重失配；而跨公网需求用 Tailscale（§1.5）以近零代码成本即可满足。**不做。**（若未来要做屏幕串流，届时 WebRTC 媒体通道才有意义。）

---

### 1.5 Tailscale / ZeroTier 虚拟组网 + 任意协议

**形态**：PC 与手机安装 Tailscale（或 ZeroTier）加入同一虚拟网，Nexus WS server 直接监听 tailnet 接口，手机连 `ws://<tailnet-IP>:<port>`。**它不是协议，而是"把公网问题变成局域网问题"的底座。**

| 维度 | 评估 |
|---|---|
| 原理与可信度 | Tailscale = WireGuard + 按需 NAT 穿透 + DERP 加密中继兜底；DERP 只转发**已加密的 WireGuard 包**，中继看不到明文（[Tailscale 开源页](https://tailscale.com/open-source)、[DERP 说明](https://shattered.io)）。直连优先、中继仅兜底（[Tailscale vs WireGuard](https://shattered.io)）。控制面可自托管 Headscale（内嵌 DERP 保底，[headscale.net](https://headscale.net)；[自建指南](https://www.ssdnodes.com)）。 |
| TS/Node 生态成熟度 | 与 Node 无关（系统级 VPN），Nexus 代码**零改动**——WS server 监听 0.0.0.0 即天然可用。 |
| Android 接入难度 | 低偏中：装官方 App + 登录，一次性操作；VPN 常驻有电量与"Always-on VPN"设置成本（个人自用可接受）。 |
| NAT 穿透 | **全自动**（打洞失败走 DERP），蜂窝网/外网均可达。移动网络 Wi-Fi↔蜂窝切换下 WireGuard 重握手表现好（[Onidel 2025 对比](https://onidel.com)）。 |
| 加密 | WireGuard 端到端加密，强度无需担心。 |
| 断线重连 | 系统级自愈，应用层只需保留 WS 层重连。 |
| 延迟 | 直连路径额外开销 ~几十µs 级（内核态 WireGuard）；DERP 兜底路径取决于中继距离，仍远优于不可达。 |
| 维护成本 | **近零**（SaaS 免费档 100 设备/3 用户）；选 Headscale 则+1 台 VPS。 |
| 与"单一软件"原则的关系 | 需要额外安装 Tailscale App（外部依赖），**故只能做公网备通道，不能做主通道**；Nexus 应在设置页提供一键引导。 |

**Tailscale vs ZeroTier**：两者都做 NAT 穿透 + 加密 P2P；2025 年共识是个人 + 移动场景 Tailscale 凭 WireGuard 性能、免费额度（100 设备 vs ZeroTier 有限设备数）与身份验证更优（[Tailscale 官方对比页](https://tailscale.com)、[Onidel](https://onidel.com)、[XDA 评测](https://www.xda-developers.com)）。**选 Tailscale。**

**结论**：公网备通道的最优解——零协议开发、零基础设施、安全模型现成。代价是外部 App 依赖与一次登录引导。

---

### 1.6 成熟开源远控/监控项目的架构借鉴

#### 1.6.1 RustDesk（ID 服务器 / 中继 / P2P）

- 架构：`hbbs`（ID/rendezvous 信令服务器，TCP 21114–21116 + UDP 21116 用于打洞协调）+ `hbbr`（中继服务器，TCP 21117+）；客户端经 ID 注册，连接时由 hbbs 协调 NAT 打洞，**打洞失败才落 hbbr 中继**（[RustDesk 自托管文档](https://rustdesk.com/docs)）。
- 安全：基于 NaCl/libsodium 的端到端加密——**中继上也只见密文**；服务器用 Ed25519 密钥对签名，客户端通过 `key` 做公钥固定（[RustDesk 官网/文档](https://rustdesk.com/docs)）。
- **可借鉴思想**：① 信令（rendezvous）与数据分离；② 中继只是 fallback 而非默认路径；③ 公钥/证书指纹固定防中间人。→ 对应草案的「QR 携带证书指纹 + mDNS/QR 信令 + Tailscale 兜底」。

#### 1.6.2 Sunshine + Moonlight（串流配对协议）

- 配对流程：客户端生成自签 X.509 证书 → 发起配对 → 客户端展示 4 位 PIN → 用户 30 秒内在主机输入 PIN → 双方以 PIN 为低熵共享秘密（salted SHA-256）派生 AES 密钥并互验 challenge 签名 → **主机保存客户端证书，配对一次、长期信任**（[Moonlight FAQ / moonlight-stream](https://github.com/moonlight-stream)、协议细节在 [moonlight-common-c](https://github.com/moonlight-stream/moonlight-common-c)）。
- **可借鉴思想**：① "扫码/输 PIN 一次 → 换取长期设备信任"的低摩擦配对；② PIN 有时效（30s）；③ 证书指纹替代 CA 体系。→ 直接对应草案 §3 配对协议（ 学术对应物是 PAKE：SPAKE2，RFC 9382，[rfc-editor](https://www.rfc-editor.org/rfc/rfc9382.html)）。

#### 1.6.3 Netdata（监控数据流 + 告警）

- per-second 粒度采集；parent-child 流式汇聚（child 把指标流式推给 parent，告警在 parent 统一评估，[Netdata Learn](https://learn.netdata.cloud)）；前端实时数据走 **WebSocket + permessage-deflate 压缩**（[源码内协议文档](https://github.com/netdata/netdata/blob/master/src/web/websocket/README.md)）。
- **可借鉴思想**：① 秒级推流用 WS 而非轮询；② 开 permessage-deflate 省流量；③ "边采集边评估告警，把结论而非原始数据推给客户端"；④ 订阅制（客户端声明要哪些图表）。→ 对应草案 §4 推送模型。

#### 1.6.4 Home Assistant（长期令牌 + REST/WS API + 移动端配对）

- 鉴权：REST 用 `Authorization: Bearer <Long-Lived Access Token>`（在用户资料页手动创建，[REST API 文档](https://developers.home-assistant.io)）；**WS 连接后第一帧必须发 `{"type":"auth","access_token":...}`**（[Postman WebSocket 指南](https://www.postman.com)）；长期令牌是官方推荐的 App/脚本接入方式，可创建可撤销（[Authentication 文档](https://www.home-assistant.io)）；移动端 App 走完整 OAuth2/前端授权流程换 token。
- **可借鉴思想**：① 设备级长期令牌（可撤销、可审计、权限可分）而非裸密码；② "连接→首帧 auth→401 显式拒绝"的简单会话语义；③ 自动发现失败时手动输入 `http://IP:8123` 的一等公民兜底 UX。→ 对应草案 §3.3/§3.4。

#### 1.6.5 借鉴汇总

| 项目 | 借鉴点 | 落到草案的位置 |
|---|---|---|
| RustDesk | rendezvous/relay 分离；中继仅兜底；密钥固定 | §2 拓扑、§3.1 QR 指纹 |
| Sunshine/Moonlight | QR+PIN 派生密钥、30s 时效、一次配对长期信任 | §3.2 配对协议 |
| Netdata | WS 推流 + permessage-deflate + 订阅制 + 告警在 PC 侧评估 | §4 推送模型 |
| Home Assistant | 设备长期令牌、WS 首帧 auth、手动地址兜底 UX | §3.3/§3.4 鉴权 |
| Matter/SPAKE2（补充） | PAKE 抗离线字典攻击的 PIN 派生 | §3.2 密钥派生 |

---

### 1.7 （补充）HTTP 轮询 / SSE

简单但在"双向、低延迟指令"场景先天不足：轮询延迟=轮询间隔（500ms 内需高频轮询，浪费电量）；SSE 单向（仅服务器→客户端），指令仍要另开 HTTP POST。两者作为**配对握手/文件导出等低频 REST 端点**保留，不作主通道。

---

## 2. 方案对比总表

评分 1–5，5 为最优（越符合 §0 约束越高）。

| 方案 | TS/Node 生态 | Android 接入 | NAT 穿透 | 加密 | 断线重连 | 延迟 | 维护成本 | **综合** |
|---|---|---|---|---|---|---|---|---|
| **① LAN WS 直连** | 5 | 5 | 2（仅 LAN） | 4（需自选 WSS/应用层） | 4（自研但模式成熟） | 5 | 5 | **4.6** |
| ② MQTT | 4 | 3 | 2（同上；公网依赖 broker） | 4 | 5（协议内建） | 4 | 3 | 3.6 |
| ③ gRPC/Connect | 4 | 3 | 2 | 4 | 3 | 5 | 2（工具链重） | 3.3 |
| ④ WebRTC DataChannel | 3 | 2 | 5 | 5 | 3 | 4（建连慢） | 2 | 3.1 |
| **⑤ Tailscale + WS** | 5（零代码） | 3（装 App+登录） | 5 | 5（WireGuard） | 4 | 4~5 | 5 | **4.4（备通道）** |
| ⑦ 轮询/SSE | 5 | 5 | 2 | 3 | 5（无状态） | 2 | 5 | 3.0（辅助） |

---

## 3. 与 ZCode 远控组件的结合方式

本地实证（`F:\ZCode-main`，只读观察）：

- `packages/rpc`（`@zcode/rpc`）是 **VS Code 风格的 IPC/Channel 通信抽象**（`channelServer.ts` / `channelClient.ts` / `proxy-channel.ts` / `remote.ts`，含 `04-remote-connection.ts` 示例）。
- `packages/server`（`@zcode/server`）以 `hono + @hono/node-ws + ws + node-pty + ssh2` 提供 HTTP/WS 服务，导出 `./remote`（`src/remote/`：SSH/WSL/Docker backend、handshake、deploy 等）——其 "remote" 指的是**把 dev server 部署到远端主机**，`harness/remote` 只是 SSH Docker 辅助脚本（`F:\ZCode-main\harness\remote\README.md`）。
- **结论**：ZCode 没有面向手机的远控协议。Nexus 不必（也不应）复用其线上协议，而是：
  1. PC 端 Nexus 主进程在本机经 localhost HTTP/WS 或进程/SQLite 层对接各 ZCode 实例（细节归 T2《ZCode 远控源码分析报告》与 T6《多开管理方案》）；
  2. Nexus 自行定义 **手机↔PC** 的私有 JSON 信封协议（见草案 §4），信封的 `type/requestId` 语义与 `@zcode/rpc` 的 channel/request-response 风格保持一致，降低桥接心智成本；
  3. 两端类型共享走 monorepo shared 包 + Zod，替代 gRPC codegen（呼应 §1.3 结论）。

---

## 4. 结论

1. **主通道**：局域网 WebSocket 直连（PC Electron 内嵌 server），mDNS 发现 + QR 扫码配对兜底，PIN 派生密钥 + 设备长期令牌 + 审计——复杂度最低、延迟最优、数据不出本网。
2. **备通道**：公网场景直接叠加 Tailscale（WS 原样跑在虚拟网上），不做自研 NAT 穿透/中继。
3. **不采用**：MQTT（卖点失配）、gRPC/Connect（工具链过重，用 Zod 共享层替代）、WebRTC（为穿 NAT 而生，但 Tailscale 更省）、公共 broker/中继（数据出第三方）。
4. 必须正视的三个平台事实：Windows 防火墙按 exe 弹窗（安装器预建规则）、Android 16 局域网权限门控 mDNS+socket（运行时请求 + 降级 UX）、mDNS 在 AP 隔离/访客网失效（QR 手动配对必须是第一公民）。

## 5. 主要来源

- RustDesk 架构/加密：https://rustdesk.com/docs
- Moonlight 配对：https://github.com/moonlight-stream 、https://github.com/moonlight-stream/moonlight-common-c
- Netdata 流式/WebSocket：https://learn.netdata.cloud 、https://github.com/netdata/netdata/blob/master/src/web/websocket/README.md
- Home Assistant 鉴权/API：https://developers.home-assistant.io 、https://www.home-assistant.io 、https://www.postman.com
- Tailscale/DERP/Headscale：https://tailscale.com/open-source 、https://headscale.net 、https://shattered.io 、https://www.ssdnodes.com 、https://onidel.com 、https://www.xda-developers.com
- SPAKE2 (RFC 9382)：https://www.rfc-editor.org/rfc/rfc9382.html
- 协议对比：https://www.svix.com 、https://ably.com 、https://websocket.org 、https://charlessieg.com
- ConnectRPC：https://github.com/connectrpc/connect-es 、https://github.com/connectrpc/connect-kotlin 、https://buf.build 、https://connectrpc.com 、https://kmcd.dev
- WebRTC Node：https://www.npmjs.com/package/node-datachannel 、https://github.com/shinyoshiaki/werift-webrtc
- MQTT：https://github.com/mqttjs/MQTT.js 、https://github.com/moscajs/aedes 、https://www.hivemq.com 、https://www.cedalo.com
- WS 服务器参考：https://github.com/jlongster/electron-with-server-example
- mDNS/发现：https://www.npmjs.com/package/mdns 、https://www.npmjs.com/package/bonjour-service 、https://github.com/futomi/node-dns-sd 、https://developer.android.com/training/connectivity/device-discovery 、https://www.esper.io 、https://www.mist.com 、https://www.snbforums.com
- Android 局域网权限：https://developer.android.com/about/versions/16/behavior-changes-16 、https://developer.android.com/privacy-and-security/local-network-permission
- Windows 防火墙：https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallrule 、https://learn.microsoft.com
- ZCode 本地源码（只读）：`F:\ZCode-main\packages\rpc`、`F:\ZCode-main\packages\server\package.json`、`F:\ZCode-main\harness\remote`

> 注：部分来源以站点域级引用（搜索结果仅给出域名级出处），报告日期 2026-09-25，检索为当日最新可得信息。
