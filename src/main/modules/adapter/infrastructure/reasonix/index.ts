// Reasonix 桌面端适配器。数据源：
// 1) %APPDATA%/reasonix/stats/YYYY-MM-DD.jsonl —— 请求级用量日志（按天分文件、追加写）：
//    口径实测：total = prompt + completion（reasoning ⊆ completion；prompt = cache_hit + cache_miss）。
//    → Nexus 映射：input=cache_miss，cacheRead=cache_hit，output=completion，reasoning=0（防双计）。
// 2) %LOCALAPPDATA%/reasonix/session-catalog/v4.sqlite & v5.sqlite —— catalog_topics 会话目录。
// 3) %LOCALAPPDATA%/reasonix/task-catalog/v1.sqlite —— task_snapshots 任务/工具执行记录。
// 4) %APPDATA%/reasonix/{sessions,projects/*/sessions}/*.jsonl & *.ckpt —— 会话消息与 tool_calls 工具调用。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type {
  AgentAdapter,
  SyncContext,
  SyncResult,
  StoreWriter
} from '@main/modules/adapter/domain/types'
import {
  collectFilesAsync,
  openReadonlyDb,
  parseTimestampMs,
  readJsonlOrZstdLines,
  sqliteFileStamp,
  statFilesAsync,
  tableExists,
  yieldToEventLoop
} from '../util'

const BASE = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'reasonix')
const LOCAL_BASE = join(
  process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
  'reasonix'
)
const TZ_OFFSET_MS = 8 * 3600_000 // 目录名时间戳为 UTC+8 本地时间

interface ReasonixStatLine {
  ts?: string
  model?: string
  prompt?: number
  completion?: number
  reasoning?: number
  cache_hit?: number
  cache_miss?: number
  total?: number
  requests?: number
}

function parseTsMs(iso: string | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

/** "API SPACE/deepseek-v4-flash" → "deepseek-v4-flash"（前缀是项目名不是模型） */
function normalizeModel(m: string | undefined): string {
  if (!m) return 'unknown'
  const idx = m.lastIndexOf('/')
  return idx >= 0 && idx < m.length - 1 ? m.slice(idx + 1) : m
}

/** "20260810-131307"（UTC+8）→ epoch ms。非法输入返回 null。 */
function localStampToMs(stamp: string): number | null {
  if (!/^\d{8}-\d{6}$/.test(stamp)) return null
  const y = Number(stamp.slice(0, 4))
  const mo = Number(stamp.slice(4, 6))
  const d = Number(stamp.slice(6, 8))
  const hh = Number(stamp.slice(9, 11))
  const mi = Number(stamp.slice(11, 13))
  const ss = Number(stamp.slice(13, 15))
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null
  return Date.UTC(y, mo - 1, d, hh, mi, ss) - TZ_OFFSET_MS
}

const SESSION_DIR_RE = /^(\d{8}-\d{6})\.\d+-(.+)\.ckpt$/

export class ReasonixAdapter implements AgentAdapter {
  readonly id = 'reasonix'
  readonly label = 'Reasonix'
  private readonly statsDir = join(BASE, 'stats')
  private readonly sessionsDir = join(BASE, 'sessions')
  private readonly projectsDir = join(BASE, 'projects')

  constructor(private readonly store: StoreWriter) {}

  detect(): boolean {
    return existsSync(this.statsDir) || existsSync(this.sessionsDir) || existsSync(LOCAL_BASE)
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    if (!this.detect()) {
      return { records: 0, sessions: 0, tools: 0, lastTs: ctx.state.lastTs, meta: ctx.state.meta }
    }
    const offsets = new Map<string, number>(
      Object.entries((ctx.state.meta.statsOffsets as Record<string, number> | undefined) ?? {})
    )
    const seenSessions = new Set<string>(
      Array.isArray(ctx.state.meta.seenSessions) ? (ctx.state.meta.seenSessions as string[]) : []
    )
    const jsonlStamps: Record<string, string> = {
      ...((ctx.state.meta.jsonlStamps as Record<string, string> | undefined) ?? {})
    }
    const sqliteStamps: Record<string, string> = {
      ...((ctx.state.meta.sqliteStamps as Record<string, string> | undefined) ?? {})
    }

    let records = 0
    let sessions = 0
    let tools = 0

    // 1) stats/*.jsonl 增量续读
    if (existsSync(this.statsDir)) {
      const files = readdirSync(this.statsDir)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
      const rows: Parameters<StoreWriter['insertUsage']>[0] = []
      for (const file of files) {
        const path = join(this.statsDir, file)
        let size = 0
        try {
          size = statSync(path).size
        } catch {
          continue
        }
        const prev = offsets.get(file) ?? 0
        if (size <= prev) continue
        let text = ''
        let start = prev
        try {
          const buf = readFileSync(path)
          if (prev > 0) {
            const nl = buf.subarray(0, Math.min(prev + 1, size)).lastIndexOf(0x0a)
            start = nl > 0 ? nl + 1 : prev
          }
          text = buf.subarray(start, size).toString('utf8')
        } catch {
          continue
        }
        const lines = text.split('\n')
        if (lines.length > 0 && !text.endsWith('\n')) lines.pop()
        let consumed = start
        for (const line of lines) {
          consumed += Buffer.byteLength(line, 'utf8') + 1
          if (!line.trim()) continue
          let o: ReasonixStatLine
          try {
            o = JSON.parse(line) as ReasonixStatLine
          } catch {
            continue
          }
          const ts = parseTsMs(o.ts)
          const total = o.total ?? 0
          if (ts == null || total <= 0) continue
          const model = normalizeModel(o.model)
          rows.push({
            agent: this.id,
            model,
            provider: null,
            ts,
            inputTokens: o.cache_miss ?? 0,
            outputTokens: o.completion ?? 0,
            reasoningTokens: 0,
            cacheReadTokens: o.cache_hit ?? 0,
            cacheWriteTokens: 0,
            sessionId: null,
            dedupeKey: `reasonix:${o.ts}:${model}`,
            isEstimated: false
          })
        }
        offsets.set(file, consumed)
      }
      if (rows.length > 0) records = this.store.insertUsage(rows)
    }

    const sessionMap = new Map<
      string,
      {
        sessionId: string
        title: string | null
        projectDir: string | null
        model: string | null
        startedAt: number | null
        updatedAt: number | null
      }
    >()
    const toolRows: Parameters<StoreWriter['insertToolCalls']>[0] = []

    // 2) sessions/*.ckpt 目录 → 会话元数据
    if (existsSync(this.sessionsDir)) {
      const dirs = readdirSync(this.sessionsDir).filter((d) => d.endsWith('.ckpt'))
      for (const dir of dirs) {
        if (seenSessions.has(dir)) continue
        const dirPath = join(this.sessionsDir, dir)
        const m = dir.match(SESSION_DIR_RE)
        const startedAt: number | null = m ? localStampToMs(m[1]) : null
        let title: string | null = null
        let updatedAt: number | null = null
        try {
          updatedAt = statSync(dirPath).mtimeMs
          const turn0 = JSON.parse(readFileSync(join(dirPath, 'turn-0.json'), 'utf8')) as {
            prompt?: string
            time?: string
          }
          if (turn0.prompt) title = turn0.prompt.slice(0, 120)
          const t0 = parseTsMs(turn0.time)
          if (t0 != null) updatedAt = t0
        } catch {
          // ignore
        }
        sessionMap.set(dir, {
          sessionId: dir,
          title,
          projectDir: null,
          model: m ? normalizeModel(m[2]) : null,
          startedAt,
          updatedAt
        })
        seenSessions.add(dir)
      }
    }

    // 3) %LOCALAPPDATA%/reasonix/session-catalog/v4.sqlite & v5.sqlite
    for (const ver of ['v4.sqlite', 'v5.sqlite']) {
      const dbPath = join(LOCAL_BASE, 'session-catalog', ver)
      const dbStamp = sqliteFileStamp(dbPath)
      if (!dbStamp || sqliteStamps[dbPath] === dbStamp) continue
      try {
        const db = openReadonlyDb(dbPath)
        try {
          if (tableExists(db, 'catalog_topics')) {
            const rows = db
              .prepare(
                `SELECT topic_id, title, workspace_root, created_at, last_activity_at
                 FROM catalog_topics LIMIT 5000`
              )
              .all() as Array<Record<string, unknown>>
            for (const r of rows) {
              const sid = typeof r.topic_id === 'string' && r.topic_id ? r.topic_id : null
              if (!sid) continue
              const existing = sessionMap.get(sid)
              const title =
                typeof r.title === 'string' && r.title.trim()
                  ? r.title.trim().slice(0, 120)
                  : existing?.title ?? null
              const cwd =
                typeof r.workspace_root === 'string' && r.workspace_root
                  ? r.workspace_root
                  : existing?.projectDir ?? null
              const startedAt = parseTimestampMs(r.created_at) ?? existing?.startedAt ?? null
              const updatedAt = parseTimestampMs(r.last_activity_at) ?? existing?.updatedAt ?? null
              sessionMap.set(sid, {
                sessionId: sid,
                title,
                projectDir: cwd,
                model: existing?.model ?? null,
                startedAt,
                updatedAt
              })
            }
          }
          sqliteStamps[dbPath] = dbStamp
        } finally {
          db.close()
        }
      } catch {
        // ignore
      }
    }

    // 4) %LOCALAPPDATA%/reasonix/task-catalog/v1.sqlite
    const taskDbPath = join(LOCAL_BASE, 'task-catalog', 'v1.sqlite')
    const taskStamp = sqliteFileStamp(taskDbPath)
    if (taskStamp && sqliteStamps[taskDbPath] !== taskStamp) {
      try {
        const db = openReadonlyDb(taskDbPath)
        try {
          if (tableExists(db, 'task_snapshots')) {
            const rows = db
              .prepare(
                `SELECT task_id, session_id, kind, created_at FROM task_snapshots LIMIT 10000`
              )
              .all() as Array<Record<string, unknown>>
            for (const r of rows) {
              const tid = typeof r.task_id === 'string' && r.task_id ? r.task_id : null
              if (!tid) continue
              const sid = typeof r.session_id === 'string' && r.session_id ? r.session_id : null
              const kind = typeof r.kind === 'string' && r.kind ? r.kind : 'task'
              const ts = parseTimestampMs(r.created_at)
              toolRows.push({
                agent: this.id,
                toolName: kind.slice(0, 200),
                ts,
                sessionId: sid,
                dedupeKey: `reasonix:task:${tid}`
              })
            }
          }
          sqliteStamps[taskDbPath] = taskStamp
        } finally {
          db.close()
        }
      } catch {
        // ignore
      }
    }

    // 5) %APPDATA%/reasonix/{sessions,projects/*/sessions}/*.jsonl 会话消息与 tool_calls
    const jsonlFiles = [
      ...(await collectFilesAsync(this.sessionsDir, '.jsonl', 2)),
      ...(await collectFilesAsync(this.projectsDir, '.jsonl', 4))
    ].filter(
      (f) =>
        !f.includes('-recovery-') &&
        !f.endsWith('.conflicts.jsonl') &&
        !f.endsWith('.events.jsonl')
    )

    for (const st of await statFilesAsync(jsonlFiles)) {
      const file = st.file
      const stamp = `${Math.floor(st.mtimeMs)}:${st.size}`
      if (jsonlStamps[file] === stamp) continue

      const baseSid = (file.split(/[\\/]/).pop() ?? file).replace(/\.jsonl$/i, '')
      const lines = readJsonlOrZstdLines(file)
      let firstUserPrompt: string | null = null
      let firstTs: number | null = null
      let lastTs: number | null = null

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!line.trim()) continue
        let o: Record<string, unknown>
        try {
          o = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        const ts = parseTimestampMs(o.timestamp ?? o.created_at ?? o.ts ?? o.time)
        if (ts != null) {
          if (firstTs == null || ts < firstTs) firstTs = ts
          if (lastTs == null || ts > lastTs) lastTs = ts
        }
        if (o.role === 'user' && !firstUserPrompt && typeof o.content === 'string' && o.content.trim()) {
          firstUserPrompt = o.content.trim().split(/\r?\n/)[0].slice(0, 120)
        }
        if (Array.isArray(o.tool_calls)) {
          for (let ti = 0; ti < o.tool_calls.length; ti++) {
            const tc = o.tool_calls[ti] as Record<string, unknown> | undefined
            if (!tc || typeof tc !== 'object') continue
            const fn = tc.function as Record<string, unknown> | undefined
            const name =
              typeof tc.name === 'string' && tc.name
                ? tc.name
                : typeof fn?.name === 'string' && fn.name
                  ? fn.name
                  : null
            if (!name) continue
            const tcId = typeof tc.id === 'string' && tc.id ? tc.id : `${i}:${ti}`
            toolRows.push({
              agent: this.id,
              toolName: name.slice(0, 200),
              ts: ts ?? Math.floor(st.mtimeMs),
              sessionId: baseSid,
              dedupeKey: `reasonix:tool:${baseSid}:${tcId}`
            })
          }
        }
      }

      const existing = sessionMap.get(baseSid)
      sessionMap.set(baseSid, {
        sessionId: baseSid,
        title: existing?.title ?? firstUserPrompt ?? null,
        projectDir: existing?.projectDir ?? null,
        model: existing?.model ?? null,
        startedAt: existing?.startedAt ?? firstTs ?? Math.floor(st.mtimeMs),
        updatedAt: Math.max(existing?.updatedAt ?? 0, lastTs ?? Math.floor(st.mtimeMs))
      })
      jsonlStamps[file] = stamp
      await yieldToEventLoop()
    }

    if (toolRows.length > 0) tools = this.store.insertToolCalls(toolRows)
    if (sessionMap.size > 0) {
      sessions = this.store.upsertSessions(
        [...sessionMap.values()].map((s) => ({
          agent: this.id,
          sessionId: s.sessionId,
          title: s.title,
          projectDir: s.projectDir,
          model: s.model,
          startedAt: s.startedAt,
          updatedAt: s.updatedAt
        }))
      )
    }

    return {
      records,
      sessions,
      tools,
      lastTs: ctx.now,
      meta: {
        ...ctx.state.meta,
        statsOffsets: Object.fromEntries(offsets),
        seenSessions: [...seenSessions].slice(-2000),
        jsonlStamps,
        sqliteStamps
      }
    }
  }
}
