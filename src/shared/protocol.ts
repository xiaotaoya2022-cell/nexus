// Nexus 远程协议信封 v1（PC 端 ↔ Android 端共用）。
// 设计依据：docs/research/v2/hybrid-communication-architecture-draft.md
// 原则：JSON over WebSocket；桌面内部 IPC 通道永不进入本协议；
// version 字段保留升级位；控制类消息带 capability 协商（为 v3 插件市场预留）。

/** 客户端 → PC 请求 */
export interface RequestFrame<T = unknown> {
  v: 1
  type: 'req'
  id: string // 客户端生成的请求 id（去重/关联响应）
  method: RemoteMethod
  payload: T
}

/** PC → 客户端响应 */
export interface ResponseFrame<T = unknown> {
  v: 1
  type: 'res'
  id: string // 对应请求 id
  ok: boolean
  error?: string
  payload?: T
}

/** PC → 客户端推送（订阅制） */
export interface PushFrame<T = unknown> {
  v: 1
  type: 'push'
  ch: PushChannel
  ts: number
  payload: T
}

export type RemoteFrame<TReq = unknown, TRes = unknown, TPush = unknown> =
  | RequestFrame<TReq>
  | ResponseFrame<TRes>
  | PushFrame<TPush>

export type PushChannel = 'agent.overview' | 'system.snapshot' | 'alert' | 'dsh.event' | 'quota'

/** 远程可调用方法（capability 协商：设备令牌记录允许的 method 集合，v3 插件市场扩展位） */
export type RemoteMethod =
  // 配对与鉴权（唯二无需令牌的方法）
  | 'pair' // payload: PairRequest → { deviceId }（token 由双方按二维码内容独立派生）
  | 'auth.hello' // payload: { deviceId } → { nonce }（挑战）
  | 'auth.verify' // payload: AuthVerifyRequest → AuthResult
  // 数据订阅
  | 'subscribe' // payload: { channels: PushChannel[] }
  | 'unsubscribe' // payload: { channels: PushChannel[] }
  // Agent 数据（复用查询口径）
  | 'agent.overview' // payload: { range: RangeKey }
  | 'agent.byModel' // payload: { range: RangeKey }
  | 'agent.byAgent' // payload: { range: RangeKey }
  | 'agent.sessions' // payload: { range: RangeKey; limit?: number }
  | 'agent.trend' // payload: { range: RangeKey; groupBy: 'model' | 'agent' }
  // 系统状态
  | 'system.snapshot' // payload: {}
  // 实例管理（只读发现）
  | 'zc.instances' // payload: {}
  // 有限反控：DeepSeek Harness（回环 /api 桥接）
  | 'dsh.status' // payload: {}
  | 'dsh.sessions' // payload: {}
  | 'dsh.prompt' // payload: { sessionId?: string; text: string }
  | 'dsh.cancel' // payload: { sessionId: string }
  // 有限反控：ZCode（MVP：headless 会话 spawn/stop + 深链）
  | 'zc.startHeadless' // payload: { cwd: string; text: string }
  | 'zc.stopHeadless' // payload: { sessionId: string }
  // 配对/设备
  | 'device.list' // payload: {}
  | 'device.revoke' // payload: { deviceId: string }

export interface PairRequest {
  /** 配对会话 nonce（来自 PC 二维码 nexus-pair://host:port?n=<nonce>&s=<pairingSecret>#<pin>） */
  nonce: string
  /** 证明持有二维码内容：sha256(pairingSecret + ':' + nonce + ':' + pin) */
  proof: string
  pin: string // 6 位数字 PIN（60s 有效，一次性）
  deviceName: string
}

/** 配对响应不携带任何秘密：token = sha256(pairingSecret + ':' + deviceId + ':' + nonce)，
 * 双方各自从二维码内容（pairingSecret/nonce）独立推导，令牌永不上线（红蓝审计 P1-1 修复）。 */
export interface PairResult {
  deviceId: string
}

export interface AuthHelloRequest {
  deviceId: string
}

export interface AuthChallenge {
  nonce: string
}

export interface AuthVerifyRequest {
  deviceId: string
  /** sha256(token + ':' + nonce)，nonce 为 auth.hello 下发的单次挑战 */
  proof: string
}

export interface AuthResult {
  deviceId: string
  deviceName: string
  capabilities: RemoteMethod[]
}

export interface DeviceInfo {
  deviceId: string
  name: string
  createdAt: number
  lastSeenAt: number
}

/** 远程服务状态（PC 设置面板展示） */
export interface RemoteStatusInfo {
  enabled: boolean
  port: number | null
  qrDataUrl: string | null
  pairingActive: boolean
  pairExpiresAt: number | null
  devices: DeviceInfo[]
}

export interface PairingAddress {
  host: string
  /** 网段标注：局域网 / Tailscale/虚拟网（跨网用）/ 其他网络 */
  label: string
  /** 完整配对串 nexus-pair://host:port?n=&s=#pin（手机端直接粘贴） */
  uri: string
}

export interface PairingInfo {
  pin: string
  /** 配对会话 nonce（QR 内 n= 参数） */
  nonce: string
  /** 配对预共享密钥（QR 内 s= 参数，经摄像头通道交付，绝不经网络） */
  pairingSecret: string
  /** 全部候选地址（含 Tailscale 100.x），跨网时选 Tailscale 条目 */
  addresses: PairingAddress[]
  qrDataUrl: string | null
  expiresAt: number
}

/** 系统快照（system-collector 产出的形状；Android 端共用） */
export interface SystemSnapshotLike {
  ts: number
  cpu: { manufacturer: string; model: string; loadPercent: number; cores: number }
  memory: { totalBytes: number; usedBytes: number; usedPercent: number }
  gpus: Array<{ model: string; utilPercent: number | null; memUsedMB: number | null; memTotalMB: number | null }>
  disks: Array<{ fs: string; mount: string; sizeBytes: number; usedBytes: number; usePercent: number }>
  network: { rxBytesPerSec: number; txBytesPerSec: number }
  uptimeSec: number
  load: { currentHourPercent: number | null }
}

export interface EnvelopeError {
  code:
    | 'BAD_REQUEST'
    | 'UNAUTHORIZED'
    | 'NOT_PAIRED'
    | 'CAPABILITY_DENIED'
    | 'NOT_FOUND'
    | 'UPSTREAM_ERROR'
    | 'RATE_LIMITED'
    | 'INTERNAL'
  message: string
}
