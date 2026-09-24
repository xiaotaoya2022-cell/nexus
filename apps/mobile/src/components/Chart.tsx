// echarts 按需引入：仅注册本应用用到的图表/组件 + CanvasRenderer。
// 六色图表板与文字色取自 theme.css 的 Zai Dark token，保持两端观感一致。

import { useEffect, useRef } from 'react'
import type { EChartsCoreOption } from 'echarts/core'
import * as echarts from 'echarts/core'
import { BarChart, HeatmapChart, LineChart, PieChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  LineChart,
  PieChart,
  BarChart,
  HeatmapChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer
])

export const CHART_COLORS = ['#4099ff', '#46bf72', '#7b5ce5', '#ff5c5c', '#ff8a30', '#42c8c8'] as const

export const AXIS_LABEL = { color: 'rgba(212,212,212,.6)', fontSize: 10 } as const

export const TOOLTIP_DARK = {
  backgroundColor: '#2b2b2b',
  borderColor: 'rgba(255,255,255,.1)',
  textStyle: { color: '#d4d4d4', fontSize: 11 }
} as const

export type ChartInstance = ReturnType<typeof echarts.init>

interface ChartProps {
  option: EChartsCoreOption
  className?: string
}

/** 通用图表容器：负责 init / dispose / resize / setOption */
export function Chart({ option, className }: ChartProps) {
  const elRef = useRef<HTMLDivElement | null>(null)
  const instRef = useRef<ChartInstance | null>(null)

  useEffect(() => {
    const el = elRef.current
    if (el == null) return
    const inst = echarts.init(el)
    instRef.current = inst
    const ro = new ResizeObserver(() => inst.resize())
    ro.observe(el)
    return () => {
      ro.disconnect()
      inst.dispose()
      instRef.current = null
    }
  }, [])

  useEffect(() => {
    instRef.current?.setOption(option, true)
  }, [option])

  return <div ref={elRef} className={className ?? 'chart-box'} />
}
