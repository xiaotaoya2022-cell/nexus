// 滚动数字：目标值变化时以 rAF 缓动"数"到目标（用户口径：10 → 1 2 3 … 9 10 的滚动感）。
// - 首帧/切换完整模式：从 0 起滚；常规刷新：从上一个值滚到新值（自动/手动刷新均生效）
// - prefers-reduced-motion：直接落位，不滚动
// - 数值展示遵循中文数量级（compactNumber），点击可展开完整数字（fullNumber）

import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { compactNumber, fullNumber } from '@renderer/lib/format'

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3)

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

interface TweenOptions {
  durationMs?: number
  /** 从 0 起滚（首帧/模式切换）而不是从上一个值滚 */
  restart?: boolean
}

/** 返回随动画滚动的显示值；target 变化自动触发补间 */
export function useRollingValue(target: number, opts: TweenOptions = {}): number {
  const { durationMs = 650, restart = false } = opts
  const [display, setDisplay] = useState(restart ? 0 : target)
  const shownRef = useRef(display)
  const rafRef = useRef(0)

  useEffect(() => {
    if (prefersReducedMotion()) {
      shownRef.current = target
      setDisplay(target)
      return
    }
    const from = restart ? 0 : shownRef.current
    if (from === target) return
    const start = performance.now()
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / durationMs)
      const v = from + (target - from) * easeOutCubic(t)
      shownRef.current = v
      setDisplay(v)
      if (t < 1) rafRef.current = requestAnimationFrame(step)
    }
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(rafRef.current)
  }, [target, durationMs, restart])

  return display
}

export interface AnimatedNumberProps {
  num: number
  /** 紧凑格式（默认中文数量级 compactNumber） */
  compactFormat?: (n: number) => string
  /** 完整格式（默认千分位 fullNumber）；hover 的 title 始终用完整值 */
  fullFormat?: (n: number) => string
  className?: string
  /** 点击是否可切换完整/紧凑（默认开） */
  toggleable?: boolean
}

export function AnimatedNumber({
  num,
  compactFormat = compactNumber,
  fullFormat = fullNumber,
  className,
  toggleable = true
}: AnimatedNumberProps): JSX.Element {
  const [full, setFull] = useState(false)
  const v = useRollingValue(num, { restart: full })
  const text = full ? fullFormat(v) : compactFormat(v)
  if (!toggleable) {
    return (
      <span className={className} title={fullFormat(num)}>
        {text}
      </span>
    )
  }
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={() => setFull((f) => !f)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') setFull((f) => !f)
      }}
      title={full ? '点击切换紧凑显示' : fullFormat(num)}
      className={`cursor-pointer select-none ${className ?? ''}`}
    >
      {text}
    </span>
  )
}
