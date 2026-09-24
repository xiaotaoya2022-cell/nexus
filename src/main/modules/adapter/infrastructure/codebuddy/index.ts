// CodeBuddy（CN）适配器：本地仅有会话元数据（无 token，对话与用量存腾讯云端）。
// 数据源：$APPDATA/CodeBuddy CN/codebuddy-sessions.vscdb 的 ItemTable，
// key 形如 session:<uuid>，value 为 {conversationId, cwd, title, status, createdAt, updatedAt}。
// 提供会话数/活跃度统计；Token 维度标注为云端存储。

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentAdapter,
  SyncContext,
  SyncResult,
  StoreWriter
} from '@main/modules/adapter/domain/types'
import { openReadonlyDb, tableExists } from '../util'

export class CodeBuddyAdapter implements AgentAdapter {
  readonly id = 'codebuddy'
  readonly label = 'CodeBuddy'
  private readonly vscdb = join(
    process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
    'CodeBuddy CN',
    'codebuddy-sessions.vscdb'
  )

  constructor(private readonly store: StoreWriter) {}

  detect(): boolean {
    return existsSync(this.vscdb)
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    if (!existsSync(this.vscdb)) {
      return { records: 0, sessions: 0, tools: 0, lastTs: ctx.state.lastTs, meta: ctx.state.meta }
    }
    let db
    try {
      db = openReadonlyDb(this.vscdb)
    } catch {
      return { records: 0, sessions: 0, tools: 0, lastTs: ctx.state.lastTs, meta: ctx.state.meta }
    }
    try {
      if (!tableExists(db, 'ItemTable')) {
        return { records: 0, sessions: 0, tools: 0, lastTs: ctx.state.lastTs, meta: ctx.state.meta }
      }
      const rows = db
        .prepare("SELECT value FROM ItemTable WHERE key LIKE 'session:%' LIMIT 20000")
        .all() as Array<{ value: unknown }>
      const sessions: Parameters<StoreWriter['upsertSessions']>[0] = []
      let lastTs = ctx.state.lastTs
      for (const row of rows) {
        let v: Record<string, unknown>
        try {
          v = JSON.parse(typeof row.value === 'string' ? row.value : String(row.value ?? '{}'))
        } catch {
          continue
        }
        const updatedAt = typeof v.updatedAt === 'number' ? v.updatedAt : null
        const createdAt = typeof v.createdAt === 'number' ? v.createdAt : null
        const conversationId =
          typeof v.conversationId === 'string' ? v.conversationId : null
        if (!conversationId) continue
        sessions.push({
          agent: this.id,
          sessionId: conversationId,
          title: typeof v.title === 'string' ? v.title : null,
          projectDir: typeof v.cwd === 'string' ? v.cwd : null,
          model: null,
          startedAt: createdAt,
          updatedAt
        })
        if (updatedAt != null && updatedAt > lastTs) lastTs = updatedAt
      }
      const count = sessions.length ? this.store.upsertSessions(sessions) : 0
      return { records: 0, sessions: count, tools: 0, lastTs, meta: ctx.state.meta }
    } finally {
      db.close()
    }
  }
}

