// 简易下拉刷新：顶部下拉超过阈值触发 onRefresh，期间显示指示条。

import { useRef, useState } from 'react'
import type { ReactNode, TouchEvent } from 'react'

interface PullRefreshProps {
  onRefresh: () => Promise<void> | void
  children: ReactNode
}

const TRIGGER_PX = 56

export function PullRefresh({ onRefresh, children }: PullRefreshProps) {
  const [pull, setPull] = useState(0)
  const [busy, setBusy] = useState(false)
  const startY = useRef<number | null>(null)

  const onTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    if (busy) return
    const scroller = e.currentTarget
    if (scroller.scrollTop <= 0) startY.current = e.touches[0]?.clientY ?? null
  }

  const onTouchMove = (e: TouchEvent<HTMLDivElement>) => {
    if (startY.current == null || busy) return
    const dy = (e.touches[0]?.clientY ?? 0) - startY.current
    if (dy > 0) setPull(Math.min(88, dy * 0.5))
    else setPull(0)
  }

  const onTouchEnd = () => {
    const should = pull >= TRIGGER_PX && !busy
    startY.current = null
    setPull(0)
    if (!should) return
    setBusy(true)
    void (async () => {
      try {
        await onRefresh()
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <div
      className="page-scroll"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <div className="pull-indicator" style={{ height: busy ? 34 : pull }}>
        <span className={`pull-dot${busy ? ' spin' : ''}`} style={busy ? undefined : { opacity: pull / TRIGGER_PX }} />
      </div>
      {children}
    </div>
  )
}
