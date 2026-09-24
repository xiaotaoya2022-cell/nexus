// Antigravity 适配器：
// 1) 会话元数据：~/.gemini/antigravity/conversation_summaries.db 的 conversation_summaries 表
//    （标题/工作区/状态/时间），提供会话数与活跃度。
// 2) Token 数据：~/.antigravity_cockpit/codex_local_access_logs.sqlite 的 request_logs 表
//    （第三方 Antigravity Cockpit 的本地代理日志；字段完整但本机当前 0 行，
//    适配器就绪后一旦用户启用记录即自动生效）。token 字段口径与 Codex 一致（input 不含缓存）。

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentAdapter,
  SyncContext,
  SyncResult,
  StoreWriter
} from '@main/modules/adapter/domain/types'
import {
  openReadonlyDb,
  parseTimestampMs,
  tableColumns,
  tableExists
} from '../util'

interface AgxMeta {
  sessionLastTs: number
  lastRowid: number
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

export class AntigravityAdapter implements AgentAdapter {
  readonly id = 'antigravity'
  readonly label = 'Antigravity'
  private readonly summariesDb = join(
    homedir(),
    '.gemini',
    'antigravity',
    'conversation_summaries.db'
  )
  private readonly cockpitDb = join(
    homedir(),
    '.antigravity_cockpit',
    'codex_local_access_logs.sqlite'
  )

  constructor(private readonly store: StoreWriter) {}

  detect(): boolean {
    return existsSync(this.summariesDb) || existsSync(this.cockpitDb)
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const meta = (ctx.state.meta as Partial<AgxMeta> | undefined) ?? {}
    const result: SyncResult = {
      records: 0,
      sessions: 0,
      tools: 0,
      lastTs: ctx.state.lastTs,
      meta: { ...meta, sessionLastTs: meta.sessionLastTs ?? 0, lastRowid: meta.lastRowid ?? 0 }
    }
    this.syncSessions(ctx, result)
    this.syncCockpitUsage(ctx, result)
    return result
  }

  private syncSessions(_ctx: SyncContext, result: SyncResult): void {
    if (!existsSync(this.summariesDb)) return
    let db
    try {
      db = openReadonlyDb(this.summariesDb)
    } catch {
      return
    }
    try {
      if (!tableExists(db, 'conversation_summaries')) return
      const m = result.meta as unknown as AgxMeta
      const rows = db
        .prepare(
          `SELECT conversation_id, title, last_modified_time, workspace_uris, agent_name
           FROM conversation_summaries WHERE last_modified_time >= ? LIMIT 20000`
        )
        .all(m.sessionLastTs) as Array<Record<string, unknown>>
      if (!rows.length) return
      result.sessions += this.store.upsertSessions(
        rows.map((r) => ({
          agent: this.id,
          sessionId: str(r.conversation_id) ?? '',
          title: str(r.title),
          projectDir: str(r.workspace_uris),
          model: str(r.agent_name),
          startedAt: null,
          updatedAt: parseTimestampMs(r.last_modified_time)
        }))
      )
      m.sessionLastTs = rows.reduce(
        (max, r) => Math.max(max, num(parseTimestampMs(r.last_modified_time) ?? 0)),
        m.sessionLastTs
      )
    } finally {
      db.close()
    }
  }

  private syncCockpitUsage(_ctx: SyncContext, result: SyncResult): void {
    if (!existsSync(this.cockpitDb)) return
    let db
    try {
      db = openReadonlyDb(this.cockpitDb)
    } catch {
      return
    }
    try {
      if (!tableExists(db, 'request_logs')) return
      const cols = tableColumns(db, 'request_logs')
      const has = (c: string): boolean => cols.includes(c)
      const m = result.meta as unknown as AgxMeta
      const rows = db
        .prepare(
          `SELECT rowid, ${has('timestamp') ? 'timestamp' : 'NULL'} AS ts,
                  ${has('model_id') ? 'model_id' : 'NULL'} AS model_id,
                  ${has('input_tokens') ? 'input_tokens' : '0'} AS input_tokens,
                  ${has('output_tokens') ? 'output_tokens' : '0'} AS output_tokens,
                  ${has('cached_tokens') ? 'cached_tokens' : '0'} AS cached_tokens,
                  ${has('reasoning_tokens') ? 'reasoning_tokens' : '0'} AS reasoning_tokens
           FROM request_logs WHERE rowid > ? ORDER BY rowid ASC LIMIT 20000`
        )
        .all(m.lastRowid) as Array<Record<string, unknown>>
      if (!rows.length) return
      const records = rows
        .map((r) => ({
          agent: this.id,
          model: str(r.model_id) ?? 'unknown',
          provider: null,
          ts: parseTimestampMs(r.ts) ?? 0,
          inputTokens: num(r.input_tokens),
          outputTokens: num(r.output_tokens),
          reasoningTokens: num(r.reasoning_tokens),
          cacheReadTokens: num(r.cached_tokens),
          cacheWriteTokens: 0,
          sessionId: null,
          dedupeKey: `agx:req:${num(r.rowid)}`
        }))
        .filter((r) => r.ts > 0)
      result.records += this.store.insertUsage(records)
      m.lastRowid = Math.max(m.lastRowid, ...rows.map((r) => num(r.rowid)))
    } finally {
      db.close()
    }
  }
}
