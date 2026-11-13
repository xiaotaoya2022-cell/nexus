// 顶栏多格式导出中心浮层：支持 PNG 看板高清长图、CSV 对账表格、Markdown 摘要报告与原始 JSON 快照。

import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { ExportFormat } from '@shared/types'
import { t, useLang } from '../i18n'
import { ExportIcon } from './ui'

export interface ExportMenuProps {
  scopeLabel: string
  onExport: (format: ExportFormat) => void | Promise<void>
}

interface ExportOption {
  format: ExportFormat
  ext: string
  titleKey: string
  descKey: string
}

const OPTIONS: ExportOption[] = [
  { format: 'png', ext: 'PNG', titleKey: 'export.png.title', descKey: 'export.png.desc' },
  { format: 'csv', ext: 'CSV', titleKey: 'export.csv.title', descKey: 'export.csv.desc' },
  { format: 'markdown', ext: 'MD', titleKey: 'export.md.title', descKey: 'export.md.desc' },
  { format: 'json', ext: 'JSON', titleKey: 'export.json.title', descKey: 'export.json.desc' }
]

export function ExportMenu({ scopeLabel, onExport }: ExportMenuProps): JSX.Element {
  useLang()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  return (
    <div className="relative" data-no-drag="">
      <button
        type="button"
        data-export-trigger=""
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('header.action.exportPng')}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-7 items-center gap-0.5 rounded-lg px-1.5 text-foreground-subtle transition-colors duration-150 hover:bg-hover hover:text-foreground ${
          open ? 'bg-selected text-foreground' : ''
        }`}
      >
        <ExportIcon />
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden className="opacity-70">
          <path d="M2.5 3.75L5 6.25L7.5 3.75" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div
            role="menu"
            data-export-menu=""
            className="nx-fade-in nx-card-elevated absolute right-0 top-9 z-30 w-72 overflow-hidden rounded-xl border border-border bg-card p-1.5"
          >
            <div className="flex items-center justify-between px-2.5 pb-1.5 pt-1 text-[11px] font-medium text-foreground-subtle">
              <span>{t('export.title')}</span>
              <span className="truncate max-w-[160px] text-ui-xs font-normal text-foreground-subtlest" title={scopeLabel}>
                {scopeLabel}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              {OPTIONS.map((opt) => (
                <button
                  key={opt.format}
                  type="button"
                  role="menuitem"
                  data-export-format={opt.format}
                  onClick={() => {
                    setOpen(false)
                    void onExport(opt.format)
                  }}
                  className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 hover:bg-hover"
                >
                  <span className="mt-0.5 inline-flex h-5 w-9 shrink-0 items-center justify-center rounded border border-hairline bg-surface font-mono text-[10px] font-semibold tracking-wider text-signal">
                    {opt.ext}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-ui-sm font-medium text-foreground">{t(opt.titleKey)}</span>
                    <span className="block text-[11px] leading-snug text-foreground-subtlest">
                      {t(opt.descKey)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
