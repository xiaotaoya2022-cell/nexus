// 用量预算与异常突增告警监控：
// 在本地同步或远程 Mesh 上报后评估今日花费预算（USD）与近 10 分钟 Token 暴涨阈值，
// 通过冷却时间窗口防抖，避免 60s 轮询反复弹出重复通知。

import { DEFAULT_APP_PREFERENCES, type AppAlertEvent, type AppPreferences } from '@shared/types'
import { TOTAL_EXPR, type NexusStore } from '../aggregator/infrastructure/store'
import type { QueryService } from '../aggregator/application/query-service'

export function normalizeAppPreferences(raw: unknown): AppPreferences {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const closeToTray =
    typeof obj.closeToTray === 'boolean' ? obj.closeToTray : DEFAULT_APP_PREFERENCES.closeToTray
  const budget = Number(obj.budgetDailyUsd)
  const spike = Number(obj.spikeTokens10m)
  return {
    closeToTray,
    budgetDailyUsd: Number.isFinite(budget) && budget > 0 ? Math.min(100_000, Number(budget.toFixed(2))) : 0,
    spikeTokens10m: Number.isFinite(spike) && spike > 0 ? Math.min(1e12, Math.round(spike)) : 0
  }
}

export function getAppPreferences(store: NexusStore): AppPreferences {
  const raw = store.getSetting('appPreferences')
  if (!raw) return { ...DEFAULT_APP_PREFERENCES }
  try {
    return normalizeAppPreferences(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_APP_PREFERENCES }
  }
}

export function setAppPreferences(
  store: NexusStore,
  patch: Partial<AppPreferences>
): AppPreferences {
  const merged = normalizeAppPreferences({ ...getAppPreferences(store), ...patch })
  store.setSetting('appPreferences', JSON.stringify(merged))
  return merged
}

function localDayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export class UsageAlertMonitor {
  private lastBudgetDay: string | null = null
  private lastBudgetThreshold = 0
  private lastSpikeAlertAt = 0

  constructor(
    private readonly store: NexusStore,
    private readonly query: QueryService,
    private readonly onAlert: (event: AppAlertEvent) => void
  ) {}

  evaluate(now = Date.now()): void {
    const prefs = getAppPreferences(this.store)
    if (prefs.budgetDailyUsd > 0) {
      const todayKey = localDayKey(now)
      const shouldReset =
        this.lastBudgetDay !== todayKey || prefs.budgetDailyUsd < this.lastBudgetThreshold
      if (shouldReset) {
        const overview = this.query.getOverview('today', null, now, null)
        const spent = overview.totals.estimatedCostUsd
        if (spent >= prefs.budgetDailyUsd) {
          this.lastBudgetDay = todayKey
          this.lastBudgetThreshold = prefs.budgetDailyUsd
          this.onAlert({
            id: `budget-${todayKey}-${Math.round(spent * 100)}`,
            kind: 'budget',
            title: 'Nexus 今日花费预算预警',
            body: `今日估算费用 $${spent.toFixed(2)} 已达到预算上限 $${prefs.budgetDailyUsd.toFixed(2)}`,
            ts: now
          })
        }
      }
    }

    if (prefs.spikeTokens10m > 0 && now - this.lastSpikeAlertAt >= 30 * 60_000) {
      const row = this.store.db
        .prepare(
          `SELECT COALESCE(SUM(${TOTAL_EXPR}), 0) t FROM usage_records WHERE ts >= ? AND ts <= ?`
        )
        .get(now - 10 * 60_000, now) as { t?: number } | undefined
      const recentTokens = Number(row?.t) || 0
      if (recentTokens >= prefs.spikeTokens10m) {
        this.lastSpikeAlertAt = now
        const m = (recentTokens / 1e6).toFixed(1)
        const tm = (prefs.spikeTokens10m / 1e6).toFixed(1)
        this.onAlert({
          id: `spike-${now}`,
          kind: 'spike',
          title: 'Nexus 10 分钟 Token 异常突增',
          body: `近 10 分钟消耗达 ${m}M tokens（阈值 ${tm}M），请检查 Agent 是否存在死循环调用`,
          ts: now
        })
      }
    }
  }
}
