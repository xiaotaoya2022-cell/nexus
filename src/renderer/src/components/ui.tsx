// 基础 UI 组件：状态灯、KPI 卡、图表卡、药丸切换器、空状态、图标。
// 样式遵循《Nexus UI 设计规范草案》§4。

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, JSX, KeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { AgentStatus, RangeKey } from '@shared/types'
import { t, useLang } from '../i18n'
import { BorderBeam } from './MotionEffects'
import { SlidingTabIndicator } from './SmoothHighlight'

/** 状态文案：渲染期走 t()（语言切换即时生效） */
export function statusText(status: AgentStatus): string {
  return t(`status.${status}`)
}

export function StatusDot({ status }: { status: AgentStatus }): JSX.Element {
  useLang()
  const cls =
    status === 'active'
      ? 'bg-chart-1 nx-breathe'
      : status === 'idle'
        ? 'bg-idle'
        : status === 'offline'
          ? 'bg-border'
          : 'bg-border opacity-60'
  return <span title={statusText(status)} className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${cls}`} />
}

export function KpiCard({
  label,
  value,
  sub,
  indexTag,
  accent,
  progressPct,
  featured
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  indexTag?: string
  accent?: 'signal' | 'cobalt' | 'success'
  progressPct?: number
  featured?: boolean
}): JSX.Element {
  const accentColor =
    accent === 'signal'
      ? 'var(--nx-signal)'
      : accent === 'cobalt'
        ? 'var(--nx-cobalt)'
        : accent === 'success'
          ? 'var(--nx-success)'
          : undefined
  return (
    <div className="nx-card-elevated nx-kpi-card nx-spotlight-card relative flex flex-col gap-2 overflow-hidden rounded-xl border border-border bg-card px-4 py-3">
      <BorderBeam active={Boolean(featured)} durationSec={5.6} />
      <div className="flex items-center justify-between gap-2">
        <div className="text-ui-xs font-medium text-foreground-subtle">{label}</div>
        {(indexTag || accentColor) && (
          <div className="nx-only items-center gap-1.5 font-mono text-[10px] tracking-wider text-foreground-subtlest">
            {accentColor && (
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: accentColor }}
              />
            )}
            {indexTag && <span>{indexTag}</span>}
          </div>
        )}
      </div>
      <div className="nx-kpi-val font-mono text-ui-lg tabular-nums text-foreground">{value}</div>
      {sub != null && <div className="text-ui-xs text-foreground-subtlest">{sub}</div>}
      {typeof progressPct === 'number' && Number.isFinite(progressPct) && (
        <div className="nx-only-block absolute inset-x-0 bottom-0 h-[2px] bg-hairline">
          <div
            className="h-full transition-[width] duration-300"
            style={{
              width: `${Math.max(4, Math.min(100, Math.round(progressPct)))}%`,
              backgroundColor: accentColor ?? 'var(--nx-signal)'
            }}
          />
        </div>
      )}
    </div>
  )
}

export function ChartCard({
  title,
  actions,
  legend,
  children,
  className
}: {
  title: string
  actions?: ReactNode
  legend?: ReactNode
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <section
      className={`nx-card-elevated nx-spotlight-chart flex flex-col gap-3 rounded-xl bg-surface p-4 ${className ?? ''}`}
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-ui-base font-medium text-foreground">{title}</h2>
        {actions}
      </header>
      {legend != null && (
        <div className="flex flex-wrap gap-x-3 gap-y-2">{legend}</div>
      )}
      {children}
    </section>
  )
}

export function LegendItem({ color, label }: { color: string; label: string }): JSX.Element {
  return (
    <span className="flex items-center gap-1.5 text-ui-sm text-foreground-subtle">
      <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </span>
  )
}

export function PillSwitcher<T extends string>({
  options,
  value,
  onChange
}: {
  options: Array<{ key: T; label: string }>
  value: T
  onChange: (v: T) => void
}): JSX.Element {
  return (
    <div className="relative isolate flex h-7 items-center rounded-full bg-surface p-0.5">
      <SlidingTabIndicator activeSelector='button[data-active="true"]' />
      {options.map((o) => {
        const active = value === o.key
        return (
          <button
            key={o.key}
            type="button"
            data-active={active ? 'true' : undefined}
            onClick={() => onChange(o.key)}
            className={`relative z-10 h-6 cursor-pointer rounded-full px-2.5 text-ui-sm transition-colors duration-150 ${
              active ? 'font-medium text-foreground' : 'text-foreground-subtle hover:text-foreground'
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function EmptyState({ title, description }: { title: string; description: string }): JSX.Element {
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center">
      <div className="text-ui-base font-medium text-foreground">{title}</div>
      <div className="mt-1 text-ui-sm text-foreground-subtle">{description}</div>
    </div>
  )
}

export function IconButton({
  title,
  onClick,
  children,
  spinning,
  style
}: {
  title: string
  onClick: () => void
  children: ReactNode
  spinning?: boolean
  style?: CSSProperties
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={style}
      className="flex size-7 items-center justify-center rounded-lg text-foreground-subtle transition-colors duration-150 hover:bg-hover hover:text-foreground"
    >
      <span className={spinning ? 'nx-spin' : undefined}>{children}</span>
    </button>
  )
}

export interface NexusSelectOption<T extends string | number> {
  value: T
  label: string
}

/** 站内 DOM 下拉选择器（替代原生 <select>，杜绝 OS 弹窗偷焦点与系统光标闪烁） */
export function NexusSelect<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
  className = 'h-7 w-full text-ui-base'
}: {
  value: T
  options: NexusSelectOption<T>[]
  onChange: (value: T) => void
  ariaLabel?: string
  className?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ left: number; top?: number; bottom?: number; width: number }>({
    left: 0,
    top: 0,
    width: 120
  })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const currentLabel = options.find((o) => o.value === value)?.label ?? String(value)

  const reposition = (): void => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const estimatedH = Math.min(options.length * 30 + 10, 220)
    const spaceBelow = window.innerHeight - rect.bottom - 8
    const openUp = spaceBelow < estimatedH && rect.top > spaceBelow
    const width = Math.max(rect.width, 96)
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8)
    setMenuPos(
      openUp
        ? { left, bottom: window.innerHeight - rect.top + 4, width }
        : { left, top: rect.bottom + 4, width }
    )
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node | null
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onScroll = (e: Event): void => {
      const target = e.target as Node | null
      if (menuRef.current && target && menuRef.current.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    const onResize = (): void => setOpen(false)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (!open) {
        reposition()
        setOpen(true)
        return
      }
      const idx = options.findIndex((o) => o.value === value)
      if (e.key === 'ArrowDown') {
        onChange(options[(idx + 1) % options.length].value)
      } else if (e.key === 'ArrowUp') {
        onChange(options[(idx - 1 + options.length) % options.length].value)
      } else {
        setOpen(false)
      }
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => {
          if (!open) reposition()
          setOpen((v) => !v)
        }}
        onKeyDown={handleKeyDown}
        className={`flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-border bg-card px-2 text-left text-foreground transition-colors hover:border-border-hover ${className}`}
      >
        <span className="min-w-0 truncate">{currentLabel}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden
          className={`shrink-0 text-foreground-subtlest transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        >
          <path d="M3 4.5 6 7.5l3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            data-no-drag=""
            style={{
              position: 'fixed',
              left: `${menuPos.left}px`,
              top: menuPos.top !== undefined ? `${menuPos.top}px` : undefined,
              bottom: menuPos.bottom !== undefined ? `${menuPos.bottom}px` : undefined,
              width: `${menuPos.width}px`,
              zIndex: 140
            }}
            className="nx-fade-in nx-card-elevated max-h-56 overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-xl"
          >
            {options.map((opt) => {
              const selected = opt.value === value
              return (
                <button
                  key={String(opt.value)}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onChange(opt.value)
                    setOpen(false)
                    triggerRef.current?.focus()
                  }}
                  className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-ui-xs transition-colors ${
                    selected
                      ? 'bg-selected font-medium text-foreground'
                      : 'text-foreground-subtle hover:bg-hover hover:text-foreground'
                  }`}
                >
                  <span className="truncate">{opt.label}</span>
                  {selected && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal" />
                  )}
                </button>
              )
            })}
          </div>,
          document.body
        )}
    </>
  )
}

// ── 图标（16px 线性，stroke currentColor）──
export function RefreshIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v2.8h-2.8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function SunIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function MoonIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function GearIcon(): JSX.Element {
  // 真齿轮（齿圈+中孔），与 SunIcon 的"圆+射线"明显区分（用户反馈两者曾难以分辨）
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="2" />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function ExportIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 2v8m0 0 3-3m-3 3L5 7M2.5 11v1.5A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5V11"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 时间范围选项（label 渲染期由 t(`range.${key}`) 生成；昨日置于今日左侧，PO 指定） */
export const RANGE_OPTIONS: Array<{ key: RangeKey }> = [
  { key: 'yesterday' },
  { key: 'today' },
  { key: '7d' },
  { key: '30d' },
  { key: 'month' },
  { key: 'year' },
  { key: 'all' }
]
