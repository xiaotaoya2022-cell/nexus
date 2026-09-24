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

export type PushChannel = 'agent.overview' | 'system.snapshot' | 'alert' | 'dsh.event'

/** 远程可调用方法（capability 协商：设备令牌记录允许的 method 集合，v3 插件市场扩展位） */
export type RemoteMethod =
  // 配对与鉴权（唯二无需令牌的方法）
  | 'pair' // payload: PairRequest → PairResult
  | 'auth' // payload: { deviceId: string; token: string } → { ok: true; capabilities: RemoteMethod[] }
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
  pin: string // 6 位数字 PIN（60s 有效）
  deviceName: string
}

export interface PairResult {
  deviceId: string
  token: string // 设备长期令牌（HMAC 校验）
}

export interface AuthRequest {
  deviceId: string
  token: string
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

export interface PairingInfo {
  pin: string
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
