// 图表主题 Token 读取与 ECharts option 工厂。
// 颜色一律来自 CSS 变量（tokens.css），主题切换时由 React 重渲染触发重建。

import type { EChartsOption } from 'echarts'
import type { HeatmapData, NamedStat, ToolStat, TrendPoint, TokenTypeStat } from '@shared/types'
import { compactNumber, formatDayLabel, fullNumber } from '@renderer/lib/format'
import { getLang, t } from '../i18n'

export interface ChartTokens {
  fg: string
  fgSubtle: string
  fgSubtlest: string
  hairline: string
  border: string
  card: string
  signal: string
  cobalt: string
  nexus: boolean
  series: string[]
  /** 热力五档（含空档）：echarts 无法解析 color-mix()，直接按主题给出 rgba 串 */
  heat: string[]
}

const HEAT_DARK = [
  'rgba(255,255,255,0.05)',
  'rgba(64,153,255,0.28)',
  'rgba(64,153,255,0.48)',
  'rgba(64,153,255,0.68)',
  'rgba(128,190,255,0.85)'
]
const HEAT_LIGHT = [
  'rgba(13,13,13,0.05)',
  'rgba(11,127,255,0.26)',
  'rgba(11,127,255,0.46)',
  'rgba(11,127,255,0.66)',
  'rgba(11,127,255,0.85)'
]
const HEAT_NEXUS_DARK = [
  'rgba(235,241,255,0.045)',
  'rgba(239,75,30,0.24)',
  'rgba(239,75,30,0.44)',
  'rgba(239,75,30,0.68)',
  '#ef4b1e'
]
const HEAT_NEXUS_LIGHT = [
  'rgba(23,25,30,0.055)',
  'rgba(227,66,22,0.22)',
  'rgba(227,66,22,0.42)',
  'rgba(227,66,22,0.68)',
  '#e34216'
]

export function chartTokens(): ChartTokens {
  const root = document.documentElement
  const cs = getComputedStyle(root)
  const v = (name: string): string => cs.getPropertyValue(name).trim()
  const light = root.classList.contains('theme-light')
  const nexus = root.classList.contains('style-nexus')
  return {
    fg: v('--nx-foreground'),
    fgSubtle: v('--nx-foreground-subtle'),
    fgSubtlest: v('--nx-foreground-subtlest'),
    hairline: v('--nx-hairline'),
    border: v('--nx-border'),
    card: v('--nx-card'),
    signal: v('--nx-signal') || v('--nx-chart-1'),
    cobalt: v('--nx-cobalt') || v('--nx-chart-1'),
    nexus,
    series: [1, 2, 3, 4, 5, 6].map((i) => v(`--nx-chart-${i}`)),
    heat: nexus ? (light ? HEAT_NEXUS_LIGHT : HEAT_NEXUS_DARK) : light ? HEAT_LIGHT : HEAT_DARK
  }
}

const MONO =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Microsoft YaHei UI', monospace"

const AXIS_LABEL = { fontSize: 10, fontFamily: MONO }

function withAlpha(color: string, alpha: number): string | undefined {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return undefined
  const hex = m[1]
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function baseTooltip(): EChartsOption['tooltip'] {
  const nexus = document.documentElement.classList.contains('style-nexus')
  return {
    // tooltip 是渲染在图表容器 DOM 上的元素，extraCssText 中可用 CSS 变量
    extraCssText: nexus
      ? `background: var(--nx-card); border: 1px solid var(--nx-border-hover); border-radius: 10px; box-shadow: 0 10px 28px rgba(0, 0, 0, 0.22); color: var(--nx-foreground); font-size: 12px; padding: 8px 10px;`
      : `background: var(--nx-card); border: 1px solid var(--nx-border); border-radius: 8px; box-shadow: none; color: var(--nx-foreground); font-size: 12px;`
  }
}

export function colorForIndex(tokens: ChartTokens, i: number): string {
  return tokens.series[i % tokens.series.length]
}

/** Agent → 颜色的全局稳定映射：按调用方给出的确定性顺序取模，跨图表一致 */
export function agentColorMap(names: string[], tokens: ChartTokens): Map<string, string> {
  return new Map([...new Set(names)].map((n, i) => [n, colorForIndex(tokens, i)]))
}

/** Y 轴按可见峰值统一单位（全 B 或全 M…），避免 B/M 混排误读 */
function fixedUnitFormatter(points: Array<{ total: number }>): (v: number) => string {
  const max = Math.max(1, ...points.map((p) => p.total))
  // 数量级台阶按语言：中文 万/亿/万亿，英文 K/M/B/T
  const units: Array<[string, number]> =
    getLang() === 'en'
      ? [
          ['T', 1e12],
          ['B', 1e9],
          ['M', 1e6],
          ['K', 1e3],
          ['', 1]
        ]
      : [
          ['万亿', 1e12],
          ['亿', 1e8],
          ['万', 1e4],
          ['', 1]
        ]
  const unit = units.find(([, d]) => max >= d) ?? ['', 1]
  return (v) => (unit[1] === 1 ? String(Math.round(v)) : `${(v / unit[1]).toFixed(1)}${unit[0]}`)
}

// ── 趋势折线 ──
export function trendOption(
  points: TrendPoint[],
  tokens: ChartTokens,
  range: 'today' | 'week' | 'month' | 'all',
  opts?: {
    colorOf?: (key: string, i: number) => string
    labelOf?: (key: string) => string
  }
): EChartsOption {
  const totalsByKey = new Map<string, number>()
  for (const p of points) {
    for (const [k, v] of Object.entries(p.series)) {
      totalsByKey.set(k, (totalsByKey.get(k) ?? 0) + v)
    }
  }
  const topKeys = [...totalsByKey.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k]) => k)

  return {
    animationDuration: 200,
    grid: { top: 12, right: 20, left: 14, bottom: 0, containLabel: true },
    tooltip: {
      ...baseTooltip(),
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: tokens.border } },
      valueFormatter: (v) => fullNumber(Number(v))
    },
    xAxis: {
      type: 'category',
      data: points.map((p) => (range === 'today' ? p.bucket : formatDayLabel(p.bucket))),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { ...AXIS_LABEL, color: tokens.fgSubtlest },
      boundaryGap: false
    },
    yAxis: {
      type: 'value',
      axisLabel: {
        ...AXIS_LABEL,
        color: tokens.fgSubtlest,
        formatter: fixedUnitFormatter(points)
      },
      splitLine: { lineStyle: { color: tokens.hairline, type: 'dashed' } }
    },
    series: topKeys.map((key, i) => {
      const color = opts?.colorOf ? opts.colorOf(key, i) : colorForIndex(tokens, i)
      const label = opts?.labelOf ? opts.labelOf(key) : key
      const areaTop = tokens.nexus && i === 0 ? withAlpha(color, 0.18) : undefined
      const areaBottom = tokens.nexus && i === 0 ? withAlpha(color, 0) : undefined
      return {
        name: label,
        type: 'line' as const,
        data: points.map((p) => p.series[key] ?? 0),
        smooth: tokens.nexus ? 0.22 : false,
        symbol: 'none',
        lineStyle: { width: tokens.nexus && i === 0 ? 2.25 : 2, color },
        itemStyle: { color },
        ...(areaTop && areaBottom
          ? {
              areaStyle: {
                color: {
                  type: 'linear' as const,
                  x: 0,
                  y: 0,
                  x2: 0,
                  y2: 1,
                  colorStops: [
                    { offset: 0, color: areaTop },
                    { offset: 1, color: areaBottom }
                  ]
                }
              }
            }
          : {}),
        emphasis: { focus: 'series' as const },
        triggerLineEvent: false
      }
    })
  }
}

// ── 7x24 热力图 ──
export function heatmapOption(data: HeatmapData, tokens: ChartTokens): EChartsOption {
  const hours = Array.from({ length: 24 }, (_, h) => h)
  const weekdayLabels = [0, 1, 2, 3, 4, 5, 6].map((i) => t(`weekday.${i}`))
  const lookup = new Map(data.cells.map(([h, w, t]) => [`${h}:${w}`, t]))
  const grid: Array<[number, number, number]> = []
  for (const w of [0, 1, 2, 3, 4, 5, 6]) {
    for (const h of hours) {
      grid.push([h, w, lookup.get(`${h}:${w}`) ?? 0])
    }
  }
  return {
    animationDuration: 200,
    grid: { top: 4, right: 8, left: 8, bottom: 0, containLabel: true },
    tooltip: {
      ...baseTooltip(),
      position: 'top',
      formatter: (p) => {
        const [h, w, t] = (p as unknown as { value: [number, number, number] }).value
        return `${weekdayLabels[w]} ${String(h).padStart(2, '0')}:00 · ${fullNumber(t)} tokens`
      }
    },
    xAxis: {
      type: 'category',
      data: hours.map(String),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { ...AXIS_LABEL, color: tokens.fgSubtlest, interval: 2 },
      splitArea: { show: false }
    },
    yAxis: {
      type: 'category',
      data: weekdayLabels,
      inverse: true,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { ...AXIS_LABEL, color: tokens.fgSubtlest }
    },
    visualMap: {
      show: false,
      min: 0,
      max: Math.max(data.max, 1),
      // 五档含空档：0 值格映射 heat[0]，非零才进蓝色渐变（红队 N-07）
      inRange: {
        color: [tokens.heat[0], tokens.heat[1], tokens.heat[2], tokens.heat[3], tokens.heat[4]]
      }
    },
    series: [
      {
        name: 'tokens',
        type: 'heatmap',
        data: grid,
        itemStyle: { borderColor: tokens.card, borderWidth: 2, borderRadius: tokens.nexus ? 4 : 3 },
        emphasis: { itemStyle: { borderColor: tokens.border } }
      }
    ]
  }
}

// ── 环形图（Agent 占比 / Token 类型）──
export function donutOption(
  items: Array<{ name: string; value: number }>,
  colorOf: (name: string, i: number) => string,
  tokens: ChartTokens
): EChartsOption {
  return {
    animationDuration: 200,
    tooltip: {
      ...baseTooltip(),
      trigger: 'item',
      valueFormatter: (v) => fullNumber(Number(v))
    },
    series: [
      {
        type: 'pie',
        radius: ['58%', '80%'],
        center: ['50%', '50%'],
        avoidLabelOverlap: true,
        padAngle: 2,
        itemStyle: { borderColor: tokens.card, borderWidth: 2, borderRadius: tokens.nexus ? 4 : 3 },
        label: { show: false },
        emphasis: {
          scaleSize: 3,
          label: { show: false }
        },
        data: items.map((it, i) => ({
          name: it.name,
          value: it.value,
          itemStyle: { color: colorOf(it.name, i) }
        }))
      }
    ]
  }
}

// ── 横向条形排行（模型 / 工具）──
export function rankBarOption(
  stats: NamedStat[] | ToolStat[],
  tokens: ChartTokens,
  colorByIndex = true,
  unitName = ''
): EChartsOption {
  const rows = [...stats].reverse() // echarts y 轴自下而上
  const isTool = (r: (typeof rows)[number]): r is ToolStat => 'tool' in r
  return {
    animationDuration: 200,
    grid: { top: 4, right: 40, left: 8, bottom: 0, containLabel: true },
    tooltip: {
      ...baseTooltip(),
      trigger: 'item',
      formatter: (p) => {
        const d = p as { name: string; value: number }
        return `${d.name} · ${fullNumber(d.value)}`
      }
    },
    xAxis: {
      type: 'value',
      name: unitName,
      nameTextStyle: { fontSize: 10, color: tokens.fgSubtlest, align: 'right' },
      nameGap: 8,
      splitNumber: 3,
      axisLabel: {
        ...AXIS_LABEL,
        color: tokens.fgSubtlest,
        formatter: (v) => compactNumber(Number(v)),
        hideOverlap: true
      },
      splitLine: { lineStyle: { color: tokens.hairline, type: 'dashed' } }
    },
    yAxis: {
      type: 'category',
      data: rows.map((r) => (isTool(r) ? r.tool : r.name)),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { ...AXIS_LABEL, color: tokens.fgSubtle, width: 120, overflow: 'truncate' }
    },
    series: [
      {
        type: 'bar',
        barWidth: 12,
        data: rows.map((r, i) => ({
          value: isTool(r) ? r.count : r.tokens,
          itemStyle: {
            color: colorByIndex ? colorForIndex(tokens, rows.length - 1 - i) : tokens.series[0],
            borderRadius: [0, 3, 3, 0]
          }
        })),
        label: {
          show: true,
          position: 'right',
          fontFamily: MONO,
          fontSize: 10,
          color: tokens.fgSubtlest,
          formatter: (p) => compactNumber(Number(p.value))
        }
      }
    ]
  }
}

/** 每日强度：按日 Token 总量条形图（GitHub 式日历在 7~30 天窗口下不可读，弃用） */
export function dailyBarOption(
  points: Array<{ bucket: string; total: number }>,
  tokens: ChartTokens
): EChartsOption {
  return {
    animationDuration: 200,
    grid: { top: 8, right: 16, left: 14, bottom: 0, containLabel: true },
    tooltip: {
      ...baseTooltip(),
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(128,128,128,0.08)' } },
      valueFormatter: (v) => fullNumber(Number(v))
    },
    xAxis: {
      type: 'category',
      data: points.map((p) => formatDayLabel(p.bucket)),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { ...AXIS_LABEL, color: tokens.fgSubtlest, hideOverlap: true }
    },
    yAxis: {
      type: 'value',
      axisLabel: {
        ...AXIS_LABEL,
        color: tokens.fgSubtlest,
        formatter: fixedUnitFormatter(points),
        hideOverlap: true
      },
      splitLine: { lineStyle: { color: tokens.hairline, type: 'dashed' } }
    },
    series: [
      {
        type: 'bar',
        data: points.map((p) => p.total),
        barMaxWidth: 18,
        itemStyle: { color: tokens.series[0], borderRadius: tokens.nexus ? [4, 4, 0, 0] : [3, 3, 0, 0] }
      }
    ]
  }
}

export const TOKEN_TYPE_COLORS: Array<{ key: TokenTypeStat['key']; colorVarIndex: number }> = [
  { key: 'input', colorVarIndex: 0 },
  { key: 'output', colorVarIndex: 1 },
  { key: 'reasoning', colorVarIndex: 2 },
  { key: 'cacheRead', colorVarIndex: 5 },
  { key: 'cacheWrite', colorVarIndex: 4 }
]
