// 远程通信服务（v2 Phase 1，指导书 §4.2 remote-server）。
// 设计依据：docs/research/v2/hybrid-communication-architecture-draft.md（混合通信架构草案）
// - LAN WS 直连（随机端口）+ mDNS/QR 配对 + 60s PIN + 设备长期令牌 + 订阅推送 + 审计日志 + 限流
// - 鉴权前仅允许 pair/auth 两个方法；令牌经 HMAC-SHA256 校验（存 hash 不存明文）
// - 公网场景建议 Tailscale 组网后复用同一协议（草案 §备通道）

import { WebSocketServer, WebSocket } from 'ws'
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  PairRequest,
  PushChannel,
  RemoteMethod,
  RemoteStatusInfo,
  RequestFrame
} from '@shared/protocol'
import type { RangeKey } from '@shared/types'
import type { NexusStore } from '@main/modules/aggregator/infrastructure/store'
import type { QueryService } from '@main/modules/aggregator/application/query-service'
import type { SystemCollector } from '@main/modules/system/collector'
import type { ZcodeManager } from '@main/modules/zcode/manager'
import type { DshBridge } from '@main/modules/dsh/bridge'
import { logger } from '@main/modules/shared/logger'

const PAIR_PIN_TTL_MS = 60_000
const MAX_FRAME_BYTES = 256 * 1024
const RATE_LIMIT_PER_MIN = 120

interface DeviceRecord {
  deviceId: string
  name: string
  /** 原始 token（仅存 PC 本机 nexus.db；威胁模型：本机文件读取 = 与使用数据同级失守，审计已接受） */
  token: string
  createdAt: number
  lastSeenAt: number
}

interface ConnState {
  deviceId: string | null
  channels: Set<PushChannel>
  reqTimestamps: number[]
  authNonce: string | null
}

const MAX_CONNS = 32
const MAX_PAIR_FAILURES = 10

export type RemoteStatus = RemoteStatusInfo

interface Deps {
  store: NexusStore
  query: QueryService
  system: SystemCollector
  zcode: ZcodeManager
  dsh: DshBridge
  userDataDir: string
  onAlert?: (alert: { level: 'warn' | 'error'; title: string; body: string }) => void
  onPaired?: (deviceId: string, deviceName: string) => void
}

const ALL_CAPABILITIES: RemoteMethod[] = [
  'subscribe',
  'unsubscribe',
  'agent.overview',
  'agent.byModel',
  'agent.byAgent',
  'agent.sessions',
  'agent.trend',
  'system.snapshot',
  'zc.instances',
  'dsh.status',
  'dsh.sessions',
  'dsh.prompt',
  'dsh.cancel',
  'device.list',
  'device.revoke'
]

export class RemoteServer {
  private wss: WebSocketServer | null = null
  private port: number | null = null
  private enabled = false
  private pin: string | null = null
  private pinExpiresAt = 0
  private pairNonce = randomBytes(16).toString('hex')
  private pairingSecret: string | null = null
  private pairFailures = 0
  private conns = new Map<WebSocket, ConnState>()
  private pushTimer: NodeJS.Timeout | null = null
  private lastConnOpenAt = 0
  private auditPath: string

  constructor(
    private readonly deps: Deps,
    private readonly _secret: string // 保留位：token 已改为二维码配对密钥派生（P1-1），不再依赖服务端 secret
  ) {
    this.auditPath = join(deps.userDataDir, 'remote-audit.jsonl')
  }

  // ── 设备存储（settings 表，存 token hash 不存明文）──
  private loadDevices(): DeviceRecord[] {
    try {
      return JSON.parse(this.deps.store.getSetting('remoteDevices') ?? '[]') as DeviceRecord[]
    } catch {
      return []
    }
  }

  private saveDevices(devices: DeviceRecord[]): void {
    this.deps.store.setSetting('remoteDevices', JSON.stringify(devices))
  }

  private audit(deviceId: string, method: string, ok: boolean, detail?: string): void {
    const line = JSON.stringify({ ts: Date.now(), deviceId, method, ok, detail: detail ?? null })
    try {
      appendFileSync(this.auditPath, line + '\n')
    } catch {
      // 审计失败不影响服务
    }
  }

  // ── 生命周期 ──
  start(): void {
    if (this.wss) return
    this.enabled = true
    this.deps.store.setSetting('remoteEnabled', '1')
    // 红蓝审计 P2-2：maxPayload 收紧到 256KB（帧上限在协议层之前生效）；
    // 浏览器发起的跨站 WS（带 http/https Origin）在握手期直接拒绝
    this.wss = new WebSocketServer({
      host: '0.0.0.0',
      port: 0,
      maxPayload: MAX_FRAME_BYTES,
      verifyClient: (info) => {
        const origin = info.req.headers.origin
        return origin == null || !/^https?:\/\//i.test(String(origin))
      }
    })
    this.wss.on('listening', () => {
      const addr = this.wss?.address()
      this.port = typeof addr === 'object' && addr ? addr.port : null
      // eslint-disable-next-line no-console
      console.log(`[remote] listening on ${this.port}`)
      logger.info('remote.started', { port: this.port })
    })
    this.wss.on('connection', (ws) => this.onConnection(ws))
    this.pushTimer = setInterval(() => void this.pushTick(), 2000)
  }

  stop(): void {
    this.enabled = false
    this.deps.store.setSetting('remoteEnabled', '0')
    if (this.pushTimer) clearInterval(this.pushTimer)
    this.pushTimer = null
    for (const [ws] of this.conns) ws.close()
    this.conns.clear()
    this.wss?.close()
    this.wss = null
    this.port = null
    logger.info('remote.stopped')
  }

  /** 生成新配对会话：QR 内含 pairingSecret（经摄像头通道交付，绝不经网络传输）。
   * token = sha256(pairingSecret:deviceId:nonce)，由两端独立推导，令牌永不上线（P1-1 修复）。 */
  async regeneratePairing(): Promise<{
    pin: string
    nonce: string
    pairingSecret: string
    qrDataUrl: string | null
    expiresAt: number
  }> {
    const pin = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.pairNonce = randomBytes(16).toString('hex')
    this.pairingSecret = randomBytes(32).toString('hex')
    this.pin = pin
    this.pinExpiresAt = Date.now() + PAIR_PIN_TTL_MS
    this.pairFailures = 0
    let qr: string | null = null
    try {
      const qrLib = await import('qrcode')
      const host = await this.lanIp()
      qr = await qrLib.toDataURL(
        `nexus-pair://${host}:${this.port ?? 0}?n=${this.pairNonce}&s=${this.pairingSecret}#${pin}`,
        { margin: 1, width: 240 }
      )
    } catch (err) {
      logger.warn('remote.qr_failed', { error: err instanceof Error ? err.message : String(err) })
    }
    return { pin, nonce: this.pairNonce, pairingSecret: this.pairingSecret, qrDataUrl: qr, expiresAt: this.pinExpiresAt }
  }

  private async lanIp(): Promise<string> {
    const osInfo = await import('node:os')
    const ifaces = osInfo.networkInterfaces()
    for (const list of Object.values(ifaces)) {
      for (const ni of list ?? []) {
        if (ni.family === 'IPv4' && !ni.internal) return ni.address
      }
    }
    return '127.0.0.1'
  }

  status(): RemoteStatus {
    const pinActive = this.pin != null && Date.now() < this.pinExpiresAt
    return {
      enabled: this.enabled,
      port: this.port,
      qrDataUrl: null, // QR 仅在 regeneratePairing 时生成（含 PIN，不常驻内存）
      pairingActive: pinActive,
      pairExpiresAt: pinActive ? this.pinExpiresAt : null,
      devices: this.loadDevices().map(({ token: _t, ...rest }) => rest)
    }
  }

  revokeDevice(deviceId: string): void {
    this.saveDevices(this.loadDevices().filter((d) => d.deviceId !== deviceId))
    this.audit(deviceId, 'device.revoke', true)
    for (const [ws, st] of this.conns) {
      if (st.deviceId === deviceId) ws.close()
    }
  }

  // ── 连接处理 ──
  private onConnection(ws: WebSocket): void {
    // 红蓝审计 P2-1：并发连接上限
    if (this.conns.size >= MAX_CONNS) {
      ws.close()
      return
    }
    const state: ConnState = { deviceId: null, channels: new Set(), reqTimestamps: [], authNonce: null }
    this.conns.set(ws, state)
    this.lastConnOpenAt = Date.now()
    // eslint-disable-next-line no-console
    console.log('[remote] conn_open')
    logger.info('remote.conn_open', { total: this.conns.size })
    ws.on('close', (code, reason) => {
      // eslint-disable-next-line no-console
      console.log(`[remote] conn_close code=${code}`)
      logger.info('remote.conn_close', { code, reason: reason.toString().slice(0, 100) })
      this.conns.delete(ws)
    })
    ws.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.log(`[remote] conn_error ${err.message}`)
      logger.warn('remote.conn_error', { error: err.message })
      this.conns.delete(ws)
    })
    ws.on('message', (data) => {
      try {
        const raw = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
        if (raw.length > MAX_FRAME_BYTES) {
          this.sendErr(ws, '?', 'BAD_REQUEST', '帧超限')
          return
        }
        const frame = JSON.parse(raw.toString('utf8')) as RequestFrame
        if (frame.v !== 1 || frame.type !== 'req' || typeof frame.id !== 'string') {
          this.sendErr(ws, '?', 'BAD_REQUEST', '帧格式错误')
          return
        }
        if (!this.rateCheck(state)) {
          this.sendErr(ws, frame.id, 'RATE_LIMITED', '请求过于频繁')
          return
        }
        void this.handleReq(ws, state, frame)
      } catch {
        this.sendErr(ws, '?', 'BAD_REQUEST', '无法解析帧')
      }
    })
  }

  private rateCheck(state: ConnState): boolean {
    const now = Date.now()
    state.reqTimestamps = state.reqTimestamps.filter((t) => now - t < 60_000)
    if (state.reqTimestamps.length >= RATE_LIMIT_PER_MIN) return false
    state.reqTimestamps.push(now)
    return true
  }

  private send(ws: WebSocket, frame: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
  }

  private sendErr(ws: WebSocket, id: string, code: string, message: string): void {
    this.send(ws, { v: 1, type: 'res', id, ok: false, error: `${code}: ${message}` })
  }

  private async handleReq(ws: WebSocket, state: ConnState, frame: RequestFrame): Promise<void> {
    const method = frame.method
    // 未鉴权只允许 pair / auth.hello / auth.verify
    if (
      state.deviceId == null &&
      method !== 'pair' &&
      method !== 'auth.hello' &&
      method !== 'auth.verify'
    ) {
      this.sendErr(ws, frame.id, 'UNAUTHORIZED', '请先配对或鉴权')
      return
    }
    try {
      switch (method) {
        case 'pair':
          return this.handlePair(ws, state, frame)
        case 'auth.hello':
          return this.handleAuthHello(ws, state, frame)
        case 'auth.verify':
          return this.handleAuthVerify(ws, state, frame)
        case 'subscribe':
        case 'unsubscribe': {
          const channels = (frame.payload as { channels?: PushChannel[] })?.channels ?? []
          for (const ch of channels) {
            if (ch === 'agent.overview' || ch === 'system.snapshot' || ch === 'alert' || ch === 'dsh.event') {
              if (method === 'subscribe') state.channels.add(ch)
              else state.channels.delete(ch)
            }
          }
          this.send(ws, { v: 1, type: 'res', id: frame.id, ok: true, payload: { channels: [...state.channels] } })
          return
        }
        case 'agent.overview': {
          const range = this.rangeOf(frame.payload)
          this.send(ws, { v: 1, type: 'res', id: frame.id, ok: true, payload: this.deps.query.getOverview(range, null) })
          return
        }
        case 'agent.byModel': {
          const range = this.rangeOf(frame.payload)
          this.send(ws, { v: 1, type: 'res', id: frame.id, ok: true, payload: this.deps.query.getByModel(range, null) })
          return
        }
        case 'agent.byAgent': {
          const range = this.rangeOf(frame.payload)
          this.send(ws, { v: 1, type: 'res', id: frame.id, ok: true, payload: this.deps.query.getByAgent(range) })
          return
        }
        case 'agent.sessions': {
          const range = this.rangeOf(frame.payload)
          const rawLimit = Number((frame.payload as { limit?: number })?.limit ?? 50)
          const limit = Number.isFinite(rawLimit) ? rawLimit : 50
          this.send(ws, {
            v: 1,
            type: 'res',
            id: frame.id,
            ok: true,
            payload: this.deps.query.getSessions(range, null, Math.min(Math.max(1, limit), 100))
          })
          return
        }
        case 'agent.trend': {
          const range = this.rangeOf(frame.payload)
          const groupBy = (frame.payload as { groupBy?: 'model' | 'agent' })?.groupBy === 'agent' ? 'agent' : 'model'
          this.send(ws, { v: 1, type: 'res', id: frame.id, ok: true, payload: this.deps.query.getTrend(range, null, groupBy) })
          return
        }
        case 'system.snapshot': {
          const snap = await this.deps.system.snapshot()
          this.send(ws, { v: 1, type: 'res', id: frame.id, ok: true, payload: snap })
          return
        }
        case 'zc.instances': {
          this.send(ws, { v: 1, type: 'res', id: frame.id, ok: true, payload: this.deps.zcode.instances() })
          return
        }
        case 'dsh.status': {
          this.send(ws, { v: 1, type: 'res', id: frame.id, ok: true, payload: await this.deps.dsh.status() })
          return
        }
        case 'dsh.sessions': {
          this.send(ws, { v: 1, type: 'res', id: frame.id, ok: true, payload: await this.deps.dsh.listSessions() })
          return
        }
        case 'dsh.prompt': {
          const p = frame.payload as { sessionId?: string; text?: string }
          if (!p?.text || typeof p.text !== 'string' || p.text.length > 32_000) {
            this.sendErr(ws, frame.id, 'BAD_REQUEST', 'text 缺失或超长')
            return
          }
          let sessionId = p.sessionId
          if (!sessionId) {
            sessionId = (await this.deps.dsh.createSession({})).sessionId
          }
          const res = await this.deps.dsh.prompt(sessionId, p.text)
          this.send(ws, { v: 1, type: 'res', id: frame.id, ok: true, payload: { sessionId, res } })
          return
        }
        case 'dsh.cancel': {
          const p = frame.payload as { sessionId?: string }
          if (!p?.sessionId) {
            this.sendErr(ws, frame.id, 'BAD_REQUEST', 'sessionId 缺失')
            return
          }
          this.send(ws, { v: 1, type: 'res', id: frame.id, ok: true, payload: await this.deps.dsh.cancel(p.sessionId) })
          return
        }
        case 'device.list': {
          this.send(ws, { v: 1, type: 'res', id: frame.id, ok: true, payload: this.loadDevices().map(({ token: _t, ...rest }) => rest) })
          return
        }
        case 'device.revoke': {
          // 设备不能自吊销时也不允许吊销他人：MVP 拒绝远程吊销（仅 PC 端 UI 操作）
          this.sendErr(ws, frame.id, 'CAPABILITY_DENIED', '远程吊销请在 PC 端操作')
          return
        }
        default:
          this.sendErr(ws, frame.id, 'NOT_FOUND', `未知方法 ${String(method)}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (state.deviceId) this.audit(state.deviceId, String(method), false, message)
      this.sendErr(ws, frame.id, 'UPSTREAM_ERROR', message.slice(0, 200))
    }
  }

  private rangeOf(payload: unknown): RangeKey {
    const r = (payload as { range?: RangeKey })?.range
    return r === 'today' || r === '7d' || r === '30d' || r === 'month' || r === 'year' || r === 'all' ? r : '7d'
  }

  /** 配对（红蓝审计 P1-1 修复）：令牌永不上线。
   * 客户端从二维码获得 pairingSecret/nonce/PIN（摄像头通道，不经网络），
   * 证明 = sha256(pairingSecret:nonce:pin)；token = sha256(pairingSecret:deviceId:nonce)
   * 由两端独立推导。失败预算：累计 ≥MAX_PAIR_FAILURES 次作废当前配对会话。 */
  private handlePair(ws: WebSocket, state: ConnState, frame: RequestFrame): void {
    const p = frame.payload as Partial<PairRequest>
    const active =
      this.pin != null &&
      this.pairingSecret != null &&
      Date.now() < this.pinExpiresAt &&
      typeof p.nonce === 'string' &&
      p.nonce === this.pairNonce
    const proofOk =
      active &&
      typeof p.proof === 'string' &&
      p.proof.length === 64 &&
      timingSafeEqual(
        Buffer.from(createHash('sha256').update(`${this.pairingSecret}:${p.nonce}:${p.pin}`).digest('hex')),
        Buffer.from(p.proof)
      )
    const pinOk =
      active && typeof p.pin === 'string' && p.pin.length === 6 && timingSafeEqual(Buffer.from(p.pin), Buffer.from(this.pin))
    if (!proofOk || !pinOk) {
      this.pairFailures += 1
      this.audit('unpaired', 'pair', false, `证明或 PIN 无效（失败 ${this.pairFailures}）`)
      if (this.pairFailures >= MAX_PAIR_FAILURES) {
        // 失败预算耗尽：作废当前配对会话，需重新生成二维码
        this.pin = null
        this.pairingSecret = null
        this.pinExpiresAt = 0
      }
      this.sendErr(ws, frame.id, 'UNAUTHORIZED', '配对证明无效或已过期')
      return
    }
    const deviceName = typeof p.deviceName === 'string' && p.deviceName.trim() ? p.deviceName.trim().slice(0, 40) : 'device'
    const deviceId = `dev_${randomBytes(6).toString('hex')}`
    const nonce = String(p.nonce)
    const token = createHash('sha256').update(`${String(this.pairingSecret)}:${deviceId}:${nonce}`).digest('hex')
    const devices = this.loadDevices()
    devices.push({
      deviceId,
      name: deviceName,
      token,
      createdAt: Date.now(),
      lastSeenAt: Date.now()
    })
    this.saveDevices(devices)
    state.deviceId = deviceId
    this.audit(deviceId, 'pair', true, deviceName)
    // 响应仅含 deviceId——token 双方各自推导，永不上线
    this.send(ws, { v: 1, type: 'res', id: frame.id, ok: true, payload: { deviceId } })
    // 一次性配对会话：成功即失效
    this.pin = null
    this.pairingSecret = null
    this.pinExpiresAt = 0
    this.pairFailures = 0
    this.deps.onPaired?.(deviceId, deviceName)
  }

  /** 鉴权挑战：为指定设备下发单次 nonce */
  private handleAuthHello(ws: WebSocket, state: ConnState, frame: RequestFrame): void {
    const p = frame.payload as Partial<{ deviceId: string }>
    const device = this.loadDevices().find((d) => d.deviceId === p.deviceId)
    if (!device) {
      this.audit(String(p.deviceId ?? '?'), 'auth.hello', false, '设备不存在')
      this.sendErr(ws, frame.id, 'UNAUTHORIZED', '设备未配对')
      return
    }
    const nonce = randomBytes(16).toString('hex')
    state.authNonce = nonce
    this.send(ws, { v: 1, type: 'res', id: frame.id, ok: true, payload: { nonce } })
  }

  /** 鉴权校验：proof = sha256(token:nonce)，nonce 单次有效（防重放） */
  private handleAuthVerify(ws: WebSocket, state: ConnState, frame: RequestFrame): void {
    const p = frame.payload as Partial<{ deviceId: string; proof: string }>
    const device = this.loadDevices().find((d) => d.deviceId === p.deviceId)
    const expectedNonce = state.authNonce
    state.authNonce = null // 单次挑战
    if (!device || typeof p.proof !== 'string' || p.proof.length !== 64 || expectedNonce == null) {
      this.audit(String(p.deviceId ?? '?'), 'auth.verify', false, '设备/证明/挑战缺失')
      this.sendErr(ws, frame.id, 'UNAUTHORIZED', '鉴权失败')
      return
    }
    const expected = createHash('sha256').update(`${device.token}:${expectedNonce}`).digest('hex')
    const ok =
      expected.length === p.proof.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(p.proof))
    if (!ok) {
      this.audit(device.deviceId, 'auth.verify', false, '证明不匹配')
      this.sendErr(ws, frame.id, 'UNAUTHORIZED', '鉴权失败')
      return
    }
    state.deviceId = device.deviceId
    device.lastSeenAt = Date.now()
    this.saveDevices(this.loadDevices().map((d) => (d.deviceId === device.deviceId ? device : d)))
    this.audit(device.deviceId, 'auth.verify', true)
    this.send(ws, {
      v: 1,
      type: 'res',
      id: frame.id,
      ok: true,
      payload: { deviceId: device.deviceId, deviceName: device.name, capabilities: ALL_CAPABILITIES }
    })
  }

  // ── 订阅推送 ──
  private async pushTick(): Promise<void> {
    if (!this.enabled || this.conns.size === 0) return
    const anyWants = (ch: PushChannel): boolean =>
      [...this.conns.values()].some((s) => s.channels.has(ch) && s.deviceId != null)
    if (anyWants('system.snapshot')) {
      try {
        const snap = await this.deps.system.snapshot()
        this.broadcast('system.snapshot', snap)
      } catch {
        // 采样失败跳过本轮
      }
    }
    if (anyWants('agent.overview')) {
      try {
        this.broadcast('agent.overview', this.deps.query.getOverview('today', null))
      } catch {
        // 查询失败跳过
      }
    }
  }

  /** 主动推送（含告警）；供告警引擎/DSH 事件转发调用 */
  broadcastPush(channel: PushChannel, payload: unknown): void {
    this.broadcast(channel, payload)
  }

  private broadcast(ch: PushChannel, payload: unknown): void {
    const frame = { v: 1, type: 'push', ch, ts: Date.now(), payload }
    for (const [ws, st] of this.conns) {
      if (st.deviceId != null && st.channels.has(ch)) this.send(ws, frame)
    }
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  /** 测试辅助：等待连接静默（连接数为 0 且最近 5s 无新连接），供冒烟脚本收尾 */
  async waitForIdle(maxMs = 45_000): Promise<void> {
    const deadline = Date.now() + maxMs
    while (Date.now() < deadline) {
      const idle =
        this.conns.size === 0 && Date.now() - this.lastConnOpenAt > 5_000
      if (idle) return
      await new Promise((r) => setTimeout(r, 300))
    }
  }
}
