// Nexus 主界面：三栏布局（规范 §6）—— 顶栏 + Agent 侧栏 + 图表矩阵 + 会话明细。

import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { EChartsOption } from 'echarts'
import { nexus } from './lib/api'
import { useUi } from './store'
import { useDashboard } from './useDashboard'
import { EChart } from './charts/EChart'
import { AgentSidebar } from './components/AgentSidebar'
import { SessionsPanel } from './components/SessionsPanel'
import { SystemPill } from './components/SystemPill'
import { AccountPanel } from './components/AccountPanel'
import { WindowControls } from './components/WindowControls'
import nexusMark from './assets/nexus-mark.png'
import { getLang, setLang, t, useLang } from './i18n'
import type { Lang } from './i18n'
import { AnimatedNumber } from './components/RollingNumber'
import {
  ChartCard,
  EmptyState,
  ExportIcon,
  GearIcon,
  IconButton,
  KpiCard,
  LegendItem,
  MoonIcon,
  PillSwitcher,
  RANGE_OPTIONS,
  RefreshIcon,
  SunIcon
} from './components/ui'
import {
  agentColorMap,
  chartTokens,
  colorForIndex,
  dailyBarOption,
  donutOption,
  heatmapOption,
  rankBarOption,
  TOKEN_TYPE_COLORS,
  trendOption
} from './charts/options'
import {
  compactNumber,
  formatCost,
  fullNumber
} from './lib/format'
import type { RangeKey } from '@shared/types'

export default function App(): JSX.Element {
  const range = useUi((s) => s.range)
  const agent = useUi((s) => s.agent)
  const theme = useUi((s) => s.theme)
  // 语言订阅：切换语言时触发 App 重渲染（各子组件自行 useLang）
  useLang()
  const setTheme = useUi((s) => s.setTheme)
  const setAgent = useUi((s) => s.setAgent)
  const sync = useUi((s) => s.sync)
  const { data, agents, loading, trendGroup, setTrendGroup } = useDashboard()
  const [toast, setToast] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [retention, setRetention] = useState<number>(0)
  const [remoteOn, setRemoteOn] = useState(false)
  const [remoteStatus, setRemoteStatus] = useState<Awaited<ReturnType<typeof nexus.getRemoteStatus>> | null>(null)
  const [pairing, setPairing] = useState<Awaited<ReturnType<typeof nexus.regeneratePairing>> | null>(null)
  const [dshStatus, setDshStatus] = useState<Awaited<ReturnType<typeof nexus.getDshStatus>> | null>(null)
  const [dshSessions, setDshSessions] = useState<Awaited<ReturnType<typeof nexus.getDshSessions>>>([])

  // 启动时读取主题与上次时间范围（含自定义范围的起止）
  useEffect(() => {
    void (async () => {
      const s = await nexus.getSettings()
      useUi.getState().setTheme(s.theme)
      const r = await nexus.getSavedRange()
      useUi.getState().setRange(r)
      const cr = await nexus.getCustomRange()
      if (cr) useUi.getState().setCustomRange(cr)
    })()
  }, [])

  // 自定义时间范围选择浮层
  const [customPickerOpen, setCustomPickerOpen] = useState(false)
  // 表单初值：默认最近 7 天（本地时区零点到当前）
  const [customFrom, setCustomFrom] = useState(() => {
    const d = new Date(Date.now() - 7 * 86400_000)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T00:00`
  })
  const [customTo, setCustomTo] = useState(() => {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T23:59`
  })

  const applyCustomRange = async (): Promise<void> => {
    const start = new Date(customFrom).getTime()
    const end = new Date(customTo).getTime()
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      setToast(t('custom.toast.invalid'))
      return
    }
    const saved = await nexus.setCustomRange(start, end)
    useUi.getState().setCustomRange(saved)
    useUi.getState().setRange('custom')
    setCustomPickerOpen(false)
    setToast(
      t('custom.toast.applied', {
        from: new Date(start).toLocaleDateString(),
        to: new Date(end).toLocaleDateString()
      })
    )
  }

  // 主题 class 必须在子组件读取 CSS 变量（chartTokens）之前生效：
  // useLayoutEffect 先落 class，再以 epoch 触发重渲染与图表 option 重建
  const [themeEpoch, setThemeEpoch] = useState(0)
  useLayoutEffect(() => {
    const el = document.documentElement
    el.classList.remove('theme-dark', 'theme-light')
    el.classList.add(theme === 'light' ? 'theme-light' : 'theme-dark')
    setThemeEpoch((v) => v + 1)
  }, [theme])

  // toast 自动消失
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3500)
    return () => clearTimeout(t)
  }, [toast])

  const tokens = useMemo(() => chartTokens(), [themeEpoch])

  const agentLabels = useMemo(() => new Map(agents.map((a) => [a.id, a.label])), [agents])
  // 配色顺序：产出数据的 Agent 优先取前排色，同组内按 id 字典序，保证跨刷新稳定
  const colorOrderIds = useMemo(() => {
    return [...agents]
      .sort((a, b) => {
        const ga = a.status === 'active' || a.status === 'idle' || a.todayTokens > 0 ? 0 : 1
        const gb = b.status === 'active' || b.status === 'idle' || b.todayTokens > 0 ? 0 : 1
        return ga - gb || a.id.localeCompare(b.id)
      })
      .map((a) => a.id)
  }, [agents])
  const agentColors = useMemo(
    () => agentColorMap(colorOrderIds, tokens),
    [colorOrderIds, tokens]
  )

  const handleExport = async (): Promise<void> => {
    const r = await nexus.exportBoard()
    if (r.ok && r.path) setToast(t('toast.export.done', { path: r.path }))
    else if (!r.ok && !r.canceled) setToast(t('toast.export.failed', { err: r.error ?? t('toast.unknownError') }))
  }

  const toggleTheme = async (): Promise<void> => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    await nexus.setTheme(next)
  }

  const openSettings = async (): Promise<void> => {
    if (!settingsOpen) {
      setRetention(await nexus.getRetentionDays())
      const s = await nexus.getRemoteStatus()
      setRemoteStatus(s)
      setRemoteOn(s.enabled)
      setDshStatus(await nexus.getDshStatus())
      void nexus.getDshSessions().then(setDshSessions)
    }
    setSettingsOpen((v) => !v)
  }

  const changeRetention = async (days: number): Promise<void> => {
    const v = await nexus.setRetentionDays(days)
    setRetention(v)
    setToast(days > 0 ? t('settings.retention.toast.days', { n: days }) : t('settings.retention.toast.forever'))
  }

  const totalTokens = data?.overview.totals.total ?? 0

  // 图表 option（数据或主题变化时重建）
  const trendOpt = useMemo<EChartsOption | null>(() => {
    if (!data) return null
    return trendOption(data.trend, tokens, range === 'today' ? 'today' : 'week')
  }, [data, tokens, range])

  const trendLegend = useMemo(() => {
    if (!data) return null
    const totals = new Map<string, number>()
    for (const p of data.trend) {
      for (const [k, v] of Object.entries(p.series)) totals.set(k, (totals.get(k) ?? 0) + v)
    }
    const names = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k)
    const order = trendGroup === 'model' ? names : [...names].sort()
    return order.map((n, i) => (
      <LegendItem key={n} label={trendGroup === 'model' ? n : agentLabels.get(n) ?? n} color={colorForIndex(tokens, i)} />
    ))
  }, [data, tokens, trendGroup, agentLabels])

  const typeOpt = useMemo<EChartsOption | null>(() => {
    if (!data) return null
    const items = data.breakdown
      .filter((b) => b.tokens > 0)
      .map((b) => ({ name: b.label, value: b.tokens }))
    if (!items.length) return null
    const colorByKey = new Map(TOKEN_TYPE_COLORS.map((t) => [t.key, t.colorVarIndex]))
    const keyByLabel = new Map(data.breakdown.map((b) => [b.label, b.key]))
    return donutOption(items, (_name, i) => {
      const label = items[i].name
      const key = keyByLabel.get(label)
      const idx = key != null ? colorByKey.get(key) : undefined
      return tokens.series[(idx ?? 0) % tokens.series.length]
    }, tokens)
  }, [data, tokens])

  const agentDonutOpt = useMemo<EChartsOption | null>(() => {
    if (!data || data.byAgent.length === 0) return null
    const items = data.byAgent.map((a) => ({ name: a.name, value: a.tokens }))
    return donutOption(items, (name) => agentColors.get(name) ?? tokens.series[0], tokens)
  }, [data, tokens, agentColors])

  const modelBarOpt = useMemo<EChartsOption | null>(() => {
    if (!data || data.byModel.length === 0) return null
    // 与趋势图同规则（按 Token 排名取色），跨图同模型同色
    return rankBarOption(data.byModel.slice(0, 10), tokens, true, 'tokens')
  }, [data, tokens])

  const toolBarOpt = useMemo<EChartsOption | null>(() => {
    if (!data || data.tools.length === 0) return null
    return rankBarOption(data.tools, tokens, false, t('unit.times'))
  }, [data, tokens])

  const heatmapOpt = useMemo<EChartsOption | null>(() => {
    if (!data) return null
    return heatmapOption(data.heatmap, tokens)
  }, [data, tokens])

  const dailyBarOpt = useMemo<EChartsOption | null>(() => {
    if (!data || range === 'today') return null
    return dailyBarOption(data.trend, tokens)
  }, [data, tokens, range])

  const cacheHit =
    data && data.overview.totals.input + data.overview.totals.cacheRead + data.overview.totals.cacheWrite > 0
      ? (data.overview.totals.cacheRead /
          (data.overview.totals.input + data.overview.totals.cacheRead + data.overview.totals.cacheWrite)) *
        100
      : null

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* 顶栏：自绘窗口控制钮（frame:false）——随主题 class 即时变色，无原生 WCO 同步问题。
          双击顶栏空白切换最大化。 */}
      <header
        onDoubleClick={(e) => {
          // 双击空白区（非按钮）切换最大化
          const el = e.target as HTMLElement
          if (el.closest('button, select, input, a')) return
          void nexus.toggleMaximizeWindow()
        }}
        style={{WebkitAppRegion: "drag"} as React.CSSProperties}
        className="relative flex h-12 shrink-0 items-center gap-4 border-b border-border bg-panel px-4"
      >
        <div className="flex items-center gap-2">
          {/* 标题栏品牌徽章：渐变底座 + 内侧描边 + 轻投影（同 ZCode 立体三件套），mark 双主题通吃 */}
          <span
            aria-hidden
            className="relative flex size-6 items-center justify-center overflow-hidden rounded-md
              bg-[linear-gradient(180deg,#ffffff_0%,#eaeaec_100%)]
              before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit]
              before:border before:border-black/10"
          >
            <img src={nexusMark} alt="" className="h-auto w-4" draggable={false} />
          </span>
          <span className="text-ui-base font-medium">Nexus</span>
          <span className="text-ui-sm text-foreground-subtlest">{t('app.subtitle')}</span>
        </div>
        <div className="flex-1" style={{WebkitAppRegion: "no-drag"} as React.CSSProperties} />
        {sync.phase === 'running' && (
          <span className="text-ui-xs text-foreground-subtle">{t('header.syncing')}</span>
        )}
        <div className="relative" style={{WebkitAppRegion: "no-drag"} as React.CSSProperties}>
          <PillSwitcher
            options={[
              ...RANGE_OPTIONS.map((o) => ({ ...o, label: t(`range.${o.key}`) })),
              { key: 'custom' as RangeKey, label: t('range.custom') }
            ]}
            value={range}
            onChange={(r: RangeKey) => {
              if (r === 'custom') {
                // 打开自定义浮层（若已有自定义范围则直接沿用，浮层内可改）
                setCustomPickerOpen(true)
                return
              }
              useUi.getState().setRange(r)
              void nexus.setSavedRange(r)
            }}
          />
          {customPickerOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setCustomPickerOpen(false)} />
              <div className="nx-fade-in absolute right-0 top-9 z-20 w-80 rounded-xl border border-border bg-card p-4">
                <div className="mb-3 text-ui-base font-medium">{t('custom.title')}</div>
                <label className="mb-1 block text-ui-xs text-foreground-subtle">{t('custom.start')}</label>
                <input
                  type="datetime-local"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="h-8 w-full rounded-lg border border-border bg-card px-2 font-mono text-ui-sm text-foreground"
                />
                <label className="mb-1 mt-3 block text-ui-xs text-foreground-subtle">{t('custom.end')}</label>
                <input
                  type="datetime-local"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="h-8 w-full rounded-lg border border-border bg-card px-2 font-mono text-ui-sm text-foreground"
                />
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={() => void applyCustomRange()}
                    className="h-8 flex-1 rounded-lg bg-chart-1 px-2 text-ui-sm font-medium text-white transition-colors duration-150 hover:opacity-90"
                  >
                    {t('custom.apply')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setCustomPickerOpen(false)}
                    className="h-8 flex-1 rounded-lg bg-secondary px-2 text-ui-sm text-foreground transition-colors duration-150 hover:bg-surface-hover"
                  >
                    {t('custom.cancel')}
                  </button>
                </div>
                <div className="mt-2 text-ui-xs text-foreground-subtlest">{t('custom.hint')}</div>
              </div>
            </>
          )}
        </div>
        <SystemPill />
        <AccountPanel />
        <IconButton style={{WebkitAppRegion: "no-drag"} as React.CSSProperties} title={t('header.action.syncNow')} onClick={() => void nexus.syncNow()} spinning={sync.phase === 'running'}>
          <RefreshIcon />
        </IconButton>
        <IconButton title={theme === 'dark' ? t('header.action.toggleLight') : t('header.action.toggleDark')} onClick={() => void toggleTheme()}>
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </IconButton>
        <IconButton style={{WebkitAppRegion: "no-drag"} as React.CSSProperties} title={t('header.action.exportPng')} onClick={() => void handleExport()}>
          <ExportIcon />
        </IconButton>
        <IconButton style={{WebkitAppRegion: "no-drag"} as React.CSSProperties} title={t('header.action.settings')} onClick={() => void openSettings()}>
          <GearIcon />
        </IconButton>
        <WindowControls />
        {settingsOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setSettingsOpen(false)} />
            <div
              className="nx-fade-in absolute right-3 top-12 z-20 w-72 rounded-xl border border-border bg-card p-4"
              role="dialog"
            >
            <div className="mb-3 text-ui-base font-medium">{t('settings.title')}</div>
            <label className="mb-1 block text-ui-xs text-foreground-subtle">{t('settings.language')}</label>
            <select
              value={getLang()}
              onChange={(e) => {
                setLang(e.target.value as Lang)
                void nexus.setTheme(theme) // 触发一次设置持久化同步（语言本身走 localStorage）
              }}
              className="h-7 w-full rounded-lg border border-border bg-card px-2 text-ui-base text-foreground"
            >
              <option value="zh-CN">{t('settings.lang.zh')}</option>
              <option value="en">{t('settings.lang.en')}</option>
            </select>
            <label className="mb-1 mt-3 block text-ui-xs text-foreground-subtle">{t('settings.retention')}</label>
            <select
              value={retention}
              onChange={(e) => void changeRetention(Number(e.target.value))}
              className="h-7 w-full rounded-lg border border-border bg-card px-2 text-ui-base text-foreground"
            >
              <option value={0}>{t('settings.retention.forever')}</option>
              <option value={90}>{t('settings.retention.days', { n: 90 })}</option>
              <option value={180}>{t('settings.retention.days', { n: 180 })}</option>
              <option value={365}>{t('settings.retention.days', { n: 365 })}</option>
            </select>
            <div className="mt-1 text-ui-xs text-foreground-subtlest">
              {t('settings.retention.hint')}
            </div>
            <button
              type="button"
              onClick={() => {
                void nexus.getDataDir().then((dir) => nexus.openPath(dir))
              }}
              className="mt-3 h-7 w-full rounded-lg bg-secondary px-2 text-ui-base text-foreground transition-colors duration-150 hover:bg-surface-hover"
            >
              {t('settings.openDataDir')}
            </button>

            <div className="my-3 h-px bg-hairline" />
            <div className="mb-1 text-ui-xs text-foreground-subtle">{t('settings.dsh.title')}</div>
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-ui-sm text-foreground">
                {dshStatus?.available
                  ? `${t('settings.dsh.connected', { port: dshStatus.port })}${dshStatus.sessionCount ? t('settings.dsh.sessionSuffix', { n: dshStatus.sessionCount }) : ''}`
                  : t('settings.dsh.notDetected')}
              </span>
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${dshStatus?.available ? 'bg-success' : 'bg-border'}`}
                title={dshStatus?.available ? t('settings.dsh.available') : t('settings.dsh.unavailable')}
              />
            </div>
            {dshStatus?.detail && (
              <div className="text-ui-xs text-foreground-subtlest">{dshStatus.detail}</div>
            )}
            {dshSessions.length > 0 && (
              <div className="mt-2 flex flex-col gap-0.5">
                <div className="text-ui-xs text-foreground-subtle">
                  {t('settings.dsh.localSessions', { n: dshSessions.length })}
                </div>
                {dshSessions.slice(0, 8).map((sess) => (
                  <button
                    key={sess.sessionId}
                    type="button"
                    title={`${t('settings.dsh.sessionTip', { title: sess.title ?? sess.projectDir ?? sess.sessionId, n: sess.requests, tokens: fullNumber(sess.tokens) })}${sess.projectDir ? `\n${sess.projectDir}` : ''}`}
                    onClick={() => {
                      if (!sess.projectDir) return
                      void nexus.openPath(sess.projectDir).catch(() => undefined)
                    }}
                    className="flex items-center justify-between gap-2 rounded-md px-1.5 py-0.5 text-left text-ui-xs text-foreground-subtle transition-colors duration-150 hover:bg-hover hover:text-foreground"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {sess.title ?? sess.projectDir ?? `${sess.sessionId.slice(0, 12)}…`}
                    </span>
                    <span className="shrink-0 font-mono tabular-nums text-foreground-subtlest">
                      {compactNumber(sess.tokens)} tk
                    </span>
                  </button>
                ))}
                <div className="text-ui-xs text-foreground-subtlest">
                  {t('settings.dsh.hint')}
                </div>
              </div>
            )}

            <div className="my-3 h-px bg-hairline" />
            <div className="mb-1 text-ui-xs text-foreground-subtle">{t('settings.remote.title')}</div>
            <div className="flex items-center justify-between">
              <span className="text-ui-sm text-foreground">{remoteOn ? t('settings.remote.on') : t('settings.remote.off')}</span>
              <button
                type="button"
                onClick={() => {
                  void nexus.setRemoteEnabled(!remoteOn).then(() =>
                    nexus.getRemoteStatus().then((s) => {
                      setRemoteStatus(s)
                      setRemoteOn(s.enabled)
                    })
                  )
                }}
                className="h-7 rounded-lg bg-secondary px-2 text-ui-sm text-foreground transition-colors duration-150 hover:bg-surface-hover"
              >
                {remoteOn ? t('settings.remote.action.off') : t('settings.remote.action.on')}
              </button>
            </div>
            {remoteOn && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    void nexus.regeneratePairing().then((p) => setPairing(p))
                  }}
                  className="mt-2 h-7 w-full rounded-lg bg-secondary px-2 text-ui-sm text-foreground transition-colors duration-150 hover:bg-surface-hover"
                >
                  {t('settings.remote.qr')}
                </button>
                {pairing?.qrDataUrl && (
                  <div className="mt-2 flex flex-col items-center gap-1">
                    <img src={pairing.qrDataUrl} alt={t('settings.remote.qrAlt')} className="h-40 w-40 rounded-lg border border-border" />
                    <span className="font-mono text-ui-sm tabular-nums text-foreground-subtle">
                      PIN {pairing.pin}
                    </span>
                  </div>
                )}
                {pairing && pairing.addresses.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1">
                    <div className="text-ui-xs text-foreground-subtle">{t('settings.remote.addressesHint')}</div>
                    {pairing.addresses.map((a) => (
                      <div key={a.host} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-ui-xs text-foreground-subtlest" title={a.uri}>
                          <span className="text-foreground-subtle">{a.label}</span> · {a.host}:{remoteStatus?.port ?? ''}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            void navigator.clipboard.writeText(a.uri).then(() => setToast(t('settings.remote.copied')))
                          }}
                          className="shrink-0 rounded-md px-1.5 py-0.5 text-ui-xs text-foreground-subtle transition-colors duration-150 hover:bg-hover hover:text-foreground"
                        >
                          {t('settings.remote.copy')}
                        </button>
                      </div>
                    ))}
                    <div className="text-ui-xs text-foreground-subtlest">
                      {t('settings.remote.crossNet')}
                    </div>
                  </div>
                )}
                {remoteStatus && remoteStatus.devices.length > 0 && (
                  <div className="mt-2">
                    <div className="mb-1 text-ui-xs text-foreground-subtle">{t('settings.remote.devices')}</div>
                    {remoteStatus.devices.map((d) => (
                      <div key={d.deviceId} className="flex items-center justify-between py-0.5">
                        <span className="truncate text-ui-caption text-foreground" title={d.deviceId}>
                          {d.name}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            void nexus.revokeDevice(d.deviceId).then(() =>
                              nexus.getRemoteStatus().then(setRemoteStatus)
                            )
                          }}
                          className="rounded-md px-1.5 py-0.5 text-ui-xs text-destructive transition-colors duration-150 hover:bg-destructive-surface"
                        >
                          {t('settings.remote.revoke')}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            </div>
          </>
        )}
      </header>

      {/* 三栏 */}
      <div className="flex min-h-0 flex-1 gap-1 p-1">
        <AgentSidebar agents={agents} lastSyncAt={sync.finishedAt} />

        <main
          style={{ opacity: loading ? 0.55 : 1 }}
          className="min-w-0 flex-1 space-y-4 overflow-y-auto rounded-xl border border-hairline bg-panel p-4 transition-opacity duration-150"
        >
          {!data ? (
            <EmptyState title={t('empty.loading.title')} description={t('empty.loading.desc')} />
          ) : totalTokens === 0 && data.sessions.length === 0 ? (
            <EmptyState
              title={t('empty.noData.title')}
              description={
                agent
                  ? t('empty.noData.filtered', {
                      agent: agentLabels.get(agent) ?? agent,
                      range: t(`range.${range}`)
                    })
                  : t('empty.noData.plain', { range: t(`range.${range}`) })
              }
            />
          ) : (
            <>
              {/* KPI 矩阵 */}
              <div className="grid grid-cols-2 gap-4 2xl:grid-cols-4">
                <KpiCard
                  label={t('kpi.tokens')}
                  value={<AnimatedNumber num={totalTokens} />}
                  sub={t('kpi.tokens.sub', { tokens: fullNumber(totalTokens), n: data.overview.totals.requests })}
                />
                <KpiCard
                  label={t('kpi.sessions')}
                  value={<AnimatedNumber num={data.overview.sessionCount} />}
                  sub={t('kpi.sessions.sub', { n: data.overview.activeModels })}
                />
                <KpiCard
                  label={t('kpi.tools')}
                  value={<AnimatedNumber num={data.overview.toolCallCount} />}
                  sub={data.tools.length ? t('kpi.tools.top', { tool: data.tools[0].tool }) : t('kpi.tools.none')}
                />
                <KpiCard
                  label={t('kpi.cost')}
                  value={
                    <AnimatedNumber
                      num={data.overview.totals.estimatedCostUsd}
                      compactFormat={formatCost}
                      fullFormat={(n) => `$${n.toFixed(4)}`}
                    />
                  }
                  sub={t('kpi.cost.sub')}
                />
              </div>

              {/* 趋势 + Token 类型 */}
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                <ChartCard
                  title={t('chart.trend')}
                  className="xl:col-span-2"
                  actions={
                    <PillSwitcher
                      options={[
                        { key: 'model', label: t('chart.trend.byModel') },
                        { key: 'agent', label: t('chart.trend.byAgent') }
                      ]}
                      value={trendGroup}
                      onChange={setTrendGroup}
                    />
                  }
                  legend={trendLegend ?? undefined}
                >
                  {trendOpt != null ? (
                    <EChart option={trendOpt} className="h-60 w-full" />
                  ) : (
                    <EmptyState title={t('chart.trend.empty.title')} description={t('chart.trend.empty.desc')} />
                  )}
                </ChartCard>
                <ChartCard title={t('chart.types')}>
                  {typeOpt != null ? (
                    <>
                      <EChart option={typeOpt} className="h-44 w-full" />
                      <div className="flex flex-wrap gap-x-3 gap-y-2">
                        {data.breakdown
                          .filter((b) => b.tokens > 0)
                          .map((b, i) => (
                            <LegendItem
                              key={b.key}
                              label={`${t(`tokenType.${b.key}`)} ${compactNumber(b.tokens)}`}
                              color={colorForIndex(tokens, TOKEN_TYPE_COLORS.find((tt) => tt.key === b.key)?.colorVarIndex ?? i)}
                            />
                          ))}
                      </div>
                    </>
                  ) : (
                    <EmptyState title={t('chart.empty.title')} description={t('chart.empty.desc')} />
                  )}
                </ChartCard>
              </div>

              {/* Agent 占比 + 模型排行 */}
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                <ChartCard
                  title={t('chart.agentShare')}
                  actions={
                    agent ? (
                      <button
                        type="button"
                        onClick={() => setAgent(null)}
                        className="rounded-lg px-2 py-0.5 text-ui-xs text-foreground-subtle transition-colors duration-150 hover:bg-hover hover:text-foreground"
                      >
                        {t('chart.agentShare.filtered', { agent: agentLabels.get(agent) ?? agent })}
                      </button>
                    ) : (
                      <span className="text-ui-xs text-foreground-subtlest">{t('chart.agentShare.drill')}</span>
                    )
                  }
                >
                  {agentDonutOpt != null ? (
                    <>
                      <EChart
                        option={agentDonutOpt}
                        className="h-44 w-full"
                        onClick={(name) => setAgent(agent === name ? null : name)}
                      />
                      <div className="flex flex-wrap gap-x-3 gap-y-2">
                        {data.byAgent.slice(0, 6).map((a) => (
                          <LegendItem
                            key={a.name}
                            label={`${agentLabels.get(a.name) ?? a.name} ${compactNumber(a.tokens)}`}
                            color={agentColors.get(a.name) ?? tokens.series[0]}
                          />
                        ))}
                      </div>
                    </>
                  ) : (
                    <EmptyState title={t('chart.empty.title')} description={t('chart.empty.desc')} />
                  )}
                </ChartCard>
                <div className="xl:col-span-2">
                  <ChartCard title={t('chart.modelRank')}>
                    {modelBarOpt != null ? (
                      <EChart option={modelBarOpt} className="h-60 w-full" />
                    ) : (
                      <EmptyState title={t('chart.empty.title')} description={t('chart.modelRank.empty.desc')} />
                    )}
                  </ChartCard>
                </div>
              </div>

              {/* 热力图 + 工具排行 */}
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                <div className="xl:col-span-2">
                  <ChartCard
                    title={t('chart.heatmap')}
                    actions={
                      <span className="text-ui-xs text-foreground-subtlest">
                        {cacheHit != null ? t('chart.heatmap.cacheHit', { pct: cacheHit.toFixed(1) }) : ''}
                      </span>
                    }
                  >
                    <EChart option={heatmapOpt ?? {}} className="h-48 w-full" />
                  </ChartCard>
                </div>
                <ChartCard title={t('chart.toolRank')}>
                  {toolBarOpt != null ? (
                    <EChart option={toolBarOpt} className="h-48 w-full" />
                  ) : (
                    <EmptyState title={t('chart.toolRank.empty.title')} description={t('chart.toolRank.empty.desc')} />
                  )}
                </ChartCard>
              </div>

              {/* 每日强度 */}
              {dailyBarOpt != null && (
                <ChartCard title={t('chart.daily')}>
                  <EChart option={dailyBarOpt} className="h-48 w-full" />
                </ChartCard>
              )}
            </>
          )}
        </main>

        <div className="hidden 2xl:flex">
          <SessionsPanel sessions={data?.sessions ?? []} agentColors={agentColors} />
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className="nx-fade-in fixed bottom-4 right-4 max-w-md rounded-lg border border-border bg-card px-3 py-1.5 text-ui-sm text-foreground">
          {toast}
        </div>
      )}
    </div>
  )
}
