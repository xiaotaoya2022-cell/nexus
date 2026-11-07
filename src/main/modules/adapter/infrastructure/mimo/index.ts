// MiMo Code 适配器（小米 MiMo 团队的终端编程助手，OpenCode fork，XiaomiMiMo/MiMo-Code）。
// 数据源（调研 2026-11-07，tokscale/官方 README 佐证）：
// ~/.local/share/mimocode/mimocode.db（SQLite，与 opencode 同构）：
// - message 表 data JSON = {role, tokens{input,output,reasoning,cache{read,write}},
//   modelID, providerID, time{created,completed}}；assistant 消息带请求级 tokens。
// - session 表：id/title/directory/time_created/time_updated。
// 兼容 fork 演化：同时扫描同目录 mimocode-*.db 渠道分库；表缺失自动跳过。
// 本机未安装时 detect() 为 false，安装即自动生效。

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentAdapter,
  SyncContext,
  SyncResult,
  StoreWriter
} from '@main/modules/adapter/domain/types'
import { openReadonlyDb, tableColumns } from '../util'

const DATA_DIR = join(homedir(), '.local', 'share', 'mimocode')

interface MimocodeMessageData {
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

interface MimocodeSessionRow {
  id: string
  title?: string | null
  directory?: string | null
  model?: string | null
  time_created?: number | null
  time_updated?: number | null
}

function listDbs(): string[] {
  const main = join(DATA_DIR, 'mimocode.db')
  if (!existsSync(DATA_DIR)) return []
  const extra = readdirSync(DATA_DIR)
    .filter((f) => /^mimocode-.+\.db$/.test(f))
    .map((f) => join(DATA_DIR, f))
  return existsSync(main) ? [main, ...extra] : extra
}

function syncOneDb(
  dbPath: string,
  store: StoreWriter,
  agentId: string
): { records: number; sessions: number } {
  let db
  try {
    db = openReadonlyDb(dbPath)
  } catch {
    return { records: 0, sessions: 0 }
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
        let d: MimocodeMessageData
        try {
          d = JSON.parse(r.data) as MimocodeMessageData
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
          agent: agentId,
          model,
          provider: d.providerID ?? null,
          ts,
          inputTokens: input,
          outputTokens: output,
          // 口径与 opencode 同构（fork 继承）：reasoning 单列由库口径聚合，
          // 若与 output 重叠会在总量上略偏高（codex subset 同类风险，量级小）
          reasoningTokens: reasoning,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          sessionId: r.session_id,
          dedupeKey: `mimo:${r.id}`,
          isEstimated: false
        })
      }
      if (usage.length > 0) records = store.insertUsage(usage)
    }

    if (tableColumns(db, 'session').length > 0) {
      const rows = db
        .prepare('SELECT id, title, directory, model, time_created, time_updated FROM session')
        .all() as unknown as Array<MimocodeSessionRow>
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
          agent: agentId,
          sessionId: s.id,
          title: s.title ?? null,
          projectDir: s.directory ?? null,
          model,
          startedAt: s.time_created ?? null,
          updatedAt: s.time_updated ?? null
        })
      }
      if (sessionRows.length > 0) sessions = store.upsertSessions(sessionRows)
    }

    return { records, sessions }
  } finally {
    db.close()
  }
}

export class MimoAdapter implements AgentAdapter {
  readonly id = 'mimo'
  readonly label = 'MiMo Code'
  private readonly dataDir = DATA_DIR

  constructor(private readonly store: StoreWriter) {}

  detect(): boolean {
    return existsSync(this.dataDir)
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    if (!this.detect()) {
      return { records: 0, sessions: 0, tools: 0, lastTs: ctx.state.lastTs, meta: ctx.state.meta }
    }
    let records = 0
    let sessions = 0
    for (const dbPath of listDbs()) {
      const r = syncOneDb(dbPath, this.store, this.id)
      records += r.records
      sessions += r.sessions
    }
    return { records, sessions, tools: 0, lastTs: ctx.now, meta: ctx.state.meta }
  }
}
