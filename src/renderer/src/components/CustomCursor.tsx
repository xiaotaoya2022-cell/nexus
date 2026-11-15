// 全局弹簧自定义鼠标与设置组（移植并适配自 ApiSpace）。
// 六态状态机：default（倾斜拉伸圆点）/ interactive（12 点圆周采样空心环）/
// text（全接管衬线 I-beam + 8ms 紧跟随）/ press（0.82 收缩回弹）/
// leave-blur（自动暂停并还原系统光标）/ remote-degrade（远控跳变检测自动退避与静默恢复）。

import { useEffect, useRef, useState } from 'react'
import type { JSX, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { t, useLang } from '../i18n'
import {
  clearCursorDegraded,
  CURSOR_CONFIG_CHANGED_EVENT,
  CURSOR_DEGRADED_EVENT,
  CURSOR_DEGRADED_STORAGE_KEY,
  CURSOR_SIZE_OPTIONS,
  dispatchCursorDegradedChanged,
  emitCursorToast,
  readCursorDegraded,
  readCursorEnabled,
  readCursorSize,
  writeCursorEnabled,
  writeCursorSize,
  type CursorSizeOption
} from '../lib/cursorConfig'
import { useUi } from '../store'

export type GlobalCursorMode = 'default' | 'interactive' | 'text'

export const GLOBAL_TEXT_CURSOR_SELECTOR = [
  "input:not([type='checkbox']):not([type='radio']):not([type='button']):not([type='submit']):not([type='reset']):not([type='file'])",
  'textarea',
  "[contenteditable]:not([contenteditable='false'])"
].join(',')

export const GLOBAL_INTERACTIVE_CURSOR_SELECTOR = [
  'a',
  'button',
  "[role='button']",
  "[role='link']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']",
  "[role='option']",
  "[role='switch']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='slider']",
  "[role='combobox']",
  "[role='scrollbar']",
  "[data-nx-scrollbar-thumb]",
  '[aria-haspopup]',
  'label[for]',
  'label:has(input, textarea, select)',
  'select',
  'summary',
  "input[type='checkbox']",
  "input[type='radio']",
  "input[type='file']",
  "input[type='button']",
  "input[type='submit']",
  "input[type='reset']",
  "[data-list-row]",
  "[data-cursor='interactive']",
  '.cursor-pointer'
].join(',')

const HIDDEN_CURSOR_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNoaGhgBAAEhgGCm2g9SgAAAABJRU5ErkJggg=='

const GLOBAL_HOST_CLASS = 'nx-cursor-global-host'
const PANEL_HOST_CLASS = 'nx-cursor-host'
const DEFAULT_SIZE = 12
const INTERACTIVE_SIZE_MULTIPLIER = 2.5
const RING_PROBE_COUNT = 12
const SAMPLE_MIN_INTERVAL_MS = 32
/** 空闲休眠：指针静止且弹簧收敛后停掉 rAF（此前常驻每帧空转是基线负载来源） */
const CURSOR_IDLE_STOP_MS = 900
const CURSOR_SETTLE_SPEED_EPS = 0.05
/** 卡顿看门狗：rAF 帧间隔超过该值说明主线程刚被长任务卡死——
    立即归还系统光标一段时间，保证任何主线程卡顿下鼠标都可见可用 */
const CURSOR_STALL_DETECT_MS = 200
const CURSOR_STALL_LIFT_MS = 900
/** 看门狗心跳间隔：6Hz 定时器成本可忽略，换来空闲休眠期的卡顿感知 */
const CURSOR_WATCHDOG_INTERVAL_MS = 160
const TEXT_BEAM_WIDTH = 2
const TEXT_BEAM_HEIGHT = 20
const PRESS_SCALE = 0.82
const FOLLOW_TAU_MS = 28
const TEXT_FOLLOW_TAU_MS = 8
const VELOCITY_TAU_MS = 80
const STRETCH_SPEED_DIVISOR = 4000
const MAX_STRETCH = 0.35
const MAX_DT = 1 / 30

// 二阶弹簧参数（局部预览面板专用，与 ApiSpace PanelSpringCursor 保持一致）
const PANEL_SPRING_STIFFNESS = 320
const PANEL_SPRING_DAMPING = 26

// 远控/注入指针降级与自动恢复阈值
export const CURSOR_JUMP_THRESHOLD_PX = 400
const CURSOR_JUMP_WINDOW_MS = 2000
const CURSOR_JUMP_LIMIT = 3
export const CURSOR_RECOVERY_WINDOW_MS = 8000
export const CURSOR_RECOVERY_MIN_EVENTS = 40

const sampleModeCache = new WeakMap<Element, GlobalCursorMode>()

export function resolveSampleCursorMode(target: EventTarget | null): GlobalCursorMode | null {
  if (!(target instanceof Element)) return null

  // 动态自绘控件（如 ECharts canvas）通过 inline style.cursor 实时开关 pointer，不能走永久 WeakMap 缓存
  const isDynamicCanvas = target.tagName === 'CANVAS'
  let cur: Element | null = target
  for (let depth = 0; cur && depth < 5; depth += 1) {
    if (cur instanceof HTMLElement && cur.style.cursor === 'pointer') {
      return 'interactive'
    }
    cur = cur.parentElement
  }
  if (isDynamicCanvas) return null

  const cached = sampleModeCache.get(target)
  if (cached) return cached

  let mode: GlobalCursorMode | null = null
  if (target.closest(GLOBAL_TEXT_CURSOR_SELECTOR)) {
    mode = 'text'
  } else if (target.closest(GLOBAL_INTERACTIVE_CURSOR_SELECTOR)) {
    mode = 'interactive'
  }
  if (mode) sampleModeCache.set(target, mode)
  return mode
}

export function globalCursorModeFromSamples(
  center: EventTarget | null,
  ring: ArrayLike<EventTarget | null>
): GlobalCursorMode {
  const centerMode = resolveSampleCursorMode(center)
  if (centerMode === 'text') return 'text'
  for (let i = 0; i < ring.length; i += 1) {
    if (resolveSampleCursorMode(ring[i]) === 'interactive') return 'interactive'
  }
  if (centerMode === 'interactive') return 'interactive'
  return 'default'
}

export function globalCursorModeFromTarget(target: EventTarget | null): GlobalCursorMode {
  if (!(target instanceof Element)) return 'default'
  if (target.closest(GLOBAL_TEXT_CURSOR_SELECTOR)) return 'text'
  if (target.closest(GLOBAL_INTERACTIVE_CURSOR_SELECTOR)) return 'interactive'
  return 'default'
}

export interface CursorRecoveryTracker {
  lastX: number | null
  lastY: number
  windowStartMs: number
  eventCount: number
}

export function createCursorRecoveryTracker(): CursorRecoveryTracker {
  return { lastX: null, lastY: 0, windowStartMs: 0, eventCount: 0 }
}

export function observeCursorRecovery(
  tracker: CursorRecoveryTracker,
  x: number,
  y: number,
  timeMs: number
): boolean {
  const isJump =
    tracker.lastX !== null &&
    Math.hypot(x - tracker.lastX, y - tracker.lastY) > CURSOR_JUMP_THRESHOLD_PX
  if (tracker.lastX === null || isJump) {
    tracker.lastX = x
    tracker.lastY = y
    tracker.windowStartMs = timeMs
    tracker.eventCount = 1
    return false
  }
  tracker.lastX = x
  tracker.lastY = y
  tracker.eventCount += 1
  return (
    timeMs - tracker.windowStartMs >= CURSOR_RECOVERY_WINDOW_MS &&
    tracker.eventCount >= CURSOR_RECOVERY_MIN_EVENTS
  )
}

function usePointerEligible(): boolean {
  const [eligible, setEligible] = useState(true)
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const coarse = window.matchMedia('(pointer: coarse)')
    const reevaluate = (): void => setEligible(!reduced.matches && !coarse.matches)
    reevaluate()
    reduced.addEventListener('change', reevaluate)
    coarse.addEventListener('change', reevaluate)
    return () => {
      reduced.removeEventListener('change', reevaluate)
      coarse.removeEventListener('change', reevaluate)
    }
  }, [])
  return eligible
}

/** 全站自定义跟随光标 */
export function GlobalSpringCursor({ size = DEFAULT_SIZE }: { size?: number }): JSX.Element | null {
  const dotRef = useRef<HTMLDivElement | null>(null)
  const eligible = usePointerEligible()
  const [degraded, setDegraded] = useState(readCursorDegraded)

  useEffect(() => {
    if (!eligible || degraded) return
    const root = document.documentElement
    const dot = dotRef.current
    if (!root || !dot) return

    let rafId = 0
    let running = false
    let lastTime = 0
    let deferred = false
    let mode: GlobalCursorMode = 'default'
    let pressed = false
    let jumpCount = 0
    let lastJumpAt = 0
    let lastSampleAt = 0
    let prevRawX = 0
    let prevRawY = 0
    let hasPrevRaw = false
    let idleDeadline = 0
    // 原生光标接管（lift）：系统光标回归（合成器渲染，不受主线程卡顿影响），
    // 弹簧点隐藏。两个来源：看板刷新窗口（boardLoading）与主线程卡顿看门狗。
    let lifted = false
    let boardLifted = false
    let stallLiftUntil = 0
    const state = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, seen: false }

    // 预解码极微透明 1×1 PNG 光标，确保首帧即命中缓存而不触发 SetCursor(NULL)
    const preload = new Image()
    preload.src = HIDDEN_CURSOR_DATA_URI

    const applyMode = (next: GlobalCursorMode): void => {
      if (next === mode) return
      mode = next
      dot.classList.toggle('nx-interactive', next === 'interactive')
      dot.classList.toggle('nx-text', next === 'text')
      if (next === 'interactive') {
        const ringSize = size * INTERACTIVE_SIZE_MULTIPLIER
        dot.style.width = `${ringSize}px`
        dot.style.height = `${ringSize}px`
        dot.style.borderRadius = '9999px'
        dot.style.borderWidth = '1.5px'
      } else {
        dot.style.borderWidth = '0px'
        if (next === 'text') {
          dot.style.width = `${TEXT_BEAM_WIDTH}px`
          dot.style.height = `${TEXT_BEAM_HEIGHT}px`
          dot.style.borderRadius = '1px'
        } else {
          dot.style.width = `${size}px`
          dot.style.height = `${size}px`
          dot.style.borderRadius = '9999px'
        }
      }
    }

    const paint = (): void => {
      const speed = Math.hypot(state.vx, state.vy)
      const stretch = mode === 'text' ? 0 : Math.min(speed / STRETCH_SPEED_DIVISOR, MAX_STRETCH)
      const angle =
        mode !== 'text' && speed > 0.01 ? (Math.atan2(state.vy, state.vx) * 180) / Math.PI : 0
      const press = pressed ? PRESS_SCALE : 1
      dot.style.opacity = state.seen && !deferred && !lifted ? '1' : '0'
      dot.style.transform =
        `translate3d(${state.x}px, ${state.y}px, 0) translate(-50%, -50%)` +
        (mode === 'text'
          ? ` scale(${press})`
          : ` rotate(${angle}deg) scale(${(1 + stretch) * press}, ${(1 - stretch * 0.5) * press})`)
    }

    /** 归还系统光标：摘掉全局隐藏类（原生指针由合成器渲染，主线程卡死也可用），弹簧点隐藏 */
    const liftNative = (): void => {
      if (lifted) return
      lifted = true
      root.classList.remove(GLOBAL_HOST_CLASS)
      paint()
    }

    /** 恢复接管：重新隐藏系统光标；弹簧点吸附到当前指针位置立即显示，不出现"无指针"窗口 */
    const restoreNative = (): void => {
      if (!lifted) return
      lifted = false
      root.classList.add(GLOBAL_HOST_CLASS)
      if (state.seen) {
        state.x = state.tx
        state.y = state.ty
        state.vx = 0
        state.vy = 0
        paint()
      }
    }

    const applyLiftState = (): void => {
      const stalled = performance.now() < stallLiftUntil
      if (boardLifted || stalled) {
        liftNative()
      } else {
        restoreNative()
      }
    }

    const tick = (time: number): void => {
      const rawDt = time - lastTime
      const dt = Math.min(rawDt / 1000 || 0, MAX_DT)
      lastTime = time
      if (dt > 0) {
        const tauMs = mode === 'text' ? TEXT_FOLLOW_TAU_MS : FOLLOW_TAU_MS
        const prevX = state.x
        const prevY = state.y
        const follow = 1 - Math.exp(-dt / (tauMs / 1000))
        state.x += (state.tx - state.x) * follow
        state.y += (state.ty - state.y) * follow
        const velSmooth = 1 - Math.exp(-dt / (VELOCITY_TAU_MS / 1000))
        const rawVx = (state.x - prevX) / dt
        const rawVy = (state.y - prevY) / dt
        state.vx += (rawVx - state.vx) * velSmooth
        state.vy += (rawVy - state.vy) * velSmooth
      }
      paint()
      // 空闲休眠：无按压、静止超时且弹簧已收敛 → 停排帧（dot 保持最后姿态），
      // 任意 pointermove/pointerdown 会重新 start()；主线程不再被常驻 rAF 空转
      if (
        !pressed &&
        !lifted &&
        performance.now() >= idleDeadline &&
        Math.hypot(state.vx, state.vy) < CURSOR_SETTLE_SPEED_EPS
      ) {
        running = false
        return
      }
      rafId = requestAnimationFrame(tick)
    }

    const start = (): void => {
      // lift（原生光标接管）期间不重新隐藏系统光标
      if (!lifted) root.classList.add(GLOBAL_HOST_CLASS)
      if (running) return
      running = true
      lastTime = performance.now()
      rafId = requestAnimationFrame(tick)
    }

    const stop = (removeHostClass = false): void => {
      if (removeHostClass) root.classList.remove(GLOBAL_HOST_CLASS)
      if (!running) {
        dot.style.opacity = '0'
        state.seen = false
        hasPrevRaw = false
        return
      }
      running = false
      cancelAnimationFrame(rafId)
      dot.style.opacity = '0'
      state.seen = false
      hasPrevRaw = false
      deferred = false
      pressed = false
    }

    // 挂载即接管全局指针隐藏类，避免首帧及组件显隐瞬间闪烁系统光标
    root.classList.add(GLOBAL_HOST_CLASS)

    // 刷新窗口鼠标保证：boardLoading 一开始（重活尚未落地）就归还系统光标——
    // 原生指针由 OS 合成器渲染，随后无论主线程被图表重建卡多久，鼠标都可见可点；
    // loading 结束后弹簧点吸附回指针位置无缝接管。刷新机制与动效完全不动。
    boardLifted = useUi.getState().boardLoading
    if (boardLifted) liftNative()
    const unsubBoard = useUi.subscribe((s, prev) => {
      if (s.boardLoading === prev.boardLoading) return
      boardLifted = s.boardLoading
      applyLiftState()
    })

    // 卡顿看门狗（独立于弹簧 rAF——空闲休眠停帧后依然在岗，覆盖空闲期卡顿）：
    // 低频心跳对时；心跳迟到说明主线程刚被长任务卡死 → 归还系统光标一段时间。
    // 归还/恢复的判定也在这里收口，空闲休眠与看门狗互不依赖。
    let stallWatchdogBeat = performance.now()
    const stallWatchdog = window.setInterval(() => {
      const now = performance.now()
      if (now - stallWatchdogBeat > CURSOR_STALL_DETECT_MS + CURSOR_WATCHDOG_INTERVAL_MS) {
        stallLiftUntil = now + CURSOR_STALL_LIFT_MS
        liftNative()
      }
      stallWatchdogBeat = now
      if (lifted && !boardLifted && now >= stallLiftUntil) {
        restoreNative()
      }
    }, CURSOR_WATCHDOG_INTERVAL_MS)

    const pointElement = (px: number, py: number): Element | null => {
      if (typeof document.elementFromPoint === 'function') {
        return document.elementFromPoint(px, py)
      }
      return typeof document.elementsFromPoint === 'function'
        ? document.elementsFromPoint(px, py)[0] ?? null
        : null
    }

    const sampleCursorModeAt = (x: number, y: number): GlobalCursorMode => {
      const center = pointElement(x, y)
      const centerMode = resolveSampleCursorMode(center)
      if (centerMode === 'text') return 'text'
      if (centerMode === 'interactive') return 'interactive'
      const probeRadius = (size * INTERACTIVE_SIZE_MULTIPLIER) / 2
      for (let k = 0; k < RING_PROBE_COUNT; k += 1) {
        const angle = (k / RING_PROBE_COUNT) * Math.PI * 2
        const el = pointElement(
          x + Math.cos(angle) * probeRadius,
          y + Math.sin(angle) * probeRadius
        )
        if (resolveSampleCursorMode(el) === 'interactive') return 'interactive'
      }
      return 'default'
    }

    const onPointerMove = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') return
      idleDeadline = performance.now() + CURSOR_IDLE_STOP_MS
      state.tx = event.clientX
      state.ty = event.clientY
      const wasSeen = state.seen
      const target = event.target
      deferred = target instanceof Element && target.closest('[data-nx-panel-cursor]') !== null
      if (!deferred && event.timeStamp - lastSampleAt >= SAMPLE_MIN_INTERVAL_MS) {
        lastSampleAt = event.timeStamp
        applyMode(sampleCursorModeAt(state.tx, state.ty))
      }
      if (!state.seen) {
        state.x = state.tx
        state.y = state.ty
        state.vx = 0
        state.vy = 0
        state.seen = true
        prevRawX = state.tx
        prevRawY = state.ty
        hasPrevRaw = true
      } else {
        // 使用连续原始指针位移而非 tx-x（弹簧滞后距离），避免快速甩鼠标误判为远控跳变
        const rawDelta = hasPrevRaw ? Math.hypot(state.tx - prevRawX, state.ty - prevRawY) : 0
        prevRawX = state.tx
        prevRawY = state.ty
        hasPrevRaw = true
        if (running && rawDelta > CURSOR_JUMP_THRESHOLD_PX) {
          const now = performance.now()
          if (now - lastJumpAt > CURSOR_JUMP_WINDOW_MS) jumpCount = 0
          lastJumpAt = now
          jumpCount += 1
          if (jumpCount >= CURSOR_JUMP_LIMIT) {
            try {
              window.sessionStorage.setItem(CURSOR_DEGRADED_STORAGE_KEY, '1')
            } catch {
              // ignore storage failures
            }
            setDegraded(true)
            stop(true)
            dispatchCursorDegradedChanged()
            emitCursorToast(t('cursor.degradedToast'))
            return
          }
        }
      }
      if (!running) {
        start()
        paint()
      } else if (!wasSeen) {
        paint()
      }
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') return
      idleDeadline = performance.now() + CURSOR_IDLE_STOP_MS
      pressed = true
      if (!running) start()
      paint()
    }

    const onPointerPressEnd = (): void => {
      if (!pressed) return
      pressed = false
      if (running) paint()
    }

    const onPointerLeave = (): void => stop(false)
    const onBlur = (): void => stop(false)

    dot.style.width = `${size}px`
    dot.style.height = `${size}px`
    document.addEventListener('pointermove', onPointerMove, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointerup', onPointerPressEnd)
    window.addEventListener('pointercancel', onPointerPressEnd)
    document.addEventListener('pointerleave', onPointerLeave)
    window.addEventListener('blur', onBlur)
    return () => {
      stop(true)
      unsubBoard()
      window.clearInterval(stallWatchdog)
      document.removeEventListener('pointermove', onPointerMove, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointerup', onPointerPressEnd)
      window.removeEventListener('pointercancel', onPointerPressEnd)
      document.removeEventListener('pointerleave', onPointerLeave)
      window.removeEventListener('blur', onBlur)
    }
  }, [eligible, degraded, size])

  if (!eligible || degraded || typeof document === 'undefined') return null
  return createPortal(
    <div
      ref={dotRef}
      data-slot="smooth-global-cursor"
      className="nx-cursor"
      style={{ opacity: 0 }}
      aria-hidden="true"
    />,
    document.body
  )
}

/** 局部预览面板的真·二阶弹簧光标 */
export function PanelSpringCursor({
  targetRef,
  size = DEFAULT_SIZE
}: {
  targetRef: RefObject<HTMLElement | null>
  size?: number
}): JSX.Element | null {
  const dotRef = useRef<HTMLDivElement | null>(null)
  const eligible = usePointerEligible()

  useEffect(() => {
    if (!eligible) return
    const host = targetRef.current
    const dot = dotRef.current
    if (!host || !dot) return

    let rafId = 0
    let running = false
    let lastTime = 0
    let idleDeadline = 0
    const state = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, seen: false }

    const paint = (): void => {
      const speed = Math.hypot(state.vx, state.vy)
      const stretch = Math.min(speed / STRETCH_SPEED_DIVISOR, MAX_STRETCH)
      const angle = speed > 0.01 ? (Math.atan2(state.vy, state.vx) * 180) / Math.PI : 0
      dot.style.opacity = state.seen ? '1' : '0'
      dot.style.transform =
        `translate3d(${state.x}px, ${state.y}px, 0) translate(-50%, -50%)` +
        ` rotate(${angle}deg) scale(${1 + stretch}, ${1 - stretch * 0.5})`
    }

    const tick = (time: number): void => {
      const dt = Math.min((time - lastTime) / 1000 || 0, MAX_DT)
      lastTime = time
      state.vx += (state.tx - state.x) * PANEL_SPRING_STIFFNESS * dt - state.vx * PANEL_SPRING_DAMPING * dt
      state.vy += (state.ty - state.y) * PANEL_SPRING_STIFFNESS * dt - state.vy * PANEL_SPRING_DAMPING * dt
      state.x += state.vx * dt
      state.y += state.vy * dt
      paint()
      // 空闲休眠：静止超时且弹簧收敛 → 停排帧；pointermove 会重新 start()
      if (
        performance.now() >= idleDeadline &&
        Math.hypot(state.vx, state.vy) < CURSOR_SETTLE_SPEED_EPS &&
        Math.hypot(state.tx - state.x, state.ty - state.y) < 0.5
      ) {
        running = false
        return
      }
      rafId = requestAnimationFrame(tick)
    }

    const start = (): void => {
      if (running) return
      running = true
      lastTime = performance.now()
      host.classList.add(PANEL_HOST_CLASS)
      rafId = requestAnimationFrame(tick)
    }

    const stop = (): void => {
      if (!running) return
      running = false
      cancelAnimationFrame(rafId)
      host.classList.remove(PANEL_HOST_CLASS)
      dot.style.opacity = '0'
      state.seen = false
    }

    const onPointerEnter = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') return
      start()
    }
    const onPointerMove = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') return
      idleDeadline = performance.now() + CURSOR_IDLE_STOP_MS
      if (!running) start()
      state.tx = event.clientX
      state.ty = event.clientY
      if (!state.seen) {
        state.x = state.tx
        state.y = state.ty
        state.vx = 0
        state.vy = 0
        state.seen = true
      }
      paint()
    }
    const onPointerLeave = (): void => stop()

    dot.style.width = `${size}px`
    dot.style.height = `${size}px`
    host.addEventListener('pointerenter', onPointerEnter)
    host.addEventListener('pointermove', onPointerMove)
    host.addEventListener('pointerleave', onPointerLeave)
    return () => {
      stop()
      host.removeEventListener('pointerenter', onPointerEnter)
      host.removeEventListener('pointermove', onPointerMove)
      host.removeEventListener('pointerleave', onPointerLeave)
    }
  }, [eligible, targetRef, size])

  if (!eligible || typeof document === 'undefined') return null
  return createPortal(
    <div
      ref={dotRef}
      data-slot="smooth-panel-cursor"
      className="nx-cursor"
      style={{ opacity: 0 }}
      aria-hidden="true"
    />,
    document.body
  )
}

function CursorRecoveryProbe({ onRecovered }: { onRecovered: () => void }): null {
  const onRecoveredRef = useRef(onRecovered)
  onRecoveredRef.current = onRecovered
  const [degraded, setDegraded] = useState(readCursorDegraded)

  useEffect(() => {
    const sync = (): void => setDegraded(readCursorDegraded())
    window.addEventListener(CURSOR_DEGRADED_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(CURSOR_DEGRADED_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  useEffect(() => {
    if (!degraded) return
    const tracker = createCursorRecoveryTracker()
    const onPointerMove = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') return
      const recovered = observeCursorRecovery(
        tracker,
        event.clientX,
        event.clientY,
        window.performance.now()
      )
      if (!recovered) return
      window.removeEventListener('pointermove', onPointerMove, true)
      clearCursorDegraded()
      setDegraded(false)
      emitCursorToast(t('cursor.restoredToast'))
      onRecoveredRef.current()
    }
    window.addEventListener('pointermove', onPointerMove, true)
    return () => window.removeEventListener('pointermove', onPointerMove, true)
  }, [degraded])

  return null
}

/** 根级挂载点：实时响应启用开关与尺寸变更 */
export function GlobalCursorMount(): JSX.Element | null {
  const [state, setState] = useState(() => ({
    enabled: readCursorEnabled(),
    size: readCursorSize(),
    version: 0
  }))

  useEffect(() => {
    const onConfigChanged = (): void => {
      setState((prev) => ({
        enabled: readCursorEnabled(),
        size: readCursorSize(),
        version: prev.version + 1
      }))
    }
    const onStorage = (): void => {
      setState((prev) => {
        const enabled = readCursorEnabled()
        const size = readCursorSize()
        if (enabled === prev.enabled && size === prev.size) return prev
        return { enabled, size, version: prev.version + 1 }
      })
    }
    window.addEventListener(CURSOR_CONFIG_CHANGED_EVENT, onConfigChanged)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(CURSOR_CONFIG_CHANGED_EVENT, onConfigChanged)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  if (!state.enabled) return null
  return (
    <>
      <GlobalSpringCursor key={state.version} size={state.size} />
      <CursorRecoveryProbe
        onRecovered={() => setState((prev) => ({ ...prev, version: prev.version + 1 }))}
      />
    </>
  )
}

/** 设置弹窗内的自定义鼠标控制段（含开关、尺寸选择与弹簧预览垫） */
export function CursorSettingsSection(): JSX.Element {
  useLang()
  const [enabled, setEnabled] = useState(readCursorEnabled)
  const [size, setSize] = useState(readCursorSize)
  const [degraded, setDegraded] = useState(readCursorDegraded)
  const previewRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const sync = (): void => {
      setEnabled(readCursorEnabled())
      setSize(readCursorSize())
      setDegraded(readCursorDegraded())
    }
    window.addEventListener(CURSOR_CONFIG_CHANGED_EVENT, sync)
    window.addEventListener(CURSOR_DEGRADED_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(CURSOR_CONFIG_CHANGED_EVENT, sync)
      window.removeEventListener(CURSOR_DEGRADED_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const toggleEnabled = (): void => {
    const next = !enabled
    setEnabled(next)
    writeCursorEnabled(next)
  }

  const pickSize = (opt: CursorSizeOption): void => {
    setSize(opt)
    writeCursorSize(opt)
  }

  const handleReEnable = (): void => {
    clearCursorDegraded()
    setDegraded(false)
    setEnabled(true)
    writeCursorEnabled(true)
    emitCursorToast(t('cursor.restoredToast'))
  }

  return (
    <div>
      <div className="mb-1 text-ui-xs text-foreground-subtle">{t('settings.cursor.title')}</div>
      {degraded && (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning-surface px-2.5 py-1.5 text-ui-xs text-foreground">
          <span>{t('cursor.degradedBanner')}</span>
          <button
            type="button"
            onClick={handleReEnable}
            className="shrink-0 rounded-md bg-card px-2 py-0.5 text-ui-xs font-medium text-foreground transition-colors hover:bg-hover"
          >
            {t('cursor.reEnable')}
          </button>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-ui-sm text-foreground">{t('settings.cursor.enable')}</div>
          <div className="text-ui-xs text-foreground-subtlest">{t('settings.cursor.hint')}</div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={t('settings.cursor.enable')}
          onClick={toggleEnabled}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors duration-150 ${
            enabled
              ? 'border-signal bg-signal'
              : 'border-border bg-surface hover:bg-surface-hover'
          }`}
        >
          <span
            className={`inline-block size-3.5 rounded-full bg-white shadow-sm transition-transform duration-150 ${
              enabled ? 'translate-x-[17px]' : 'translate-x-[2px]'
            }`}
          />
        </button>
      </div>

      <div className="mt-2.5">
        <div className="mb-1 text-ui-xs text-foreground-subtlest">{t('settings.cursor.size')}</div>
        <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label={t('settings.cursor.size')}>
          {CURSOR_SIZE_OPTIONS.map((opt) => {
            const active = size === opt
            return (
              <button
                key={opt}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => pickSize(opt)}
                className={`flex flex-col items-center justify-center gap-1 rounded-lg border py-1.5 transition-colors duration-150 ${
                  active
                    ? 'border-signal bg-signal-soft text-foreground'
                    : 'border-border bg-surface text-foreground-subtle hover:border-border-hover hover:text-foreground'
                }`}
              >
                <span className="flex h-5 items-center justify-center">
                  <span
                    className="rounded-full bg-foreground"
                    style={{ width: `${opt}px`, height: `${opt}px` }}
                  />
                </span>
                <span className="font-mono text-[10px] tabular-nums">{opt}px</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="mt-2.5">
        <div
          ref={previewRef}
          data-nx-panel-cursor=""
          className="flex h-16 items-end justify-center rounded-lg border border-dashed border-border bg-surface/60 px-2 pb-1.5 text-center text-[11px] text-foreground-subtlest"
        >
          <span className="pointer-events-none select-none">
            {enabled ? t('settings.cursor.preview') : t('settings.cursor.previewDisabled')}
          </span>
        </div>
        {enabled && <PanelSpringCursor targetRef={previewRef} size={size} />}
      </div>
    </div>
  )
}
