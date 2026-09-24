// 系统：CPU / 内存 / 磁盘 / 网络四卡，由 system.snapshot 推送驱动（约 2s 一次）。
// 附加：CPU 负载滚动折线、网络速率滚动热力图、磁盘使用率横向条形、GPU 只读行。

import { useEffect, useMemo, useRef, useState } from 'react'
import type { EChartsCoreOption } from 'echarts/core'
import { Chart, AXIS_LABEL, CHART_COLORS, TOOLTIP_DARK } from '../components/Chart'
import { fmtBytes, fmtBytesRate, fmtPct, fmtUptime } from '../lib/format'
import { useStore } from '../lib/store'

const HIST_LEN = 90 // 约 3 分钟滚动窗口
const CELL_SAMPLES = 10 // 热力图每列聚合的采样数（10 × 2s = 20s/列）
const HEAT_COLS = 8

interface Hist {
  cpu: number[]
  mem: number[]
  rx: number[]
  tx: number[]
}

const EMPTY_HIST: Hist = { cpu: [], mem: [], rx: [], tx: [] }

function pushSeries(arr: number[], v: number | null | undefined): void {
  if (v == null || Number.isNaN(v)) return
  arr.push(v)
  if (arr.length > HIST_LEN) arr.shift()
}

/** 把滚动序列聚合成热力图列（均值，KB/s），不足一列的头部丢弃 */
function heatCells(rx: number[], tx: number[]): { cells: Array<[number, number, number]>; max: number; labels: string[] } {
  const usable = Math.floor(Math.min(rx.length, tx.length) / CELL_SAMPLES) * CELL_SAMPLES
  const cells: Array<[number, number, number]> = []
  const labels: string[] = []
  let max = 0
  const colCount = Math.min(HEAT_COLS, usable / CELL_SAMPLES)
  const start = rx.length - colCount * CELL_SAMPLES
  for (let c = 0; c < colCount; c++) {
    let sumRx = 0
    let sumTx = 0
    for (let i = 0; i < CELL_SAMPLES; i++) {
      sumRx += rx[start + c * CELL_SAMPLES + i]
      sumTx += tx[start + c * CELL_SAMPLES + i]
    }
    const kbRx = sumRx / CELL_SAMPLES / 1024
    const kbTx = sumTx / CELL_SAMPLES / 1024
    cells.push([c, 0, Math.round(kbRx)], [c, 1, Math.round(kbTx)])
    max = Math.max(max, kbRx, kbTx)
    labels.push('')
  }
  return { cells, max: Math.max(1, Math.ceil(max)), labels }
}

export function SystemPage() {
  const snapshot = useStore((s) => s.snapshot)
  const online = useStore((s) => s.status.status === 'online')
  const histRef = useRef<Hist>({ ...EMPTY_HIST, cpu: [], mem: [], rx: [], tx: [] })
  const [hist, setHist] = useState<Hist>(EMPTY_HIST)

  useEffect(() => {
    if (snapshot == null) return
    const h = histRef.current
    pushSeries(h.cpu, snapshot.cpu.loadPercent)
    pushSeries(h.mem, snapshot.memory.usedPercent)
    pushSeries(h.rx, snapshot.network.rxBytesPerSec)
    pushSeries(h.tx, snapshot.network.txBytesPerSec)
    setHist({ cpu: [...h.cpu], mem: [...h.mem], rx: [...h.rx], tx: [...h.tx] })
  }, [snapshot])

  const cpuOption = useMemo<EChartsCoreOption>(
    () => ({
      grid: { left: 6, right: 6, top: 6, bottom: 0, containLabel: false },
      xAxis: { type: 'category', show: false, data: hist.cpu.map((_, i) => i) },
      yAxis: { type: 'value', show: false, max: 100 },
      series: [
        {
          type: 'line',
          data: hist.cpu,
          smooth: true,
          symbol: 'none',
          lineStyle: { color: CHART_COLORS[0], width: 1.5 },
          areaStyle: { color: 'rgba(64,153,255,.12)' }
        }
      ]
    }),
    [hist.cpu]
  )

  const heat = useMemo(() => heatCells(hist.rx, hist.tx), [hist.rx, hist.tx])

  const heatOption = useMemo<EChartsCoreOption>(() => {
    const now = Date.now()
    const labels = heat.cells.length
      ? Array.from({ length: Math.max(...heat.cells.map((c) => c[0])) + 1 }, (_, c) => {
          const secAgo = ((Math.max(...heat.cells.map((x) => x[0])) - c) * CELL_SAMPLES + CELL_SAMPLES) * 2
          const d = new Date(now - secAgo * 1000)
          const p = (x: number) => String(x).padStart(2, '0')
          return `${p(d.getMinutes())}:${p(d.getSeconds())}`
        })
      : []
    return {
      grid: { left: 38, right: 8, top: 4, bottom: 18 },
      tooltip: {
        ...TOOLTIP_DARK,
        formatter: (p: unknown) => {
          const params = p as { value: [number, number, number] }
          const dir = params.value[1] === 0 ? '下行' : '上行'
          return `${dir} ${params.value[2]} KB/s`
        }
      },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { ...AXIS_LABEL, interval: 2 },
        axisLine: { show: false },
        axisTick: { show: false },
        splitArea: { show: false }
      },
      yAxis: {
        type: 'category',
        data: ['下行', '上行'],
        axisLabel: AXIS_LABEL,
        axisLine: { show: false },
        axisTick: { show: false }
      },
      visualMap: {
        show: false,
        min: 0,
        max: heat.max,
        inRange: { color: ['#232936', '#2b4a6f', '#4099ff'] }
      },
      series: [
        {
          type: 'heatmap',
          data: heat.cells,
          label: { show: false }
        }
      ]
    }
  }, [heat])

  const diskOption = useMemo<EChartsCoreOption>(() => {
    const disks = snapshot?.disks ?? []
    const top = [...disks].sort((a, b) => b.usePercent - a.usePercent).slice(0, 6)
    return {
      grid: { left: 8, right: 34, top: 4, bottom: 0, containLabel: true },
      tooltip: {
        ...TOOLTIP_DARK,
        formatter: (p: unknown) => {
          const params = p as { name: string; value: number }
          return `${params.name} ${params.value}%`
        }
      },
      xAxis: { type: 'value', max: 100, show: false },
      yAxis: {
        type: 'category',
        data: top.map((d) => d.mount),
        axisLabel: { ...AXIS_LABEL, fontSize: 9 },
        axisLine: { show: false },
        axisTick: { show: false }
      },
      series: [
        {
          type: 'bar',
          data: top.map((d) => ({
            value: d.usePercent,
            itemStyle: {
              color: d.usePercent >= 90 ? CHART_COLORS[3] : d.usePercent >= 75 ? CHART_COLORS[4] : CHART_COLORS[5],
              borderRadius: 3
            }
          })),
          barWidth: 8,
          label: {
            show: true,
            position: 'right',
            color: 'rgba(212,212,212,.6)',
            fontSize: 9,
            fontFamily: 'Consolas, monospace',
            formatter: (p: unknown) => `${(p as { value: number }).value}%`
          }
        }
      ]
    }
  }, [snapshot])

  const cpu = snapshot?.cpu
  const mem = snapshot?.memory
  const net = snapshot?.network
  const gpus = snapshot?.gpus ?? []

  return (
    <div className="page-scroll">
      {!online && <div className="banner warn">未连接 PC 端</div>}
      {online && snapshot == null && <div className="banner">等待 system.snapshot 推送（约 2s）…</div>}

      <div className="card">
        <div className="card-head">
          <span className="card-title">CPU</span>
          <span className="card-side mono">{fmtUptime(snapshot?.uptimeSec)}</span>
        </div>
        <div className="big-metric">
          <span className="mono accent-blue">{fmtPct(cpu?.loadPercent)}</span>
          <span className="metric-sub">
            {cpu?.model ?? '—'} · {cpu?.cores ?? '—'} 核
          </span>
        </div>
        {hist.cpu.length > 1 ? <Chart option={cpuOption} className="chart-box mini" /> : null}
      </div>

      <div className="card">
        <div className="card-head">
          <span className="card-title">内存</span>
          <span className="card-side mono">{fmtPct(mem?.usedPercent)}</span>
        </div>
        <div className="big-metric">
          <span className="mono accent-green">{fmtBytes(mem?.usedBytes)}</span>
          <span className="metric-sub">/ {fmtBytes(mem?.totalBytes)}</span>
        </div>
        <div className="bar-track">
          <div
            className="bar-fill"
            style={{
              width: `${Math.min(100, mem?.usedPercent ?? 0)}%`,
              background: (mem?.usedPercent ?? 0) >= 90 ? 'var(--c-red)' : 'var(--c-green)'
            }}
          />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <span className="card-title">网络速率</span>
          <span className="card-side">
            <span className="mono accent-blue">↓ {fmtBytesRate(net?.rxBytesPerSec)}</span>
            <span className="mono accent-orange" style={{ marginLeft: 10 }}>
              ↑ {fmtBytesRate(net?.txBytesPerSec)}
            </span>
          </span>
        </div>
        {heat.cells.length > 0 ? (
          <Chart option={heatOption} className="chart-box mini" />
        ) : (
          <div className="empty">积累采样中…</div>
        )}
      </div>

      <div className="card">
        <div className="card-title">磁盘使用率</div>
        {(snapshot?.disks?.length ?? 0) > 0 ? (
          <Chart option={diskOption} className="chart-box bars" />
        ) : (
          <div className="empty">暂无磁盘数据</div>
        )}
      </div>

      {gpus.length > 0 && (
        <div className="card">
          <div className="card-title">GPU</div>
          <div className="list">
            {gpus.map((g, i) => (
              <div className="list-row" key={`${g.model}-${i}`}>
                <div className="list-main">
                  <div className="list-title">{g.model}</div>
                  <div className="list-sub mono">
                    {g.memUsedMB != null && g.memTotalMB != null ? `${g.memUsedMB} / ${g.memTotalMB} MB` : '—'}
                  </div>
                </div>
                <div className="list-side mono">{g.utilPercent != null ? fmtPct(g.utilPercent) : '—'}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
