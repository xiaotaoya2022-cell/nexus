// 连接层：Nexus 远程协议 v1 客户端（契约见 src/shared/protocol.ts，与 PC 端单一事实源）。
// - 配对：pair {nonce, proof=sha256(s:n:pin), pin, deviceName} → {deviceId}，
//   token = sha256(s:deviceId:n) 本地推导，令牌永不上线（红蓝审计 P1-1）
// - 鉴权：auth.hello {deviceId} → {challenge nonce} → auth.verify {deviceId,
//   proof=sha256(token:nonce)} → {capabilities}，挑战单次有效
// - 重连退避 1s/2s/5s/10s 封顶，鉴权成功后清零
// - 请求 Promise map（id 关联响应 + 超时）
// - 订阅缓存：断线重连鉴权成功后自动重发 subscribe
// - 状态与推送经回调广播（store.ts 桥接到 zustand）

import { sha256 } from 'js-sha256'
import type {
  AuthChallenge,
  AuthVerifyRequest,
  PairRequest,
  PairResult,
  PushChannel,
  RemoteFrame,
  RemoteMethod,
  RequestFrame,
  ResponseFrame
} from '@shared/protocol'

export type ConnStatus = 'disconnected' | 'connecting' | 'authing' | 'online' | 'error'

export interface ConnStatusInfo {
  status: ConnStatus
  detail: string | null
  retryInMs: number | null // 下次重连等待（disconnected 且将重连时非空）
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000]
const REQ_TIMEOUT_MS = 10_000

type StatusListener = (info: ConnStatusInfo) => void
type PushListener = (payload: unknown, ts: number) => void

interface Pending {
  resolve: (payload: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function nextId(): string {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export class NexusConnection {
  private ws: WebSocket | null = null
  private url = ''
  private deviceId = ''
  private token = ''

  private pending = new Map<string, Pending>()
  private subs = new Map<PushChannel, Set<PushListener>>()
  private statusListeners = new Set<StatusListener>()

  private backoffIdx = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private manualClose = false

  private _status: ConnStatusInfo = { status: 'disconnected', detail: null, retryInMs: null }

  get status(): ConnStatusInfo {
    return this._status
  }

  get isConfigured(): boolean {
    return this.url !== '' && this.deviceId !== '' && this.token !== ''
  }

  onStatus(cb: StatusListener): () => void {
    this.statusListeners.add(cb)
    cb(this._status)
    return () => {
      this.statusListeners.delete(cb)
    }
  }

  private setStatus(status: ConnStatus, detail: string | null = null, retryInMs: number | null = null): void {
    this._status = { status, detail, retryInMs }
    for (const cb of this.statusListeners) cb(this._status)
  }

  // ── 生命周期 ──
  connect(url: string, deviceId: string, token: string): void {
    this.disconnect(true)
    this.url = url
    this.deviceId = deviceId
    this.token = token
    this.manualClose = false
    this.backoffIdx = 0
    this.open()
  }

  disconnect(silent = false): void {
    if (!silent) this.manualClose = true
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.failAllPending('连接已断开')
    const ws = this.ws
    this.ws = null
    if (ws != null) {
      ws.onopen = null
      ws.onmessage = null
      ws.onclose = null
      ws.onerror = null
      try {
        ws.close()
      } catch {
        /* noop */
      }
    }
    if (!silent) this.setStatus('disconnected', '已手动断开')
  }

  private open(): void {
    this.setStatus('connecting', '连接中')
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch (err) {
      this.scheduleReconnect(`地址无效：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.setStatus('authing', '鉴权中')
      // 两步挑战式鉴权（红蓝审计 P1-1）：token 永不上线，
      // proof = sha256(token:challengeNonce)，挑战由 auth.hello 下发且单次有效。
      void (async () => {
        const hello = await this.request('auth.hello', { deviceId: this.deviceId }, 8_000)
        const { nonce } = hello as AuthChallenge
        const proof = sha256(`${this.token}:${nonce}`)
        const verify: AuthVerifyRequest = { deviceId: this.deviceId, proof }
        await this.request('auth.verify', verify, 8_000)
      })()
        .then(() => {
          this.backoffIdx = 0
          this.setStatus('online', null)
          this.resubscribeAll()
        })
        .catch((err: Error) => {
          if (
            err.message.includes('UNAUTHORIZED') ||
            err.message.includes('鉴权') ||
            err.message.includes('配对')
          ) {
            // 令牌失效（PC 端吊销/数据重置）：停止自动重连，等待用户重新配对
            this.manualClose = true
            this.teardownSocket()
            this.failAllPending('鉴权失败')
            this.setStatus('error', '鉴权失败：请在 PC 端重新生成配对码并配对')
          } else {
            // 服务器保持连接打开，先关闭旧 socket 再调度重连，避免泄漏
            this.teardownSocket()
            this.scheduleReconnect(`鉴权失败：${err.message}`)
          }
        })
    }
    ws.onmessage = (ev: MessageEvent) => this.onRawMessage(ev.data)
    ws.onclose = (ev: CloseEvent) => {
      this.failAllPending('连接已断开')
      if (this.manualClose || this.ws !== ws) return
      this.scheduleReconnect(`连接断开（code=${ev.code}）`)
    }
    ws.onerror = () => {
      /* close 事件随后触发，由 onclose 统一调度重连 */
    }
  }

  /** 关闭当前 socket 并摘除事件（防止 onclose 再触发重连调度） */
  private teardownSocket(): void {
    const cur = this.ws
    this.ws = null
    if (cur != null) {
      cur.onopen = null
      cur.onmessage = null
      cur.onclose = null
      cur.onerror = null
      try {
        cur.close()
      } catch {
        /* noop */
      }
    }
  }

  private scheduleReconnect(detail: string): void {
    this.ws = null
    const wait = BACKOFF_MS[Math.min(this.backoffIdx, BACKOFF_MS.length - 1)]
    this.backoffIdx += 1
    this.setStatus('disconnected', detail, wait)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.manualClose && this.isConfigured) this.open()
    }, wait)
  }

  // ── 帧收发 ──
  private send(frame: RequestFrame): void {
    const ws = this.ws
    if (ws != null && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
  }

  private onRawMessage(raw: unknown): void {
    if (typeof raw !== 'string') return
    let frame: RemoteFrame
    try {
      frame = JSON.parse(raw) as RemoteFrame
    } catch {
      return
    }
    if (frame.v !== 1) return
    if (frame.type === 'res') this.onResponse(frame)
    else if (frame.type === 'push') this.dispatchPush(frame.ch, frame.ts, frame.payload)
  }

  request<T = unknown>(method: RemoteMethod, payload?: unknown, timeoutMs = REQ_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const ws = this.ws
      if (ws == null || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('未连接'))
        return
      }
      const id = nextId()
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`请求超时：${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (p: unknown) => void, reject, timer })
      this.send({ v: 1, type: 'req', id, method, payload: payload ?? {} })
    })
  }

  private onResponse(frame: ResponseFrame): void {
    const p = this.pending.get(frame.id)
    if (p == null) return
    this.pending.delete(frame.id)
    clearTimeout(p.timer)
    if (frame.ok) p.resolve(frame.payload)
    else p.reject(new Error(frame.error ?? '未知错误'))
  }

  private failAllPending(msg: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(msg))
    }
    this.pending.clear()
  }

  // ── 订阅（含缓存；重连后自动重发）──
  onPush<T = unknown>(ch: PushChannel, cb: (payload: T, ts: number) => void): () => void {
    let set = this.subs.get(ch)
    if (set == null) {
      set = new Set()
      this.subs.set(ch, set)
    }
    set.add(cb as PushListener)
    void this.ensureSubscribed([ch])
    return () => {
      const s = this.subs.get(ch)
      if (s == null) return
      s.delete(cb as PushListener)
      if (s.size === 0) {
        this.subs.delete(ch)
        void this.fireAndForget('unsubscribe', { channels: [ch] })
      }
    }
  }

  private async ensureSubscribed(channels: PushChannel[]): Promise<void> {
    if (channels.length === 0) return
    if (this._status.status !== 'online') return // 离线时由 resubscribeAll 兜底
    try {
      await this.request('subscribe', { channels }, 5_000)
    } catch {
      /* 失败则依赖 resubscribeAll */
    }
  }

  private resubscribeAll(): void {
    const channels = [...this.subs.keys()]
    void this.ensureSubscribed(channels)
  }

  private dispatchPush(ch: PushChannel, ts: number, payload: unknown): void {
    const set = this.subs.get(ch)
    if (set == null) return
    for (const cb of set) {
      try {
        cb(payload, ts)
      } catch {
        /* 单个订阅者异常不影响其他 */
      }
    }
  }

  private async fireAndForget(method: RemoteMethod, payload: unknown): Promise<void> {
    try {
      await this.request(method, payload, 5_000)
    } catch {
      /* noop */
    }
  }
}

export const conn = new NexusConnection()

/** 配对所需二维码内容（nexus-pair://host:port?n=<nonce>&s=<pairingSecret>#<pin>） */
export interface PairInput {
  nonce: string
  pairingSecret: string
  pin: string
  deviceName: string
}

/** 配对结果：仅 deviceId 上线；token 由双方从二维码内容独立推导（红蓝审计 P1-1） */
export interface PairedCredentials {
  deviceId: string
  /** sha256(pairingSecret:deviceId:nonce)，本地持久化，代替旧 token 字段语义 */
  token: string
}

/** 一次性配对：独立短连接。proof = sha256(pairingSecret:nonce:pin) 证明持有二维码内容，
 * 响应只含 deviceId，token 由本地推导——秘密与令牌均不经网络明文。 */
export function pairOnce(
  host: string,
  port: string | number,
  input: PairInput,
  timeoutMs = 10_000
): Promise<PairedCredentials> {
  return new Promise((resolve, reject) => {
    let settled = false
    let ws: WebSocket
    try {
      ws = new WebSocket(`ws://${host}:${port}`)
    } catch (err) {
      reject(new Error(`地址无效：${err instanceof Error ? err.message : String(err)}`))
      return
    }
    const finish = (err: Error | null, result?: PairedCredentials) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ws.onopen = null
      ws.onmessage = null
      ws.onclose = null
      ws.onerror = null
      try {
        ws.close()
      } catch {
        /* noop */
      }
      if (err != null) reject(err)
      else resolve(result as PairedCredentials)
    }
    const timer = setTimeout(() => finish(new Error('配对超时')), timeoutMs)
    ws.onopen = () => {
      const payload: PairRequest = {
        nonce: input.nonce,
        proof: sha256(`${input.pairingSecret}:${input.nonce}:${input.pin}`),
        pin: input.pin,
        deviceName: input.deviceName
      }
      ws.send(JSON.stringify({ v: 1, type: 'req', id: nextId(), method: 'pair', payload }))
    }
    ws.onmessage = (ev: MessageEvent) => {
      try {
        const frame = JSON.parse(String(ev.data)) as ResponseFrame
        if (frame.type !== 'res') return
        if (frame.ok) {
          const { deviceId } = frame.payload as PairResult
          if (typeof deviceId !== 'string' || deviceId === '') {
            finish(new Error('配对响应缺 deviceId'))
            return
          }
          // 双方独立推导 token（与 PC 端 server.ts 同口径）
          finish(null, { deviceId, token: sha256(`${input.pairingSecret}:${deviceId}:${input.nonce}`) })
        } else {
          finish(new Error(frame.error ?? '配对失败'))
        }
      } catch {
        finish(new Error('响应解析失败'))
      }
    }
    ws.onclose = () => finish(new Error('连接已关闭'))
    ws.onerror = () => finish(new Error('无法连接服务器'))
  })
}

/** 解析 PC 端配对二维码内容：nexus-pair://host:port?n=<nonce>&s=<pairingSecret>#<pin> */
export function parsePairingUri(
  text: string
): { host: string; port: string; nonce: string; pairingSecret: string; pin: string } | null {
  const m = text
    .trim()
    .match(/^nexus-pair:\/\/([^:/?#]+):(\d+)\?([^#\s]*)#(\d{6})$/)
  if (m == null) return null
  const params = new URLSearchParams(m[3])
  const nonce = params.get('n')
  const pairingSecret = params.get('s')
  if (nonce == null || nonce === '' || pairingSecret == null || pairingSecret === '') return null
  return { host: m[1], port: m[2], nonce, pairingSecret, pin: m[4] }
}
