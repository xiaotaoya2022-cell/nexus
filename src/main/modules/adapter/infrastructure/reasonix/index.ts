// Reasonix 桌面端适配器。数据源（本机实测 2026-10-02）：
// 1) %APPDATA%/reasonix/stats/YYYY-MM-DD.jsonl —— 请求级用量日志（按天分文件、追加写）：
//    {"ts":"2026-08-16T00:00:50.9687143+08:00","model":"API SPACE/deepseek-v4-flash","source":"desktop",
//     "prompt":902112,"completion":501,"reasoning":283,"cache_hit":902016,"cache_miss":96,"total":902613,
//     "requests":1,...}
//    口径实测：total = prompt + completion（reasoning ⊆ completion；prompt = cache_hit + cache_miss）。
//    → Nexus 映射：input=cache_miss，cacheRead=cache_hit，output=completion，reasoning=0（防双计）。
// 2) %APPDATA%/reasonix/sessions/<YYYYMMDD-HHMMSS.ffffff>-<model>.ckpt/turn-N.json —— 会话元数据，
//    turn-0.json 含 time/prompt（作标题）。
// 增量：stats 按文件字节 offset 续读；sessions 按目录名记录已入库。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type {
  AgentAdapter,
  SyncContext,
  SyncResult,
  StoreWriter
} from '@main/modules/adapter/domain/types'

const BASE = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'reasonix')
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

  constructor(private readonly store: StoreWriter) {}

  detect(): boolean {
    return existsSync(this.statsDir) || existsSync(this.sessionsDir)
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

    let records = 0
    let sessions = 0

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
          // 只读新增区段；按行取完整行（最后可能半行，留在下轮）
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
        if (lines.length > 0 && !text.endsWith('\n')) lines.pop() // 半行留待下轮
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
            reasoningTokens: 0, // 实测 reasoning ⊆ completion，另计会双计
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

    // 2) sessions 目录 → 会话元数据（新目录才扫，turn-0.json 作标题）
    if (existsSync(this.sessionsDir)) {
      const dirs = readdirSync(this.sessionsDir).filter((d) => d.endsWith('.ckpt'))
      const sessionRows: Parameters<StoreWriter['upsertSessions']>[0] = []
      for (const dir of dirs) {
        if (seenSessions.has(dir)) continue
        const dirPath = join(this.sessionsDir, dir)
        // 目录名：<YYYYMMDD-HHMMSS.ffffff>-<model>.ckpt
        const m = dir.match(SESSION_DIR_RE)
        let startedAt: number | null = m ? localStampToMs(m[1]) : null
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
          // 无 turn-0 也保留目录级元数据
        }
        sessionRows.push({
          agent: this.id,
          sessionId: dir,
          title,
          projectDir: null,
          model: m ? normalizeModel(m[2]) : null,
          startedAt,
          updatedAt
        })
        seenSessions.add(dir)
        sessions++
      }
      if (sessionRows.length > 0) this.store.upsertSessions(sessionRows)
    }

    return {
      records,
      sessions,
      tools: 0,
      lastTs: ctx.now,
      meta: {
        ...ctx.state.meta,
        statsOffsets: Object.fromEntries(offsets),
        seenSessions: [...seenSessions].slice(-2000)
      }
    }
  }
}
