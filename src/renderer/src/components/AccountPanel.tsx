// 账号面板：顶栏按钮弹出（用户设计定稿：账号信息不入主看板）。
// 内容：各平台账号（配额窗口 + DeepSeek 官方账单的余额/累计消费/近30天逐日趋势）
// + 应用内登录/登出/刷新 + 告警阈值。取代原 QuotaCard 与设置面板的「账号与配额」区。

import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { AccountQuotaView, AccountUsagePoint, PlatformMetaView } from '@shared/quotas'
import type { EChartsOption } from 'echarts'
import { nexus } from '../lib/api'
import { EChart } from '../charts/EChart'
import { chartTokens, colorForIndex } from '../charts/options'
import { compactNumber, formatTime, fullNumber } from '../lib/format'
import { IconButton, RefreshIcon } from './ui'

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

/** 账号每日用量小图：tokens 口径画 token 柱，credits 口径（tokens=0）画 credit 柱 */
function UsageMiniChart({ points }: { points: AccountUsagePoint[] }): JSX.Element | null {
  const tokens = chartTokens()
  if (points.length === 0) return null
  const tokenSum = points.reduce((a, p) => a + p.tokens, 0)
  const creditMode = tokenSum === 0
  const filled = points.map((p) => ({
    bucket: p.day,
    total: creditMode ? p.costAmount : p.tokens
  }))
  const option: EChartsOption = {
    animationDuration: 200,
    grid: { top: 6, right: 8, left: 8, bottom: 0, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(128,128,128,0.08)' } },
      valueFormatter: (v) =>
        creditMode ? `${Number(v).toFixed(2)} credits` : fullNumber(Number(v))
    },
    xAxis: {
      type: 'category',
      data: filled.map((p) => p.bucket.slice(5)),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: tokens.fgSubtlest, fontSize: 9, hideOverlap: true }
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: tokens.fgSubtlest, fontSize: 9, formatter: (v: number) => compactNumber(v), hideOverlap: true },
      splitLine: { lineStyle: { color: tokens.hairline, type: 'dashed' } }
    },
    series: [
      {
        type: 'bar',
        data: filled.map((p) => p.total),
        itemStyle: { color: colorForIndex(tokens, 0), borderRadius: 2 },
        barMaxWidth: 10,
        tooltip: {
          valueFormatter: (v) => (creditMode ? `${Number(v).toFixed(2)} credits` : `${fullNumber(Number(v))} tokens`)
        }
      }
    ]
  }
  return <EChart option={option} className="h-24 w-full" />
}

function AccountRow({ view, onLogout }: { view: AccountQuotaView; onLogout: () => void }): JSX.Element {
  const [usage, setUsage] = useState<AccountUsagePoint[] | null>(null)
  const hasOfficialUsage = view.extra?.usage30Tokens != null

  useEffect(() => {
    // 所有账号都尝试拉逐日账单（DeepSeek=tokens/花费，CodeBuddy/WorkBuddy=credits）
    let alive = true
    void nexus.getAccountUsage(view.platform, view.accountId, 30).then((rows) => {
      if (alive) setUsage(rows)
    })
    return () => {
      alive = false
    }
  }, [hasOfficialUsage, view.platform, view.accountId])

  const creditSum =
    usage?.reduce((a, p) => a + (p.currency === 'CRED' ? p.costAmount : 0), 0) ?? 0
  const creditRequests = usage?.reduce((a, p) => a + (p.currency === 'CRED' ? p.requests : 0), 0) ?? 0

  return (
    <div className="flex flex-col gap-2 rounded-lg px-2 py-2 transition-colors duration-150 hover:bg-surface">
      <div className="flex items-center gap-2">
        <span className="text-ui-caption font-medium text-foreground">{view.platformLabel}</span>
        <span className="truncate text-ui-xs text-foreground-subtlest">{view.label}</span>
        {view.planLabel && (
          <span className="h-5 rounded-full border border-border bg-surface px-2 text-ui-xs font-medium leading-5 text-foreground-subtle">
            {view.planLabel}
          </span>
        )}
        <span className="flex-1" />
        <span className="font-mono text-ui-xs text-foreground-subtlest">{formatTime(view.fetchedAt)} 采集</span>
        {view.source === 'oauth' && (
          <button
            type="button"
            onClick={onLogout}
            className="rounded-md px-1.5 py-0.5 text-ui-xs text-foreground-subtle transition-colors duration-150 hover:bg-hover hover:text-foreground"
          >
            登出
          </button>
        )}
      </div>

      {/* 官方账单口径（DeepSeek 开放平台）：余额/累计消费/近30天 */}
      {view.extra?.totalCostText != null && (
        <div className="grid grid-cols-3 gap-2 rounded-lg border border-hairline bg-surface px-3 py-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-ui-xs text-foreground-subtle">累计消费（官方）</span>
            <span className="font-mono text-ui-base tabular-nums text-foreground">{view.extra.totalCostText}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-ui-xs text-foreground-subtle">余额</span>
            <span className="font-mono text-ui-base tabular-nums text-foreground">
              {view.extra.balanceText}
              {view.extra.usdBalanceText && view.extra.usdBalanceText !== '$0.00' ? ` + ${view.extra.usdBalanceText}` : ''}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-ui-xs text-foreground-subtle">近 30 天</span>
            <span className="font-mono text-ui-base tabular-nums text-foreground" title={`${view.extra.usage30Requests ?? 0} 次请求`}>
              {compactNumber(Number(view.extra.usage30Tokens ?? 0))} tk · {view.extra.usage30CostText ?? '—'}
            </span>
          </div>
        </div>
      )}

      {view.error ? (
        <div className="text-ui-xs text-warning">{view.error}</div>
      ) : (
        view.windows.length > 0 && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {view.windows.map((w) => (
              <div key={w.label}>
                {windowBar(w.label, w.usedPercent, w.remainingPercent)}
                {w.resetAt != null && (
                  <div className="mt-0.5 text-ui-xs text-foreground-subtlest">重置 {formatTime(w.resetAt)}</div>
                )}
              </div>
            ))}
          </div>
        )
      )}
      {view.extra?.usageText && (
        <div className="font-mono text-ui-xs text-foreground-subtlest">{view.extra.usageText}</div>
      )}
      {/* credits 口径（CodeBuddy/WorkBuddy 云端账单）：无官方 usage 块时单独给一行汇总 */}
      {hasOfficialUsage !== true && creditRequests > 0 && (
        <div className="flex items-baseline justify-between rounded-lg border border-hairline bg-surface px-3 py-1.5">
          <span className="text-ui-xs text-foreground-subtle">近 30 天消耗（云端账单）</span>
          <span className="font-mono text-ui-sm tabular-nums text-foreground">
            {creditRequests} 次请求 · {creditSum.toFixed(2)} credits
          </span>
        </div>
      )}
      {usage != null && usage.length > 0 && <UsageMiniChart points={usage} />}
    </div>
  )
}

export function AccountPanel(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [platforms, setPlatforms] = useState<PlatformMetaView[]>([])
  const [accounts, setAccounts] = useState<AccountQuotaView[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [loggingIn, setLoggingIn] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const [ps, accs] = await Promise.all([nexus.quotaPlatforms(), nexus.quotaAccounts()])
    setPlatforms(ps)
    setAccounts(accs)
  }, [])

  useEffect(() => {
    if (!open) return
    void load()
    return nexus.onQuotaUpdate((views) => setAccounts(views))
  }, [open, load])

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      setAccounts(await nexus.quotaRefresh())
    } finally {
      setRefreshing(false)
    }
  }

  const login = async (platformId: string, label: string, mode: 'normal' | 'incognito'): Promise<void> => {
    setLoggingIn(platformId)
    setError(null)
    try {
      await nexus.quotaLogin(platformId, mode)
      await load()
    } catch (err) {
      setError(`${label} 登录失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoggingIn(null)
    }
  }

  return (
    <div className="relative">
      <IconButton title="账号与配额" onClick={() => setOpen((v) => !v)}>
        <WalletIcon />
      </IconButton>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="nx-fade-in absolute right-0 top-9 z-20 w-[30rem] rounded-xl border border-border bg-card p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-ui-base font-medium">账号与配额</span>
              <IconButton title="立即刷新" onClick={() => void refresh()} spinning={refreshing}>
                <RefreshIcon />
              </IconButton>
            </div>

            {/* 平台登录入口：普通（系统浏览器）+ 无痕（应用内独立窗口）两种方式 */}
            <div className="mb-2 flex flex-wrap gap-1.5">
              {platforms.map((p) => {
                const logged = accounts.some((a) => a.platform === p.id)
                return p.oauthSupported ? (
                  <span key={p.id} className="inline-flex h-6 items-center overflow-hidden rounded-full border border-border">
                    <button
                      type="button"
                      disabled={loggingIn !== null}
                      onClick={() => void login(p.id, p.label, 'normal')}
                      className={`h-6 px-2 text-ui-xs transition-colors duration-150 ${
                        logged
                          ? 'bg-surface text-foreground-subtle'
                          : 'bg-secondary text-foreground hover:bg-surface-hover'
                      }`}
                    >
                      {loggingIn === p.id ? `${p.label} 登录中…` : logged ? `${p.label} · 已登录` : `登录 ${p.label}`}
                    </button>
                    <button
                      type="button"
                      disabled={loggingIn !== null}
                      title="无痕登录：应用内独立窗口，不影响浏览器已登录态，可登录第二个账号"
                      onClick={() => void login(p.id, p.label, 'incognito')}
                      className="h-6 border-l border-border bg-surface px-1.5 text-ui-xs text-foreground-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-foreground"
                    >
                      无痕
                    </button>
                  </span>
                ) : null
              })}
            </div>
            {error && <div className="mb-2 text-ui-xs text-warning">{error}</div>}

            {accounts.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-ui-sm text-foreground-subtle">
                尚未发现平台账号。点击上方平台按钮登录（Cursor / Codex CLI 本机登录态会自动导入）。
              </div>
            ) : (
              <div className="flex max-h-[26rem] flex-col divide-y divide-hairline overflow-y-auto">
                {accounts.map((v) => (
                  <AccountRow
                    key={`${v.platform}:${v.accountId}`}
                    view={v}
                    onLogout={() => {
                      void nexus.quotaLogout(v.platform, v.accountId).then(load)
                    }}
                  />
                ))}
              </div>
            )}
            <div className="mt-2 text-ui-xs text-foreground-subtlest">
              DeepSeek 为官方账单口径（累计消费/余额/逐日用量，每 5 分钟刷新）；其余平台为配额窗口。凭据仅在内存使用，不写入 Nexus 数据库。
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export function WalletIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.8" y="3.5" width="12.4" height="9" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M1.8 6.5h12.4" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11.4" cy="9.8" r="1" fill="currentColor" />
    </svg>
  )
}
