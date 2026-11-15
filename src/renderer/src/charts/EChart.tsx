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

/* 全局图表更新队列：每帧最多应用 FRAMES_PER_FRAME 个图表的 setOption。
   数据刷新/主题切换时 8 张图不再同一帧全量重建（主线程长任务 → 自定义光标冻结的主源），
   而是错帧摊平；刷新动效照常播放。 */
const CHARTS_PER_FRAME = 2
const updateQueue: Array<() => void> = []
let queueRafId = 0

function pumpQueue(): void {
  queueRafId = 0
  const batch = updateQueue.splice(0, CHARTS_PER_FRAME)
  for (const task of batch) task()
  if (updateQueue.length > 0) {
    queueRafId = requestAnimationFrame(pumpQueue)
  }
}

function enqueueChartUpdate(task: () => void): void {
  updateQueue.push(task)
  if (queueRafId === 0) {
    queueRafId = requestAnimationFrame(pumpQueue)
  }
}

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
  // option 引用未变时跳过 setOption：上游重渲染（loading 切换等）不再触发重绘
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
    if (lastOptionRef.current === option) return
    lastOptionRef.current = option
    // 动画全局关闭：切主题/切范围时图表瞬时成型（200ms 逐段动画是"慢半拍"观感的主因）
    // 错帧应用：多图更新分散到连续帧，单帧不再被整板 setOption 挤满
    enqueueChartUpdate(() => {
      chartRef.current?.setOption({ animation: false, ...option }, true)
    })
  }, [option])

  return <div ref={ref} className={className} />
}
