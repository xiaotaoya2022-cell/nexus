// SurePoint Core Engine (Zero-Dependency, Framework-Agnostic)
// Six-state adaptive pointer: default / interactive / text / press / leave-blur / remote-degrade

import { resolveAdaptiveTone, type LuminanceOptions, type SurePointTone } from './luminance'

export type SurePointMode = 'default' | 'interactive' | 'text'

export interface SurePointOptions {
  /** Base dot diameter in px (default: 12) */
  size?: number
  /** Custom CSS selector for text I-beam targets */
  textSelector?: string
  /** Custom CSS selector for interactive ring targets */
  interactiveSelector?: string
  /** Adaptive luminance sampling thresholds */
  luminance?: LuminanceOptions
  /** Remote jump threshold in px (default: 400) */
  jumpThresholdPx?: number
  /** Callback when remote jump triggers native fallback */
  onDegraded?: () => void
  /** Callback when continuous movement restores SurePoint */
  onRecovered?: () => void
}

export interface SurePointInstance {
  /** Force returning OS cursor while heavy main-thread work runs */
  setExternalLift: (lifted: boolean) => void
  /** Cleanly unmount listeners, timers, and DOM node */
  destroy: () => void
}

export const DEFAULT_TEXT_SELECTOR = [
  "input:not([type='checkbox']):not([type='radio']):not([type='button']):not([type='submit']):not([type='reset']):not([type='file'])",
  'textarea',
  "[contenteditable]:not([contenteditable='false'])"
].join(',')

export const DEFAULT_INTERACTIVE_SELECTOR = [
  'a',
  'button',
  "[role='button']",
  "[role='link']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='option']",
  "[role='switch']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='slider']",
  "[role='combobox']",
  '[aria-haspopup]',
  'label[for]',
  'select',
  'summary',
  "[data-cursor='interactive']",
  '.cursor-pointer'
].join(',')

const HIDDEN_CURSOR_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNoaGhgBAAEhgGCm2g9SgAAAABJRU5ErkJggg=='

const GLOBAL_HOST_CLASS = 'sp-cursor-global-host'
const INTERACTIVE_MULTIPLIER = 2.5
const RING_PROBE_COUNT = 12
const SAMPLE_MIN_INTERVAL_MS = 32
const IDLE_STOP_MS = 900
const SETTLE_SPEED_EPS = 0.05
const STALL_DETECT_MS = 200
const STALL_LIFT_MS = 900
const WATCHDOG_INTERVAL_MS = 160
const TEXT_BEAM_WIDTH = 2
const TEXT_BEAM_HEIGHT = 20
const PRESS_SCALE = 0.82
const FOLLOW_TAU_MS = 28
const TEXT_FOLLOW_TAU_MS = 8
const VELOCITY_TAU_MS = 80
const STRETCH_DIVISOR = 4000
const MAX_STRETCH = 0.35
const MAX_DT = 1 / 30
const JUMP_WINDOW_MS = 2000
const JUMP_LIMIT = 3

export function createSurePoint(options: SurePointOptions = {}): SurePointInstance {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { setExternalLift: () => undefined, destroy: () => undefined }
  }

  const size = options.size ?? 12
  const textSelector = options.textSelector ?? DEFAULT_TEXT_SELECTOR
  const interactiveSelector = options.interactiveSelector ?? DEFAULT_INTERACTIVE_SELECTOR
  const jumpThresholdPx = options.jumpThresholdPx ?? 400
  const modeCache = new WeakMap<Element, SurePointMode>()

  const resolveModeForElement = (target: EventTarget | null): SurePointMode | null => {
    if (!(target instanceof Element)) return null
    const isDynamicCanvas = target.tagName === 'CANVAS'
    let cur: Element | null = target
    for (let depth = 0; cur && depth < 5; depth += 1) {
      if (cur instanceof HTMLElement && cur.style.cursor === 'pointer') return 'interactive'
      cur = cur.parentElement
    }
    if (!isDynamicCanvas) {
      const cached = modeCache.get(target)
      if (cached !== undefined) return cached
    }
    let resolved: SurePointMode = 'default'
    if (target.closest(textSelector)) resolved = 'text'
    else if (target.closest(interactiveSelector)) resolved = 'interactive'
    if (!isDynamicCanvas) modeCache.set(target, resolved)
    return resolved
  }

  const root = document.documentElement
  const dot = document.createElement('div')
  dot.className = 'sp-cursor'
  dot.setAttribute('data-surepoint-cursor', 'true')
  dot.setAttribute('aria-hidden', 'true')
  dot.style.opacity = '0'
  dot.style.width = `${size}px`
  dot.style.height = `${size}px`
  document.body.appendChild(dot)

  const preload = new Image()
  preload.src = HIDDEN_CURSOR_DATA_URI

  let rafId = 0
  let running = false
  let lastTime = 0
  let mode: SurePointMode = 'default'
  let tone: SurePointTone = root.classList.contains('dark') || root.classList.contains('theme-dark') ? 'light' : 'dark'
  dot.dataset.tone = tone

  let pressed = false
  let degraded = false
  let lifted = false
  let externalLifted = false
  let stallLiftUntil = 0
  let jumpCount = 0
  let lastJumpAt = 0
  let lastSampleAt = 0
  let prevRawX = 0
  let prevRawY = 0
  let hasPrevRaw = false
  let idleDeadline = 0
  const state = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, seen: false }

  const applyTone = (next: SurePointTone): void => {
    if (next === tone) return
    tone = next
    dot.dataset.tone = next
  }

  const applyMode = (next: SurePointMode): void => {
    if (next === mode) return
    mode = next
    dot.classList.toggle('sp-interactive', next === 'interactive')
    dot.classList.toggle('sp-text', next === 'text')
    if (next === 'interactive') {
      const ringSize = size * INTERACTIVE_MULTIPLIER
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
    const stretch = mode === 'text' ? 0 : Math.min(speed / STRETCH_DIVISOR, MAX_STRETCH)
    const angle = mode !== 'text' && speed > 0.01 ? (Math.atan2(state.vy, state.vx) * 180) / Math.PI : 0
    const press = pressed ? PRESS_SCALE : 1
    dot.style.opacity = state.seen && !lifted && !degraded ? '1' : '0'
    dot.style.transform =
      `translate3d(${state.x}px, ${state.y}px, 0) translate(-50%, -50%)` +
      (mode === 'text'
        ? ` scale(${press})`
        : ` rotate(${angle}deg) scale(${(1 + stretch) * press}, ${(1 - stretch * 0.5) * press})`)
  }

  const liftNative = (): void => {
    if (lifted) return
    lifted = true
    root.classList.remove(GLOBAL_HOST_CLASS)
    paint()
  }

  const restoreNative = (): void => {
    if (!lifted || degraded) return
    lifted = false
    root.classList.add(GLOBAL_HOST_CLASS)
    if (state.seen) {
      state.x = state.tx
      state.y = state.ty
      state.vx = 0
      state.vy = 0
      applyTone(resolveAdaptiveTone(state.tx, state.ty, tone, options.luminance))
      paint()
    }
  }

  const tick = (time: number): void => {
    const dt = Math.min((time - lastTime) / 1000 || 0, MAX_DT)
    lastTime = time
    if (dt > 0) {
      const tauMs = mode === 'text' ? TEXT_FOLLOW_TAU_MS : FOLLOW_TAU_MS
      const prevX = state.x
      const prevY = state.y
      const follow = 1 - Math.exp(-dt / (tauMs / 1000))
      state.x += (state.tx - state.x) * follow
      state.y += (state.ty - state.y) * follow
      const velSmooth = 1 - Math.exp(-dt / (VELOCITY_TAU_MS / 1000))
      state.vx += ((state.x - prevX) / dt - state.vx) * velSmooth
      state.vy += ((state.y - prevY) / dt - state.vy) * velSmooth
    }
    paint()
    if (!pressed && !lifted && performance.now() >= idleDeadline && Math.hypot(state.vx, state.vy) < SETTLE_SPEED_EPS) {
      running = false
      return
    }
    rafId = requestAnimationFrame(tick)
  }

  const start = (): void => {
    if (!lifted && !degraded) root.classList.add(GLOBAL_HOST_CLASS)
    if (running) return
    running = true
    lastTime = performance.now()
    rafId = requestAnimationFrame(tick)
  }

  const stop = (removeHostClass = false): void => {
    if (removeHostClass) root.classList.remove(GLOBAL_HOST_CLASS)
    if (running) {
      running = false
      cancelAnimationFrame(rafId)
    }
    dot.style.opacity = '0'
    state.seen = false
    hasPrevRaw = false
    pressed = false
  }

  root.classList.add(GLOBAL_HOST_CLASS)

  let watchdogBeat = performance.now()
  const watchdog = window.setInterval(() => {
    const now = performance.now()
    if (now - watchdogBeat > STALL_DETECT_MS + WATCHDOG_INTERVAL_MS) {
      stallLiftUntil = now + STALL_LIFT_MS
      liftNative()
    }
    watchdogBeat = now
    if (lifted && !externalLifted && now >= stallLiftUntil) {
      restoreNative()
    }
  }, WATCHDOG_INTERVAL_MS)

  const sampleModeAt = (x: number, y: number): SurePointMode => {
    const center = document.elementFromPoint(x, y)
    const centerMode = resolveModeForElement(center)
    if (centerMode === 'text') return 'text'
    if (centerMode === 'interactive') return 'interactive'
    const radius = (size * INTERACTIVE_MULTIPLIER) / 2
    for (let k = 0; k < RING_PROBE_COUNT; k += 1) {
      const a = (k / RING_PROBE_COUNT) * Math.PI * 2
      const el = document.elementFromPoint(x + Math.cos(a) * radius, y + Math.sin(a) * radius)
      if (resolveModeForElement(el) === 'interactive') return 'interactive'
    }
    return 'default'
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch' || degraded) return
    idleDeadline = performance.now() + IDLE_STOP_MS
    state.tx = event.clientX
    state.ty = event.clientY
    const wasSeen = state.seen

    if (!wasSeen || event.timeStamp - lastSampleAt >= SAMPLE_MIN_INTERVAL_MS) {
      lastSampleAt = event.timeStamp
      applyMode(sampleModeAt(state.tx, state.ty))
      applyTone(resolveAdaptiveTone(state.tx, state.ty, tone, options.luminance))
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
      const rawDelta = hasPrevRaw ? Math.hypot(state.tx - prevRawX, state.ty - prevRawY) : 0
      prevRawX = state.tx
      prevRawY = state.ty
      hasPrevRaw = true
      if (running && rawDelta > jumpThresholdPx) {
        const now = performance.now()
        if (now - lastJumpAt > JUMP_WINDOW_MS) jumpCount = 0
        lastJumpAt = now
        jumpCount += 1
        if (jumpCount >= JUMP_LIMIT) {
          degraded = true
          stop(true)
          options.onDegraded?.()
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
    if (event.pointerType === 'touch' || degraded) return
    idleDeadline = performance.now() + IDLE_STOP_MS
    pressed = true
    if (!running) start()
    paint()
  }

  const onPointerUp = (): void => {
    if (!pressed) return
    pressed = false
    if (running) paint()
  }

  const onLeave = (): void => stop(false)

  document.addEventListener('pointermove', onPointerMove, true)
  document.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerUp)
  document.addEventListener('pointerleave', onLeave)
  window.addEventListener('blur', onLeave)

  return {
    setExternalLift: (next: boolean) => {
      externalLifted = next
      if (next || performance.now() < stallLiftUntil) liftNative()
      else restoreNative()
    },
    destroy: () => {
      stop(true)
      window.clearInterval(watchdog)
      document.removeEventListener('pointermove', onPointerMove, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      document.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('blur', onLeave)
      dot.remove()
    }
  }
}
