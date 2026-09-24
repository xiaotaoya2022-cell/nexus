// 系统状态卡（PC 看板）：3s 轮询快照，展示 CPU/内存/GPU/磁盘/网络。

import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { SystemSnapshotLike } from '@shared/protocol'
import { nexus } from '../lib/api'
import { compactNumber, fullNumber } from '../lib/format'

function bar(percent: number): JSX.Element {
  const clamped = Math.max(0, Math.min(100, percent))
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface">
      <div
        className="h-full rounded-full bg-chart-1 transition-[width] duration-200"
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}

export function SystemCard(): JSX.Element {
  const [snap, setSnap] = useState<SystemSnapshotLike | null>(null)

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
    <section className="flex flex-col gap-3 rounded-xl bg-surface p-4">
      <header className="flex items-center justify-between">
        <h2 className="text-ui-base font-medium text-foreground">系统状态</h2>
        <span className="font-mono text-ui-xs tabular-nums text-foreground-subtlest">
          {snap ? `运行 ${Math.floor(snap.uptimeSec / 3600)}h` : '采集中…'}
        </span>
      </header>
      {snap == null ? (
        <div className="py-6 text-center text-ui-sm text-foreground-subtle">等待系统采样…</div>
      ) : (
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-4">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-ui-xs text-foreground-subtle">CPU</span>
              <span className="font-mono text-ui-sm tabular-nums text-foreground">{snap.cpu.loadPercent}%</span>
            </div>
            {bar(snap.cpu.loadPercent)}
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-ui-xs text-foreground-subtle">内存</span>
              <span className="font-mono text-ui-sm tabular-nums text-foreground">{snap.memory.usedPercent}%</span>
            </div>
            {bar(snap.memory.usedPercent)}
            <span className="font-mono text-ui-xs tabular-nums text-foreground-subtlest">
              {compactNumber(snap.memory.usedBytes / 1048576)} / {compactNumber(snap.memory.totalBytes / 1048576)} MB
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-ui-xs text-foreground-subtle">GPU</span>
              <span className="font-mono text-ui-sm tabular-nums text-foreground">
                {gpu?.utilPercent != null ? `${gpu.utilPercent}%` : '—'}
              </span>
            </div>
            {gpu?.utilPercent != null ? bar(gpu.utilPercent) : bar(0)}
            {gpu?.memUsedMB != null && (
              <span className="font-mono text-ui-xs tabular-nums text-foreground-subtlest">
                {compactNumber(gpu.memUsedMB)} / {gpu.memTotalMB != null ? compactNumber(gpu.memTotalMB) : '?'} MB
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-ui-xs text-foreground-subtle">网络</span>
              <span className="font-mono text-ui-sm tabular-nums text-foreground">
                ↓{compactNumber(snap.network.rxBytesPerSec)} ↑{compactNumber(snap.network.txBytesPerSec)}
              </span>
            </div>
            {mainDisk && (
              <span className="font-mono text-ui-xs tabular-nums text-foreground-subtlest" title={fullNumber(mainDisk.usedBytes)}>
                {mainDisk.mount} 已用 {mainDisk.usePercent}%
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
