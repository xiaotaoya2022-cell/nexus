// 动效原语组件库（Spotlight 鼠标聚光灯 / Scroll Reveal 滚动显现 / Border Beam 边缘流光 / Marquee 无缝跑马灯）
// 全部支持 Dark & Light 双主题，遵循 prefers-reduced-motion 无障碍降级。

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, JSX, ReactNode } from 'react'
import type { AgentInfo, MeshNodeInfo, NamedStat } from '@shared/types'
import { vendorOf } from '@shared/vendors'
import { t, useLang } from '../i18n'
import { compactNumber } from '../lib/format'
import { AgentLogo } from './AgentLogo'
import { NodeKindIcon, formatRamGb, nodeDisplayName } from './NodeVisuals'

const SPOTLIGHT_PROXIMITY_PX = 200

/**
 * Spotlight 聚光灯作用域容器：
 * 以单监听 rAF 节流向后代所有 `.nx-spotlight-card` 写入相对坐标 `--nx-spot-x/y`，
 * 指针进入卡内时激活表面光斑与微点阵纹理，靠近相邻卡片间隙时也能提前点亮边缘高光。
 */
export function SpotlightGroup({
  children,
  className = '',
  style,
  as = 'div'
}: {
  children: ReactNode
  className?: string
  style?: CSSProperties
  as?: 'div' | 'main' | 'section'
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const pointerRef = useRef<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false })
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    const updateCards = (): void => {
      rafRef.current = null
      const cards = root.querySelectorAll<HTMLElement>('.nx-spotlight-card, .nx-spotlight-chart')
      const { x, y, active } = pointerRef.current
      if (!active) {
        for (const card of cards) {
          card.style.setProperty('--nx-spot-op', '0')
          card.style.setProperty('--nx-spot-border-op', '0')
        }
        return
      }
      for (const card of cards) {
        const rect = card.getBoundingClientRect()
        const relX = x - rect.left
        const relY = y - rect.top
        const dx = Math.max(rect.left - x, 0, x - rect.right)
        const dy = Math.max(rect.top - y, 0, y - rect.bottom)
        const dist = Math.hypot(dx, dy)
        if (dist > SPOTLIGHT_PROXIMITY_PX) {
          card.style.setProperty('--nx-spot-op', '0')
          card.style.setProperty('--nx-spot-border-op', '0')
          continue
        }
        card.style.setProperty('--nx-spot-x', `${Math.round(relX)}px`)
        card.style.setProperty('--nx-spot-y', `${Math.round(relY)}px`)
        const inside = dx === 0 && dy === 0
        card.style.setProperty('--nx-spot-op', inside ? '1' : '0')
        const borderStrength = inside ? 1 : Math.max(0.18, 1 - dist / SPOTLIGHT_PROXIMITY_PX)
        card.style.setProperty('--nx-spot-border-op', borderStrength.toFixed(2))
      }
    }

    const schedule = (): void => {
      if (rafRef.current != null) return
      rafRef.current = window.requestAnimationFrame(updateCards)
    }

    const onPointerMove = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') return
      pointerRef.current = { x: event.clientX, y: event.clientY, active: true }
      schedule()
    }

    const onPointerLeave = (): void => {
      pointerRef.current.active = false
      schedule()
    }

    const onScroll = (): void => {
      if (pointerRef.current.active) schedule()
    }

    root.addEventListener('pointermove', onPointerMove, { passive: true })
    root.addEventListener('pointerleave', onPointerLeave, { passive: true })
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      if (rafRef.current != null) window.cancelAnimationFrame(rafRef.current)
      root.removeEventListener('pointermove', onPointerMove)
      root.removeEventListener('pointerleave', onPointerLeave)
      root.removeEventListener('scroll', onScroll)
    }
  }, [])

  const Tag = as
  return (
    <Tag ref={rootRef as React.RefObject<never>} style={style} className={className}>
      {children}
    </Tag>
  )
}

/** Border Beam 边缘流光：沿圆角卡片边框连续游走的彗星光弧（适合焦点卡片 / 在线配对态） */
export function BorderBeam({
  active = true,
  durationSec = 4.8,
  fromColor = 'var(--nx-cobalt)',
  toColor = 'var(--nx-signal)',
  glow = true
}: {
  active?: boolean
  durationSec?: number
  fromColor?: string
  toColor?: string
  glow?: boolean
}): JSX.Element | null {
  if (!active) return null
  const style = {
    '--nx-beam-dur': `${durationSec}s`,
    '--nx-beam-from': fromColor,
    '--nx-beam-to': toColor
  } as CSSProperties
  return (
    <>
      {glow && <span aria-hidden className="nx-border-beam-glow" style={style} />}
      <span aria-hidden className="nx-border-beam" style={style} />
    </>
  )
}

/** Scroll Reveal 滚动显现：进入视口时顺滑淡入并轻微上浮归位 */
export function ScrollReveal({
  children,
  delayMs = 0,
  once = true,
  className = ''
}: {
  children: ReactNode
  delayMs?: number
  once?: boolean
  className?: string
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [revealed, setRevealed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  })
  const [settled, setSettled] = useState(revealed)

  useEffect(() => {
    if (revealed && settled) return
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setRevealed(true)
      setSettled(true)
      return
    }

    // 若挂载时已在首屏可视区内，立即开启交错动画避免首屏阻塞等待
    const rect = el.getBoundingClientRect()
    if (rect.height > 0 && rect.top < window.innerHeight + 32 && rect.bottom > -32) {
      const raf = window.requestAnimationFrame(() => setRevealed(true))
      return () => window.cancelAnimationFrame(raf)
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setRevealed(true)
            if (once) observer.disconnect()
          } else if (!once) {
            setRevealed(false)
            setSettled(false)
          }
        }
      },
      { threshold: 0.05, rootMargin: '0px 0px -16px 0px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [once, revealed, settled])

  useEffect(() => {
    if (!revealed || settled) return
    const timer = window.setTimeout(() => setSettled(true), Math.max(560, delayMs + 560))
    return () => window.clearTimeout(timer)
  }, [revealed, settled, delayMs])

  return (
    <div
      ref={ref}
      data-revealed={revealed ? 'true' : 'false'}
      data-settled={settled ? 'true' : undefined}
      style={{ '--nx-reveal-delay': `${delayMs}ms` } as CSSProperties}
      className={`nx-reveal ${className}`}
    >
      {children}
    </div>
  )
}

/** Marquee 跑马灯：等距双组轨道实现 -50% 无缝无限循环，支持悬停暂停与反向 */
export function Marquee({
  children,
  durationSec = 34,
  pauseOnHover = true,
  reverse = false,
  className = ''
}: {
  children: ReactNode
  durationSec?: number
  pauseOnHover?: boolean
  reverse?: boolean
  className?: string
}): JSX.Element {
  return (
    <div
      data-pause-hover={pauseOnHover ? 'true' : undefined}
      className={`nx-marquee-viewport ${className}`}
    >
      <div
        data-reverse={reverse ? 'true' : undefined}
        style={{ '--nx-marquee-dur': `${durationSec}s` } as CSSProperties}
        className="nx-marquee-track"
      >
        <div className="flex shrink-0 items-center gap-2.5 pr-2.5">{children}</div>
        <div aria-hidden="true" className="flex shrink-0 items-center gap-2.5 pr-2.5">
          {children}
        </div>
      </div>
    </div>
  )
}

/** Nexus 实时生态与模型/集群遥测跑马灯条（基于真实数据渲染，支持点击直达筛选） */
export function NexusTelemetryMarquee({
  mode,
  agents,
  models = [],
  nodes = [],
  onSelectAgent,
  onSelectNode,
  className = ''
}: {
  mode: 'board' | 'mesh'
  agents: AgentInfo[]
  models?: NamedStat[]
  nodes?: MeshNodeInfo[]
  onSelectAgent?: (agentId: string) => void
  onSelectNode?: (nodeId: string) => void
  className?: string
}): JSX.Element | null {
  useLang()

  const activeAgents = agents.filter((a) => (a.rangeTokens ?? a.todayTokens) > 0)
  const displayAgents = activeAgents.length >= 3 ? activeAgents : agents.slice(0, 12)
  const displayModels = models.slice(0, 8)

  if (mode === 'board' && displayAgents.length === 0 && displayModels.length === 0) return null
  if (mode === 'mesh' && nodes.length === 0 && displayAgents.length === 0) return null

  return (
    <div
      data-nx-marquee=""
      className={`nx-card-elevated nx-spotlight-card flex items-center gap-3 overflow-hidden rounded-xl bg-card/90 px-3.5 py-2 ${className}`}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-r border-hairline pr-3">
        <span className="nx-breathe h-1.5 w-1.5 rounded-full bg-signal" />
        <span className="font-mono text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
          {mode === 'mesh' ? t('marquee.meshLabel') : t('marquee.boardTitle')}
        </span>
      </div>

      <Marquee durationSec={mode === 'mesh' ? 46 : 42} className="min-w-0 flex-1 opacity-85 transition-opacity duration-150 hover:opacity-100">
        {mode === 'mesh' &&
          nodes.map((node) => (
            <button
              key={`node-${node.nodeId}`}
              type="button"
              onClick={() => onSelectNode?.(node.nodeId)}
              className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 text-ui-xs transition-colors duration-150 hover:border-signal/60 hover:bg-hover"
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  node.status === 'online' ? 'bg-success' : 'bg-border'
                }`}
              />
              <NodeKindIcon kind={node.kind} className="size-3.5 text-cobalt" />
              <span className="font-medium text-foreground">{nodeDisplayName(node)}</span>
              <span className="font-mono text-[10px] text-foreground-subtlest">
                {node.hwSummary.cpuCores}C/{formatRamGb(node.hwSummary.ramTotalBytes, 0)}G
              </span>
              <span className="font-mono text-[10px] tabular-nums text-foreground-subtle">
                {compactNumber(node.totalTokens)}
              </span>
            </button>
          ))}

        {displayAgents.map((a) => {
          const tk = a.rangeTokens ?? a.todayTokens
          return (
            <button
              key={`agent-${a.id}`}
              type="button"
              onClick={() => onSelectAgent?.(a.id)}
              className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 text-ui-xs transition-colors duration-150 hover:border-cobalt/60 hover:bg-hover"
            >
              <AgentLogo agentId={a.id} vendor={vendorOf(a.id)} size={14} />
              <span className="font-medium text-foreground">{a.label}</span>
              <span
                className={`font-mono text-[10px] tabular-nums ${
                  tk > 0 ? 'text-signal' : 'text-foreground-subtlest'
                }`}
              >
                {tk > 0 ? compactNumber(tk) : t('time.noRecord')}
              </span>
            </button>
          )
        })}

        {mode === 'board' &&
          displayModels.map((m) => (
            <span
              key={`model-${m.name}`}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-hairline bg-panel px-2.5 font-mono text-[10px] text-foreground-subtle"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-cobalt" />
              <span className="max-w-[160px] truncate text-foreground">{m.name}</span>
              <span className="tabular-nums text-foreground-subtlest">
                {compactNumber(m.tokens)} · {m.requests}r
              </span>
            </span>
          ))}
      </Marquee>

      <span className="hidden shrink-0 font-mono text-[10px] text-foreground-subtlest sm:inline">
        {t('marquee.pauseHint')}
      </span>
    </div>
  )
}

/**
 * 增量脉冲高亮检测 Hook：仅当同 scopeKey（范围/节点不变）下某项指标真实递增或新条目到达时，
 * 返回短暂高亮 ID 集合（820ms 自动熄灭）；切范围/切节点时重置基线，避免全列表误闪。
 */
export function useDeltaFlashIds<T>(
  items: T[],
  getKey: (item: T) => string,
  getMetric: (item: T) => number,
  scopeKey: string,
  durationMs = 820
): Set<string> {
  const prevScopeRef = useRef(scopeKey)
  const prevMetricsRef = useRef<Map<string, number>>(new Map())
  const initializedRef = useRef(false)
  const timersRef = useRef<Map<string, number>>(new Map())
  const [flashing, setFlashing] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const id of timers.values()) window.clearTimeout(id)
      timers.clear()
    }
  }, [])

  useEffect(() => {
    if (prevScopeRef.current !== scopeKey) {
      prevScopeRef.current = scopeKey
      prevMetricsRef.current = new Map()
      initializedRef.current = false
      for (const id of timersRef.current.values()) window.clearTimeout(id)
      timersRef.current.clear()
      setFlashing(new Set())
    }

    const nextMap = new Map<string, number>()
    const newlyIncreased: string[] = []
    for (const item of items) {
      const k = getKey(item)
      const val = getMetric(item)
      nextMap.set(k, val)
      if (initializedRef.current) {
        const prev = prevMetricsRef.current.get(k)
        if ((prev === undefined && val > 0) || (prev !== undefined && val > prev)) {
          newlyIncreased.push(k)
        }
      }
    }
    prevMetricsRef.current = nextMap

    if (!initializedRef.current) {
      if (items.length > 0) initializedRef.current = true
      return
    }
    if (newlyIncreased.length === 0) return

    setFlashing((curr) => {
      const merged = new Set(curr)
      for (const k of newlyIncreased) merged.add(k)
      return merged
    })

    for (const k of newlyIncreased) {
      const prevTimer = timersRef.current.get(k)
      if (prevTimer !== undefined) window.clearTimeout(prevTimer)
      const timer = window.setTimeout(() => {
        timersRef.current.delete(k)
        setFlashing((curr) => {
          if (!curr.has(k)) return curr
          const next = new Set(curr)
          next.delete(k)
          return next
        })
      }, durationMs)
      timersRef.current.set(k, timer)
    }
  }, [items, scopeKey, durationMs]) // getKey/getMetric 应为纯函数

  return flashing
}

/**
 * 轻量交叠淡入 Hook：节点/范围/Agent 切换时用 WAAPI 在宿主容器上执行 190ms 微滑入过渡，
 * 不修改 React key、不卸载 ECharts Canvas 实例。
 */
export function useViewCrossfade(
  targetRef: React.RefObject<HTMLElement | null>,
  triggerKey: string
): void {
  const prevKeyRef = useRef(triggerKey)
  useEffect(() => {
    if (prevKeyRef.current === triggerKey) return
    prevKeyRef.current = triggerKey
    const el = targetRef.current
    if (!el || typeof el.animate !== 'function') return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    el.animate(
      [
        { opacity: 0.72, transform: 'translate3d(0, 4px, 0)' },
        { opacity: 1, transform: 'translate3d(0, 0, 0)' }
      ],
      { duration: 190, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
    )
  }, [targetRef, triggerKey])
}
