// 同步编排服务：调度全部适配器做增量同步，持久化各适配器 sync_state，
// 并向渲染进程广播进度。启动时立即同步一次，之后每 60s 轮询。

import type { AgentAdapter } from '@main/modules/adapter/domain/types'
import type { SyncProgress } from '@shared/types'
import type { NexusStore } from '../infrastructure/store'
import { yieldToEventLoop } from '@main/modules/adapter/infrastructure/util'
import { logger } from '@main/modules/shared/logger'

const SYNC_INTERVAL_MS = 60_000

export class SyncService {
  private status: SyncProgress = {
    phase: 'idle',
    agent: null,
    message: '',
    startedAt: 0,
    finishedAt: null,
    results: []
  }
  private timer: NodeJS.Timeout | null = null
  private syncing = false

  constructor(
    private readonly store: NexusStore,
    private readonly adapters: AgentAdapter[],
    private readonly broadcast: (p: SyncProgress) => void
  ) {}

  getStatus(): SyncProgress {
    return this.status
  }

  startBackgroundLoop(): void {
    if (this.timer) return
    void this.syncNow()
    this.timer = setInterval(() => {
      void this.syncNow()
    }, SYNC_INTERVAL_MS)
  }

  stopBackgroundLoop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async syncNow(): Promise<SyncProgress> {
    if (this.syncing) return this.status
    this.syncing = true
    const started: SyncProgress = { ...this.status, phase: 'running', startedAt: Date.now(), finishedAt: null, results: [] }
    this.status = started
    this.broadcast(this.status)

    for (const adapter of this.adapters) {
      if (!adapter.detect()) {
        started.results.push({ agent: adapter.id, records: 0, sessions: 0, tools: 0, error: null })
        continue
      }
      this.status = { ...started, agent: adapter.id, message: `同步 ${adapter.label}` }
      this.broadcast(this.status)
      try {
        const state = this.store.loadSyncState(adapter.id)
        const result = await adapter.sync({ state, now: Date.now() })
        this.store.saveSyncState(adapter.id, result.lastTs, result.meta)
        started.results.push({
          agent: adapter.id,
          records: result.records,
          sessions: result.sessions,
          tools: result.tools,
          error: null
        })
        logger.info('adapter.synced', {
          agent: adapter.id,
          records: result.records,
          sessions: result.sessions,
          tools: result.tools
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        started.results.push({ agent: adapter.id, records: 0, sessions: 0, tools: 0, error: message })
        logger.error('adapter.failed', { agent: adapter.id, error: message })
      }
      await yieldToEventLoop()
    }

    // DSH 本地 zstd 会话由 DshAdapter 统一增量同步（usage/sessions/tools 三表）

    this.status = {
      ...started,
      phase: 'done',
      agent: null,
      message: '',
      finishedAt: Date.now()
    }
    this.cleanup()
    this.broadcast(this.status)
    this.syncing = false
    return this.status
  }

  /** 保留策略（立项书 §4.3）：settings.retentionDays > 0 时清理超期自有数据；0/未设 = 永久保留 */
  private cleanup(): void {
    const days = Number(this.store.getSetting('retentionDays') ?? 0)
    if (!Number.isFinite(days) || days <= 0) return
    const cutoff = Date.now() - days * 86400_000
    this.store.db.prepare('BEGIN').run()
    try {
      this.store.db.prepare('DELETE FROM usage_records WHERE ts < ?').run(cutoff)
      this.store.db.prepare('DELETE FROM tool_calls WHERE ts IS NOT NULL AND ts < ?').run(cutoff)
      // 会话元数据一并清理（蓝队 F3）；无时间戳的行保守保留
      this.store.db
        .prepare(
          'DELETE FROM sessions WHERE COALESCE(updated_at, started_at, 0) > 0 AND COALESCE(updated_at, started_at, 0) < ?'
        )
        .run(cutoff)
      this.store.db.prepare('COMMIT').run()
    } catch {
      this.store.db.prepare('ROLLBACK').run()
    }
    logger.info('store.cleanup', { retentionDays: days, cutoff })
  }

  dispose(): void {
    this.stopBackgroundLoop()
  }
}
