// WorkBuddy 适配器（腾讯系 AI 员工，真数据目录 ~/.workbuddy-ai/，~/.workbuddy 是旧版兼容）。
// 三个数据源（本机实测 2026-10-02，子代理深挖确认）：
// 1) ~/.workbuddy-ai/projects/<工作区>/<sessionId>.jsonl —— CLI 转录，逐请求用量**带模型名**：
//    行 = {id, timestamp(ms), type, providerData:{model, usage:{requests, inputTokens, outputTokens,
//      inputTokensDetails:[{cached_tokens}], outputTokensDetails:[{reasoning_tokens}]}, ...},
//      message:{usage:{input_tokens, output_tokens, cache_read_input_tokens, ...}}, sessionId, cwd}
//    口径：inputTokens 含缓存读（total=input+output，reasoning⊆output），拆分与 codex 同构。
// 2) ~/.workbuddy-ai/traces/<pid>/trace_*.json —— trace 级聚合兜底（转录未覆盖的会话）：
//    trace:{traceId, startedAt, totalTokens, sessionId, modelInfo:{models[], totalInputTokens,
//      totalOutputTokens, totalCachedTokens, callCount}}。
//    去重：trace.sessionId 已有转录的跳过，防双计。
// 3) ~/.workbuddy-ai/workbuddy.db —— sessions 表（title/model/cwd/时间）。

import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentAdapter,
  SyncContext,
  SyncResult,
  StoreWriter
} from '@main/modules/adapter/domain/types'
import { openReadonlyDb, tableExists, tableColumns } from '../util'

const HOME = homedir()
const WB_NEW = join(HOME, '.workbuddy-ai')
const WB_OLD = join(HOME, '.workbuddy')

interface WbUsage {
  requests?: number
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  inputTokensDetails?: Array<{ cached_tokens?: number }>
  outputTokensDetails?: Array<{ reasoning_tokens?: number }>
}

interface WbLine {
  id?: string
  timestamp?: number
  type?: string
  providerData?: { model?: string; usage?: WbUsage }
  message?: { usage?: Record<string, number> }
  sessionId?: string
}

interface WbTrace {
  trace?: {
    traceId?: string
    startedAt?: string
    totalTokens?: number
    sessionId?: string
    modelInfo?: {
      models?: string[]
      totalInputTokens?: number
      totalOutputTokens?: number
      totalCachedTokens?: number
    }
  }
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

function jsonlDirs(): string[] {
  const dirs: string[] = []
  for (const base of [WB_NEW, WB_OLD]) {
    const p = join(base, 'projects')
    if (existsSync(p)) dirs.push(p)
  }
  return dirs
}

function traceDirs(): string[] {
  const dirs: string[] = []
  for (const base of [WB_NEW, WB_OLD]) {
    const p = join(base, 'traces')
    if (existsSync(p)) dirs.push(p)
  }
  return dirs
}

/** 新增字节读取：从 prev offset 起（对齐到下一行首），返回新读文本与消耗到的 offset。 */
function readAppended(path: string, prev: number): { text: string; consumed: number } | null {
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return null
  }
  if (size <= prev) return null
  const start = prev === 0 ? 0 : prev
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    let text = buf.toString('utf8')
    let consumed = size
    // 半行留待下轮
    if (!text.endsWith('\n')) {
      const nl = text.lastIndexOf('\n')
      text = nl >= 0 ? text.slice(0, nl + 1) : ''
      consumed = start + Buffer.byteLength(text, 'utf8')
    }
    return { text, consumed }
  } finally {
    closeSync(fd)
  }
}

export class WorkBuddyAdapter implements AgentAdapter {
  readonly id = 'workbuddy'
  readonly label = 'WorkBuddy'

  constructor(private readonly store: StoreWriter) {}

  detect(): boolean {
    return existsSync(WB_NEW) || existsSync(WB_OLD)
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    if (!this.detect()) {
      return { records: 0, sessions: 0, tools: 0, lastTs: ctx.state.lastTs, meta: ctx.state.meta }
    }
    const stamps = stampsFrom(ctx.state.meta)
    let records = 0
    let sessions = 0

    // 1) CLI 转录 jsonl（逐请求，带模型）
    const usageRows: Parameters<StoreWriter['insertUsage']>[0] = []
    const transcriptSessions = new Set<string>()
    for (const dir of jsonlDirs()) {
      let workspaces: string[] = []
      try {
        workspaces = readdirSync(dir)
      } catch {
        continue
      }
      for (const ws of workspaces) {
        const wsDir = join(dir, ws)
        let files: string[] = []
        try {
          files = readdirSync(wsDir).filter((f) => f.endsWith('.jsonl'))
        } catch {
          continue
        }
        for (const file of files) {
          const path = join(wsDir, file)
          let st: { mtimeMs: number; size: number }
          try {
            const s = statSync(path)
            st = { mtimeMs: s.mtimeMs, size: s.size }
          } catch {
            continue
          }
          const stampKey = path
          const prevOffset = (ctx.state.meta.jsonlOffsets as Record<string, number> | undefined)?.[stampKey] ?? 0
          // 转录为追加写；mtime 变化但 offset 已到末尾则跳过（半行处理在 readAppended 内）
          const appended = readAppended(path, prevOffset)
          if (!appended || !appended.text) {
            if (appended) stamps.set(stampKey, { m: st.mtimeMs, s: st.size })
            continue
          }
          for (const line of appended.text.split('\n')) {
            if (!line.trim()) continue
            let o: WbLine
            try {
              o = JSON.parse(line) as WbLine
            } catch {
              continue
            }
            if (typeof o.sessionId === 'string' && o.sessionId) transcriptSessions.add(o.sessionId)
            const ts = typeof o.timestamp === 'number' ? o.timestamp : null
            if (ts == null) continue
            let model: string | null = o.providerData?.model ?? null
            let input: number | null = null
            let output: number | null = null
            let cacheRead = 0
            const pu = o.providerData?.usage
            const mu = o.message?.usage
            if (pu && typeof pu.inputTokens === 'number') {
              input = pu.inputTokens
              output = pu.outputTokens ?? 0
              cacheRead = pu.inputTokensDetails?.[0]?.cached_tokens ?? 0
            } else if (mu && typeof mu.input_tokens === 'number') {
              input = mu.input_tokens
              output = mu.output_tokens ?? 0
              cacheRead = mu.cache_read_input_tokens ?? 0
              if (typeof mu.input_tokens_details === 'object') {
                const det = mu.input_tokens_details as { cached_tokens?: number } | undefined
                cacheRead = det?.cached_tokens ?? cacheRead
              }
            }
            if (input == null) continue
            const out = output ?? 0
            const inputNonCache = Math.max(0, input - cacheRead)
            if (inputNonCache + out <= 0) continue
            if (!model) model = 'unknown'
            usageRows.push({
              agent: this.id,
              model,
              provider: 'workbuddy',
              ts,
              inputTokens: inputNonCache,
              outputTokens: out,
              reasoningTokens: 0, // reasoning ⊆ output（实测 total=input+output）
              cacheReadTokens: cacheRead,
              cacheWriteTokens: 0,
              sessionId: o.sessionId ?? null,
              dedupeKey: `workbuddy:line:${o.id ?? `${ts}:${input}:${output}`}`,
              isEstimated: false
            })
          }
          stamps.set(stampKey, { m: st.mtimeMs, s: st.size })
        }
      }
    }
    if (usageRows.length > 0) records = this.store.insertUsage(usageRows)

    // 2) traces 兜底（仅转录未覆盖的 sessionId）
    const traceRows: Parameters<StoreWriter['insertUsage']>[0] = []
    for (const dir of traceDirs()) {
      let pids: string[] = []
      try {
        pids = readdirSync(dir)
      } catch {
        continue
      }
      for (const pid of pids) {
        const pidDir = join(dir, pid)
        let files: string[] = []
        try {
          files = readdirSync(pidDir).filter((f) => f.startsWith('trace_') && f.endsWith('.json'))
        } catch {
          continue
        }
        for (const file of files) {
          const path = join(pidDir, file)
          let st: { mtimeMs: number; size: number }
          try {
            const s = statSync(path)
            st = { mtimeMs: s.mtimeMs, size: s.size }
          } catch {
            continue
          }
          const prev = stamps.get(path)
          if (prev && prev.m === st.mtimeMs && prev.s === st.size) continue
          let d: WbTrace
          try {
            d = JSON.parse(readFileSync(path, 'utf8')) as WbTrace
          } catch {
            continue
          }
          const t = d.trace
          if (t?.traceId && t.sessionId && !transcriptSessions.has(t.sessionId)) {
            const mi = t.modelInfo
            const totalTokens = t.totalTokens ?? 0
            if (totalTokens > 0 && typeof t.startedAt === 'string') {
              const tsMs = Date.parse(t.startedAt)
              if (!Number.isNaN(tsMs)) {
                const input = mi?.totalInputTokens
                const output = mi?.totalOutputTokens
                const cache = mi?.totalCachedTokens ?? 0
                const fallbackInput = Math.max(0, totalTokens - (output ?? 0))
                traceRows.push({
                  agent: this.id,
                  model: mi?.models?.[0] ?? 'unknown',
                  provider: 'workbuddy',
                  ts: tsMs,
                  inputTokens: typeof input === 'number' ? Math.max(0, input - cache) : fallbackInput,
                  outputTokens: output ?? 0,
                  reasoningTokens: 0,
                  cacheReadTokens: cache,
                  cacheWriteTokens: 0,
                  sessionId: t.sessionId,
                  dedupeKey: `workbuddy:trace:${t.traceId}`,
                  isEstimated: false
                })
              }
            }
          }
          stamps.set(path, { m: st.mtimeMs, s: st.size })
        }
      }
    }
    if (traceRows.length > 0) records += this.store.insertUsage(traceRows)

    // 3) workbuddy.db sessions（title/model/cwd）
    for (const base of [WB_NEW, WB_OLD]) {
      const dbPath = join(base, 'workbuddy.db')
      if (!existsSync(dbPath)) continue
      try {
        const db = openReadonlyDb(dbPath)
        try {
          if (tableExists(db, 'sessions') && tableColumns(db, 'sessions').includes('title')) {
            const rows = db
              .prepare(
                `SELECT id, title, custom_title, cwd, model, created_at, updated_at
                 FROM sessions LIMIT 20000`
              )
              .all() as Array<Record<string, unknown>>
            const sRows: Parameters<StoreWriter['upsertSessions']>[0] = []
            for (const r of rows) {
              const id = typeof r.id === 'string' ? r.id : null
              if (!id) continue
              const title = [r.custom_title, r.title].find(
                (v): v is string => typeof v === 'string' && v.length > 0
              )
              sRows.push({
                agent: this.id,
                sessionId: id,
                title: title ?? null,
                projectDir: typeof r.cwd === 'string' ? r.cwd : null,
                model: typeof r.model === 'string' ? r.model : null,
                startedAt: typeof r.created_at === 'number' ? r.created_at : null,
                updatedAt: typeof r.updated_at === 'number' ? r.updated_at : null
              })
            }
            if (sRows.length > 0) sessions = this.store.upsertSessions(sRows)
          }
        } finally {
          db.close()
        }
      } catch {
        // db 忙/损坏不影响前两源
      }
    }

    const fileStamps: Record<string, FileStamp> = {}
    for (const [k, v] of stamps) fileStamps[k] = v
    const jsonlOffsets: Record<string, number> = {}
    for (const [k, v] of stamps) jsonlOffsets[k] = v.s
    return {
      records,
      sessions,
      tools: 0,
      lastTs: ctx.now,
      meta: { ...ctx.state.meta, fileStamps, jsonlOffsets }
    }
  }
}
