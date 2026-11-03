// 查询服务（aggregator 应用层）：为看板提供全部只读查询。
// 时间口径：库内 ts 为 epoch ms；日期分桶用 SQLite localtime 修饰符（跟随本机时区），
// today 的起点取 JS 本地零点，两者一致。

import type {
  BoardData,
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
  SUM(cache_read_tokens) cr, SUM(cache_write_tokens) cw, COALESCE(SUM(requests), COUNT(*)) n`

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
           SELECT agent, session_id, SUM(${TOTAL_EXPR}) tokens, COALESCE(SUM(requests), COUNT(*)) requests
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

  /** 看板全量聚合：单遍扫描 usage_records，同时产出 overview/趋势(双分组)/byAgent/
   *  byModel/breakdown/heatmap/sessions。代替 9 次独立全表查询（实测 1.65s→~0.4s）。
   *  tool_calls 与 sessions 表为独立小表，各自单查。 */
  getBoard(range: RangeKey, agent: string | null, now = Date.now()): BoardData {
    const since = rangeStartMs(range, now)
    const whereAgent = agent ? 'AND agent = ?' : ''
    const params: Array<string | number> = agent ? [since, agent] : [since]

    // ── 主扫描：usage_records 一次物化，JS 单遍聚合 ──
    const rows = this.store.db
      .prepare(
        `SELECT agent, model, session_id, ts,
                input_tokens i, output_tokens o, reasoning_tokens r,
                cache_read_tokens cr, cache_write_tokens cw, COALESCE(requests, 1) n
         FROM usage_records WHERE ts >= ? ${whereAgent}`
      )
      .all(...params) as Array<Record<string, unknown>>

    const sum = { i: 0, o: 0, r: 0, cr: 0, cw: 0, n: 0 }
    const perModel = new Map<string, { i: number; o: number; r: number; cr: number; cw: number; n: number }>()
    const perAgent = new Map<string, { i: number; o: number; r: number; cr: number; cw: number; n: number }>()
    const trendM = new Map<string, Map<string, number>>() // bucket×model → tokens
    const trendA = new Map<string, Map<string, number>>() // bucket×agent → tokens
    const bucketsM = new Map<string, { total: number; i: number; o: number; r: number; cr: number; cw: number; n: number }>()
    const heat = new Map<string, number>() // 'h,wd' → tokens
    const sessionUsage = new Map<string, { agent: string; sessionId: string; tokens: number; requests: number }>()
    const sessionsSet = new Set<string>()
    const isToday = range === 'today'

    for (const r of rows) {
      const i = Number(r.i) || 0
      const o = Number(r.o) || 0
      const rr = Number(r.r) || 0
      const cr = Number(r.cr) || 0
      const cw = Number(r.cw) || 0
      const n = Number(r.n) || 1
      const agentId = String(r.agent)
      const model = String(r.model ?? 'unknown')
      const tot = i + o + rr + cr + cw

      sum.i += i; sum.o += o; sum.r += rr; sum.cr += cr; sum.cw += cw; sum.n += n

      let pm = perModel.get(model)
      if (!pm) { pm = { i: 0, o: 0, r: 0, cr: 0, cw: 0, n: 0 }; perModel.set(model, pm) }
      pm.i += i; pm.o += o; pm.r += rr; pm.cr += cr; pm.cw += cw; pm.n += n

      let pa = perAgent.get(agentId)
      if (!pa) { pa = { i: 0, o: 0, r: 0, cr: 0, cw: 0, n: 0 }; perAgent.set(agentId, pa) }
      pa.i += i; pa.o += o; pa.r += rr; pa.cr += cr; pa.cw += cw; pa.n += n

      // 桶：今日=小时，其余=日期（JS 本地时区，与 strftime localtime 口径一致）
      const d = new Date(Number(r.ts))
      const bucket = isToday
        ? `${String(d.getHours()).padStart(2, '0')}:00`
        : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      let bm = trendM.get(bucket)
      if (!bm) { bm = new Map(); trendM.set(bucket, bm) }
      bm.set(model, (bm.get(model) ?? 0) + tot)
      let ba = trendA.get(bucket)
      if (!ba) { ba = new Map(); trendA.set(bucket, ba) }
      ba.set(agentId, (ba.get(agentId) ?? 0) + tot)

      const bk = bucketsM.get(bucket)
      if (bk) { bk.total += tot; bk.i += i; bk.o += o; bk.r += rr; bk.cr += cr; bk.cw += cw; bk.n += n }
      else bucketsM.set(bucket, { total: tot, i: i, o: o, r: rr, cr: cr, cw: cw, n: n })

      const hkey = `${d.getHours()},${(d.getDay() + 6) % 7}`
      heat.set(hkey, (heat.get(hkey) ?? 0) + tot)

      const sid = r.session_id
      if (sid != null && sid !== '') {
        const skey = `${agentId}\u0000${String(sid)}`
        sessionsSet.add(skey)
        let su = sessionUsage.get(skey)
        if (!su) { su = { agent: agentId, sessionId: String(sid), tokens: 0, requests: 0 }; sessionUsage.set(skey, su) }
        su.tokens += tot
        su.requests += n
      }
    }

    // trend 点组装（含空桶补齐，口径与 getTrend 一致）
    const buildTrend = (byKey: Map<string, Map<string, number>>): TrendPoint[] => {
      const points = new Map<string, TrendPoint>()
      for (const [b, groups] of byKey) {
        let total = 0
        const series: Record<string, number> = {}
        for (const [g, v] of groups) { series[g] = (series[g] ?? 0) + v; total += v }
        const bk = bucketsM.get(b)
        points.set(b, {
          bucket: b, total,
          input: bk?.i ?? 0, output: bk?.o ?? 0, cacheRead: bk?.cr ?? 0,
          cacheWrite: bk?.cw ?? 0, reasoning: bk?.r ?? 0, series
        })
      }
      if (isToday) {
        const filled: TrendPoint[] = []
        for (let h = 0; h < 24; h++) {
          const label = `${String(h).padStart(2, '0')}:00`
          filled.push(points.get(label) ?? { bucket: label, total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, series: {} })
        }
        return filled
      }
      const result = [...points.values()].sort((x, y) => (x.bucket < y.bucket ? -1 : 1))
      if (range !== 'all' && result.length > 1) {
        const filled: TrendPoint[] = []
        const cursor = new Date(rangeStartMs(range, now))
        while (cursor.getTime() <= now) {
          const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
          filled.push(points.get(key) ?? { bucket: key, total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, series: {} })
          cursor.setDate(cursor.getDate() + 1)
        }
        return filled
      }
      return result
    }

    const named = (m: Map<string, { i: number; o: number; r: number; cr: number; cw: number; n: number }>): NamedStat[] =>
      [...m.entries()]
        .map(([name, v]) => ({
          name,
          tokens: v.i + v.o + v.r + v.cr + v.cw,
          requests: v.n,
          input: v.i, output: v.o, cacheRead: v.cr, cacheWrite: v.cw
        }))
        .sort((a, b) => b.tokens - a.tokens)

    let cost = 0
    for (const [model, v] of perModel) {
      cost += estimateCostUsd(model, { input: v.i, output: v.o, reasoning: v.r, cacheRead: v.cr, cacheWrite: v.cw })
    }

    // sessions 表 join（会话元数据小表单查）
    const sessionRows = this.store.db
      .prepare(
        `SELECT agent, session_id, title, project_dir, model, started_at, updated_at
         FROM sessions ${agent ? 'WHERE agent = ?' : ''}`
      )
      .all(...(agent ? [agent] : [])) as Array<Record<string, unknown>>
    const sessions: SessionRow[] = sessionRows
      .map((r) => {
        const su = sessionUsage.get(`${String(r.agent)}\u0000${String(r.session_id)}`)
        return {
          agent: String(r.agent),
          sessionId: String(r.session_id),
          title: r.title == null ? null : String(r.title),
          projectDir: r.project_dir == null ? null : String(r.project_dir),
          model: r.model == null ? null : String(r.model),
          startedAt: r.started_at == null ? null : Number(r.started_at),
          updatedAt: r.updated_at == null ? null : Number(r.updated_at),
          tokens: su?.tokens ?? 0,
          requests: su?.requests ?? 0
        }
      })
      .sort((a, b) => b.tokens - a.tokens || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 120)

    const cells: HeatmapData['cells'] = []
    let heatMax = 0
    for (const [k, tokens] of heat) {
      const parts = k.split(',')
      cells.push([Number(parts[0]), Number(parts[1]), tokens])
      if (tokens > heatMax) heatMax = tokens
    }

    const toolParams: Array<string | number> = [since]
    if (agent) toolParams.push(agent)
    const toolRows = this.store.db
      .prepare(
        `SELECT tool_name t, COUNT(*) c FROM tool_calls
         WHERE ts >= ? ${agent ? 'AND agent = ?' : ''} GROUP BY tool_name ORDER BY c DESC LIMIT 12`
      )
      .all(...toolParams) as Array<Record<string, unknown>>

    return {
      overview: {
        range,
        agent,
        totals: {
          requests: sum.n,
          input: sum.i, output: sum.o, reasoning: sum.r,
          cacheRead: sum.cr, cacheWrite: sum.cw,
          total: sum.i + sum.o + sum.r + sum.cr + sum.cw,
          estimatedCostUsd: cost
        },
        sessionCount: sessionsSet.size,
        toolCallCount: Number(
          (this.store.db
            .prepare(
              `SELECT COUNT(*) c FROM tool_calls WHERE ts >= ? ${agent ? 'AND agent = ?' : ''}`
            )
            .get(...toolParams) as { c: number } | undefined)?.c ?? 0
        ),
        activeModels: perModel.size
      },
      trendByModel: buildTrend(trendM),
      trendByAgent: buildTrend(trendA),
      byAgent: named(perAgent),
      byModel: named(perModel),
      breakdown: [
        { key: 'input', label: '输入', tokens: sum.i },
        { key: 'output', label: '输出', tokens: sum.o },
        { key: 'reasoning', label: '推理', tokens: sum.r },
        { key: 'cacheRead', label: '缓存读取', tokens: sum.cr },
        { key: 'cacheWrite', label: '缓存写入', tokens: sum.cw }
      ],
      heatmap: { cells, max: heatMax },
      tools: toolRows.map((r) => ({ tool: String(r.t), count: Number(r.c) || 0 })),
      sessions
    }
  }
}