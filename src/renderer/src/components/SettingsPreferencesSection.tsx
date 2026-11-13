// 设置抽屉扩展分区：系统托盘驻留、每日预算/10分钟突增预警、模型定价校准与币种切换。

import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import {
  DEFAULT_APP_PREFERENCES,
  DEFAULT_PRICING_CONFIG,
  type CurrencyCode,
  type PricingConfig,
  type PricingOverride,
  type PricingOverrideMode
} from '@shared/types'
import { t, useLang } from '../i18n'
import { nexus } from '../lib/api'
import { useUi } from '../store'
import { SlidingTabIndicator } from './SmoothHighlight'
import { NexusSelect } from './ui'

export function SettingsPreferencesSection({
  onToast
}: {
  onToast: (msg: string) => void
}): JSX.Element {
  useLang()
  const storePricing = useUi((s) => s.pricingConfig)
  const setStorePricing = useUi((s) => s.setPricingConfig)

  const [closeToTray, setCloseToTray] = useState(DEFAULT_APP_PREFERENCES.closeToTray)
  const [budgetStr, setBudgetStr] = useState('0')
  const [spikeMStr, setSpikeMStr] = useState('0')

  const [pricingDraft, setPricingDraft] = useState<PricingConfig>(storePricing ?? DEFAULT_PRICING_CONFIG)

  useEffect(() => {
    void nexus.getAppPreferences().then((p) => {
      setCloseToTray(p.closeToTray)
      setBudgetStr(String(p.budgetDailyUsd))
      setSpikeMStr(p.spikeTokens10m > 0 ? String(Number((p.spikeTokens10m / 1e6).toFixed(2))) : '0')
    })
    void nexus.getPricingConfig().then((cfg) => {
      setPricingDraft(cfg)
      setStorePricing(cfg, false)
    })
  }, [setStorePricing])

  const persistPrefs = async (
    nextTray = closeToTray,
    nextBudgetStr = budgetStr,
    nextSpikeMStr = spikeMStr,
    silent = false
  ): Promise<void> => {
    const budget = Math.max(0, Number(nextBudgetStr) || 0)
    const spikeM = Math.max(0, Number(nextSpikeMStr) || 0)
    const saved = await nexus.setAppPreferences({
      closeToTray: nextTray,
      budgetDailyUsd: budget,
      spikeTokens10m: Math.round(spikeM * 1e6)
    })
    setCloseToTray(saved.closeToTray)
    setBudgetStr(String(saved.budgetDailyUsd))
    setSpikeMStr(saved.spikeTokens10m > 0 ? String(Number((saved.spikeTokens10m / 1e6).toFixed(2))) : '0')
    if (!silent) onToast(t('settings.alerts.saved'))
  }

  const persistPricing = async (cfg: PricingConfig): Promise<void> => {
    const saved = await nexus.setPricingConfig(cfg)
    setPricingDraft(saved)
    setStorePricing(saved, true)
    onToast(t('settings.pricing.saved'))
  }

  const switchCurrency = (currency: CurrencyCode): void => {
    const next = { ...pricingDraft, currency }
    setPricingDraft(next)
    void persistPricing(next)
  }

  const addOverride = (presetLocal = false): void => {
    const rule: PricingOverride = presetLocal
      ? {
          id: `ov_${Date.now()}`,
          pattern: 'ollama|local|lmstudio|vllm',
          mode: 'free'
        }
      : {
          id: `ov_${Date.now()}`,
          pattern: '',
          mode: 'multiplier',
          multiplier: 0.5
        }
    setPricingDraft((prev) => ({ ...prev, overrides: [...prev.overrides, rule] }))
  }

  const updateOverride = (id: string, patch: Partial<PricingOverride>): void => {
    setPricingDraft((prev) => ({
      ...prev,
      overrides: prev.overrides.map((o) => (o.id === id ? { ...o, ...patch } : o))
    }))
  }

  const removeOverride = (id: string): void => {
    setPricingDraft((prev) => ({
      ...prev,
      overrides: prev.overrides.filter((o) => o.id !== id)
    }))
  }

  return (
    <>
      <div className="my-3 h-px bg-hairline" />
      <div className="mb-1.5 text-ui-xs font-medium text-foreground-subtle">
        {t('settings.alerts.title')}
      </div>
      <label className="flex cursor-pointer items-center justify-between gap-2 rounded-lg bg-surface px-2.5 py-2">
        <span className="text-ui-xs text-foreground">{t('settings.tray.closeToTray')}</span>
        <input
          type="checkbox"
          data-pref-close-to-tray=""
          checked={closeToTray}
          onChange={(e) => {
            const next = e.target.checked
            setCloseToTray(next)
            void persistPrefs(next, budgetStr, spikeMStr, false)
          }}
          className="h-3.5 w-3.5 accent-signal"
        />
      </label>
      <div className="mt-1 text-[11px] leading-snug text-foreground-subtlest">
        {t('settings.tray.hint')}
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-[11px] text-foreground-subtle">
            {t('settings.alerts.budgetDaily')}
          </span>
          <input
            type="number"
            min="0"
            step="0.5"
            data-pref-budget-usd=""
            value={budgetStr}
            onChange={(e) => setBudgetStr(e.target.value)}
            onBlur={() => void persistPrefs(closeToTray, budgetStr, spikeMStr, true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void persistPrefs()
            }}
            className="h-7 w-full rounded-lg border border-border bg-card px-2 font-mono text-ui-xs text-foreground"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-foreground-subtle">
            {t('settings.alerts.spike10m')}
          </span>
          <input
            type="number"
            min="0"
            step="1"
            data-pref-spike-m=""
            value={spikeMStr}
            onChange={(e) => setSpikeMStr(e.target.value)}
            onBlur={() => void persistPrefs(closeToTray, budgetStr, spikeMStr, true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void persistPrefs()
            }}
            className="h-7 w-full rounded-lg border border-border bg-card px-2 font-mono text-ui-xs text-foreground"
          />
        </label>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-[10px] text-foreground-subtlest">{t('settings.alerts.offHint')}</span>
        <button
          type="button"
          data-save-alerts=""
          onClick={() => void persistPrefs()}
          className="shrink-0 rounded-md bg-secondary px-2 py-0.5 text-[11px] text-foreground transition-colors duration-150 hover:bg-surface-hover"
        >
          {t('custom.apply')}
        </button>
      </div>

      <div className="my-3 h-px bg-hairline" />
      <div className="mb-1.5 text-ui-xs font-medium text-foreground-subtle">
        {t('settings.pricing.title')}
      </div>
      <div className="mb-1 text-[11px] text-foreground-subtle">{t('settings.pricing.currency')}</div>
      <div className="relative isolate grid grid-cols-2 gap-1 rounded-lg border border-border bg-surface p-0.5">
        <SlidingTabIndicator activeSelector='button[data-active="true"]' className="rounded-md bg-selected" />
        {(
          [
            ['USD', 'USD ($)'],
            ['CNY', 'CNY (¥)']
          ] as const
        ).map(([code, label]) => (
          <button
            key={code}
            type="button"
            data-currency-btn={code}
            data-active={pricingDraft.currency === code ? 'true' : undefined}
            onClick={() => switchCurrency(code)}
            className={`relative z-10 h-6 cursor-pointer rounded-md px-2 text-ui-xs transition-colors duration-150 ${
              pricingDraft.currency === code
                ? 'font-medium text-foreground'
                : 'text-foreground-subtle hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        {pricingDraft.currency === 'CNY' && (
          <label className="block">
            <span className="mb-1 block text-[11px] text-foreground-subtle">
              {t('settings.pricing.cnyRate')}
            </span>
            <input
              type="number"
              min="0.1"
              step="0.05"
              data-pricing-cny-rate=""
              value={pricingDraft.cnyRate}
              onChange={(e) =>
                setPricingDraft((prev) => ({ ...prev, cnyRate: Math.max(0.1, Number(e.target.value) || 7.2) }))
              }
              className="h-7 w-full rounded-lg border border-border bg-card px-2 font-mono text-ui-xs text-foreground"
            />
          </label>
        )}
        <label className={`block ${pricingDraft.currency === 'USD' ? 'col-span-2' : ''}`}>
          <span className="mb-1 block text-[11px] text-foreground-subtle">
            {t('settings.pricing.multiplier')}
          </span>
          <input
            type="number"
            min="0"
            step="0.1"
            data-pricing-multiplier=""
            value={pricingDraft.globalMultiplier}
            onChange={(e) =>
              setPricingDraft((prev) => ({
                ...prev,
                globalMultiplier: Math.max(0, Number(e.target.value) || 0)
              }))
            }
            className="h-7 w-full rounded-lg border border-border bg-card px-2 font-mono text-ui-xs text-foreground"
          />
        </label>
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-2">
        <span className="text-[11px] text-foreground-subtle">{t('settings.pricing.overrides')}</span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => addOverride(true)}
            className="rounded-md bg-surface px-1.5 py-0.5 text-[10px] text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground"
          >
            {t('settings.pricing.presetLocal')}
          </button>
          <button
            type="button"
            data-add-pricing-rule=""
            onClick={() => addOverride(false)}
            className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] text-foreground transition-colors hover:bg-surface-hover"
          >
            {t('settings.pricing.addRule')}
          </button>
        </div>
      </div>

      {pricingDraft.overrides.length > 0 && (
        <div className="mt-1.5 space-y-1.5">
          {pricingDraft.overrides.map((rule) => (
            <div key={rule.id} className="space-y-1 rounded-lg border border-hairline bg-surface p-2">
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={rule.pattern}
                  placeholder={t('settings.pricing.patternPlaceholder')}
                  onChange={(e) => updateOverride(rule.id, { pattern: e.target.value })}
                  className="h-6 min-w-0 flex-1 rounded border border-border bg-card px-1.5 font-mono text-[11px] text-foreground"
                />
                <button
                  type="button"
                  onClick={() => removeOverride(rule.id)}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-foreground-subtlest hover:bg-hover hover:text-destructive"
                >
                  ×
                </button>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="min-w-[116px]">
                  <NexusSelect
                    value={rule.mode}
                    onChange={(mode: PricingOverrideMode) => {
                      updateOverride(rule.id, {
                        mode,
                        multiplier: mode === 'multiplier' ? (rule.multiplier ?? 0.5) : undefined,
                        input: mode === 'custom' ? (rule.input ?? 1) : undefined,
                        output: mode === 'custom' ? (rule.output ?? 3) : undefined,
                        cacheRead: mode === 'custom' ? (rule.cacheRead ?? 0.1) : undefined
                      })
                    }}
                    className="h-6 w-full text-[11px]"
                    options={[
                      { value: 'free', label: t('settings.pricing.modeFree') },
                      { value: 'multiplier', label: t('settings.pricing.modeMult') },
                      { value: 'custom', label: t('settings.pricing.modeCustom') }
                    ]}
                  />
                </div>
                {rule.mode === 'multiplier' && (
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={rule.multiplier ?? 1}
                    onChange={(e) =>
                      updateOverride(rule.id, { multiplier: Math.max(0, Number(e.target.value) || 0) })
                    }
                    className="h-6 w-20 rounded border border-border bg-card px-1.5 font-mono text-[11px] text-foreground"
                  />
                )}
                {rule.mode === 'custom' && (
                  <div className="grid flex-1 grid-cols-3 gap-1">
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      title="Input $/1M"
                      value={rule.input ?? 0}
                      onChange={(e) =>
                        updateOverride(rule.id, { input: Math.max(0, Number(e.target.value) || 0) })
                      }
                      className="h-6 rounded border border-border bg-card px-1 font-mono text-[10px] text-foreground"
                    />
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      title="Output $/1M"
                      value={rule.output ?? 0}
                      onChange={(e) =>
                        updateOverride(rule.id, { output: Math.max(0, Number(e.target.value) || 0) })
                      }
                      className="h-6 rounded border border-border bg-card px-1 font-mono text-[10px] text-foreground"
                    />
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      title="CacheRead $/1M"
                      value={rule.cacheRead ?? 0}
                      onChange={(e) =>
                        updateOverride(rule.id, { cacheRead: Math.max(0, Number(e.target.value) || 0) })
                      }
                      className="h-6 rounded border border-border bg-card px-1 font-mono text-[10px] text-foreground"
                    />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        data-apply-pricing=""
        onClick={() => void persistPricing(pricingDraft)}
        className="mt-2.5 h-7 w-full rounded-lg bg-chart-1 px-2 text-ui-xs font-medium text-white transition-opacity duration-150 hover:opacity-90"
      >
        {t('settings.pricing.save')}
      </button>
    </>
  )
}
