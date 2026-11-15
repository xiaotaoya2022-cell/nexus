// 会话深度透视抽屉：点击会话行弹出右侧详细面板，展示模型分摊费用、Token 构成、工具调用与工作区联动。

import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { SessionDetail, SessionRow } from '@shared/types'
import { vendorOf } from '@shared/vendors'
import { t, useLang } from '../i18n'
import { nexus } from '../lib/api'
import { compactNumber, formatCost, formatCostPrecise, formatTime, fullNumber } from '../lib/format'
import { useUi } from '../store'
import { AgentLogo } from './AgentLogo'

export interface SessionInspectorDrawerProps {
  session: SessionRow | null
  agentLabel: string
  agentColor: string
  onClose: () => void
  onFilterProject: (projectDir: string) => void
}

export function SessionInspectorDrawer({
  session,
  agentLabel,
  agentColor,
  onClose,
  onFilterProject
}: SessionInspectorDrawerProps): JSX.Element | null {
  useLang()
  const pricingConfig = useUi((s) => s.pricingConfig)
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!session) {
      setDetail(null)
      return
    }
    let cancelled = false
    setLoading(true)
    void nexus
      .getSessionDetail(session.agent, session.sessionId, session.sourceNodeId)
      .then((res) => {
        if (!cancelled) setDetail(res)
      })
      .catch(() => {
        if (!cancelled) setDetail(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      cancelled = true
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [session, pricingConfig, onClose])

  if (!session) return null

  const cur = detail?.session ?? session
  const totals = detail?.totals
  const tokenParts = totals
    ? [
        { key: 'input', label: t('tokenType.input'), val: totals.input, color: 'var(--nx-chart-1)' },
        { key: 'output', label: t('tokenType.output'), val: totals.output, color: 'var(--nx-chart-2)' },
        { key: 'reasoning', label: t('tokenType.reasoning'), val: totals.reasoning, color: 'var(--nx-chart-3)' },
        { key: 'cacheRead', label: t('tokenType.cacheRead'), val: totals.cacheRead, color: 'var(--nx-chart-4)' },
        { key: 'cacheWrite', label: t('tokenType.cacheWrite'), val: totals.cacheWrite, color: 'var(--nx-chart-5)' }
      ].filter((p) => p.val > 0)
    : []

  const totalTokens = totals?.total ?? cur.tokens

  return (
    <div className="fixed inset-0 z-40 flex justify-end" data-session-inspector="">
      <div className="fixed inset-0 bg-black/45 backdrop-blur-[2px]" onClick={onClose} />
      <aside
        role="dialog"
        aria-label={t('inspector.title')}
        className="nx-popover nx-fade-in nx-card-elevated relative z-10 flex h-full w-full max-w-[460px] flex-col border-l border-border bg-card shadow-2xl"
      >
        <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface ring-1 ring-inset ring-hairline"
              style={{ boxShadow: `inset 0 0 0 1px ${agentColor}33` }}
            >
              <AgentLogo agentId={cur.agent} vendor={vendorOf(cur.agent)} size={16} />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-ui-xs font-medium text-foreground-subtle">{agentLabel}</span>
                {cur.sourceNodeLabel && (
                  <span className="rounded bg-surface px-1.5 py-0.5 text-[11px] text-foreground-subtlest">
                    {cur.sourceNodeLabel}
                  </span>
                )}
              </div>
              <h2 className="truncate text-ui-base font-medium text-foreground" title={cur.title ?? cur.sessionId}>
                {cur.title || cur.sessionId}
              </h2>
            </div>
          </div>
          <button
            type="button"
            data-inspector-close=""
            onClick={onClose}
            aria-label={t('win.close')}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-foreground-subtle transition-colors duration-150 hover:bg-hover hover:text-foreground"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
              <path d="M2.5 2.5L9.5 9.5M9.5 2.5L2.5 9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {/* 元信息 & 工作区快捷操作 */}
          <div className="space-y-2 rounded-xl border border-hairline bg-surface p-3.5 text-ui-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-foreground-subtlest">{t('inspector.sessionId')}</span>
              <span className="truncate font-mono text-foreground-subtle" title={cur.sessionId}>
                {cur.sessionId}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-foreground-subtlest">{t('inspector.duration')}</span>
              <span className="font-mono tabular-nums text-foreground-subtle">
                {formatTime(cur.startedAt, false)} → {formatTime(cur.updatedAt, true)}
              </span>
            </div>
            <div className="flex items-start justify-between gap-2 pt-0.5">
              <span className="shrink-0 text-foreground-subtlest">{t('inspector.workspace')}</span>
              <span className="min-w-0 break-all text-right font-mono text-foreground" title={cur.projectDir ?? ''}>
                {cur.projectDir || t('chart.projectRank.unassigned')}
              </span>
            </div>
            {cur.projectDir && (
              <div className="flex flex-wrap gap-2 pt-1.5">
                <button
                  type="button"
                  data-inspector-filter-project=""
                  onClick={() => {
                    if (cur.projectDir) {
                      onFilterProject(cur.projectDir)
                      onClose()
                    }
                  }}
                  className="flex-1 rounded-lg bg-chart-1 px-2.5 py-1.5 text-ui-xs font-medium text-white transition-opacity duration-150 hover:opacity-90"
                >
                  {t('inspector.filterProject')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (cur.projectDir) void nexus.openPath(cur.projectDir).catch(() => undefined)
                  }}
                  className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-ui-xs text-foreground transition-colors duration-150 hover:bg-hover"
                >
                  {t('inspector.openFolder')}
                </button>
              </div>
            )}
          </div>

          {loading ? (
            <div className="rounded-xl border border-hairline bg-surface p-6 text-center text-ui-xs text-foreground-subtle">
              {t('inspector.loading')}
            </div>
          ) : !detail ? (
            <div className="rounded-xl border border-hairline bg-surface p-6 text-center text-ui-xs text-foreground-subtle">
              {t('inspector.empty')}
            </div>
          ) : (
            <>
              {/* 4 项核心摘要 */}
              <div className="grid grid-cols-2 gap-2.5">
                <div className="rounded-xl border border-hairline bg-surface px-3 py-2.5">
                  <div className="text-[11px] text-foreground-subtlest">{t('inspector.tokens')}</div>
                  <div className="mt-0.5 font-mono text-ui-lg tabular-nums text-foreground" title={fullNumber(detail.totals.total)}>
                    {compactNumber(detail.totals.total)}
                  </div>
                </div>
                <div className="rounded-xl border border-hairline bg-surface px-3 py-2.5">
                  <div className="text-[11px] text-foreground-subtlest">{t('inspector.cost')}</div>
                  <div
                    className="mt-0.5 font-mono text-ui-lg tabular-nums text-signal"
                    title={formatCostPrecise(detail.totals.estimatedCostUsd, pricingConfig)}
                  >
                    {formatCost(detail.totals.estimatedCostUsd, pricingConfig)}
                  </div>
                </div>
                <div className="rounded-xl border border-hairline bg-surface px-3 py-2.5">
                  <div className="text-[11px] text-foreground-subtlest">{t('inspector.requests')}</div>
                  <div className="mt-0.5 font-mono text-ui-base tabular-nums text-foreground">
                    {fullNumber(detail.totals.requests)}
                  </div>
                </div>
                <div className="rounded-xl border border-hairline bg-surface px-3 py-2.5">
                  <div className="text-[11px] text-foreground-subtlest">{t('inspector.cacheHit')}</div>
                  <div className="mt-0.5 font-mono text-ui-base tabular-nums text-foreground">
                    {detail.cacheHitRate != null ? `${detail.cacheHitRate.toFixed(1)}%` : '—'}
                  </div>
                </div>
              </div>

              {/* Token 构成堆叠条 */}
              {tokenParts.length > 0 && totalTokens > 0 && (
                <div className="space-y-2 rounded-xl border border-hairline bg-surface p-3.5">
                  <div className="text-ui-xs font-medium text-foreground-subtle">{t('inspector.tokenMix')}</div>
                  <div className="flex h-2 w-full overflow-hidden rounded-full bg-card">
                    {tokenParts.map((part) => (
                      <div
                        key={part.key}
                        title={`${part.label}: ${fullNumber(part.val)}`}
                        style={{
                          width: `${Math.max(1.5, (part.val / totalTokens) * 100)}%`,
                          backgroundColor: part.color
                        }}
                      />
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-foreground-subtle">
                    {tokenParts.map((part) => (
                      <span key={part.key} className="inline-flex items-center gap-1 font-mono tabular-nums">
                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: part.color }} />
                        <span>{part.label}</span>
                        <span className="text-foreground">{compactNumber(part.val)}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* 模型分解明细 */}
              <div className="space-y-2 rounded-xl border border-hairline bg-surface p-3.5">
                <div className="text-ui-xs font-medium text-foreground-subtle">{t('inspector.models')}</div>
                {detail.models.length === 0 ? (
                  <div className="text-ui-xs text-foreground-subtlest">—</div>
                ) : (
                  <div className="divide-y divide-hairline">
                    {detail.models.map((m) => (
                      <div key={m.model} className="flex items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
                        <div className="min-w-0">
                          <div className="truncate font-mono text-ui-xs font-medium text-foreground" title={m.model}>
                            {m.model}
                          </div>
                          <div className="text-[11px] text-foreground-subtlest">
                            {m.requests} req · In {compactNumber(m.input)} · Out {compactNumber(m.output)} · CR{' '}
                            {compactNumber(m.cacheRead)}
                          </div>
                        </div>
                        <div className="shrink-0 text-right font-mono tabular-nums">
                          <div className="text-ui-xs text-foreground">{compactNumber(m.total)}</div>
                          <div className="text-[11px] text-foreground-subtlest">
                            {formatCost(m.estimatedCostUsd, pricingConfig)}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 工具调用分解 */}
              <div className="space-y-2 rounded-xl border border-hairline bg-surface p-3.5">
                <div className="text-ui-xs font-medium text-foreground-subtle">{t('inspector.tools')}</div>
                {detail.tools.length === 0 ? (
                  <div className="text-ui-xs text-foreground-subtlest">{t('inspector.noTools')}</div>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {detail.tools.map((tl) => (
                      <span
                        key={tl.tool}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-card px-2 py-1 font-mono text-[11px] text-foreground"
                      >
                        <span>{tl.tool}</span>
                        <span className="rounded bg-surface px-1 text-[11px] tabular-nums text-signal">
                          ×{tl.count}
                        </span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  )
}
