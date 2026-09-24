// 查询服务（aggregator 应用层）：为看板提供全部只读查询。
// 时间口径：库内 ts 为 epoch ms；日期分桶用 SQLite localtime 修饰符（跟随本机时区），
// today 的起点取 JS 本地零点，两者一致。

import type {
  CalendarDay,
  HeatmapData,
  NamedStat,
  Overview,
  RangeKey,
  SessionRow,
  TokenTotals,
  ToolStat,
  TrendPoint,
  TokenTypeStat
} from '@shared/types'
import type { NexusStore } from '../infrastructure/store'
import { TOTAL_EXPR } from '../infrastructure/store'
import { estimateCostUsd } from './pricing'

const SUMS = `SUM(input_tokens) i, SUM(output_tokens) o, SUM(reasoning_tokens) r,
  SUM(cache_read_tokens) cr, SUM(cache_write_tokens) cw, COUNT(*) n`

export function rangeStartMs(range: RangeKey, now = Date.now()): number {
  if (range === 'all') return 0
  if (range === 'today') {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  if (range === 'month') {
    const d = new Date(now)
    d.setDate(1)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  if (range === 'year') {
    const d = new Date(now)
    d.setMonth(0, 1)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  const days = range === '7d' ? 7 : 30
  return now - days * 86400_000
}

interface SumRow {
  i: number
  o: number
  r: number
  cr: number
  cw: number
  n: number
}

function emptySum(): SumRow {
  return { i: 0, o: 0, r: 0, cr: 0, cw: 0, n: 0 }
}

function normalize(row: Partial<SumRow> | undefined): SumRow {
  const s = emptySum()
  if (!row) return s
  return {
    i: Number(row.i) || 0,
    o: Number(row.o) || 0,
    r: Number(row.r) || 0,
    cr: Number(row.cr) || 0,
    cw: Number(row.cw) || 0,
    n: Number(row.n) || 0
  }
}

export class QueryService {
  constructor(private readonly store: NexusStore) {}

  private where(range: RangeKey, agent: string | null, now: number): {
    sql: string
    params: Array<string | number>
  } {
    const since = rangeStartMs(range, now)
    const conds = ['ts >= ?']
    const params: Array<string | number> = [since]
    if (agent) {
      conds.push('agent = ?')
      params.push(agent)
    }
    return { sql: `WHERE ${conds.join(' AND ')}`, params }
  }

  getOverview(range: RangeKey, agent: string | null, now = Date.now()): Overview {
    const w = this.where(range, agent, now)
    const sum = normalize(
      this.store.db
        .prepare(`SELECT ${SUMS} FROM usage_records ${w.sql}`)
        .get(...w.params) as Partial<SumRow> | undefined
    )
    const sessionRow = this.store.db
      .prepare(
        `SELECT COUNT(DISTINCT session_id) c FROM usage_records ${w.sql} AND session_id IS NOT NULL`
      )
      .get(...w.params) as { c: number } | undefined
    const toolRow = this.store.db
      .prepare(
        `SELECT COUNT(*) c FROM tool_calls WHERE ts >= ? ${agent ? 'AND agent = ?' : ''}`
      )
      .get(...(agent ? [rangeStartMs(range, now), agent] : [rangeStartMs(range, now)])) as
      | { c: number }
      | undefined
    const modelRow = this.store.db
      .prepare(`SELECT COUNT(DISTINCT model) c FROM usage_records ${w.sql}`)
      .get(...w.params) as { c: number } | undefined

    // 成本按模型逐项估算（定价因模型而异）
    const modelRows = this.store.db
      .prepare(`SELECT model, ${SUMS} FROM usage_records ${w.sql} GROUP BY model`)
      .all(...w.params) as Array<Record<string, unknown>>
    let cost = 0
    for (const m of modelRows) {
      cost += estimateCostUsd(String(m.model), {
        input: Number(m.i) || 0,
        output: Number(m.o) || 0,
        reasoning: Number(m.r) || 0,
        cacheRead: Number(m.cr) || 0,
        cacheWrite: Number(m.cw) || 0
      })
    }

    const totals: TokenTotals = {
      requests: sum.n,
      input: sum.i,
      output: sum.o,
      reasoning: sum.r,
      cacheRead: sum.cr,
      cacheWrite: sum.cw,
      total: sum.i + sum.o + sum.r + sum.cr + sum.cw,
      estimatedCostUsd: cost
    }
    return {
      range,
      agent,
      totals,
      sessionCount: Number(sessionRow?.c) || 0,
      toolCallCount: Number(toolRow?.c) || 0,
      activeModels: Number(modelRow?.c) || 0
    }
  }

  getTrend(
    range: RangeKey,
    agent: string | null,
    groupBy: 'model' | 'agent',
    now = Date.now()
  ): TrendPoint[] {
    const w = this.where(range, agent, now)
    const bucketExpr =
      range === 'today'
        ? `strftime('%H', ts/1000, 'unixepoch', 'localtime') || ':00'`
        : `strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime')`
    const rows = this.store.db
      .prepare(
        `SELECT ${bucketExpr} b, ${groupBy} g, ${SUMS} FROM usage_records ${w.sql} GROUP BY b, g ORDER BY b`
      )
      .all(...w.params) as Array<Record<string, unknown>>

    const points = new Map<string, TrendPoint>()
    const ensure = (b: string): TrendPoint => {
      let p = points.get(b)
      if (!p) {
        p = {
          bucket: b,
          total: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          series: {}
        }
        points.set(b, p)
      }
      return p
    }
    for (const row of rows) {
      const b = String(row.b)
      const g = String(row.g ?? 'unknown')
      const p = ensure(b)
      const tot = (Number(row.i) || 0) + (Number(row.o) || 0) + (Number(row.r) || 0) +
        (Number(row.cr) || 0) + (Number(row.cw) || 0)
      p.series[g] = (p.series[g] ?? 0) + tot
      p.total += tot
      p.input += Number(row.i) || 0
      p.output += Number(row.o) || 0
      p.reasoning += Number(row.r) || 0
      p.cacheRead += Number(row.cr) || 0
      p.cacheWrite += Number(row.cw) || 0
    }

    // 补齐空桶，保证折线时间轴连续
    const result = [...points.values()]
    if (range === 'today') {
      const filled: TrendPoint[] = []
      for (let h = 0; h < 24; h++) {
        const label = `${String(h).padStart(2, '0')}:00`
        filled.push(points.get(label) ?? { bucket: label, total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, series: {} })
      }
      return filled
    }
    if (range !== 'all' && result.length > 1) {
      const filled: TrendPoint[] = []
      const start = new Date(rangeStartMs(range, now))
      const end = new Date(now)
      const cursor = new Date(start)
      while (cursor.getTime() <= end.getTime()) {
        const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
        filled.push(points.get(key) ?? { bucket: key, total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, series: {} })
        cursor.setDate(cursor.getDate() + 1)
      }
      return filled
    }
    return result.sort((a, b) => (a.bucket < b.bucket ? -1 : 1))
  }

  private namedStats(sql: string, params: Array<string | number>): NamedStat[] {
    const rows = this.store.db.prepare(sql).all(...params) as Array<Record<string, unknown>>
    return rows
      .map((r) => {
        const i = Number(r.i) || 0
        const o = Number(r.o) || 0
        const cr = Number(r.cr) || 0
        const cw = Number(r.cw) || 0
        return {
          name: String(r.g),
          tokens: i + o + (Number(r.r) || 0) + cr + cw,
          requests: Number(r.n) || 0,
          input: i,
          output: o,
          cacheRead: cr,
          cacheWrite: cw
        }
      })
      .sort((a, b) => b.tokens - a.tokens)
  }

  getByAgent(range: RangeKey, now = Date.now()): NamedStat[] {
    const w = this.where(range, null, now)
    return this.namedStats(
      `SELECT agent g, ${SUMS} FROM usage_records ${w.sql} GROUP BY agent`,
      w.params
    )
  }

  getByModel(range: RangeKey, agent: string | null, now = Date.now()): NamedStat[] {
    const w = this.where(range, agent, now)
    return this.namedStats(
      `SELECT model g, ${SUMS} FROM usage_records ${w.sql} GROUP BY model`,
      w.params
    )
  }

  getTokenTypeBreakdown(range: RangeKey, agent: string | null, now = Date.now()): TokenTypeStat[] {
    const w = this.where(range, agent, now)
    const s = normalize(
      this.store.db
        .prepare(`SELECT ${SUMS} FROM usage_records ${w.sql}`)
        .get(...w.params) as Partial<SumRow> | undefined
    )
    return [
      { key: 'input', label: '输入', tokens: s.i },
      { key: 'output', label: '输出', tokens: s.o },
      { key: 'reasoning', label: '推理', tokens: s.r },
      { key: 'cacheRead', label: '缓存读取', tokens: s.cr },
      { key: 'cacheWrite', label: '缓存写入', tokens: s.cw }
    ]
  }

  getHeatmap(range: RangeKey, agent: string | null, now = Date.now()): HeatmapData {
    const w = this.where(range, agent, now)
    const rows = this.store.db
      .prepare(
        `SELECT CAST(strftime('%H', ts/1000, 'unixepoch', 'localtime') AS INTEGER) h,
                CAST(strftime('%w', ts/1000, 'unixepoch', 'localtime') AS INTEGER) wd,
                SUM(${TOTAL_EXPR}) t
         FROM usage_records ${w.sql} GROUP BY h, wd`
      )
      .all(...w.params) as Array<Record<string, unknown>>
    const cells: HeatmapData['cells'] = []
    let max = 0
    for (const r of rows) {
      const hour = Number(r.h) || 0
      const sundayFirst = Number(r.wd) || 0
      const weekday = (sundayFirst + 6) % 7 // 0=周一
      const tokens = Number(r.t) || 0
      cells.push([hour, weekday, tokens])
      if (tokens > max) max = tokens
    }
    return { cells, max }
  }

  getCalendar(range: RangeKey, agent: string | null, now = Date.now()): CalendarDay[] {
    const w = this.where(range, agent, now)
    const rows = this.store.db
      .prepare(
        `SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') d, SUM(${TOTAL_EXPR}) t
         FROM usage_records ${w.sql} GROUP BY d ORDER BY d`
      )
      .all(...w.params) as Array<Record<string, unknown>>
    return rows.map((r) => ({ day: String(r.d), tokens: Number(r.t) || 0 }))
  }

  getToolStats(range: RangeKey, agent: string | null, now = Date.now()): ToolStat[] {
    const since = rangeStartMs(range, now)
    const rows = this.store.db
      .prepare(
        `SELECT tool_name t, COUNT(*) c FROM tool_calls
         WHERE ts >= ? ${agent ? 'AND agent = ?' : ''} GROUP BY tool_name ORDER BY c DESC LIMIT 12`
      )
      .all(...(agent ? [since, agent] : [since])) as Array<Record<string, unknown>>
    return rows.map((r) => ({ tool: String(r.t), count: Number(r.c) || 0 }))
  }

  getSessions(range: RangeKey, agent: string | null, limit: number, now = Date.now()): SessionRow[] {
    const since = rangeStartMs(range, now)
    const rows = this.store.db
      .prepare(
        `SELECT s.agent, s.session_id, s.title, s.project_dir, s.model, s.started_at, s.updated_at,
                ifnull(u.tokens, 0) tokens, ifnull(u.requests, 0) requests
         FROM sessions s
         LEFT JOIN (
           SELECT agent, session_id, SUM(${TOTAL_EXPR}) tokens, COUNT(*) requests
           FROM usage_records
           WHERE ts >= ? AND session_id IS NOT NULL
           GROUP BY agent, session_id
         ) u ON u.agent = s.agent AND u.session_id = s.session_id
         WHERE (? IS NULL OR s.agent = ?)
         ORDER BY tokens DESC, COALESCE(s.updated_at, 0) DESC
         LIMIT ?`
      )
      .all(since, agent, agent, limit) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      agent: String(r.agent),
      sessionId: String(r.session_id),
      title: r.title == null ? null : String(r.title),
      projectDir: r.project_dir == null ? null : String(r.project_dir),
      model: r.model == null ? null : String(r.model),
      startedAt: r.started_at == null ? null : Number(r.started_at),
      updatedAt: r.updated_at == null ? null : Number(r.updated_at),
      tokens: Number(r.tokens) || 0,
      requests: Number(r.requests) || 0
    }))
  }
}
