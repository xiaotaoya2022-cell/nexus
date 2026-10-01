// CodeBuddy（CN）适配器。三个数据源（本机实测 2026-10-02，子代理深挖确认）：
// 1) %LOCALAPPDATA%/CodeBuddyExtension/Data/<uid>/<IDE>/<uid>/history/<wsHash>/<convId>/index.json
//    —— 逐请求用量（唯一结构化 token 来源）：
//    requests[]: {id, type, state, startedAt(ms),
//      usage:{inputTokens, outputTokens, totalTokens, cacheTokens, cachedWriteTokens, cachedMissTokens, credit}}
//    messages[]: {id, role, isComplete}；正文在 messages/<id>.json（首问可作标题）。
//    覆盖 CodeBuddyIDE/VSCode/JetBrains 三代客户端，本机约 9.6 亿 input tokens（2026-02 至今）。
// 2) $APPDATA/CodeBuddy CN/codebuddy-sessions.vscdb —— 会话元数据（title/cwd），
//    conversationId 与 history 目录名一致，JOIN 补全标题。
// 3) 请求级无模型名（index.json 不含 model），模型维度标注 unknown。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentAdapter,
  SyncContext,
  SyncResult,
  StoreWriter
} from '@main/modules/adapter/domain/types'
import { openReadonlyDb, tableExists } from '../util'

const APPDATA = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
const LOCALAPPDATA = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
const EXT_DATA = join(LOCALAPPDATA, 'CodeBuddyExtension', 'Data')
const VSCDB = join(APPDATA, 'CodeBuddy CN', 'codebuddy-sessions.vscdb')

interface CbUsage {
  inputTokens?: number
  outputTokens?: number
  cacheTokens?: number
  cachedWriteTokens?: number
  cachedMissTokens?: number
  credit?: number
}

interface CbRequest {
  id?: string
  state?: string
  startedAt?: number
  usage?: CbUsage
}

interface CbIndex {
  messages?: Array<{ id?: string; role?: string }>
  requests?: CbRequest[]
}

interface FileStamp {
  m: number
  s: number
}

function stampsFrom(meta: Record<string, unknown>): Map<string, FileStamp> {
  const out = new Map<string, FileStamp>()
  const raw = meta.fileStamps
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const st = v as { m?: unknown; s?: unknown }
      if (typeof st?.m === 'number' && typeof st?.s === 'number') out.set(k, { m: st.m, s: st.s })
    }
  }
  return out
}

/** 枚举会话级 index.json：Data/<uid>/<IDE>/<uid>/history/<wsHash>/<convId>/index.json */
function enumerateHistory(): string[] {
  if (!existsSync(EXT_DATA)) return []
  const out: string[] = []
  for (const uid of readdirSync(EXT_DATA)) {
    const uidDir = join(EXT_DATA, uid)
    let ides: string[] = []
    try {
      ides = readdirSync(uidDir)
    } catch {
      continue
    }
    for (const ide of ides) {
      const inner = join(uidDir, ide, uid)
      let hist = join(inner, 'history')
      if (!existsSync(hist)) {
        // 兜底：个别版本无内层 uid 目录
        hist = join(uidDir, ide, 'history')
        if (!existsSync(hist)) continue
      }
      let wsList: string[] = []
      try {
        wsList = readdirSync(hist)
      } catch {
        continue
      }
      for (const ws of wsList) {
        const wsDir = join(hist, ws)
        let convs: string[] = []
        try {
          convs = readdirSync(wsDir)
        } catch {
          continue
        }
        for (const conv of convs) {
          const p = join(wsDir, conv, 'index.json')
          if (existsSync(p)) out.push(p)
        }
      }
    }
  }
  return out
}

/** 首条用户消息 → 标题（剥 <user_info> 壳；失败返回 null，保留 vscdb 侧标题）。 */
function extractTitle(convDir: string, messages: CbIndex['messages']): string | null {
  const first = messages?.find((m) => m.role === 'user' && typeof m.id === 'string')
  if (!first?.id) return null
  try {
    const raw = JSON.parse(readFileSync(join(convDir, 'messages', `${first.id}.json`), 'utf8')) as {
      message?: string
    }
    let text = typeof raw.message === 'string' ? raw.message : ''
    try {
      const inner = JSON.parse(text) as { content?: Array<{ type?: string; text?: string }> }
      text = (inner.content ?? [])
        .filter((c) => c?.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join(' ')
    } catch {
      // message 字段非 JSON 字符串时按原文处理
    }
    text = text.replace(/<user_info>[\s\S]*?<\/user_info>/g, ' ').trim()
    if (!text || text.startsWith('<')) return null
    return text.slice(0, 120)
  } catch {
    return null
  }
}

export class CodeBuddyAdapter implements AgentAdapter {
  readonly id = 'codebuddy'
  readonly label = 'CodeBuddy'
  private readonly vscdb = VSCDB

  constructor(private readonly store: StoreWriter) {}

  detect(): boolean {
    return existsSync(this.vscdb) || existsSync(EXT_DATA)
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const stamps = stampsFrom(ctx.state.meta)
    let records = 0
    let sessions = 0
    let lastTs = ctx.state.lastTs

    // 1) history index.json → 逐请求用量 + 会话时间轴
    if (existsSync(EXT_DATA)) {
      const usageRows: Parameters<StoreWriter['insertUsage']>[0] = []
      const sessionRows: Parameters<StoreWriter['upsertSessions']>[0] = []
      for (const path of enumerateHistory()) {
        const convDir = path.slice(0, -'/index.json'.length)
        const sessionId = convDir.split(/[\\/]/).pop() ?? convDir
        let st: { mtimeMs: number; size: number }
        try {
          const s = statSync(path)
          st = { mtimeMs: s.mtimeMs, size: s.size }
        } catch {
          continue
        }
        const prev = stamps.get(path)
        const changed = !prev || prev.m !== st.mtimeMs || prev.s !== st.size
        if (changed) {
          let d: CbIndex
          try {
            d = JSON.parse(readFileSync(path, 'utf8')) as CbIndex
          } catch {
            continue
          }
          let startedAt: number | null = null
          let updatedAt: number | null = null
          for (const r of d.requests ?? []) {
            const u = r.usage
            if (!u || typeof r.startedAt !== 'number') continue
            const total = (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
            if (total <= 0) continue
            usageRows.push({
              agent: this.id,
              model: 'unknown', // index.json 不含模型名
              provider: 'codebuddy',
              ts: r.startedAt,
              inputTokens: u.inputTokens ?? 0,
              outputTokens: u.outputTokens ?? 0,
              reasoningTokens: 0,
              cacheReadTokens: u.cacheTokens ?? 0,
              cacheWriteTokens: u.cachedWriteTokens ?? 0,
              sessionId,
              dedupeKey: `codebuddy:req:${r.id ?? `${r.startedAt}`}`,
              isEstimated: false
            })
            if (startedAt == null || r.startedAt < startedAt) startedAt = r.startedAt
            if (updatedAt == null || r.startedAt > updatedAt) updatedAt = r.startedAt
          }
          sessionRows.push({
            agent: this.id,
            sessionId,
            title: extractTitle(convDir, d.messages),
            projectDir: null,
            model: null,
            startedAt,
            updatedAt
          })
          stamps.set(path, { m: st.mtimeMs, s: st.size })
        }
      }
      if (usageRows.length > 0) records = this.store.insertUsage(usageRows)
      if (sessionRows.length > 0) sessions = this.store.upsertSessions(sessionRows)
    }

    // 2) vscdb 会话元数据（title/cwd，覆盖最近会话）
    if (existsSync(this.vscdb)) {
      try {
        const db = openReadonlyDb(this.vscdb)
        try {
          if (tableExists(db, 'ItemTable')) {
            const rows = db
              .prepare("SELECT value FROM ItemTable WHERE key LIKE 'session:%' LIMIT 20000")
              .all() as Array<{ value: unknown }>
            const sRows: Parameters<StoreWriter['upsertSessions']>[0] = []
            for (const row of rows) {
              let v: Record<string, unknown>
              try {
                v = JSON.parse(typeof row.value === 'string' ? row.value : String(row.value ?? '{}'))
              } catch {
                continue
              }
              const updatedAt = typeof v.updatedAt === 'number' ? v.updatedAt : null
              const createdAt = typeof v.createdAt === 'number' ? v.createdAt : null
              const conversationId = typeof v.conversationId === 'string' ? v.conversationId : null
              if (!conversationId) continue
              sRows.push({
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
            if (sRows.length > 0) this.store.upsertSessions(sRows)
          }
        } finally {
          db.close()
        }
      } catch {
        // vscdb 打不开不影响 history 用量
      }
    }

    const fileStamps: Record<string, FileStamp> = {}
    for (const [k, v] of stamps) fileStamps[k] = v
    return {
      records,
      sessions,
      tools: 0,
      lastTs,
      meta: { ...ctx.state.meta, fileStamps }
    }
  }
}
