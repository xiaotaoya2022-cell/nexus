// 总览：今日 Token KPI 卡 ×2 + 7 天趋势折线 + Token 类型环形 + 今日会话 top10。
// KPI 与环形由 agent.overview 推送驱动（约 2s）；趋势/会话为请求式数据。

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { EChartsCoreOption } from 'echarts/core'
import type { SessionRow, TrendPoint, Overview } from '@shared/types'
import { Chart, AXIS_LABEL, CHART_COLORS, TOOLTIP_DARK } from '../components/Chart'
import { conn } from '../lib/conn'
import { fmtCompact, fmtTime, fmtUsd } from '../lib/format'
import { useStore } from '../lib/store'

const TOKEN_TYPES: Array<{ key: keyof Overview['totals']; label: string }> = [
  { key: 'input', label: '输入' },
  { key: 'output', label: '输出' },
  { key: 'reasoning', label: '推理' },
  { key: 'cacheRead', label: '缓存读' },
  { key: 'cacheWrite', label: '缓存写' }
]

export function OverviewPage() {
  const overview = useStore((s) => s.overview)
  const online = useStore((s) => s.status.status === 'online')
  const [trend, setTrend] = useState<TrendPoint[] | null>(null)
  const [sessions, setSessions] = useState<SessionRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [t, s] = await Promise.all([
        conn.request<TrendPoint[]>('agent.trend', { range: '7d', groupBy: 'model' }),
        conn.request<SessionRow[]>('agent.sessions', { range: 'today', limit: 10 })
      ])
      setTrend(t)
      setSessions(s)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    if (online) void load()
  }, [online, load])

  const totals = overview?.totals ?? null

  const trendOption = useMemo<EChartsCoreOption>(() => {
    const points = trend ?? []
    return {
      grid: { left: 8, right: 10, top: 30, bottom: 4, containLabel: true },
      tooltip: {
        ...TOOLTIP_DARK,
        trigger: 'axis',
        valueFormatter: (v: unknown) => fmtCompact(Number(v))
      },
      xAxis: {
        type: 'category',
        data: points.map((p) => p.bucket.slice(5)),
        axisLabel: AXIS_LABEL,
        axisLine: { lineStyle: { color: 'rgba(255,255,255,.1)' } },
        axisTick: { show: false }
      },
      yAxis: {
        type: 'value',
        axisLabel: { ...AXIS_LABEL, formatter: (v: number) => fmtCompact(v) },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } }
      },
      series: [
        {
          name: 'Token 总量',
          type: 'line',
          data: points.map((p) => p.total),
          smooth: true,
          symbol: 'circle',
          symbolSize: 5,
          lineStyle: { color: CHART_COLORS[0], width: 2 },
          itemStyle: { color: CHART_COLORS[0] },
          areaStyle: { color: 'rgba(64,153,255,.12)' }
        },
        {
          name: '输出',
          type: 'line',
          data: points.map((p) => p.output),
          smooth: true,
          symbol: 'none',
          lineStyle: { color: CHART_COLORS[1], width: 1.5, type: 'dashed' },
          itemStyle: { color: CHART_COLORS[1] }
        }
      ],
      legend: {
        top: 2,
        right: 4,
        icon: 'roundRect',
        itemWidth: 10,
        itemHeight: 4,
        textStyle: { color: 'rgba(212,212,212,.6)', fontSize: 10 }
      }
    }
  }, [trend])

  const donutOption = useMemo<EChartsCoreOption>(() => {
    const data = totals
      ? TOKEN_TYPES.map((t, i) => ({
          name: t.label,
          value: Number(totals[t.key]) || 0,
          itemStyle: { color: CHART_COLORS[i % CHART_COLORS.length] }
        }))
      : []
    const total = data.reduce((acc, d) => acc + d.value, 0)
    return {
      tooltip: { ...TOOLTIP_DARK, trigger: 'item', valueFormatter: (v: unknown) => fmtCompact(Number(v)) },
      legend: {
        bottom: 0,
        left: 'center',
        icon: 'circle',
        itemWidth: 8,
        itemHeight: 8,
        itemGap: 10,
        textStyle: { color: 'rgba(212,212,212,.6)', fontSize: 10 }
      },
      title: {
        text: total > 0 ? fmtCompact(total) : '—',
        subtext: '今日 Token',
        left: 'center',
        top: '34%',
        textStyle: { color: '#d4d4d4', fontSize: 20, fontWeight: 600, fontFamily: 'Consolas, monospace' },
        subtextStyle: { color: 'rgba(212,212,212,.6)', fontSize: 10 }
      },
      series: [
        {
          type: 'pie',
          radius: ['52%', '74%'],
          center: ['50%', '44%'],
          data: total > 0 ? data : [],
          label: { show: false },
          emphasis: { scaleSize: 4 }
        }
      ]
    }
  }, [totals])

  return (
    <div className="page-scroll">
      {!online && <div className="banner warn">未连接 PC 端，数据可能过期</div>}
      {err != null && <div className="banner error">加载失败：{err}</div>}

      <div className="kpi-row">
        <div className="card kpi">
          <div className="card-title">今日 Token</div>
          <div className="kpi-value mono">{fmtCompact(totals?.total)}</div>
          <div className="kpi-sub">
            缓存读 <span className="mono">{fmtCompact(totals?.cacheRead)}</span>
          </div>
        </div>
        <div className="card kpi">
          <div className="card-title">输出 Token</div>
          <div className="kpi-value mono accent-green">{fmtCompact(totals?.output)}</div>
          <div className="kpi-sub">
            请求 <span className="mono">{totals?.requests ?? '—'}</span> · 成本{' '}
            <span className="mono">{fmtUsd(totals?.estimatedCostUsd)}</span>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">7 天趋势</div>
        {trend != null && trend.length > 0 ? (
          <Chart option={trendOption} className="chart-box tall" />
        ) : (
          <div className="empty">{online ? '暂无趋势数据' : '等待连接…'}</div>
        )}
      </div>

      <div className="card">
        <div className="card-title">Token 类型 · 今日</div>
        {totals != null ? (
          <Chart option={donutOption} className="chart-box donut" />
        ) : (
          <div className="empty">{online ? '等待推送（约 2s）…' : '等待连接…'}</div>
        )}
      </div>

      <div className="card">
        <div className="card-title">今日会话 · Top 10</div>
        {sessions == null ? (
          <div className="empty">{online ? '加载中…' : '等待连接…'}</div>
        ) : sessions.length === 0 ? (
          <div className="empty">今日暂无会话</div>
        ) : (
          <div className="list">
            {sessions.map((s) => (
              <div className="list-row" key={`${s.agent}-${s.sessionId}`}>
                <div className="list-main">
                  <div className="list-title">{s.title ?? s.sessionId.slice(0, 12)}</div>
                  <div className="list-sub">
                    {s.agent}
                    {s.model != null ? ` · ${s.model}` : ''}
                    {s.updatedAt != null ? ` · ${fmtTime(s.updatedAt)}` : ''}
                  </div>
                </div>
                <div className="list-side mono">{fmtCompact(s.tokens)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
