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
import { openReadonlyDb, sqliteFileStamp, tableColumns, yieldToEventLoop } from '../util'
import type { DatabaseSync } from 'node:sqlite'

const CHUNK = 5000
// 红队 N-01：行落库时刻晚于 started_at，纯 >= lastTs 游标会永久漏行。
// 读取统一带 24h 安全重叠窗，配合 store 层按 dedupe_key 的 upsert，重叠重读既补漏又刷新值。
const OVERLAP_MS = 24 * 60 * 60_000

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
    const dbStamp = sqliteFileStamp(this.dbPath)
    if (dbStamp && ctx.state.meta.dbStamp === dbStamp) {
      return { records: 0, sessions: 0, tools: 0, lastTs: ctx.state.lastTs, meta: ctx.state.meta }
    }
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
      if (dbStamp) result.meta = { ...result.meta, dbStamp }
      return result
    } finally {
      db.close()
    }
  }

  private async syncUsage(db: DatabaseSync, ctx: SyncContext, result: SyncResult): Promise<void> {
    if (!tableColumns(db, 'model_usage').length) return
    const since = Math.max(0, ctx.state.lastTs - OVERLAP_MS)
    // keyset 分页 (started_at, id)：消除单毫秒 >CHUNK 行时的分页墙（蓝队 F1）
    let cursorTs = since
    let cursorId = 0
    const stmt = db.prepare(
      `SELECT id, session_id, provider_id, model_id, started_at, status,
              input_tokens, output_tokens, reasoning_tokens,
              cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens
       FROM model_usage
       WHERE started_at > ? OR (started_at = ? AND id > ?)
       ORDER BY started_at ASC, id ASC LIMIT ${CHUNK}`
    )
    for (;;) {
      const rows = stmt.all(cursorTs, cursorTs, cursorId) as Array<Record<string, unknown>>
      if (!rows.length) break
      const records = rows.map((r) => {
        const reportedInput = num(r.input_tokens)
        const cacheRead = num(r.cache_read_input_tokens)
        const cacheWrite = num(r.cache_creation_input_tokens)
        // 口径归一化（红队 N-03 复核结论）：
        // 1) ZCode input 含缓存 → 扣减为互斥字段；
        // 2) 实测 computed_total = input + output（49,215/49,215 行），
        //    reasoning 已含于 output，若单独累加会双计 → 归并入 output 后置 0。
        const input = Math.max(0, reportedInput - cacheRead - cacheWrite)
        return {
          agent: this.id,
          model: str(r.model_id) ?? 'unknown',
          provider: str(r.provider_id),
          ts: num(r.started_at),
          inputTokens: input,
          outputTokens: num(r.output_tokens),
          reasoningTokens: 0,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          sessionId: str(r.session_id),
          dedupeKey: `zcode:mu:${str(r.id) ?? `${r.started_at}:${r.model_id}`}`
        }
      })
      result.records += this.store.insertUsage(records)
      const last = rows[rows.length - 1]
      const batchTs = num(last.started_at)
      const batchId = num(last.id)
      if (batchTs < cursorTs || (batchTs === cursorTs && batchId <= cursorId)) break // 无进展兜底
      cursorTs = batchTs
      cursorId = batchId
      result.lastTs = Math.max(result.lastTs, batchTs)
      if (rows.length < CHUNK) break
      await yieldToEventLoop()
    }
  }

  private async syncSessions(db: DatabaseSync, ctx: SyncContext, result: SyncResult): Promise<void> {
    const cols = tableColumns(db, 'session')
    if (!cols.length) return
    const meta = ctx.state.meta as { sessionLastTs?: number }
    let cursor = Math.max(0, (meta.sessionLastTs ?? 0) - OVERLAP_MS)
    for (;;) {
      const rows = db
        .prepare(
          `SELECT id, directory, title, time_created, time_updated, task_type
           FROM session WHERE time_updated >= ? ORDER BY time_updated ASC LIMIT ${CHUNK}`
        )
        .all(cursor) as Array<Record<string, unknown>>
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
      const maxTs = rows.reduce((m, r) => Math.max(m, num(r.time_updated)), cursor)
      if (maxTs <= cursor) break
      cursor = maxTs
      if (rows.length < CHUNK) break
    }
    meta.sessionLastTs = Math.max(cursor, meta.sessionLastTs ?? 0)
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
    if (!tsCol) {
      // 无时间列的数据源：一次性全量（dedupe 幂等），游标不适用
      const rows = db
        .prepare(`SELECT id, tool_name, session_id FROM tool_usage LIMIT 50000`)
        .all() as Array<Record<string, unknown>>
      if (rows.length) {
        result.tools = this.store.insertToolCalls(
          rows.map((r) => ({
            agent: this.id,
            toolName: str(r.tool_name) ?? 'unknown',
            ts: null,
            sessionId: str(r.session_id),
            dedupeKey: `zcode:tool:${str(r.id) ?? ''}`
          }))
        )
      }
      return
    }
    // keyset 分页 (ts, id)，同 usage（蓝队 F1）
    let cursorTs = Math.max(0, toolLastTs - OVERLAP_MS)
    let cursorId = 0
    const stmt = db.prepare(
      `SELECT id, tool_name, session_id, ${tsCol}
       FROM tool_usage
       WHERE ${tsCol} > ? OR (${tsCol} = ? AND id > ?)
       ORDER BY ${tsCol} ASC, id ASC LIMIT 5000`
    )
    for (;;) {
      const rows = stmt.all(cursorTs, cursorTs, cursorId) as Array<Record<string, unknown>>
      if (!rows.length) break
      result.tools += this.store.insertToolCalls(
        rows.map((r) => ({
          agent: this.id,
          toolName: str(r.tool_name) ?? 'unknown',
          ts: num(r[tsCol]) || null,
          sessionId: str(r.session_id),
          dedupeKey: `zcode:tool:${str(r.id) ?? ''}`
        }))
      )
      const last = rows[rows.length - 1]
      const batchTs = num(last[tsCol])
      const batchId = num(last.id)
      if (batchTs < cursorTs || (batchTs === cursorTs && batchId <= cursorId)) break // 无进展兜底
      cursorTs = batchTs
      cursorId = batchId
      if (rows.length < 5000) break
      await yieldToEventLoop()
    }
    meta.toolLastTs = Math.max(toolLastTs, cursorTs)
    result.meta = meta
  }
}
