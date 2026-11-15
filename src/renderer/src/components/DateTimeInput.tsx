// 站内 DOM 日期时间选择器（替代原生 <input type="datetime-local">，
// 避免 Chromium Shadow DOM 图标及原生系统日历弹窗触发系统光标闪烁）。

import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { createPortal } from 'react-dom'
import { getLang, useLang } from '../i18n'

const PAD2 = (n: number): string => String(n).padStart(2, '0')

function parseDateTimeParts(raw: string): {
  dateStr: string
  timeStr: string
  year: number
  month: number
  day: number
  hour: number
  minute: number
} {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(raw.trim())
  const now = new Date()
  if (!m) {
    const y = now.getFullYear()
    const mo = now.getMonth() + 1
    const d = now.getDate()
    return {
      dateStr: `${y}-${PAD2(mo)}-${PAD2(d)}`,
      timeStr: '00:00',
      year: y,
      month: mo,
      day: d,
      hour: 0,
      minute: 0
    }
  }
  const year = Number(m[1])
  const month = Math.min(12, Math.max(1, Number(m[2])))
  const day = Math.min(31, Math.max(1, Number(m[3])))
  const hour = Math.min(23, Math.max(0, Number(m[4])))
  const minute = Math.min(59, Math.max(0, Number(m[5])))
  return {
    dateStr: `${m[1]}-${m[2]}-${m[3]}`,
    timeStr: `${m[4]}:${m[5]}`,
    year,
    month,
    day,
    hour,
    minute
  }
}

function buildIsoLocal(year: number, month: number, day: number, hour: number, minute: number): string {
  const maxDay = new Date(year, month, 0).getDate()
  const safeDay = Math.min(Math.max(1, day), maxDay)
  return `${String(year).padStart(4, '0')}-${PAD2(month)}-${PAD2(safeDay)}T${PAD2(hour)}:${PAD2(minute)}`
}

export function DateTimeInput({
  value,
  onChange,
  ariaLabel
}: {
  value: string
  onChange: (next: string) => void
  ariaLabel?: string
}): JSX.Element {
  useLang()
  const parts = useMemo(() => parseDateTimeParts(value), [value])
  const [dateDraft, setDateDraft] = useState(parts.dateStr)
  const [timeDraft, setTimeDraft] = useState(parts.timeStr)
  const [open, setOpen] = useState(false)
  const [viewYear, setViewYear] = useState(parts.year)
  const [viewMonth, setViewMonth] = useState(parts.month)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 })

  const boxRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setDateDraft(parts.dateStr)
    setTimeDraft(parts.timeStr)
  }, [parts.dateStr, parts.timeStr])

  const commitDateDraft = (raw: string): void => {
    const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(raw.trim())
    if (!m) {
      setDateDraft(parts.dateStr)
      return
    }
    const y = Math.min(2099, Math.max(2000, Number(m[1])))
    const mo = Math.min(12, Math.max(1, Number(m[2])))
    const d = Math.min(31, Math.max(1, Number(m[3])))
    const next = buildIsoLocal(y, mo, d, parts.hour, parts.minute)
    onChange(next)
  }

  const commitTimeDraft = (raw: string): void => {
    const m = /^(\d{1,2}):(\d{1,2})$/.exec(raw.trim())
    if (!m) {
      setTimeDraft(parts.timeStr)
      return
    }
    const hh = Math.min(23, Math.max(0, Number(m[1])))
    const mm = Math.min(59, Math.max(0, Number(m[2])))
    onChange(buildIsoLocal(parts.year, parts.month, parts.day, hh, mm))
  }

  const openPopover = (): void => {
    if (boxRef.current) {
      const r = boxRef.current.getBoundingClientRect()
      const popW = 248
      const popH = 264
      const left = Math.min(Math.max(8, r.right - popW), window.innerWidth - popW - 8)
      const top =
        window.innerHeight - r.bottom >= popH + 12
          ? r.bottom + 6
          : Math.max(8, r.top - popH - 6)
      setPos({ left, top })
    }
    setViewYear(parts.year)
    setViewMonth(parts.month)
    setOpen((v) => !v)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      const tNode = e.target as Node | null
      if (boxRef.current?.contains(tNode) || popRef.current?.contains(tNode)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onScroll = (e: Event): void => {
      const tNode = e.target as Node | null
      if (popRef.current && tNode && popRef.current.contains(tNode)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  const locale = getLang() === 'en' ? 'en-US' : 'zh-CN'
  const monthLabel = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short' }).format(
    new Date(viewYear, viewMonth - 1, 1)
  )

  const calendarDays = useMemo(() => {
    const firstWeekday = new Date(viewYear, viewMonth - 1, 1).getDay()
    const totalDays = new Date(viewYear, viewMonth, 0).getDate()
    const cells: Array<number | null> = []
    for (let i = 0; i < firstWeekday; i += 1) cells.push(null)
    for (let d = 1; d <= totalDays; d += 1) cells.push(d)
    return cells
  }, [viewYear, viewMonth])

  const shiftMonth = (delta: number): void => {
    const next = new Date(viewYear, viewMonth - 1 + delta, 1)
    setViewYear(next.getFullYear())
    setViewMonth(next.getMonth() + 1)
  }

  const weekdays = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: 'narrow' })
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 7 + i)))
  }, [locale])

  return (
    <div
      ref={boxRef}
      aria-label={ariaLabel}
      className="flex h-8 w-full items-center gap-1 rounded-lg border border-border bg-card px-2 font-mono text-ui-sm text-foreground"
    >
      <input
        type="text"
        value={dateDraft}
        maxLength={10}
        aria-label={ariaLabel ? `${ariaLabel} date` : 'date'}
        onChange={(e) => {
          setDateDraft(e.target.value)
          if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) commitDateDraft(e.target.value)
        }}
        onBlur={() => commitDateDraft(dateDraft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitDateDraft(dateDraft)
        }}
        className="min-w-0 flex-1 bg-transparent font-mono text-ui-sm text-foreground focus:outline-none"
      />
      <span className="select-none text-foreground-subtlest">·</span>
      <input
        type="text"
        value={timeDraft}
        maxLength={5}
        aria-label={ariaLabel ? `${ariaLabel} time` : 'time'}
        onChange={(e) => {
          setTimeDraft(e.target.value)
          if (/^\d{2}:\d{2}$/.test(e.target.value)) commitTimeDraft(e.target.value)
        }}
        onBlur={() => commitTimeDraft(timeDraft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitTimeDraft(timeDraft)
        }}
        className="w-12 bg-transparent text-center font-mono text-ui-sm text-foreground focus:outline-none"
      />
      <button
        type="button"
        aria-expanded={open}
        onClick={openPopover}
        className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
          <rect x="2" y="3" width="12" height="11" rx="1.8" stroke="currentColor" strokeWidth="1.3" />
          <path d="M2 6.5h12M5.5 1.8v2.4M10.5 1.8v2.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </button>

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popRef}
            data-no-drag=""
            style={{ position: 'fixed', left: `${pos.left}px`, top: `${pos.top}px`, width: 248, zIndex: 150 }}
            className="nx-popover nx-fade-in nx-card-elevated rounded-xl border border-border bg-card p-3 shadow-2xl"
          >
            <div className="mb-2 flex items-center justify-between gap-1">
              <button
                type="button"
                onClick={() => shiftMonth(-1)}
                className="flex size-6 cursor-pointer items-center justify-center rounded-md text-foreground-subtle hover:bg-hover hover:text-foreground"
              >
                ‹
              </button>
              <span className="text-ui-xs font-medium text-foreground">{monthLabel}</span>
              <button
                type="button"
                onClick={() => shiftMonth(1)}
                className="flex size-6 cursor-pointer items-center justify-center rounded-md text-foreground-subtle hover:bg-hover hover:text-foreground"
              >
                ›
              </button>
            </div>
            <div className="mb-1 grid grid-cols-7 text-center text-[11px] text-foreground-subtlest">
              {weekdays.map((w, idx) => (
                <span key={idx}>{w}</span>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-0.5 text-center">
              {calendarDays.map((day, idx) => {
                if (day === null) return <span key={`e-${idx}`} />
                const selected =
                  parts.year === viewYear && parts.month === viewMonth && parts.day === day
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => {
                      onChange(buildIsoLocal(viewYear, viewMonth, day, parts.hour, parts.minute))
                      setOpen(false)
                    }}
                    className={`h-6 cursor-pointer rounded text-[11px] tabular-nums transition-colors ${
                      selected
                        ? 'bg-signal font-medium text-white'
                        : 'text-foreground-subtle hover:bg-hover hover:text-foreground'
                    }`}
                  >
                    {day}
                  </button>
                )
              })}
            </div>
            <div className="mt-2 flex items-center justify-between gap-1 border-t border-hairline pt-2 text-[11px]">
              <button
                type="button"
                onClick={() => onChange(buildIsoLocal(parts.year, parts.month, parts.day, 0, 0))}
                className="cursor-pointer rounded bg-surface px-2 py-0.5 font-mono text-foreground-subtle hover:bg-hover hover:text-foreground"
              >
                00:00
              </button>
              <button
                type="button"
                onClick={() => {
                  const d = new Date()
                  onChange(buildIsoLocal(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()))
                }}
                className="cursor-pointer rounded bg-surface px-2 py-0.5 text-foreground-subtle hover:bg-hover hover:text-foreground"
              >
                {locale === 'en-US' ? 'Now' : '此刻'}
              </button>
              <button
                type="button"
                onClick={() => onChange(buildIsoLocal(parts.year, parts.month, parts.day, 23, 59))}
                className="cursor-pointer rounded bg-surface px-2 py-0.5 font-mono text-foreground-subtle hover:bg-hover hover:text-foreground"
              >
                23:59
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
