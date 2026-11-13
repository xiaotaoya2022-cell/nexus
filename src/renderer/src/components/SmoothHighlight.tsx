// 丝滑列表高亮光标与弹簧药丸指示器。
// 通过独立指示层 + CSS linear() 弹簧曲线与 GPU transform，替代生硬的逐行静态 hover/active 背景切换。

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { JSX, RefObject } from 'react'

interface PlateRect {
  left: number
  top: number
  width: number
  height: number
}

const HOST_CLASS = 'nx-list-host'

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

function measureRow(row: HTMLElement, host: HTMLElement): PlateRect {
  const rowRect = row.getBoundingClientRect()
  const hostRect = host.getBoundingClientRect()
  return {
    left: rowRect.left - hostRect.left - host.clientLeft + host.scrollLeft,
    top: rowRect.top - hostRect.top - host.clientTop + host.scrollTop,
    width: rowRect.width,
    height: rowRect.height
  }
}

function applyPlateRect(el: HTMLElement, rect: PlateRect, instant: boolean): void {
  if (instant) {
    el.style.transition = 'none'
    el.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`
    el.style.width = `${rect.width}px`
    el.style.height = `${rect.height}px`
    void el.offsetWidth
    el.style.transition = ''
    return
  }
  el.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`
  el.style.width = `${rect.width}px`
  el.style.height = `${rect.height}px`
}

export interface AutoListHighlightProps {
  /** 包含列表行的外层容器 ref；未传 containerRef / containerSelector 时即作为挂载宿主 */
  rootRef: RefObject<HTMLElement | null>
  /** 可选：显式指定滚动宿主 ref（优先于 containerSelector） */
  containerRef?: RefObject<HTMLElement | null>
  /** 可选：在 rootRef 内查询滚动宿主的选择器 */
  containerSelector?: string
  /** 列表行选择器（默认 [data-list-row]） */
  rowSelector?: string
  /** 当前选中行选择器（默认 [data-list-row][data-active="true"]） */
  activeRowSelector?: string
  /** 指示层圆角类名（应与列表行保持一致） */
  roundedClassName?: string
  /** 是否显示悬停高亮板（默认 true） */
  showHover?: boolean
  /** 是否显示选中高亮板（默认 true） */
  showSelected?: boolean
}

export function AutoListHighlight({
  rootRef,
  containerRef,
  containerSelector,
  rowSelector = '[data-list-row]',
  activeRowSelector = '[data-list-row][data-active="true"]',
  roundedClassName = 'rounded-lg',
  showHover = true,
  showSelected = true
}: AutoListHighlightProps): JSX.Element | null {
  const [hostEl, setHostEl] = useState<HTMLElement | null>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const hoverPlateRef = useRef<HTMLDivElement>(null)
  const selPlateRef = useRef<HTMLDivElement>(null)

  const resolveHost = (): void => {
    const root = rootRef.current ?? anchorRef.current?.parentElement ?? null
    if (!root) {
      setHostEl((prev) => (prev === null ? null : null))
      return
    }
    const resolved =
      containerRef?.current ??
      (containerSelector ? root.querySelector<HTMLElement>(containerSelector) : root) ??
      root
    setHostEl((prev) => (prev === resolved ? prev : resolved))
  }

  useLayoutEffect(() => {
    resolveHost()
  })

  useEffect(() => {
    resolveHost()
  }, [rootRef, containerRef, containerSelector])

  useLayoutEffect(() => {
    const host = hostEl
    if (!host) return

    const prevPosition = host.style.position
    const prevIsolation = host.style.isolation
    const computed = getComputedStyle(host)
    if (computed.position === 'static') {
      host.style.position = 'relative'
    }
    if (computed.isolation !== 'isolate') {
      host.style.isolation = 'isolate'
    }
    host.classList.add(HOST_CLASS)

    let hoveredRow: HTMLElement | null = null
    let hoverVisible = false
    let selVisible = false
    let lastPointerX = 0
    let lastPointerY = 0
    let hasPointer = false
    let hoverRaf = 0
    let scrollTimer: ReturnType<typeof setTimeout> | null = null

    const hideHover = (): void => {
      hoveredRow = null
      hoverVisible = false
      const plate = hoverPlateRef.current
      if (plate) plate.style.opacity = '0'
    }

    const syncHover = (instant = false): void => {
      if (!showHover) return
      const plate = hoverPlateRef.current
      if (!plate) return
      if (!hoveredRow || !host.contains(hoveredRow)) {
        hideHover()
        return
      }
      const rect = measureRow(hoveredRow, host)
      if (rect.width <= 0 || rect.height <= 0) {
        hideHover()
        return
      }
      const immediate = instant || !hoverVisible || prefersReducedMotion()
      applyPlateRect(plate, rect, immediate)
      plate.style.opacity = '1'
      hoverVisible = true
    }

    const syncSelected = (instant = false): void => {
      if (!showSelected) return
      const plate = selPlateRef.current
      if (!plate) return
      const active = host.querySelector<HTMLElement>(activeRowSelector)
      if (!active) {
        selVisible = false
        plate.style.opacity = '0'
        return
      }
      const rect = measureRow(active, host)
      if (rect.width <= 0 || rect.height <= 0) {
        selVisible = false
        plate.style.opacity = '0'
        return
      }
      const immediate = instant || !selVisible || prefersReducedMotion()
      applyPlateRect(plate, rect, immediate)
      plate.style.opacity = '1'
      selVisible = true
    }

    const resyncPointerFromCoords = (instant = false): void => {
      if (!showHover || !hasPointer) return
      const target = document.elementFromPoint(lastPointerX, lastPointerY)
      const row =
        target instanceof Element ? target.closest<HTMLElement>(rowSelector) : null
      if (!row || !host.contains(row)) {
        hideHover()
        return
      }
      hoveredRow = row
      syncHover(instant)
    }

    const scheduleHoverAtCoords = (clientX: number, clientY: number, row: HTMLElement | null): void => {
      lastPointerX = clientX
      lastPointerY = clientY
      hasPointer = true

      if (row && host.contains(row)) {
        if (hoveredRow === row && hoverVisible) return
        hoveredRow = row
        if (hoverRaf) cancelAnimationFrame(hoverRaf)
        hoverRaf = requestAnimationFrame(() => {
          hoverRaf = 0
          syncHover(false)
        })
        return
      }

      // 若鼠标在行间 2px-6px 缝隙移动则保持悬停板稳定，离开首尾行或进入空白区立即隐藏
      const rows = host.querySelectorAll<HTMLElement>(rowSelector)
      if (rows.length > 0) {
        const firstTop = rows[0].getBoundingClientRect().top
        const lastBottom = rows[rows.length - 1].getBoundingClientRect().bottom
        if (clientY >= firstTop - 2 && clientY <= lastBottom + 2) {
          return
        }
      }
      if (hoverRaf) {
        cancelAnimationFrame(hoverRaf)
        hoverRaf = 0
      }
      hideHover()
    }

    const onPointerMove = (e: PointerEvent): void => {
      if (!showHover) return
      if (e.pointerType === 'touch') return
      const row =
        e.target instanceof Element ? e.target.closest<HTMLElement>(rowSelector) : null
      scheduleHoverAtCoords(e.clientX, e.clientY, row)
    }

    const onPointerLeave = (): void => {
      hasPointer = false
      if (hoverRaf) {
        cancelAnimationFrame(hoverRaf)
        hoverRaf = 0
      }
      hideHover()
    }

    // 滚动过程中不读 layout，停止滚动 120ms 后按鼠标位置校正悬停板
    const onScroll = (): void => {
      if (!showHover || !hasPointer) return
      if (scrollTimer) clearTimeout(scrollTimer)
      scrollTimer = setTimeout(() => {
        scrollTimer = null
        resyncPointerFromCoords(false)
      }, 120)
    }

    const mo = new MutationObserver((records) => {
      const onlyAttr = records.every((r) => r.type === 'attributes')
      syncSelected(false)
      if (!onlyAttr && hasPointer) {
        resyncPointerFromCoords(false)
      }
    })
    mo.observe(host, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-active', 'aria-selected']
    })

    const ro = new ResizeObserver(() => {
      syncSelected(true)
      if (hoveredRow) syncHover(true)
    })
    ro.observe(host)

    host.addEventListener('pointermove', onPointerMove, { passive: true })
    host.addEventListener('pointerleave', onPointerLeave)
    host.addEventListener('scroll', onScroll, { passive: true })

    syncSelected(true)

    return () => {
      if (hoverRaf) cancelAnimationFrame(hoverRaf)
      if (scrollTimer) clearTimeout(scrollTimer)
      mo.disconnect()
      ro.disconnect()
      host.removeEventListener('pointermove', onPointerMove)
      host.removeEventListener('pointerleave', onPointerLeave)
      host.removeEventListener('scroll', onScroll)
      host.classList.remove(HOST_CLASS)
      host.style.position = prevPosition
      host.style.isolation = prevIsolation
    }
  }, [hostEl, rowSelector, activeRowSelector, showHover, showSelected])

  if (!hostEl) {
    return <span ref={anchorRef} hidden aria-hidden="true" />
  }

  return createPortal(
    <>
      {showHover && (
        <div
          ref={hoverPlateRef}
          aria-hidden="true"
          data-slot="smooth-list-plate-hover"
          className={`nx-list-plate-hover ${roundedClassName}`}
        />
      )}
      {showSelected && (
        <div
          ref={selPlateRef}
          aria-hidden="true"
          data-slot="smooth-list-plate-selected"
          className={`nx-list-plate-sel ${roundedClassName}`}
        />
      )}
    </>,
    hostEl
  )
}

export interface SlidingTabIndicatorProps {
  /** 选中按钮的选择器（默认 [data-active="true"]） */
  activeSelector?: string
  /** 药丸样式类（如 rounded-full bg-raised 或 rounded-md bg-selected） */
  className?: string
}

export function SlidingTabIndicator({
  activeSelector = '[data-active="true"]',
  className = 'rounded-full bg-raised'
}: SlidingTabIndicatorProps): JSX.Element {
  const pillRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const pill = pillRef.current
    const host = pill?.parentElement
    if (!pill || !host) return

    let visible = false

    const sync = (instant = false): void => {
      const active = host.querySelector<HTMLElement>(activeSelector)
      if (!active || active.offsetWidth <= 0 || active.offsetHeight <= 0) {
        visible = false
        pill.style.opacity = '0'
        return
      }
      const rect: PlateRect = {
        left: active.offsetLeft,
        top: active.offsetTop,
        width: active.offsetWidth,
        height: active.offsetHeight
      }
      const immediate = instant || !visible || prefersReducedMotion()
      applyPlateRect(pill, rect, immediate)
      pill.style.opacity = '1'
      visible = true
    }

    const ro = new ResizeObserver(() => {
      sync(false)
    })

    const observeTargets = (): void => {
      ro.disconnect()
      ro.observe(host)
      for (const child of Array.from(host.children)) {
        if (child !== pill && child instanceof HTMLElement) {
          ro.observe(child)
        }
      }
    }

    const mo = new MutationObserver((records) => {
      if (records.some((r) => r.type === 'childList')) {
        observeTargets()
      }
      sync(false)
    })

    mo.observe(host, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-active', 'aria-selected']
    })

    observeTargets()
    sync(true)

    return () => {
      mo.disconnect()
      ro.disconnect()
    }
  }, [activeSelector])

  return (
    <div
      ref={pillRef}
      aria-hidden="true"
      data-slot="sliding-tab-indicator"
      className={`nx-tab-pill ${className}`}
    />
  )
}
