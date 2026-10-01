// OpenCode 适配器（开源 agent，sst/opencode）。数据源（本机实测 2026-10-02）：
// ~/.local/share/opencode/opencode.db（SQLite，事件溯源库）：
// - message 表：data JSON = {role, agent, cost, tokens{input,output,reasoning,cache{read,write}},
//   modelID, providerID, time{created,completed}, error}；assistant 消息带请求级 tokens。
// - session 表：id/title/directory/time_created/time_updated/model(JSON{providerID,modelID})。
// 数据量小（千级消息），采用全量扫描 + dedupe upsert（零增量状态，流式累计由 upsert 覆盖）。

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

const DB_PATH = join(homedir(), '.local', 'share', 'opencode', 'opencode.db')

interface OpencodeMessageData {
  role?: string
  agent?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  modelID?: string
  providerID?: string
  time?: { created?: number; completed?: number }
  error?: unknown
}

interface OpencodeSessionRow {
  id: string
  title?: string | null
  directory?: string | null
  model?: string | null
  time_created?: number | null
  time_updated?: number | null
}

export class OpencodeAdapter implements AgentAdapter {
  readonly id = 'opencode'
  readonly label = 'OpenCode'
  private readonly dbPath = DB_PATH

  constructor(private readonly store: StoreWriter) {}

  detect(): boolean {
    return existsSync(this.dbPath)
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    if (!this.detect()) {
      return { records: 0, sessions: 0, tools: 0, lastTs: ctx.state.lastTs, meta: ctx.state.meta }
    }
    let db
    try {
      db = openReadonlyDb(this.dbPath)
    } catch {
      return { records: 0, sessions: 0, tools: 0, lastTs: ctx.state.lastTs, meta: ctx.state.meta }
    }
    try {
      let records = 0
      let sessions = 0

      if (tableColumns(db, 'message').length > 0) {
        const rows = db
          .prepare(`SELECT id, session_id, data FROM message WHERE data LIKE '%"tokens"%'`)
          .all() as Array<{ id: string; session_id: string | null; data: string }>
        const usage: Parameters<StoreWriter['insertUsage']>[0] = []
        for (const r of rows) {
          let d: OpencodeMessageData
          try {
            d = JSON.parse(r.data) as OpencodeMessageData
          } catch {
            continue
          }
          if (d.role !== 'assistant') continue
          const t = d.tokens
          if (!t) continue
          const input = t.input ?? 0
          const output = t.output ?? 0
          const reasoning = t.reasoning ?? 0
          const cacheRead = t.cache?.read ?? 0
          const cacheWrite = t.cache?.write ?? 0
          const total = input + output + reasoning + cacheRead + cacheWrite
          if (total <= 0) continue
          const ts = d.time?.created
          if (typeof ts !== 'number' || ts <= 0) continue
          const model =
            d.modelID ? (d.providerID ? `${d.providerID}/${d.modelID}` : d.modelID) : 'unknown'
          usage.push({
            agent: this.id,
            model,
            provider: d.providerID ?? null,
            ts,
            inputTokens: input,
            outputTokens: output,
            // 口径安全：opencode 的 total 语义未逐源验证，reasoning 单列由库口径聚合，
            // 若与 output 重叠会在总量上略偏高（与 codex subset 同类风险，量级小）
            reasoningTokens: reasoning,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            sessionId: r.session_id,
            dedupeKey: `opencode:${r.id}`,
            isEstimated: false
          })
        }
        if (usage.length > 0) records = this.store.insertUsage(usage)
      }

      if (tableColumns(db, 'session').length > 0) {
        const rows = db
          .prepare(
            `SELECT id, title, directory, model, time_created, time_updated FROM session`
          )
          .all() as unknown as Array<OpencodeSessionRow>
        const sessionRows: Parameters<StoreWriter['upsertSessions']>[0] = []
        for (const s of rows) {
          let model: string | null = null
          if (typeof s.model === 'string' && s.model) {
            try {
              const mj = JSON.parse(s.model) as { providerID?: string; modelID?: string }
              if (mj.modelID) model = mj.providerID ? `${mj.providerID}/${mj.modelID}` : mj.modelID
            } catch {
              model = s.model
            }
          }
          sessionRows.push({
            agent: this.id,
            sessionId: s.id,
            title: s.title ?? null,
            projectDir: s.directory ?? null,
            model,
            startedAt: s.time_created ?? null,
            updatedAt: s.time_updated ?? null
          })
        }
        if (sessionRows.length > 0) {
          sessions = this.store.upsertSessions(sessionRows)
        }
      }

      return { records, sessions, tools: 0, lastTs: ctx.now, meta: ctx.state.meta }
    } finally {
      db.close()
    }
  }
}
