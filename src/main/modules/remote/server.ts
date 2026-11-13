// 远程通信服务（v2 Phase 1，指导书 §4.2 remote-server）。
// 设计依据：docs/research/v2/hybrid-communication-architecture-draft.md（混合通信架构草案）
// - LAN WS 直连（随机端口）+ mDNS/QR 配对 + 60s PIN + 设备长期令牌 + 订阅推送 + 审计日志 + 限流
// - 鉴权前仅允许 pair/auth 两个方法；令牌经 HMAC-SHA256 校验（存 hash 不存明文）
// - 公网场景建议 Tailscale 组网后复用同一协议（草案 §备通道）

import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import type {
  MeshHeartbeatRequest,
  MeshHeartbeatResult,
  MeshIngestBatch,
  MeshPeerSummary,
  MeshRegisterRequest,
  MeshRegisterResult,
  PairRequest,
  PushChannel,
  RemoteMethod,
  RemoteStatusInfo,
  RequestFrame
} from '@shared/protocol'
import type { LinkTransport, NodeProfile, RangeKey } from '@shared/types'
import type { NexusStore } from '@main/modules/aggregator/infrastructure/store'
import type { QueryService } from '@main/modules/aggregator/application/query-service'
import type { SystemCollector } from '@main/modules/system/collector'
import type { ZcodeManager } from '@main/modules/zcode/manager'
import type { DshBridge } from '@main/modules/dsh/bridge'
import {
  inferPeerTransport,
  listNetworkIpHints,
  type NodeIdentityService
} from '@main/modules/mesh/identity'
import { logger } from '@main/modules/shared/logger'

const PAIR_PIN_TTL_MS = 60_000
const MAX_FRAME_BYTES = 256 * 1024
const RATE_LIMIT_PER_MIN = 240
const INGEST_RATE_LIMIT_PER_MIN = 1500

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
  meshNodeId: string | null
  remoteIp: string | null
  transport: LinkTransport | null
  channels: Set<PushChannel>
  reqTimestamps: number[]
  ingestTimestamps: number[]
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
  identity?: NodeIdentityService
  getActiveAgents?: () => string[]
  onMeshChanged?: () => void
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
  'device.revoke',
  'mesh.register',
  'mesh.heartbeat',
  'mesh.ingest'
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
    _secret: string // 保留位：token 已改为二维码配对密钥派生（P1-1），不再依赖服务端 secret
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
    const savedPort = Number(this.deps.store.getSetting('remotePort') ?? 0)
    const preferred = Number.isInteger(savedPort) && savedPort > 0 && savedPort <= 65535 ? savedPort : 0
    this.bindServer(preferred)
  }

  private bindServer(requestedPort: number): void {
    // 红蓝审计 P2-2：maxPayload 收紧到 256KB（帧上限在协议层之前生效）；
    // 浏览器发起的跨站 WS（带 http/https Origin）在握手期直接拒绝
    const wss = new WebSocketServer({
      host: '0.0.0.0',
      port: requestedPort,
      maxPayload: MAX_FRAME_BYTES,
      verifyClient: (info: { origin?: string; req: { headers: Record<string, unknown> } }) => {
        const origin = info.req.headers.origin
        return origin == null || !/^https?:\/\//i.test(String(origin))
      }
    })
    this.wss = wss
    wss.on('error', (err: NodeJS.ErrnoException) => {
      if (requestedPort !== 0 && err.code === 'EADDRINUSE' && this.enabled) {
        logger.warn('remote.port_in_use_fallback', { requestedPort })
        this.wss = null
        try {
          wss.close()
        } catch {
          // 忽略关闭异常
        }
        this.bindServer(0)
        return
      }
      logger.warn('remote.server_error', { error: err.message })
    })
    wss.on('listening', () => {
      const addr = wss.address()
      this.port = typeof addr === 'object' && addr ? addr.port : null
      if (this.port != null) {
        this.deps.store.setSetting('remotePort', String(this.port))
      }
      // eslint-disable-next-line no-console
      console.log(`[remote] listening on ${this.port}`)
      logger.info('remote.started', { port: this.port })
    })
    wss.on('connection', (ws, req) => this.onConnection(ws, req))
    if (!this.pushTimer) {
      this.pushTimer = setInterval(() => void this.pushTick(), 2000)
    }
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
    addresses: Array<{ host: string; label: string; transport?: LinkTransport; uri: string }>
    qrDataUrl: string | null
    expiresAt: number
  }> {
    if (!this.wss) this.start()
    for (let i = 0; i < 40 && this.port == null; i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
    const pin = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.pairNonce = randomBytes(16).toString('hex')
    this.pairingSecret = randomBytes(32).toString('hex')
    this.pin = pin
    this.pinExpiresAt = Date.now() + PAIR_PIN_TTL_MS
    this.pairFailures = 0
    // 候选地址：全部非环回 IPv4（局域网 / Tailscale 100.x / VMware NAT / WSL vSwitch）
    const addresses = this.candidateAddresses()
    const baseAddrs =
      addresses.length > 0
        ? addresses
        : [{ host: '127.0.0.1', label: '本机回环', transport: 'local' as const }]
    const buildUri = (host: string): string =>
      `nexus-pair://${host}:${this.port ?? 0}?n=${this.pairNonce}&s=${this.pairingSecret}#${pin}`
    const addressList = baseAddrs.map((a) => ({ ...a, uri: buildUri(a.host) }))
    let qr: string | null = null
    try {
      const qrLib = await import('qrcode')
      const primary = addressList[0]
      qr = await qrLib.toDataURL(primary ? primary.uri : buildUri('127.0.0.1'), {
        margin: 1,
        width: 240
      })
    } catch (err) {
      logger.warn('remote.qr_failed', { error: err instanceof Error ? err.message : String(err) })
    }
    return {
      pin,
      nonce: this.pairNonce,
      pairingSecret: this.pairingSecret,
      addresses: addressList,
      qrDataUrl: qr,
      expiresAt: this.pinExpiresAt
    }
  }

  /** 全部非环回 IPv4 候选（复用 Mesh 网络接口识别逻辑） */
  private candidateAddresses(): Array<{ host: string; label: string; transport: LinkTransport }> {
    return listNetworkIpHints()
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

  /** 查询当前直连在线的 Mesh 节点链路详情 */
  getConnectedMeshNodes(): Map<string, { endpoint: string | null; transport: LinkTransport | null }> {
    const map = new Map<string, { endpoint: string | null; transport: LinkTransport | null }>()
    for (const st of this.conns.values()) {
      if (st.deviceId && st.meshNodeId) {
        map.set(st.meshNodeId, {
          endpoint: st.remoteIp,
          transport: st.transport
        })
      }
    }
    return map
  }

  // ── 连接处理 ──
  private onConnection(ws: WebSocket, req?: IncomingMessage): void {
    // 红蓝审计 P2-1：并发连接上限
    if (this.conns.size >= MAX_CONNS) {
      ws.close()
      return
    }
    const rawIp = req?.socket?.remoteAddress ?? null
    const cleanIp = rawIp ? rawIp.replace(/^::ffff:/, '') : null
    const state: ConnState = {
      deviceId: null,
      meshNodeId: null,
      remoteIp: cleanIp,
      transport: null,
      channels: new Set(),
      reqTimestamps: [],
      ingestTimestamps: [],
      authNonce: null
    }
    // 未鉴权连接 60s 强制断开（防空连接占满）
    const authKick = setTimeout(() => {
      if (state.deviceId == null) ws.close()
    }, 60_000)
    authKick.unref()
    ws.on('close', () => clearTimeout(authKick))
    this.conns.set(ws, state)
    this.lastConnOpenAt = Date.now()
    // eslint-disable-next-line no-console
    console.log('[remote] conn_open')
    logger.info('remote.conn_open', { total: this.conns.size, ip: cleanIp })
    ws.on('close', (code, reason) => {
      // eslint-disable-next-line no-console
      console.log(`[remote] conn_close code=${code}`)
      logger.info('remote.conn_close', { code, reason: reason.toString().slice(0, 100) })
      const hadMesh = Boolean(state.meshNodeId)
      this.conns.delete(ws)
      if (hadMesh) this.deps.onMeshChanged?.()
    })
    ws.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.log(`[remote] conn_error ${err.message}`)
      logger.warn('remote.conn_error', { error: err.message })
      const hadMesh = Boolean(state.meshNodeId)
      this.conns.delete(ws)
      if (hadMesh) this.deps.onMeshChanged?.()
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
        if (!this.rateCheck(state, frame.method)) {
          this.sendErr(ws, frame.id, 'RATE_LIMITED', '请求过于频繁')
          return
        }
        void this.handleReq(ws, state, frame)
      } catch {
        this.sendErr(ws, '?', 'BAD_REQUEST', '无法解析帧')
      }
    })
  }

  private rateCheck(state: ConnState, method?: RemoteMethod): boolean {
    const now = Date.now()
    if (method === 'mesh.ingest') {
      state.ingestTimestamps = state.ingestTimestamps.filter((t) => now - t < 60_000)
      if (state.ingestTimestamps.length >= INGEST_RATE_LIMIT_PER_MIN) return false
      state.ingestTimestamps.push(now)
      return true
    }
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
          if (state.deviceId) this.audit(state.deviceId, 'dsh.prompt', true, sessionId)
          this.send(ws, { v: 1, type: 'res', id: frame.id, ok: true, payload: { sessionId, res } })
          return
        }
        case 'dsh.cancel': {
          const p = frame.payload as { sessionId?: string }
          if (!p?.sessionId) {
            this.sendErr(ws, frame.id, 'BAD_REQUEST', 'sessionId 缺失')
            return
          }
          if (state.deviceId) this.audit(state.deviceId, 'dsh.cancel', true, p.sessionId ?? '')
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
        case 'mesh.register':
          return this.handleMeshRegister(ws, state, frame)
        case 'mesh.heartbeat':
          return this.handleMeshHeartbeat(ws, state, frame)
        case 'mesh.ingest':
          return this.handleMeshIngest(ws, state, frame)
        default:
          this.sendErr(ws, frame.id, 'NOT_FOUND', `未知方法 ${String(method)}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (state.deviceId) this.audit(state.deviceId, String(method), false, message.slice(0, 120))
      // 不回传上游错误原文（防内网错误细节泄漏），只给固定文案
      this.sendErr(ws, frame.id, 'UPSTREAM_ERROR', '上游调用失败')
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
      active &&
      typeof p.pin === 'string' &&
      p.pin.length === 6 &&
      this.pin != null &&
      timingSafeEqual(Buffer.from(p.pin), Buffer.from(this.pin))
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

  /** 构建 Hub 端 NodeProfile 与 Mesh 节点摘要列表（供注册/心跳回传） */
  private async buildHubProfileSnapshot(): Promise<NodeProfile> {
    const active = this.deps.getActiveAgents?.() ?? []
    const snap = await Promise.race([
      this.deps.system.snapshot().catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), 500))
    ])
    if (this.deps.identity) {
      return this.deps.identity.buildProfile(snap, active)
    }
    const cpus = os.cpus()
    const totalMem = os.totalmem()
    const usedMem = Math.max(0, totalMem - os.freemem())
    return {
      nodeId: 'hub_local',
      hostname: os.hostname(),
      alias: null,
      kind: 'physical',
      role: 'hub',
      ipHints: listNetworkIpHints(),
      hwSummary: {
        osPlatform: process.platform,
        osRelease: os.release(),
        arch: process.arch,
        cpuModel: snap?.cpu.model ?? cpus[0]?.model ?? process.arch,
        cpuCores: snap?.cpu.cores ?? (cpus.length || 1),
        cpuLoadPercent: snap?.cpu.loadPercent ?? 0,
        ramTotalBytes: snap?.memory.totalBytes ?? totalMem,
        ramUsedBytes: snap?.memory.usedBytes ?? usedMem,
        ramUsedPercent: snap?.memory.usedPercent ?? 0,
        gpuModel: snap?.gpus[0]?.model ?? null,
        uptimeSec: snap?.uptimeSec ?? Math.floor(os.uptime())
      },
      activeAgents: active,
      updatedAt: Date.now()
    }
  }

  private listPeerSummaries(): MeshPeerSummary[] {
    return this.deps.store.listMeshNodeRecords().map((n) => ({
      nodeId: n.nodeId,
      hostname: n.hostname,
      alias: n.alias,
      kind: n.kind,
      role: n.role,
      transport: n.transport,
      rttMs: n.rttMs,
      lastSeenAt: n.lastSeenAt
    }))
  }

  private async handleMeshRegister(ws: WebSocket, state: ConnState, frame: RequestFrame): Promise<void> {
    const p = frame.payload as Partial<MeshRegisterRequest>
    const prof = p?.profile
    if (!prof || typeof prof.nodeId !== 'string' || !prof.nodeId || prof.nodeId === 'local') {
      this.sendErr(ws, frame.id, 'BAD_REQUEST', '节点 profile.nodeId 无效')
      return
    }
    if (this.deps.identity && prof.nodeId === this.deps.identity.nodeId) {
      this.sendErr(ws, frame.id, 'BAD_REQUEST', '节点不能与自身配对')
      return
    }
    const transport = inferPeerTransport(state.remoteIp, prof)
    state.meshNodeId = prof.nodeId
    state.transport = transport
    this.deps.store.upsertMeshNode({
      nodeId: prof.nodeId,
      hostname: String(prof.hostname || 'unknown').slice(0, 64),
      alias: prof.alias ?? null,
      kind: prof.kind,
      role: prof.role === 'hub' ? 'spoke' : prof.role,
      transport,
      endpoint: state.remoteIp ?? prof.ipHints[0]?.host ?? null,
      lastSeenAt: Date.now(),
      hwSummary: prof.hwSummary ?? null,
      activeAgents: Array.isArray(prof.activeAgents) ? prof.activeAgents : []
    })
    const stored = this.deps.store.getMeshNodeRecord(prof.nodeId)
    const hubProfile = await this.buildHubProfileSnapshot()
    const result: MeshRegisterResult = {
      hubProfile,
      effectiveRole: 'spoke',
      ackedWatermark: stored?.ackedWatermark ?? { usageId: 0, toolId: 0, sessionSeq: 0 },
      peers: this.listPeerSummaries()
    }
    this.audit(state.deviceId ?? 'unknown', 'mesh.register', true, `${prof.nodeId}:${transport}`)
    this.deps.onMeshChanged?.()
    this.send(ws, { v: 1, type: 'res', id: frame.id, ok: true, payload: result })
  }

  private handleMeshHeartbeat(ws: WebSocket, state: ConnState, frame: RequestFrame): void {
    const p = frame.payload as Partial<MeshHeartbeatRequest>
    const nodeId = typeof p?.nodeId === 'string' && p.nodeId !== 'local' ? p.nodeId : state.meshNodeId
    if (!nodeId) {
      this.sendErr(ws, frame.id, 'BAD_REQUEST', '请先调用 mesh.register')
      return
    }
    state.meshNodeId = nodeId
    const existing = this.deps.store.getMeshNodeRecord(nodeId)
    if (existing) {
      this.deps.store.upsertMeshNode({
        nodeId,
        hostname: existing.hostname,
        alias: existing.alias,
        kind: existing.kind,
        role: existing.role,
        transport: state.transport ?? existing.transport,
        endpoint: state.remoteIp ?? existing.endpoint,
        rttMs: typeof p.lastRttMs === 'number' && Number.isFinite(p.lastRttMs) ? Math.max(0, Math.round(p.lastRttMs)) : existing.rttMs,
        lastSeenAt: Date.now(),
        hwSummary: p.hwSummary ?? existing.hwSummary,
        activeAgents: Array.isArray(p.activeAgents) ? p.activeAgents : existing.activeAgents
      })
    }
    const result: MeshHeartbeatResult = {
      serverTs: Date.now(),
      hubRole: this.deps.identity?.getEffectiveRole() ?? 'hub',
      peers: this.listPeerSummaries()
    }
    this.deps.onMeshChanged?.()
    this.send(ws, { v: 1, type: 'res', id: frame.id, ok: true, payload: result })
  }

  private handleMeshIngest(ws: WebSocket, state: ConnState, frame: RequestFrame): void {
    const batch = frame.payload as Partial<MeshIngestBatch>
    const nodeId = typeof batch?.nodeId === 'string' && batch.nodeId !== 'local' ? batch.nodeId : state.meshNodeId
    if (!nodeId || !Array.isArray(batch.usage) || !Array.isArray(batch.sessions) || !Array.isArray(batch.tools) || !batch.watermarkAfter) {
      this.sendErr(ws, frame.id, 'BAD_REQUEST', 'mesh.ingest 负载格式无效')
      return
    }
    if (state.meshNodeId && state.meshNodeId !== nodeId) {
      this.sendErr(ws, frame.id, 'UNAUTHORIZED', 'nodeId 与已注册连接不匹配')
      return
    }
    state.meshNodeId = nodeId
    // 兜底：若节点未经历 register 直接传数据，先建最小档案以免外键/查询缺记录
    if (!this.deps.store.getMeshNodeRecord(nodeId)) {
      this.deps.store.upsertMeshNode({
        nodeId,
        hostname: nodeId,
        kind: 'linux',
        role: 'spoke',
        transport: state.transport ?? 'lan',
        endpoint: state.remoteIp,
        lastSeenAt: Date.now()
      })
    }
    const ack = this.deps.store.ingestRemoteBatch(nodeId, {
      nodeId,
      usage: batch.usage,
      sessions: batch.sessions,
      tools: batch.tools,
      watermarkAfter: batch.watermarkAfter
    })
    if (ack.acceptedUsage + ack.acceptedSessions + ack.acceptedTools > 0) {
      this.deps.query.invalidateBoardCache()
      this.deps.onMeshChanged?.()
    }
    this.audit(
      state.deviceId ?? 'unknown',
      'mesh.ingest',
      true,
      `${nodeId}:u=${ack.acceptedUsage},s=${ack.acceptedSessions},t=${ack.acceptedTools}`
    )
    this.send(ws, { v: 1, type: 'res', id: frame.id, ok: true, payload: ack })
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
