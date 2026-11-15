import * as echarts from 'echarts/core'
import { BarChart, HeatmapChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, VisualMapComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsOption } from 'echarts'
import type { JSX } from 'react'
import { useEffect, useRef } from 'react'

echarts.use([
  LineChart,
  BarChart,
  PieChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer
])

interface EChartProps {
  option: EChartsOption
  className?: string
  /** 图元点击回调（如饼图扇区下钻），参数为该图元的 name */
  onClick?: (name: string) => void
}

/** ECharts 薄封装：按需注册 4 类图表与核心组件，option 变化整体替换，随容器尺寸自适应。 */
export function EChart({ option, className, onClick }: EChartProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const onClickRef = useRef(onClick)
  onClickRef.current = onClick
  // option 引用未变时跳过 setOption：上游重渲染（loading/主题 epoch 等）不再触发全量重绘
  const lastOptionRef = useRef<EChartsOption | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const chart = echarts.init(el)
    chart.on('click', (params) => {
      onClickRef.current?.(String(params.name))
    })
    chartRef.current = chart
    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(el)
    return () => {
      ro.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    // 动画全局关闭：切主题/切范围时图表瞬时成型（200ms 逐段动画是"慢半拍"观感的主因）
    if (lastOptionRef.current === option) return
    lastOptionRef.current = option
    chartRef.current?.setOption({ animation: false, ...option }, true)
  }, [option])

  return <div ref={ref} className={className} />
}
