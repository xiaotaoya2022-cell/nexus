import * as echarts from 'echarts'
import type { JSX } from 'react'
import { useEffect, useRef } from 'react'

interface EChartProps {
  option: echarts.EChartsOption
  className?: string
  /** 图元点击回调（如饼图扇区下钻），参数为该图元的 name */
  onClick?: (name: string) => void
}

/** ECharts 薄封装：初始化一次，option 变化整体替换，随容器尺寸自适应。 */
export function EChart({ option, className, onClick }: EChartProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const onClickRef = useRef(onClick)
  onClickRef.current = onClick

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
    chartRef.current?.setOption({ animation: false, ...option }, true)
  }, [option])

  return <div ref={ref} className={className} />
}
