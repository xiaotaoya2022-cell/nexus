// DeepSeek Harness 桥接（v2 Phase 1，指导书 §3.3 有限反控）。
// 设计依据：docs/research/v2/DeepSeek Harness 集成方案.md —— 纯外挂（零侵入 DSH）：
// 回环 HTTP POST /api/<method> + SSE /api/events.mux。回环地址、不监听外部。

import { request } from 'node:http'
import { logger } from '@main/modules/shared/logger'

const DEFAULT_PORT = 3080
const TIMEOUT_MS = 8000

export interface DshSessionInfo {
  sessionId: string
  workspace?: string
  updatedAt?: number | string
  running?: boolean
  raw?: unknown
}

export class DshBridge {
  private port: number
  private degraded = false

  constructor(port?: number) {
    this.port = port ?? (Number(process.env.DSH_PORT) || DEFAULT_PORT)
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  /** RPC：POST /api/<method>。回环无鉴权（调研报告 §7 安全模型）。 */
  private rpc<T>(method: string, params?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const body = JSON.stringify(params ?? {})
      const req = request(
        {
          host: '127.0.0.1',
          port: this.port,
          path: `/api/${method}`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body)
          },
          timeout: TIMEOUT_MS
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            if (res.statusCode !== 200) {
              this.degraded = true
              reject(new Error(`dsh ${method} http ${res.statusCode}: ${text.slice(0, 200)}`))
              return
            }
            try {
              resolve(JSON.parse(text) as T)
            } catch {
              resolve(text as unknown as T)
            }
          })
        }
      )
      req.on('timeout', () => {
        req.destroy(new Error(`dsh ${method} timeout`))
      })
      req.on('error', (err) => {
        this.degraded = true
        reject(err)
      })
      req.end(body)
    })
  }

  /** 健康探测：host.describe 无副作用；失败即视为未运行/版本不兼容 */
  async status(): Promise<{ available: boolean; degraded: boolean; port: number; detail?: string }> {
    try {
      await this.rpc('host.describe')
      this.degraded = false
      return { available: true, degraded: false, port: this.port }
    } catch (err) {
      return {
        available: false,
        degraded: this.degraded,
        port: this.port,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  }

  async listSessions(): Promise<DshSessionInfo[]> {
    const res = await this.rpc<{ sessions?: DshSessionInfo[] } | DshSessionInfo[]>('session.list')
    const list = Array.isArray(res) ? res : (res.sessions ?? [])
    return list
  }

  async createSession(params: { cwd?: string; sessionId?: string }): Promise<{ sessionId: string }> {
    return this.rpc<{ sessionId: string }>('session.create', params)
  }

  async prompt(sessionId: string, text: string): Promise<unknown> {
    return this.rpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    })
  }

  async cancel(sessionId: string): Promise<unknown> {
    return this.rpc('session.cancel', { sessionId })
  }

  async history(sessionId: string, maxMessages = 50): Promise<unknown> {
    return this.rpc('session.history', { sessionId, maxMessages })
  }

  /** 启停：headless 场景由外部拉起 `dsh web`（集成方案 §10）；这里仅记录与暴露端口 */
  logStart(): void {
    logger.info('dsh.bridge_start', { port: this.port })
  }
}
