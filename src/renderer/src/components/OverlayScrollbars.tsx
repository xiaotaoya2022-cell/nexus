// 全局美化悬浮滚动条（Pure-DOM Overlay Scrollbar）
// 目的：
// 1. 彻底隐藏 Chromium 原生滚动条，避免 Blink EventHandler 在滚动条区域绕过 CSS cursor
//    强制渲染 Windows 默认系统箭头并与自定义弹簧光标共存。
// 2. 以 0px 占位、悬浮玻璃胶囊造型替代 14px 粗钝原生滚动条，匹配 Nexus Studio 与 Classic 双主题。

import { useEffect, useRef, useState } from 'react'
import type { JSX, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import { createPortal } from 'react-dom'

type ScrollAxis = 'y' | 'x'

interface BarMetrics {
  key: string
  el: HTMLElement
  axis: ScrollAxis
  trackLeft: number
  trackTop: number
  trackLength: number
  thumbOffset: number
  thumbLength: number
  containerHovered: boolean
  recentlyScrolled: boolean
  scrollHeight: number
  scrollWidth: number
  clientHeight: number
  clientWidth: number
  maxScroll: number
}

interface ActiveDrag {
  key: string
  el: HTMLElement
  axis: ScrollAxis
  pointerId: number
  startMouse: number
  startScroll: number
  ratio: number
}

const HIT_THICKNESS = 9
const EDGE_MARGIN = 1
const TRACK_END_INSET = 4
const CORNER_GAP = 10
const MIN_THUMB_PX = 28
const ACTIVE_SCROLL_WINDOW_MS = 1150

let idSeq = 0
const elementIds = new WeakMap<HTMLElement, string>()

function getElementKey(el: HTMLElement): string {
  let id = elementIds.get(el)
  if (!id) {
    idSeq += 1
    id = `nx-sb-${idSeq}`
    elementIds.set(el, id)
  }
  return id
}

function hasScrollableOverflow(cs: CSSStyleDeclaration, axis: ScrollAxis): boolean {
  const value = axis === 'y' ? cs.overflowY : cs.overflowX
  return value === 'auto' || value === 'scroll' || value === 'overlay'
}

function collectScrollCandidates(root: ParentNode, out: Set<HTMLElement>): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (node instanceof Element && node.hasAttribute('data-nx-scrollbar-overlay')) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    }
  })
  let node: Node | null = root instanceof HTMLElement ? root : walker.nextNode()
  while (node) {
    if (node instanceof HTMLElement && !node.hasAttribute('data-nx-scrollbar-overlay')) {
      const cls = node.className
      const quickHint =
        typeof cls === 'string' &&
        (cls.includes('overflow-y-auto') ||
          cls.includes('overflow-x-auto') ||
          cls.includes('overflow-auto') ||
          cls.includes('overflow-y-scroll') ||
          cls.includes('overflow-x-scroll'))
      if (quickHint || node.scrollHeight > node.clientHeight + 2 || node.scrollWidth > node.clientWidth + 2) {
        out.add(node)
      }
    }
    node = walker.nextNode()
  }
}

/** 计算元素自身内容区视口（扣除边框并逐层裁剪至祖先 overflow-hidden/clip/auto 边界与窗口边界） */
function computeClippedInnerRect(el: HTMLElement): {
  left: number
  top: number
  right: number
  bottom: number
} | null {
  const rect = el.getBoundingClientRect()
  let left = rect.left + el.clientLeft
  let top = rect.top + el.clientTop
  let right = left + el.clientWidth
  let bottom = top + el.clientHeight

  left = Math.max(0, left)
  top = Math.max(0, top)
  right = Math.min(window.innerWidth, right)
  bottom = Math.min(window.innerHeight, bottom)

  let parent = el.parentElement
  while (parent && parent !== document.body && parent !== document.documentElement) {
    const pcs = getComputedStyle(parent)
    const clipsY = pcs.overflowY !== 'visible'
    const clipsX = pcs.overflowX !== 'visible'
    if (clipsX || clipsY) {
      const pr = parent.getBoundingClientRect()
      if (clipsX) {
        left = Math.max(left, pr.left + parent.clientLeft)
        right = Math.min(right, pr.left + parent.clientLeft + parent.clientWidth)
      }
      if (clipsY) {
        top = Math.max(top, pr.top + parent.clientTop)
        bottom = Math.min(bottom, pr.top + parent.clientTop + parent.clientHeight)
      }
    }
    parent = parent.parentElement
  }

  if (right - left < 18 || bottom - top < 24) return null
  return { left, top, right, bottom }
}

/** 穿透本浮层检查目标坐标是否被更高层浮窗/遮罩挡住 */
function isPointOwnedByScroller(el: HTMLElement, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false
  const stack = document.elementsFromPoint(x, y)
  for (const hit of stack) {
    if (hit instanceof Element && hit.closest('[data-nx-scrollbar-overlay]')) continue
    return el.contains(hit)
  }
  return false
}

function isTrackVisible(
  el: HTMLElement,
  axis: ScrollAxis,
  clipped: { left: number; top: number; right: number; bottom: number }
): boolean {
  if (axis === 'y') {
    const probeX = Math.max(clipped.left + 2, clipped.right - 6)
    const span = clipped.bottom - clipped.top
    const probes =
      span > 48
        ? [clipped.top + 12, clipped.top + span * 0.5, clipped.bottom - 12]
        : [clipped.top + span * 0.5]
    return probes.every((py) => isPointOwnedByScroller(el, probeX, py))
  }
  const probeY = Math.max(clipped.top + 2, clipped.bottom - 6)
  const span = clipped.right - clipped.left
  const probes =
    span > 48
      ? [clipped.left + 12, clipped.left + span * 0.5, clipped.right - 12]
      : [clipped.left + span * 0.5]
  return probes.every((px) => isPointOwnedByScroller(el, px, probeY))
}

function computeBarMetrics(
  el: HTMLElement,
  axis: ScrollAxis,
  clipped: { left: number; top: number; right: number; bottom: number },
  hasOtherAxis: boolean,
  pointerX: number,
  pointerY: number,
  recentlyScrolled: boolean
): BarMetrics | null {
  const clientLen = axis === 'y' ? el.clientHeight : el.clientWidth
  const scrollLen = axis === 'y' ? el.scrollHeight : el.scrollWidth
  const maxScroll = Math.max(0, scrollLen - clientLen)
  if (maxScroll <= 2) return null

  const startBound = axis === 'y' ? clipped.top + TRACK_END_INSET : clipped.left + TRACK_END_INSET
  const endBound =
    (axis === 'y' ? clipped.bottom : clipped.right) -
    TRACK_END_INSET -
    (hasOtherAxis ? CORNER_GAP : 0)
  const trackLength = Math.floor(endBound - startBound)
  if (trackLength < MIN_THUMB_PX + 8) return null

  const rawThumb = Math.round((clientLen / scrollLen) * trackLength)
  const thumbLength = Math.min(trackLength, Math.max(MIN_THUMB_PX, rawThumb))
  const travel = Math.max(0, trackLength - thumbLength)
  const scrollPos = axis === 'y' ? el.scrollTop : el.scrollLeft
  const clampedScroll = Math.max(0, Math.min(maxScroll, scrollPos))
  const thumbOffset = travel > 0 ? (clampedScroll / maxScroll) * travel : 0

  const trackLeft =
    axis === 'y' ? Math.round(clipped.right - EDGE_MARGIN - HIT_THICKNESS) : Math.round(startBound)
  const trackTop =
    axis === 'y' ? Math.round(startBound) : Math.round(clipped.bottom - EDGE_MARGIN - HIT_THICKNESS)

  const containerHovered =
    pointerX >= clipped.left &&
    pointerX <= clipped.right &&
    pointerY >= clipped.top &&
    pointerY <= clipped.bottom

  return {
    key: `${getElementKey(el)}:${axis}`,
    el,
    axis,
    trackLeft,
    trackTop,
    trackLength,
    thumbOffset,
    thumbLength,
    containerHovered,
    recentlyScrolled,
    scrollHeight: el.scrollHeight,
    scrollWidth: el.scrollWidth,
    clientHeight: el.clientHeight,
    clientWidth: el.clientWidth,
    maxScroll
  }
}

export function GlobalOverlayScrollbars(): JSX.Element {
  const [bars, setBars] = useState<BarMetrics[]>([])
  const [hoveredTrackKey, setHoveredTrackKey] = useState<string | null>(null)
  const [draggingKey, setDraggingKey] = useState<string | null>(null)

  const candidatesRef = useRef<Set<HTMLElement>>(new Set())
  const scrollActivityRef = useRef<WeakMap<HTMLElement, number>>(new WeakMap())
  const pointerRef = useRef<{ x: number; y: number }>({ x: -9999, y: -9999 })
  const activeDragRef = useRef<ActiveDrag | null>(null)
  const hoverKeyRef = useRef<string | null>(null)
  const rafRef = useRef<number | null>(null)
  const idleTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const candidates = candidatesRef.current
    const scrollActivity = scrollActivityRef.current

    const syncNow = (): void => {
      rafRef.current = null
      const now = Date.now()
      const { x: px, y: py } = pointerRef.current
      const nextBars: BarMetrics[] = []
      let earliestFadeAt = Infinity

      for (const el of Array.from(candidates)) {
        if (!el.isConnected) {
          candidates.delete(el)
          continue
        }
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) <= 0.02) {
          continue
        }
        const canY = hasScrollableOverflow(cs, 'y') && el.scrollHeight > el.clientHeight + 2
        const canX = hasScrollableOverflow(cs, 'x') && el.scrollWidth > el.clientWidth + 2
        if (!canY && !canX) continue

        const clipped = computeClippedInnerRect(el)
        if (!clipped) continue

        const lastScrollAt = scrollActivity.get(el) ?? 0
        const elapsed = now - lastScrollAt
        const recentlyScrolled = lastScrollAt > 0 && elapsed < ACTIVE_SCROLL_WINDOW_MS
        if (recentlyScrolled) {
          earliestFadeAt = Math.min(earliestFadeAt, lastScrollAt + ACTIVE_SCROLL_WINDOW_MS)
        }

        const showY = canY && isTrackVisible(el, 'y', clipped)
        const showX = canX && isTrackVisible(el, 'x', clipped)

        if (showY) {
          const m = computeBarMetrics(el, 'y', clipped, showX, px, py, recentlyScrolled)
          if (m) nextBars.push(m)
        }
        if (showX) {
          const m = computeBarMetrics(el, 'x', clipped, showY, px, py, recentlyScrolled)
          if (m) nextBars.push(m)
        }
      }

      setBars(nextBars)

      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current)
        idleTimerRef.current = null
      }
      if (Number.isFinite(earliestFadeAt)) {
        const waitMs = Math.max(40, earliestFadeAt - Date.now() + 20)
        idleTimerRef.current = window.setTimeout(() => {
          idleTimerRef.current = null
          scheduleSync()
        }, waitMs)
      }
    }

    const scheduleSync = (): void => {
      if (rafRef.current !== null) return
      rafRef.current = window.requestAnimationFrame(syncNow)
    }

    // 首次扫描文档内所有可滚容器
    collectScrollCandidates(document.body, candidates)
    scheduleSync()

    // ResizeObserver 监听已有/新增滚动容器尺寸变化（不轮询）
    const ro = new ResizeObserver(() => scheduleSync())
    const observeCurrent = (): void => {
      for (const el of candidates) ro.observe(el)
    }
    observeCurrent()

    const mo = new MutationObserver((mutations) => {
      let touched = false
      for (const m of mutations) {
        if (m.type !== 'childList') continue
        for (const added of m.addedNodes) {
          if (added instanceof HTMLElement && !added.hasAttribute('data-nx-scrollbar-overlay')) {
            collectScrollCandidates(added, candidates)
            touched = true
          }
        }
        if (m.target instanceof HTMLElement && !m.target.hasAttribute('data-nx-scrollbar-overlay')) {
          touched = true
        }
      }
      if (touched) {
        observeCurrent()
        scheduleSync()
      }
    })
    mo.observe(document.body, { childList: true, subtree: true })

    const onAnyScroll = (event: Event): void => {
      const target = event.target
      if (target instanceof HTMLElement && !target.hasAttribute('data-nx-scrollbar-overlay')) {
        candidates.add(target)
        ro.observe(target)
        scrollActivity.set(target, Date.now())
        scheduleSync()
      }
    }

    const finishDrag = (): void => {
      const drag = activeDragRef.current
      if (!drag) return
      activeDragRef.current = null
      document.documentElement.classList.remove('nx-scrollbar-dragging')
      setDraggingKey(null)
      scheduleSync()
    }

    const onWindowPointerMove = (event: PointerEvent): void => {
      const drag = activeDragRef.current
      if (drag && drag.pointerId === event.pointerId) {
        const delta = (drag.axis === 'y' ? event.clientY : event.clientX) - drag.startMouse
        if (drag.axis === 'y') {
          drag.el.scrollTop = drag.startScroll + delta * drag.ratio
        } else {
          drag.el.scrollLeft = drag.startScroll + delta * drag.ratio
        }
        scrollActivity.set(drag.el, Date.now())
        scheduleSync()
        return
      }

      const prev = pointerRef.current
      pointerRef.current = { x: event.clientX, y: event.clientY }
      // 仅在存在跨容器进出切换可能性时刷新悬停态（避免闲置空扫高频重算）
      let hoverChanged = false
      for (const el of candidates) {
        if (!el.isConnected) continue
        if (el.scrollHeight <= el.clientHeight + 2 && el.scrollWidth <= el.clientWidth + 2) continue
        const r = el.getBoundingClientRect()
        const wasInside = prev.x >= r.left && prev.x <= r.right && prev.y >= r.top && prev.y <= r.bottom
        const isInside =
          event.clientX >= r.left &&
          event.clientX <= r.right &&
          event.clientY >= r.top &&
          event.clientY <= r.bottom
        if (wasInside !== isInside) {
          hoverChanged = true
          break
        }
      }
      if (hoverChanged) scheduleSync()
    }

    const onWindowPointerLeave = (): void => {
      pointerRef.current = { x: -9999, y: -9999 }
      if (hoverKeyRef.current !== null) {
        hoverKeyRef.current = null
        setHoveredTrackKey(null)
      }
      scheduleSync()
    }

    const onResize = (): void => scheduleSync()

    document.addEventListener('scroll', onAnyScroll, { capture: true, passive: true })
    document.addEventListener('transitionend', onResize, { capture: true, passive: true })
    window.addEventListener('resize', onResize, { passive: true })
    window.addEventListener('pointermove', onWindowPointerMove, { passive: true })
    window.addEventListener('pointerup', finishDrag, { passive: true })
    window.addEventListener('pointercancel', finishDrag, { passive: true })
    window.addEventListener('blur', finishDrag)
    document.addEventListener('mouseleave', onWindowPointerLeave)

    return () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current)
      if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current)
      document.documentElement.classList.remove('nx-scrollbar-dragging')
      ro.disconnect()
      mo.disconnect()
      document.removeEventListener('scroll', onAnyScroll, true)
      document.removeEventListener('transitionend', onResize, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointermove', onWindowPointerMove)
      window.removeEventListener('pointerup', finishDrag)
      window.removeEventListener('pointercancel', finishDrag)
      window.removeEventListener('blur', finishDrag)
      document.removeEventListener('mouseleave', onWindowPointerLeave)
    }
  }, [])

  const onTrackPointerDown = (e: ReactPointerEvent<HTMLDivElement>, bar: BarMetrics): void => {
    if (e.button !== 0) return
    // 如果直接点中拇指，由 thumb 自己的 onPointerDown 处理
    if ((e.target as HTMLElement).hasAttribute('data-nx-scrollbar-thumb')) return
    e.preventDefault()
    e.stopPropagation()

    const trackRect = e.currentTarget.getBoundingClientRect()
    const clickPos =
      bar.axis === 'y'
        ? e.clientY - trackRect.top - bar.thumbLength / 2
        : e.clientX - trackRect.left - bar.thumbLength / 2
    const travel = Math.max(1, bar.trackLength - bar.thumbLength)
    const ratio = Math.max(0, Math.min(1, clickPos / travel))
    const nextScroll = ratio * bar.maxScroll

    if (bar.axis === 'y') {
      bar.el.scrollTo({ top: nextScroll, behavior: 'smooth' })
    } else {
      bar.el.scrollTo({ left: nextScroll, behavior: 'smooth' })
    }
  }

  const onThumbPointerDown = (e: ReactPointerEvent<HTMLDivElement>, bar: BarMetrics): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()

    const travel = Math.max(1, bar.trackLength - bar.thumbLength)
    const ratio = bar.maxScroll / travel
    activeDragRef.current = {
      key: bar.key,
      el: bar.el,
      axis: bar.axis,
      pointerId: e.pointerId,
      startMouse: bar.axis === 'y' ? e.clientY : e.clientX,
      startScroll: bar.axis === 'y' ? bar.el.scrollTop : bar.el.scrollLeft,
      ratio
    }
    document.documentElement.classList.add('nx-scrollbar-dragging')
    setDraggingKey(bar.key)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // ignore
    }
  }

  const onTrackWheel = (e: ReactWheelEvent<HTMLDivElement>, bar: BarMetrics): void => {
    const unit = e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? bar.clientHeight : 1
    const dy = e.deltaY * unit
    const dx = e.deltaX * unit
    if (dy !== 0) bar.el.scrollTop += dy
    if (dx !== 0) bar.el.scrollLeft += dx
  }

  if (bars.length === 0) return <></>

  return createPortal(
    <div
      data-nx-scrollbar-overlay="true"
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[9995]"
    >
      {bars.map((bar) => {
        const isY = bar.axis === 'y'
        const isTrackHovered = hoveredTrackKey === bar.key
        const isDragging = draggingKey === bar.key
        const isExpanded = isTrackHovered || isDragging
        const state = isDragging
          ? 'dragging'
          : isTrackHovered
            ? 'hover'
            : bar.recentlyScrolled || bar.containerHovered
              ? 'active'
              : 'idle'

        return (
          <div
            key={bar.key}
            data-nx-scrollbar-overlay="true"
            data-nx-scrollbar-track={bar.axis}
            data-state={state}
            onPointerEnter={() => {
              hoverKeyRef.current = bar.key
              setHoveredTrackKey(bar.key)
            }}
            onPointerLeave={() => {
              if (hoverKeyRef.current === bar.key) {
                hoverKeyRef.current = null
                setHoveredTrackKey(null)
              }
            }}
            onPointerDown={(e) => onTrackPointerDown(e, bar)}
            onWheel={(e) => onTrackWheel(e, bar)}
            className="nx-scrollbar-track pointer-events-auto fixed"
            style={{
              left: bar.trackLeft,
              top: bar.trackTop,
              width: isY ? HIT_THICKNESS : bar.trackLength,
              height: isY ? bar.trackLength : HIT_THICKNESS
            }}
          >
            <div
              data-nx-scrollbar-overlay="true"
              data-nx-scrollbar-thumb={bar.axis}
              data-cursor="interactive"
              role="scrollbar"
              aria-orientation={isY ? 'vertical' : 'horizontal'}
              aria-valuenow={Math.round(bar.axis === 'y' ? bar.el.scrollTop : bar.el.scrollLeft)}
              data-state={state}
              data-expanded={isExpanded ? 'true' : 'false'}
              onPointerDown={(e) => onThumbPointerDown(e, bar)}
              className="nx-scrollbar-thumb"
              style={
                isY
                  ? {
                      transform: `translate3d(0, ${bar.thumbOffset}px, 0)`,
                      height: bar.thumbLength
                    }
                  : {
                      transform: `translate3d(${bar.thumbOffset}px, 0, 0)`,
                      width: bar.thumbLength
                    }
              }
            />
          </div>
        )
      })}
    </div>,
    document.body
  )
}
