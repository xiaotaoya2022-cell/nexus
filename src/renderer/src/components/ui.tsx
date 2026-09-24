// 基础 UI 组件：状态灯、KPI 卡、图表卡、药丸切换器、空状态、图标。
// 样式遵循《Nexus UI 设计规范草案》§4。

import type { ReactNode } from 'react'
import type { JSX } from 'react'
import type { AgentStatus, RangeKey } from '@shared/types'

export const STATUS_TEXT: Record<AgentStatus, string> = {
  active: '运行中',
  idle: '空闲',
  offline: '离线',
  nodata: '无数据'
}

export function StatusDot({ status }: { status: AgentStatus }): JSX.Element {
  const cls =
    status === 'active'
      ? 'bg-chart-1 nx-breathe'
      : status === 'idle'
        ? 'bg-idle'
        : status === 'offline'
          ? 'bg-border'
          : 'bg-border opacity-60'
  return <span title={STATUS_TEXT[status]} className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${cls}`} />
}

export function KpiCard({
  label,
  value,
  sub
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3">
      <div className="text-ui-xs font-medium text-foreground-subtle">{label}</div>
      <div className="font-mono text-ui-lg tabular-nums text-foreground">{value}</div>
      {sub != null && <div className="text-ui-xs text-foreground-subtlest">{sub}</div>}
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
    <section className={`flex flex-col gap-3 rounded-xl bg-surface p-4 ${className ?? ''}`}>
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
    <div className="flex h-7 items-center rounded-full bg-surface p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={`h-6 rounded-full px-2.5 text-ui-sm transition-colors duration-150 ${
            value === o.key
              ? 'bg-raised font-medium text-foreground'
              : 'text-foreground-subtle hover:text-foreground'
          }`}
        >
          {o.label}
        </button>
      ))}
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
  spinning
}: {
  title: string
  onClick: () => void
  children: ReactNode
  spinning?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-lg text-foreground-subtle transition-colors duration-150 hover:bg-hover hover:text-foreground"
    >
      <span className={spinning ? 'nx-spin' : undefined}>{children}</span>
    </button>
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

export const RANGE_OPTIONS: Array<{ key: RangeKey; label: string }> = [
  { key: 'today', label: '今日' },
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
  { key: 'month', label: '本月' },
  { key: 'year', label: '今年' },
  { key: 'all', label: '全部' }
]
