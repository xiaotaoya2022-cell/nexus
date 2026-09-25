// 账号配额卡：各平台已发现账号的配额窗口（进度条 + 重置时间），支持手动刷新。

import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { AccountQuotaView } from '@shared/quotas'
import { nexus } from '../lib/api'
import { ChartCard, EmptyState, RefreshIcon, IconButton } from './ui'
import { formatTime } from '../lib/format'

function windowBar(label: string, used: number | null, remaining: number | null): JSX.Element {
  const pct = used ?? (remaining != null ? 100 - remaining : null)
  const clamped = pct != null ? Math.max(0, Math.min(100, pct)) : null
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-ui-xs text-foreground-subtle">{label}</span>
        <span className="font-mono text-ui-xs tabular-nums text-foreground">
          {clamped != null ? `${clamped}%` : '—'}
          {remaining != null && !Number.isNaN(remaining) ? ` 剩余 ${Math.round(remaining)}` : ''}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface">
        <div
          className={`h-full rounded-full transition-[width] duration-200 ${
            clamped != null && clamped >= 90 ? 'bg-destructive' : clamped != null && clamped >= 70 ? 'bg-warning' : 'bg-chart-2'
          }`}
          style={{ width: clamped != null ? `${clamped}%` : '0%' }}
        />
      </div>
    </div>
  )
}

function AccountRow({ view }: { view: AccountQuotaView }): JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded-lg px-2 py-1.5 transition-colors duration-150 hover:bg-surface">
      <div className="flex items-center gap-2">
        <span className="text-ui-caption font-medium text-foreground">{view.platformLabel}</span>
        <span className="truncate text-ui-xs text-foreground-subtlest">{view.label}</span>
        {view.planLabel && (
          <span className="h-5 rounded-full border-transparent bg-idle-surface px-2 text-ui-xs font-medium leading-5 text-idle">
            {view.planLabel}
          </span>
        )}
        <span className="flex-1" />
        <span className="font-mono text-ui-xs text-foreground-subtlest">
          {formatTime(view.fetchedAt)} 采集
        </span>
      </div>
      {view.error ? (
        <div className="text-ui-xs text-warning">{view.error}</div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {view.windows.map((w) => (
            <div key={w.label}>
              {windowBar(w.label, w.usedPercent, w.remainingPercent)}
              {w.resetAt != null && (
                <div className="mt-0.5 text-ui-xs text-foreground-subtlest">
                  重置 {formatTime(w.resetAt)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {view.extra?.usageText && (
        <div className="font-mono text-ui-xs text-foreground-subtlest">{view.extra.usageText}</div>
      )}
    </div>
  )
}

export function QuotaCard(): JSX.Element {
  const [accounts, setAccounts] = useState<AccountQuotaView[]>([])
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setAccounts(await nexus.quotaAccounts())
  }, [])

  useEffect(() => {
    void load()
    const unsub = nexus.onQuotaUpdate((views) => setAccounts(views))
    return unsub
  }, [load])

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      setAccounts(await nexus.quotaRefresh())
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <ChartCard
      title="账号配额"
      actions={
        <IconButton title="立即刷新配额" onClick={() => void refresh()} spinning={refreshing}>
          <RefreshIcon />
        </IconButton>
      }
    >
      {accounts.length === 0 ? (
        <EmptyState
          title="尚未发现平台账号"
          description="在设置 → 账号与配额 中登录平台，或先在对应 Agent 内登录（Cursor/Codex CLI 会自动导入）。"
        />
      ) : (
        <div className="flex flex-col divide-y divide-hairline">
          {accounts.map((v) => (
            <AccountRow key={`${v.platform}:${v.accountId}`} view={v} />
          ))}
        </div>
      )}
      <div className="text-ui-xs text-foreground-subtlest">每 5 分钟自动刷新 · 凭据仅在内存使用，不写入 Nexus 数据库</div>
    </ChartCard>
  )
}
