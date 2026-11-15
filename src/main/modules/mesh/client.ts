// Spoke 端 WebSocket 客户端（Nexus Mesh）。
// 复用 nexus-pair:// + 60s PIN + challenge-response 鉴权，并基于单调水位线增量推流。

import WebSocket from 'ws'
import { createHash, randomBytes } from 'node:crypto'
import os from 'node:os'
import type { NexusStore } from '@main/modules/aggregator/infrastructure/store'
import type { SystemCollector } from '@main/modules/system/collector'
import { logger } from '@main/modules/shared/logger'
import {
  parsePairUri,
  type AuthChallenge,
  type MeshHeartbeatResult,
  type MeshIngestAck,
  type MeshRegisterResult,
  type PairResult,
  type RemoteMethod,
  type ResponseFrame
} from '@shared/protocol'
import type {
  MeshHubConnectionConfig,
  MeshStatusInfo,
  MeshWatermark
} from '@shared/types'
import { classifyInterfaceAddress, type NodeIdentityService } from './identity'

const HUB_CONFIG_KEY = 'meshHubConfig'
const WATERMARK_KEY = 'meshAckedWatermark'
const HEARTBEAT_INTERVAL_MS = 15_000
const REQUEST_TIMEOUT_MS = 15_000
const BACKOFF_MS = [1500, 3000, 6000, 15_000, 30_000]

export interface PairHubInput {
  uri?: string
  host?: string
  port?: number
  pin?: string
  nonce?: string
  pairingSecret?: string
}

interface PendingReq {
  resolve: (payload: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export class MeshClient {
  private ws: WebSocket | null = null
  private connected = false
  private stopped = false
  private retryAttempt = 0
  private retryTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private syncInFlight: Promise<{ pushed: number; watermark: MeshWatermark }> | null = null
  private pending = new Map<string, PendingReq>()
  private lastSyncAt: number | null = null
  private lastError: string | null = null
  private lastRttMs: number | null = null

  constructor(
    private readonly store: NexusStore,
    private readonly identity: NodeIdentityService,
    private readonly system: SystemCollector,
    private readonly getActiveAgents: () => string[] = () => [],
    private readonly onChanged?: () => void
  ) {}

  loadConfig(): MeshHubConnectionConfig | null {
    const raw = this.store.getSetting(HUB_CONFIG_KEY)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Partial<MeshHubConnectionConfig>
      if (parsed.hubUrl && parsed.deviceId && parsed.token) {
        return {
          hubNodeId: parsed.hubNodeId ?? null,
          deviceId: parsed.deviceId,
          deviceName: parsed.deviceName || os.hostname(),
          hubUrl: parsed.hubUrl,
          token: parsed.token,
          pairedAt: Number(parsed.pairedAt) || Date.now()
        }
      }
    } catch {
      // 忽略损坏配置
    }
    return null
  }

  private saveConfig(cfg: MeshHubConnectionConfig): void {
    this.store.setSetting(HUB_CONFIG_KEY, JSON.stringify(cfg))
  }

  loadWatermark(): MeshWatermark {
    const raw = this.store.getSetting(WATERMARK_KEY)
    if (!raw) return { usageId: 0, toolId: 0, sessionSeq: 0 }
    try {
      const parsed = JSON.parse(raw) as Partial<MeshWatermark>
      return {
        usageId: Math.max(0, Number(parsed.usageId) || 0),
        toolId: Math.max(0, Number(parsed.toolId) || 0),
        sessionSeq: Math.max(0, Number(parsed.sessionSeq) || 0)
      }
    } catch {
      return { usageId: 0, toolId: 0, sessionSeq: 0 }
    }
  }

  private saveWatermark(w: MeshWatermark): void {
    this.store.setSetting(WATERMARK_KEY, JSON.stringify(w))
  }

  status(): MeshStatusInfo['hubConnection'] {
    const cfg = this.loadConfig()
    if (!cfg) return null
    return {
      connected: this.connected,
      hubUrl: cfg.hubUrl,
      hubNodeId: cfg.hubNodeId,
      lastSyncAt: this.lastSyncAt,
      ackedWatermark: this.loadWatermark(),
      lastError: this.lastError,
      rttMs: this.lastRttMs
    }
  }

  start(): void {
    this.stopped = false
    const cfg = this.loadConfig()
    if (!cfg) return
    if (this.identity.getEffectiveRole() !== 'spoke') return
    void this.connectExisting()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    this.rejectPending(new Error('MeshClient 已停止'))
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // 忽略关闭异常
      }
      this.ws = null
    }
    this.connected = false
  }

  disconnectHub(): void {
    this.stop()
    this.store.db.prepare('DELETE FROM settings WHERE key = ?').run(HUB_CONFIG_KEY)
    this.store.db.prepare('DELETE FROM settings WHERE key = ?').run(WATERMARK_KEY)
    this.lastSyncAt = null
    this.lastError = null
    this.lastRttMs = null
    this.stopped = false
    this.onChanged?.()
  }

  async pairWithHub(input: PairHubInput): Promise<void> {
    const params = input.uri
      ? parsePairUri(input.uri)
      : {
          host: String(input.host ?? '').trim(),
          port: Number(input.port),
          nonce: String(input.nonce ?? '').trim(),
          pairingSecret: String(input.pairingSecret ?? '').trim(),
          pin: String(input.pin ?? '').trim()
        }
    if (!params.host || !Number.isInteger(params.port) || params.port <= 0) {
      throw new Error('缺少有效的 Hub 主机或端口')
    }
    if (!params.nonce || !params.pairingSecret || !/^\d{6}$/.test(params.pin)) {
      throw new Error('配对参数不完整，请直接粘贴 nexus-pair:// 完整配对串')
    }

    this.clearTimers()
    this.stopped = false
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // 忽略旧连接关闭
      }
      this.ws = null
    }
    this.connected = false

    const hubUrl = `ws://${params.host}:${params.port}`
    const ws = await this.openSocket(hubUrl)
    this.attachSocket(ws, false)

    const proof = createHash('sha256')
      .update(`${params.pairingSecret}:${params.nonce}:${params.pin}`)
      .digest('hex')
    const deviceName = this.identity.getAlias() || os.hostname()
    const pairRes = (await this.request(ws, 'pair', {
      nonce: params.nonce,
      proof,
      pin: params.pin,
      deviceName
    })) as PairResult

    const token = createHash('sha256')
      .update(`${params.pairingSecret}:${pairRes.deviceId}:${params.nonce}`)
      .digest('hex')

    const prevCfg = this.loadConfig()
    this.identity.setRoleOverride('spoke')
    const cfg: MeshHubConnectionConfig = {
      hubNodeId: prevCfg?.hubNodeId ?? null,
      deviceId: pairRes.deviceId,
      deviceName,
      hubUrl,
      token,
      pairedAt: Date.now()
    }
    this.saveConfig(cfg)
    await this.afterAuthenticated(ws, cfg)
  }

  private async connectExisting(): Promise<void> {
    if (this.stopped || this.ws) return
    const cfg = this.loadConfig()
    if (!cfg || this.identity.getEffectiveRole() !== 'spoke') return

    let activeWs: WebSocket | null = null
    try {
      const ws = await this.openSocket(cfg.hubUrl)
      if (this.stopped) {
        ws.close()
        return
      }
      activeWs = ws
      this.attachSocket(ws, true)
      const challenge = (await this.request(ws, 'auth.hello', {
        deviceId: cfg.deviceId
      })) as AuthChallenge
      const proof = createHash('sha256').update(`${cfg.token}:${challenge.nonce}`).digest('hex')
      await this.request(ws, 'auth.verify', {
        deviceId: cfg.deviceId,
        proof
      })
      await this.afterAuthenticated(ws, cfg)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.lastError = msg
      this.connected = false
      if (activeWs) {
        try {
          activeWs.close()
        } catch {
          // 忽略关闭异常
        }
        if (this.ws === activeWs) this.ws = null
      }
      logger.warn('mesh.connect_failed', { error: msg, hubUrl: cfg.hubUrl })
      this.onChanged?.()
      this.scheduleReconnect()
    }
  }

  private async afterAuthenticated(ws: WebSocket, cfg: MeshHubConnectionConfig): Promise<void> {
    const snap = await this.quickSystemSnapshot()
    const profile = this.identity.buildProfile(snap, this.getActiveAgents())
    const t0 = performance.now()
    const reg = (await this.request(ws, 'mesh.register', { profile })) as MeshRegisterResult
    this.lastRttMs = Math.max(0, Math.round(performance.now() - t0))
    this.connected = true
    this.retryAttempt = 0
    this.lastError = null

    const hubChanged = cfg.hubNodeId != null && cfg.hubNodeId !== reg.hubProfile.nodeId
    cfg.hubNodeId = reg.hubProfile.nodeId
    this.saveConfig(cfg)

    // 记入本地 mesh_nodes 便于 UI 展示远端 Hub 档案
    const hubHost = new URL(cfg.hubUrl).hostname
    const hubTransport = classifyInterfaceAddress(hubHost).transport
    this.store.upsertMeshNode({
      nodeId: reg.hubProfile.nodeId,
      hostname: reg.hubProfile.hostname,
      alias: reg.hubProfile.alias,
      kind: reg.hubProfile.kind,
      role: 'hub',
      transport: hubTransport,
      endpoint: cfg.hubUrl,
      rttMs: this.lastRttMs,
      lastSeenAt: Date.now(),
      hwSummary: reg.hubProfile.hwSummary,
      activeAgents: reg.hubProfile.activeAgents
    })

    // 若配对到全新 Hub 从头同步，否则以 Hub 返回的确认水位线与本地较小者对齐防漏传
    const localW = this.loadWatermark()
    const aligned: MeshWatermark = hubChanged
      ? reg.ackedWatermark
      : {
          usageId: Math.min(localW.usageId, reg.ackedWatermark.usageId),
          toolId: Math.min(localW.toolId, reg.ackedWatermark.toolId),
          sessionSeq: Math.min(localW.sessionSeq, reg.ackedWatermark.sessionSeq)
        }
    this.saveWatermark(aligned)

    this.startHeartbeat()
    this.onChanged?.()
    await this.syncDelta()
  }

  async syncDelta(): Promise<{ pushed: number; watermark: MeshWatermark }> {
    if (this.syncInFlight) return this.syncInFlight
    this.syncInFlight = this.runSyncDelta().finally(() => {
      this.syncInFlight = null
    })
    return this.syncInFlight
  }

  private async runSyncDelta(): Promise<{ pushed: number; watermark: MeshWatermark }> {
    let watermark = this.loadWatermark()
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return { pushed: 0, watermark }
    }
    let pushed = 0
    try {
      while (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        const chunk = this.store.exportLocalDelta(watermark)
        const totalItems = chunk.usage.length + chunk.sessions.length + chunk.tools.length
        if (totalItems === 0) break

        const ack = (await this.request(this.ws, 'mesh.ingest', {
          nodeId: this.identity.nodeId,
          usage: chunk.usage,
          sessions: chunk.sessions,
          tools: chunk.tools,
          watermarkAfter: chunk.nextWatermark
        })) as MeshIngestAck

        watermark = ack.ackedWatermark
        this.saveWatermark(watermark)
        pushed += totalItems
        this.lastSyncAt = Date.now()
        this.lastError = null
        if (!chunk.hasMore) break
      }
      if (pushed > 0) this.onChanged?.()
      return { pushed, watermark }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      logger.warn('mesh.sync_delta_failed', { error: this.lastError })
      this.onChanged?.()
      throw err
    }
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const cfg = this.loadConfig()
    if (!cfg) return
    try {
      const snap = await this.quickSystemSnapshot()
      const hwSummary = this.identity.buildHardwareSummary(snap)
      const t0 = performance.now()
      const res = (await this.request(this.ws, 'mesh.heartbeat', {
        nodeId: this.identity.nodeId,
        hwSummary,
        activeAgents: this.getActiveAgents(),
        sentAt: Date.now(),
        lastRttMs: this.lastRttMs
      })) as MeshHeartbeatResult
      this.lastRttMs = Math.max(0, Math.round(performance.now() - t0))
      if (cfg.hubNodeId) {
        const hubRecord = this.store.getMeshNodeRecord(cfg.hubNodeId)
        if (hubRecord) {
          this.store.upsertMeshNode({
            nodeId: hubRecord.nodeId,
            hostname: hubRecord.hostname,
            alias: hubRecord.alias,
            kind: hubRecord.kind,
            role: res.hubRole,
            transport: hubRecord.transport,
            endpoint: hubRecord.endpoint,
            rttMs: this.lastRttMs,
            lastSeenAt: Date.now()
          })
        }
      }
      this.onChanged?.()
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      logger.warn('mesh.heartbeat_failed', { error: this.lastError })
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat()
    }, HEARTBEAT_INTERVAL_MS)
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return
    const cfg = this.loadConfig()
    if (!cfg || this.identity.getEffectiveRole() !== 'spoke') return
    const delay = BACKOFF_MS[Math.min(this.retryAttempt, BACKOFF_MS.length - 1)]
    this.retryAttempt += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.connectExisting()
    }, delay)
  }

  private clearTimers(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private openSocket(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      const timer = setTimeout(() => {
        try {
          ws.terminate()
        } catch {
          // 忽略超时中止
        }
        reject(new Error(`连接 Hub 超时 (${url})`))
      }, 8000)
      ws.once('open', () => {
        clearTimeout(timer)
        resolve(ws)
      })
      ws.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  private attachSocket(ws: WebSocket, autoReconnect: boolean): void {
    this.ws = ws
    ws.on('message', (data) => {
      try {
        const frame = JSON.parse(String(data)) as ResponseFrame & { type?: string }
        if (frame.type !== 'res' || !frame.id) return
        const p = this.pending.get(frame.id)
        if (!p) return
        this.pending.delete(frame.id)
        clearTimeout(p.timer)
        if (frame.ok) p.resolve(frame.payload)
        else p.reject(new Error(frame.error || '远端请求失败'))
      } catch {
        // 忽略非预期消息
      }
    })
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null
      this.connected = false
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer)
        this.heartbeatTimer = null
      }
      this.rejectPending(new Error('与 Hub 连接断开'))
      this.onChanged?.()
      if (autoReconnect && !this.stopped) this.scheduleReconnect()
    })
    ws.on('error', (err) => {
      this.lastError = err.message
    })
  }

  private request(ws: WebSocket, method: RemoteMethod, payload: unknown): Promise<unknown> {
    if (ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket 未连接'))
    }
    const id = randomBytes(6).toString('hex')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC 超时: ${method}`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ v: 1, type: 'req', id, method, payload }))
    })
  }

  private rejectPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  private async quickSystemSnapshot(): Promise<Awaited<ReturnType<SystemCollector['snapshot']>> | null> {
    return Promise.race([
      this.system.snapshot().catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), 500))
    ])
  }
}
