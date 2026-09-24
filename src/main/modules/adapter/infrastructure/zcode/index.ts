// ZCode 适配器（P0）：读取 ~/.zcode/cli/db/db.sqlite 的 model_usage / session / tool_usage。
// 依据《ZCode 源码探索报告》：ZCode 侧用量表仅保留 30 天，Nexus 同步即快照，历史永久留存。
// Token 口径归一化：ZCode 的 input_tokens 已包含 cache_read/cache_write（源码报告结论，
// computed_total = input + output），本适配器将其扣减为「不含缓存」的互斥字段后入库。
// 全程只读（readOnly: true），绝不写用户数据库。

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentAdapter,
  SyncContext,
  SyncResult,
  StoreWriter
} from '@main/modules/adapter/domain/types'
import { openReadonlyDb, tableColumns } from '../util'
import type { DatabaseSync } from 'node:sqlite'

const CHUNK = 5000

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

export class ZCodeAdapter implements AgentAdapter {
  readonly id = 'zcode'
  readonly label = 'ZCode'
  private readonly dbPath = join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')

  constructor(private readonly store: StoreWriter) {}

  detect(): boolean {
    return existsSync(this.dbPath)
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const db = openReadonlyDb(this.dbPath)
    try {
      const result: SyncResult = {
        records: 0,
        sessions: 0,
        tools: 0,
        lastTs: ctx.state.lastTs,
        meta: ctx.state.meta
      }
      await this.syncUsage(db, ctx, result)
      await this.syncSessions(db, ctx, result)
      await this.syncTools(db, ctx, result)
      return result
    } finally {
      db.close()
    }
  }

  private async syncUsage(db: DatabaseSync, ctx: SyncContext, result: SyncResult): Promise<void> {
    if (!tableColumns(db, 'model_usage').length) return
    let lastTs = ctx.state.lastTs
    for (;;) {
      const rows = db
        .prepare(
          `SELECT id, session_id, provider_id, model_id, started_at, status,
                  input_tokens, output_tokens, reasoning_tokens,
                  cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens
           FROM model_usage WHERE started_at >= ? ORDER BY started_at ASC LIMIT ${CHUNK}`
        )
        .all(lastTs) as Array<Record<string, unknown>>
      if (!rows.length) break
      const records = rows.map((r) => {
        const reportedInput = num(r.input_tokens)
        const cacheRead = num(r.cache_read_input_tokens)
        const cacheWrite = num(r.cache_creation_input_tokens)
        // 口径归一化：ZCode input 含缓存 → 扣减为互斥字段
        const input = Math.max(0, reportedInput - cacheRead - cacheWrite)
        return {
          agent: this.id,
          model: str(r.model_id) ?? 'unknown',
          provider: str(r.provider_id),
          ts: num(r.started_at),
          inputTokens: input,
          outputTokens: num(r.output_tokens),
          reasoningTokens: num(r.reasoning_tokens),
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          sessionId: str(r.session_id),
          dedupeKey: `zcode:mu:${str(r.id) ?? `${r.started_at}:${r.model_id}`}`
        }
      })
      result.records += this.store.insertUsage(records)
      const maxTs = rows.reduce((m, r) => Math.max(m, num(r.started_at)), lastTs)
      lastTs = Math.max(maxTs, lastTs)
      result.lastTs = lastTs
      if (rows.length < CHUNK) break
    }
  }

  private async syncSessions(db: DatabaseSync, ctx: SyncContext, result: SyncResult): Promise<void> {
    const cols = tableColumns(db, 'session')
    if (!cols.length) return
    const meta = ctx.state.meta as { sessionLastTs?: number }
    let lastTs = meta.sessionLastTs ?? 0
    for (;;) {
      const rows = db
        .prepare(
          `SELECT id, directory, title, time_created, time_updated, task_type
           FROM session WHERE time_updated >= ? ORDER BY time_updated ASC LIMIT ${CHUNK}`
        )
        .all(lastTs) as Array<Record<string, unknown>>
      if (!rows.length) break
      result.sessions += this.store.upsertSessions(
        rows.map((r) => ({
          agent: this.id,
          sessionId: str(r.id) ?? '',
          title: str(r.title),
          projectDir: str(r.directory),
          model: null,
          startedAt: num(r.time_created) || null,
          updatedAt: num(r.time_updated) || null
        }))
      )
      const maxTs = rows.reduce((m, r) => Math.max(m, num(r.time_updated)), lastTs)
      lastTs = maxTs
      if (rows.length < CHUNK) break
    }
    meta.sessionLastTs = lastTs
    result.meta = meta
  }

  private async syncTools(db: DatabaseSync, ctx: SyncContext, result: SyncResult): Promise<void> {
    const cols = tableColumns(db, 'tool_usage')
    if (!cols.length) return
    const has = (c: string): boolean => cols.includes(c)
    const tsCol = has('started_at') ? 'started_at' : has('created_at') ? 'created_at' : null
    if (!has('tool_name') || !has('id')) return
    const meta = ctx.state.meta as { toolLastTs?: number }
    let toolLastTs = meta.toolLastTs ?? 0
    const select = `SELECT id, tool_name, session_id${tsCol ? `, ${tsCol}` : ''} FROM tool_usage`
    const where = tsCol ? ` WHERE ${tsCol} >= ? ORDER BY ${tsCol} ASC` : ''
    const stmt = db.prepare(`${select}${where} LIMIT 5000`)
    for (;;) {
      const rows = stmt.all(...(tsCol ? [toolLastTs] : [])) as Array<Record<string, unknown>>
      if (!rows.length) break
      result.tools += this.store.insertToolCalls(
        rows.map((r) => ({
          agent: this.id,
          toolName: str(r.tool_name) ?? 'unknown',
          ts: tsCol ? num(r[tsCol]) || null : null,
          sessionId: str(r.session_id),
          dedupeKey: `zcode:tool:${str(r.id) ?? ''}`
        }))
      )
      if (!tsCol) break
      const batchMax = rows.reduce((m, r) => Math.max(m, num(r[tsCol])), toolLastTs)
      if (batchMax === toolLastTs) break // 同一毫秒兜底，防死循环
      toolLastTs = batchMax
      if (rows.length < 5000) break
    }
    if (tsCol) {
      meta.toolLastTs = toolLastTs
      result.meta = meta
    }
  }
}
