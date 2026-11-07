// 顶栏系统状态：一行微型指标（CPU/内存/网速），点击弹出完整详情。
// 取代原主看板 SystemCard（用户要求：系统状态只在标题栏）。

import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { SystemSnapshotLike } from '@shared/protocol'
import { nexus } from '../lib/api'
import { compactNumber } from '../lib/format'
import { t, useLang } from '../i18n'

function fmtRate(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)}MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`
  return `${Math.round(n)}B`
}

function bar(percent: number | null): JSX.Element {
  const clamped = percent != null ? Math.max(0, Math.min(100, percent)) : 0
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-surface">
      <div
        className="h-full rounded-full bg-chart-1 transition-[width] duration-200"
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}

export function SystemPill(): JSX.Element {
  useLang() // 语言切换时重渲染
  const [snap, setSnap] = useState<SystemSnapshotLike | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let alive = true
    const tick = (): void => {
      void nexus.getSystemSnapshot().then((s) => {
        if (alive) setSnap(s)
      })
    }
    tick()
    const t = setInterval(tick, 3000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const gpu = snap?.gpus[0]
  const mainDisk = snap?.disks.filter((d) => d.mount.match(/^[C-F]:$/i))[0] ?? snap?.disks[0]

  return (
    <div className="relative">
      <button
        type="button"
        title={t('system.detail')}
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 items-center gap-2 rounded-full bg-surface px-3 font-mono text-ui-xs tabular-nums text-foreground-subtle transition-colors duration-150 hover:text-foreground"
      >
        {snap == null ? (
          <span>{t('system.collecting')}</span>
        ) : (
          <>
            <span title="CPU">CPU {snap.cpu.loadPercent}%</span>
            <span className="text-hairline">|</span>
            <span title={t('system.memory')}>{t('system.memoryPct', { pct: snap.memory.usedPercent })}</span>
            <span className="text-hairline">|</span>
            <span title={t('system.netRate')}>
              ↓{fmtRate(snap.network.rxBytesPerSec)} ↑{fmtRate(snap.network.txBytesPerSec)}
            </span>
          </>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="nx-fade-in absolute right-0 top-9 z-20 w-96 rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex items-baseline justify-between">
              <span className="text-ui-base font-medium">{t('system.title')}</span>
              <span className="font-mono text-ui-xs tabular-nums text-foreground-subtlest">
                {snap ? t('system.uptime', { h: Math.floor(snap.uptimeSec / 3600) }) : t('system.collecting')}
              </span>
            </div>
            {snap == null ? (
              <div className="py-6 text-center text-ui-sm text-foreground-subtle">{t('system.waiting')}</div>
            ) : (
              <div className="grid grid-cols-2 gap-x-5 gap-y-3">
                <div className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-ui-xs text-foreground-subtle">CPU</span>
                    <span className="font-mono text-ui-sm tabular-nums text-foreground">{snap.cpu.loadPercent}%</span>
                  </div>
                  {bar(snap.cpu.loadPercent)}
                </div>
                <div className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-ui-xs text-foreground-subtle">{t('system.memory')}</span>
                    <span className="font-mono text-ui-sm tabular-nums text-foreground">{snap.memory.usedPercent}%</span>
                  </div>
                  {bar(snap.memory.usedPercent)}
                  <span className="font-mono text-ui-xs tabular-nums text-foreground-subtlest">
                    {compactNumber(snap.memory.usedBytes / 1048576)} / {compactNumber(snap.memory.totalBytes / 1048576)} MB
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-ui-xs text-foreground-subtle">GPU</span>
                    <span className="font-mono text-ui-sm tabular-nums text-foreground">
                      {gpu?.utilPercent != null ? `${gpu.utilPercent}%` : '—'}
                    </span>
                  </div>
                  {bar(gpu?.utilPercent ?? null)}
                  {gpu?.memUsedMB != null && (
                    <span className="font-mono text-ui-xs tabular-nums text-foreground-subtlest">
                      {compactNumber(gpu.memUsedMB)} / {gpu.memTotalMB != null ? compactNumber(gpu.memTotalMB) : '?'} MB
                    </span>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-ui-xs text-foreground-subtle">{t('system.network')}</span>
                    <span className="font-mono text-ui-sm tabular-nums text-foreground">
                      ↓{compactNumber(snap.network.rxBytesPerSec)} ↑{compactNumber(snap.network.txBytesPerSec)}
                    </span>
                  </div>
                  {mainDisk && (
                    <span className="font-mono text-ui-xs tabular-nums text-foreground-subtlest">
                      {mainDisk.mount} · {mainDisk.usePercent}%
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
