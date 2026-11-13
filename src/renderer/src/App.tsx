// Nexus 主界面：三栏布局（规范 §6）—— 顶栏 + Agent 侧栏 + 图表矩阵 + 会话明细。

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { EChartsOption } from 'echarts'
import { nexus } from './lib/api'
import {
  clearCursorDegraded,
  CURSOR_CONFIG_CHANGED_EVENT,
  CURSOR_TOAST_EVENT,
  readCursorEnabled,
  writeCursorEnabled
} from './lib/cursorConfig'
import { useUi } from './store'
import { useDashboard } from './useDashboard'
import { useMesh } from './useMesh'
import { EChart } from './charts/EChart'
import { AgentSidebar } from './components/AgentSidebar'
import { CommandPalette } from './components/CommandPalette'
import { CursorSettingsSection, GlobalCursorMount } from './components/CustomCursor'
import { ExportMenu } from './components/ExportMenu'
import { MeshView } from './components/MeshView'
import { ScrollReveal, SpotlightGroup, useViewCrossfade } from './components/MotionEffects'
import { NodeSwitcherBar } from './components/NodeSwitcherBar'
import { MeshGlyph, nodeDisplayName } from './components/NodeVisuals'
import { SessionInspectorDrawer } from './components/SessionInspectorDrawer'
import { SessionsPanel, type SessionNodeMeta } from './components/SessionsPanel'
import { SettingsPreferencesSection } from './components/SettingsPreferencesSection'
import { SlidingTabIndicator } from './components/SmoothHighlight'
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
  formatCostPrecise,
  fullNumber,
  relativeTime,
  shortDir
} from './lib/format'
import type { ExportFormat, NamedStat, RangeKey, SessionRow } from '@shared/types'

export default function App(): JSX.Element {
  const activeView = useUi((s) => s.activeView)
  const selectedNodeId = useUi((s) => s.selectedNodeId)
  const selectedProjectDir = useUi((s) => s.selectedProjectDir)
  const range = useUi((s) => s.range)
  const agent = useUi((s) => s.agent)
  const theme = useUi((s) => s.theme)
  const uiStyle = useUi((s) => s.uiStyle)
  const customRange = useUi((s) => s.customRange)
  const pricingConfig = useUi((s) => s.pricingConfig)
  // 语言订阅：切换语言时触发 App 重渲染（各子组件自行 useLang）
  useLang()
  const setActiveView = useUi((s) => s.setActiveView)
  const setSelectedNodeId = useUi((s) => s.setSelectedNodeId)
  const setSelectedProjectDir = useUi((s) => s.setSelectedProjectDir)
  const setTheme = useUi((s) => s.setTheme)
  const setUiStyle = useUi((s) => s.setUiStyle)
  const setAgent = useUi((s) => s.setAgent)
  const sync = useUi((s) => s.sync)
  const { data, agents, loading, trendGroup, setTrendGroup } = useDashboard()
  const { meshStatus, actions: meshActions } = useMesh()
  const [toast, setToast] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sessionsDrawerOpen, setSessionsDrawerOpen] = useState(false)
  const [cmdkOpen, setCmdkOpen] = useState(false)
  const [quickPairNonce, setQuickPairNonce] = useState(0)
  const [cursorEnabled, setCursorEnabled] = useState(readCursorEnabled)
  const [leftChartMode, setLeftChartMode] = useState<'agent' | 'project'>('agent')
  const [inspectedSession, setInspectedSession] = useState<SessionRow | null>(null)
  const boardContentRef = useRef<HTMLDivElement>(null)
  const [retention, setRetention] = useState<number>(0)
  const [remoteOn, setRemoteOn] = useState(false)
  const [remoteStatus, setRemoteStatus] = useState<Awaited<ReturnType<typeof nexus.getRemoteStatus>> | null>(null)
  const [pairing, setPairing] = useState<Awaited<ReturnType<typeof nexus.regeneratePairing>> | null>(null)
  const [dshStatus, setDshStatus] = useState<Awaited<ReturnType<typeof nexus.getDshStatus>> | null>(null)
  const [dshSessions, setDshSessions] = useState<Awaited<ReturnType<typeof nexus.getDshSessions>>>([])

  // 启动时读取主题、时间范围与定价配置
  useEffect(() => {
    void (async () => {
      const s = await nexus.getSettings()
      useUi.getState().setTheme(s.theme)
      useUi.getState().setUiStyle(s.uiStyle === 'classic' ? 'classic' : 'nexus')
      const r = await nexus.getSavedRange()
      useUi.getState().setRange(r)
      const cr = await nexus.getCustomRange()
      if (cr) useUi.getState().setCustomRange(cr)
      const pcfg = await nexus.getPricingConfig()
      useUi.getState().setPricingConfig(pcfg, false)
    })()
    const unsubAlert = nexus.onAppAlert((alert) => {
      setToast(`${alert.title}：${alert.body}`)
    })
    return () => unsubAlert()
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
    el.classList.remove('theme-dark', 'theme-light', 'style-nexus', 'style-classic')
    el.classList.add(theme === 'light' ? 'theme-light' : 'theme-dark')
    el.classList.add(uiStyle === 'classic' ? 'style-classic' : 'style-nexus')
    setThemeEpoch((v) => v + 1)
  }, [theme, uiStyle])

  // toast 自动消失 + 接收自定义光标系统提示事件 + 全局 Ctrl+K 命令面板快捷键
  useEffect(() => {
    const onCursorToast = (e: Event): void => {
      const msg = (e as CustomEvent<string>).detail
      if (msg) setToast(msg)
    }
    const onCursorCfg = (): void => setCursorEnabled(readCursorEnabled())
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCmdkOpen((v) => !v)
      }
    }
    window.addEventListener(CURSOR_TOAST_EVENT, onCursorToast)
    window.addEventListener(CURSOR_CONFIG_CHANGED_EVENT, onCursorCfg)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener(CURSOR_TOAST_EVENT, onCursorToast)
      window.removeEventListener(CURSOR_CONFIG_CHANGED_EVENT, onCursorCfg)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  useViewCrossfade(
    boardContentRef,
    `${range}:${agent ?? 'all'}:${selectedNodeId ?? 'all'}:${selectedProjectDir ?? 'all'}`
  )

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 3500)
    return () => clearTimeout(timer)
  }, [toast])

  const nodeMetaById = useMemo(() => {
    const map = new Map<string, SessionNodeMeta>()
    if (!meshStatus) return map
    for (const n of meshStatus.nodes) {
      const entry: SessionNodeMeta = {
        label: nodeDisplayName(n),
        kind: n.kind,
        isLocal: n.isLocal
      }
      map.set(n.nodeId, entry)
      if (n.isLocal) map.set('local', entry)
    }
    return map
  }, [meshStatus])
  const multiNode = (meshStatus?.nodes.length ?? 0) > 1
  const meshOnlineCount = meshStatus?.nodes.filter((n) => n.status === 'online').length ?? 0

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

  const handleExport = async (format: ExportFormat = 'png'): Promise<void> => {
    const r = await nexus.exportReport(format, {
      range,
      agent,
      customStart: range === 'custom' ? customRange?.start : undefined,
      customEnd: range === 'custom' ? customRange?.end : undefined,
      nodeId: selectedNodeId,
      projectDir: selectedProjectDir
    })
    if (r.ok && r.path) setToast(t('toast.export.done', { path: r.path }))
    else if (!r.ok && !r.canceled) setToast(t('toast.export.failed', { err: r.error ?? t('toast.unknownError') }))
  }

  const exportScopeLabel = [
    t(`range.${range}`),
    agent ? agentLabels.get(agent) ?? agent : null,
    selectedProjectDir
      ? selectedProjectDir === '__unassigned__'
        ? t('chart.projectRank.unassigned')
        : shortDir(selectedProjectDir)
      : null
  ]
    .filter(Boolean)
    .join(' · ')

  const toggleTheme = async (): Promise<void> => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    await nexus.setTheme(next)
  }

  const changeUiStyle = async (next: 'nexus' | 'classic'): Promise<void> => {
    setUiStyle(next)
    await nexus.setUiStyle(next)
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

  const { histTokens, histLastActive } = useMemo(() => {
    if (agent) {
      const a = agents.find((x) => x.id === agent)
      return {
        histTokens: a?.totalTokens ?? 0,
        histLastActive: a?.lastActivityAt ?? null
      }
    }
    return {
      histTokens: agents.reduce((sum, a) => sum + (a.totalTokens ?? 0), 0),
      histLastActive:
        agents.reduce((m, a) => Math.max(m, a.lastActivityAt ?? 0), 0) || null
    }
  }, [agent, agents])

  const switchRangeQuick = (r: RangeKey): void => {
    useUi.getState().setRange(r)
    void nexus.setSavedRange(r)
  }

  // 图表 option（数据或主题变化时重建）
  const trendOpt = useMemo<EChartsOption | null>(() => {
    if (!data) return null
    return trendOption(
      data.trend,
      tokens,
      range === 'today' ? 'today' : 'week',
      trendGroup === 'agent'
        ? {
            colorOf: (key, i) => agentColors.get(key) ?? colorForIndex(tokens, i),
            labelOf: (key) => agentLabels.get(key) ?? key
          }
        : undefined
    )
  }, [data, tokens, range, trendGroup, agentColors, agentLabels])

  const trendLegend = useMemo(() => {
    if (!data) return null
    const totals = new Map<string, number>()
    for (const p of data.trend) {
      for (const [k, v] of Object.entries(p.series)) totals.set(k, (totals.get(k) ?? 0) + v)
    }
    const names = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k)
    return names.map((n, i) => (
      <LegendItem
        key={n}
        label={trendGroup === 'model' ? n : agentLabels.get(n) ?? n}
        color={
          trendGroup === 'agent'
            ? agentColors.get(n) ?? colorForIndex(tokens, i)
            : colorForIndex(tokens, i)
        }
      />
    ))
  }, [data, tokens, trendGroup, agentLabels, agentColors])

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

  // 支持跨 Agent 全局项目归因 & 单 Agent 工作区排行；柱条点击按工作区下钻过滤
  const { projectBarOpt, projectDirByName } = useMemo(() => {
    const dirMap = new Map<string, string>()
    if (!data || data.byProject.length === 0) {
      return { projectBarOpt: null, projectDirByName: dirMap }
    }
    const unassigned = t('chart.projectRank.unassigned')
    const stats: NamedStat[] = data.byProject.slice(0, 8).map((p) => {
      const displayName = p.projectDir ? p.name : unassigned
      dirMap.set(displayName, p.projectDir ?? '__unassigned__')
      return {
        name: displayName,
        tokens: p.tokens,
        requests: p.requests,
        input: p.input,
        output: p.output,
        cacheRead: p.cacheRead,
        cacheWrite: p.cacheWrite
      }
    })
    if (stats.length === 0) return { projectBarOpt: null, projectDirByName: dirMap }
    return {
      projectBarOpt: rankBarOption(stats, tokens, true, 'tokens'),
      projectDirByName: dirMap
    }
  }, [data, tokens])

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
      <GlobalCursorMount />
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
          {/* 标题栏品牌徽章：平面白底 + 轻阴影（PO 定稿：去立体感、留阴影） */}
          <span
            aria-hidden
            className="flex size-6 items-center justify-center overflow-hidden rounded-md bg-white shadow-[0_1px_3px_rgba(0,0,0,0.18)]"
          >
            <img src={nexusMark} alt="" className="h-auto w-4" draggable={false} />
          </span>
          <span className="text-ui-base font-medium">Nexus</span>
          <span className="hidden text-ui-sm text-foreground-subtlest xl:inline">{t('app.subtitle')}</span>
        </div>

        {/* 一级视图切换：总控看板 ↔ 算力组网 Mesh */}
        <nav
          aria-label="Primary views"
          style={{WebkitAppRegion: "no-drag"} as React.CSSProperties}
          className="relative isolate flex h-7 items-center rounded-full bg-surface p-0.5"
        >
          <SlidingTabIndicator activeSelector='button[data-active="true"]' />
          <button
            type="button"
            data-active={activeView === 'board' ? 'true' : undefined}
            onClick={() => setActiveView('board')}
            className={`relative z-10 flex h-6 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-ui-xs transition-colors duration-150 ${
              activeView === 'board'
                ? 'font-medium text-foreground'
                : 'text-foreground-subtle hover:text-foreground'
            }`}
          >
            <span>{t('nav.board')}</span>
          </button>
          <button
            type="button"
            data-active={activeView === 'mesh' ? 'true' : undefined}
            onClick={() => setActiveView('mesh')}
            className={`relative z-10 flex h-6 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-ui-xs transition-colors duration-150 ${
              activeView === 'mesh'
                ? 'font-medium text-foreground'
                : 'text-foreground-subtle hover:text-foreground'
            }`}
          >
            <MeshGlyph className="size-3.5 text-cobalt" />
            <span>{t('nav.mesh')}</span>
            {meshStatus && (
              <span className="rounded-full bg-card px-1.5 font-mono text-[10px] leading-4 tabular-nums text-foreground-subtle">
                {multiNode ? `${meshOnlineCount}/${meshStatus.nodes.length}` : meshOnlineCount}
              </span>
            )}
          </button>
        </nav>
        <button
          type="button"
          data-cmdk-trigger=""
          style={{WebkitAppRegion: "no-drag"} as React.CSSProperties}
          onClick={() => setCmdkOpen(true)}
          title={`${t('cmdk.button')} (Ctrl+K)`}
          className="hidden h-7 cursor-pointer items-center gap-1.5 rounded-full border border-hairline bg-surface px-2.5 text-ui-xs text-foreground-subtle transition-colors duration-150 hover:border-border hover:bg-hover hover:text-foreground sm:flex"
        >
          <span>{t('cmdk.button')}</span>
          <kbd className="rounded bg-card px-1 py-0.5 font-mono text-[10px] leading-none text-foreground-subtlest">
            Ctrl K
          </kbd>
        </button>
        <div className="flex-1" style={{WebkitAppRegion: "no-drag"} as React.CSSProperties} />
        {sync.phase === 'running' && (
          <span className="text-ui-xs text-foreground-subtle">{t('header.syncing')}</span>
        )}
        {activeView === 'board' && (
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
        )}
        <SystemPill />
        <AccountPanel />
        <IconButton style={{WebkitAppRegion: "no-drag"} as React.CSSProperties} title={t('header.action.syncNow')} onClick={() => void nexus.syncNow()} spinning={sync.phase === 'running'}>
          <RefreshIcon />
        </IconButton>
        <IconButton title={theme === 'dark' ? t('header.action.toggleLight') : t('header.action.toggleDark')} onClick={() => void toggleTheme()}>
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </IconButton>
        <ExportMenu scopeLabel={exportScopeLabel} onExport={handleExport} />
        {activeView === 'board' && (
          <button
            type="button"
            style={{WebkitAppRegion: "no-drag"} as React.CSSProperties}
            title={t('header.action.sessions')}
            onClick={() => setSessionsDrawerOpen((v) => !v)}
            className="flex h-7 items-center gap-1 rounded-lg px-2 text-ui-xs text-foreground-subtle transition-colors duration-150 hover:bg-hover hover:text-foreground 2xl:hidden"
          >
            <span>{t('sessions.title')}</span>
            <span className="rounded-full bg-surface px-1.5 font-mono text-[10px] tabular-nums text-foreground">
              {data?.sessions.length ?? 0}
            </span>
          </button>
        )}
        <IconButton style={{WebkitAppRegion: "no-drag"} as React.CSSProperties} title={t('header.action.settings')} onClick={() => void openSettings()}>
          <GearIcon />
        </IconButton>
        <WindowControls />
        {settingsOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setSettingsOpen(false)} />
            <div
              className="nx-fade-in nx-card-elevated absolute right-3 top-12 z-20 max-h-[84vh] w-[360px] overflow-y-auto rounded-xl border border-border bg-card p-4"
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
            <label className="mb-1 mt-3 block text-ui-xs text-foreground-subtle">{t('settings.uiStyle')}</label>
            <div className="relative isolate grid grid-cols-2 gap-1 rounded-lg border border-border bg-surface p-0.5">
              <SlidingTabIndicator
                activeSelector='button[data-active="true"]'
                className="rounded-md bg-selected"
              />
              {(
                [
                  ['nexus', t('settings.uiStyle.nexus')],
                  ['classic', t('settings.uiStyle.classic')]
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  data-active={uiStyle === id ? 'true' : undefined}
                  onClick={() => void changeUiStyle(id)}
                  className={`relative z-10 h-6 cursor-pointer rounded-md px-2 text-ui-xs transition-colors duration-150 ${
                    uiStyle === id
                      ? 'font-medium text-foreground'
                      : 'text-foreground-subtle hover:text-foreground'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="my-3 h-px bg-hairline" />
            <CursorSettingsSection />
            <SettingsPreferencesSection onToast={setToast} />
            <div className="my-3 h-px bg-hairline" />
            <label className="mb-1 block text-ui-xs text-foreground-subtle">{t('settings.retention')}</label>
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

      {/* 三栏看板 / 算力组网全画幅一级视图 */}
      <div className="flex min-h-0 flex-1 gap-1 p-1">
        {activeView === 'mesh' ? (
          <MeshView
            meshStatus={meshStatus}
            actions={meshActions}
            agents={agents}
            sessions={data?.sessions ?? []}
            agentLabels={agentLabels}
            quickPairNonce={quickPairNonce}
            onInspectNode={(nid) => {
              setSelectedNodeId(nid)
              setActiveView('board')
            }}
            onToast={setToast}
          />
        ) : (
          <>
            <AgentSidebar agents={agents} lastSyncAt={sync.finishedAt} />

            <SpotlightGroup
              as="main"
              style={{ opacity: loading ? 0.55 : 1 }}
              className="nx-shell-bg min-w-0 flex-1 space-y-4 overflow-y-auto rounded-xl border border-hairline bg-panel p-4 transition-opacity duration-150"
            >
              <NodeSwitcherBar
                meshStatus={meshStatus}
                selectedNodeId={selectedNodeId}
                onSelectNode={setSelectedNodeId}
                onOpenMeshView={() => setActiveView('mesh')}
              />
              {selectedProjectDir && (
                <div
                  data-project-filter-chip=""
                  className="nx-fade-in flex flex-wrap items-center justify-between gap-2 rounded-xl border border-cobalt/35 bg-cobalt/10 px-3.5 py-2 text-ui-xs"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 font-medium text-cobalt">{t('projectFilter.label')}</span>
                    <span
                      className="min-w-0 truncate font-mono text-foreground"
                      title={selectedProjectDir === '__unassigned__' ? t('chart.projectRank.unassigned') : selectedProjectDir}
                    >
                      {selectedProjectDir === '__unassigned__'
                        ? t('chart.projectRank.unassigned')
                        : `${shortDir(selectedProjectDir)} · ${selectedProjectDir}`}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {selectedProjectDir !== '__unassigned__' && (
                      <button
                        type="button"
                        onClick={() => void nexus.openPath(selectedProjectDir).catch(() => undefined)}
                        className="rounded-md border border-hairline bg-card px-2 py-0.5 text-[11px] text-foreground transition-colors hover:bg-hover"
                      >
                        {t('projectFilter.openDir')}
                      </button>
                    )}
                    <button
                      type="button"
                      data-clear-project-filter=""
                      onClick={() => setSelectedProjectDir(null)}
                      className="rounded-md bg-card px-2 py-0.5 text-[11px] text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground"
                    >
                      × {t('projectFilter.clear')}
                    </button>
                  </div>
                </div>
              )}
              <div ref={boardContentRef} className="space-y-4">
              {!data ? (
            <EmptyState title={t('empty.loading.title')} description={t('empty.loading.desc')} />
          ) : totalTokens === 0 && data.sessions.length === 0 ? (
            <div className="space-y-3">
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
              {histTokens > 0 && range !== 'all' && (
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => switchRangeQuick('7d')}
                    className="rounded-lg bg-surface px-3 py-1.5 text-ui-xs font-medium text-foreground transition-colors duration-150 hover:bg-hover"
                  >
                    {t('banner.switch7d')}
                  </button>
                  <button
                    type="button"
                    onClick={() => switchRangeQuick('30d')}
                    className="rounded-lg bg-surface px-3 py-1.5 text-ui-xs font-medium text-foreground transition-colors duration-150 hover:bg-hover"
                  >
                    {t('banner.switch30d')}
                  </button>
                  <button
                    type="button"
                    onClick={() => switchRangeQuick('all')}
                    className="rounded-lg bg-chart-1 px-3 py-1.5 text-ui-xs font-medium text-white transition-opacity duration-150 hover:opacity-90"
                  >
                    {t('banner.switchAll')} ({compactNumber(histTokens)})
                  </button>
                </div>
              )}
            </div>
          ) : (
            <>
              {/* 当前时间范围无 Token 但历史有消耗时的智能引导横幅 */}
              {totalTokens === 0 && histTokens > 0 && range !== 'all' && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface px-4 py-2.5 text-ui-xs text-foreground-subtle">
                  <span>
                    {t('banner.rangeEmpty', {
                      range: t(`range.${range}`),
                      tokens: compactNumber(histTokens),
                      last: relativeTime(histLastActive)
                    })}
                  </span>
                  <span className="flex items-center gap-1.5">
                    {range !== '7d' && (
                      <button
                        type="button"
                        onClick={() => switchRangeQuick('7d')}
                        className="rounded-md bg-raised px-2 py-1 text-ui-xs text-foreground transition-colors duration-150 hover:bg-hover"
                      >
                        {t('banner.switch7d')}
                      </button>
                    )}
                    {range !== '30d' && (
                      <button
                        type="button"
                        onClick={() => switchRangeQuick('30d')}
                        className="rounded-md bg-raised px-2 py-1 text-ui-xs text-foreground transition-colors duration-150 hover:bg-hover"
                      >
                        {t('banner.switch30d')}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => switchRangeQuick('all')}
                      className="rounded-md bg-chart-1 px-2.5 py-1 text-ui-xs font-medium text-white transition-opacity duration-150 hover:opacity-90"
                    >
                      {t('banner.switchAll')}
                    </button>
                  </span>
                </div>
              )}
              {/* KPI 矩阵 */}
              <div
                style={{ opacity: loading ? 0.55 : 1 }}
                className="grid grid-cols-2 gap-4 transition-opacity duration-150 2xl:grid-cols-4"
              >
                <KpiCard
                  label={t('kpi.tokens')}
                  indexTag="01"
                  accent="signal"
                  featured={agents.some((a) => a.status === 'active')}
                  progressPct={
                    range !== 'all' && histTokens > 0
                      ? (totalTokens / histTokens) * 100
                      : totalTokens > 0
                        ? 100
                        : 0
                  }
                  value={<AnimatedNumber num={totalTokens} />}
                  sub={t('kpi.tokens.sub', { tokens: fullNumber(totalTokens), n: data.overview.totals.requests })}
                />
                <KpiCard
                  label={t('kpi.sessions')}
                  indexTag="02"
                  accent="cobalt"
                  progressPct={
                    agents.length > 0
                      ? (agents.filter((a) => (a.rangeTokens ?? a.todayTokens) > 0).length /
                          agents.length) *
                        100
                      : 0
                  }
                  value={<AnimatedNumber num={data.overview.sessionCount} />}
                  sub={t('kpi.sessions.sub', { n: data.overview.activeModels })}
                />
                <KpiCard
                  label={t('kpi.tools')}
                  indexTag="03"
                  accent="success"
                  progressPct={
                    data.tools.length && data.overview.toolCallCount > 0
                      ? (data.tools[0].count / data.overview.toolCallCount) * 100
                      : 0
                  }
                  value={<AnimatedNumber num={data.overview.toolCallCount} />}
                  sub={data.tools.length ? t('kpi.tools.top', { tool: data.tools[0].tool }) : t('kpi.tools.none')}
                />
                <KpiCard
                  label={t('kpi.cost')}
                  indexTag="04"
                  accent="signal"
                  progressPct={cacheHit ?? undefined}
                  value={
                    <AnimatedNumber
                      num={data.overview.totals.estimatedCostUsd}
                      compactFormat={(n) => formatCost(n, pricingConfig)}
                      fullFormat={(n) => formatCostPrecise(n, pricingConfig)}
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

              {/* Agent 占比 / 跨 Agent 全局项目归因 + 模型排行 */}
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                <ChartCard
                  title={agent || leftChartMode === 'project' ? t('chart.projectRank') : t('chart.agentShare')}
                  actions={
                    <div className="flex items-center gap-1.5">
                      {!agent && (
                        <PillSwitcher
                          options={[
                            { key: 'agent' as const, label: t('chart.shareMode.agent') },
                            { key: 'project' as const, label: t('chart.shareMode.project') }
                          ]}
                          value={leftChartMode}
                          onChange={setLeftChartMode}
                        />
                      )}
                      {agent && (
                        <button
                          type="button"
                          onClick={() => setAgent(null)}
                          className="rounded-lg px-2 py-0.5 text-ui-xs text-foreground-subtle transition-colors duration-150 hover:bg-hover hover:text-foreground"
                        >
                          {t('chart.agentShare.filtered', { agent: agentLabels.get(agent) ?? agent })}
                        </button>
                      )}
                    </div>
                  }
                >
                  {agent || leftChartMode === 'project' ? (
                    projectBarOpt != null ? (
                      <div title={t('chart.projectRank.drill')}>
                        <EChart
                          option={projectBarOpt}
                          className="h-60 w-full"
                          onClick={(name) => {
                            const dir = projectDirByName.get(name)
                            if (dir) setSelectedProjectDir(selectedProjectDir === dir ? null : dir)
                          }}
                        />
                      </div>
                    ) : (
                      <EmptyState title={t('chart.empty.title')} description={t('chart.projectRank.empty.desc')} />
                    )
                  ) : agentDonutOpt != null ? (
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

              {/* 热力图 + 工具排行（视口下方随滚动显现） */}
              <ScrollReveal delayMs={40}>
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
              </ScrollReveal>

              {/* 每日强度（视口下方随滚动显现） */}
              {dailyBarOpt != null && (
                <ScrollReveal delayMs={70}>
                  <ChartCard title={t('chart.daily')}>
                    <EChart option={dailyBarOpt} className="h-48 w-full" />
                  </ChartCard>
                </ScrollReveal>
              )}
            </>
          )}
              </div>
            </SpotlightGroup>

            <div className="hidden 2xl:flex">
              <SessionsPanel
                sessions={data?.sessions ?? []}
                agentColors={agentColors}
                nodeMetaById={nodeMetaById}
                multiNode={multiNode}
                selectedSessionKey={
                  inspectedSession
                    ? `${inspectedSession.sourceNodeId ?? 'local'}:${inspectedSession.agent}:${inspectedSession.sessionId}`
                    : null
                }
                onSelectSession={(s) => setInspectedSession(s)}
              />
            </div>
            {sessionsDrawerOpen && (
              <div className="fixed inset-0 z-30 flex justify-end 2xl:hidden">
                <div
                  className="fixed inset-0 bg-black/40"
                  onClick={() => setSessionsDrawerOpen(false)}
                />
                <div className="nx-fade-in relative z-10 h-full border-l border-border shadow-xl">
                  <SessionsPanel
                    sessions={data?.sessions ?? []}
                    agentColors={agentColors}
                    nodeMetaById={nodeMetaById}
                    multiNode={multiNode}
                    selectedSessionKey={
                      inspectedSession
                        ? `${inspectedSession.sourceNodeId ?? 'local'}:${inspectedSession.agent}:${inspectedSession.sessionId}`
                        : null
                    }
                    onSelectSession={(s) => {
                      setSessionsDrawerOpen(false)
                      setInspectedSession(s)
                    }}
                    onClose={() => setSessionsDrawerOpen(false)}
                  />
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* 会话深度透视抽屉 */}
      <SessionInspectorDrawer
        session={inspectedSession}
        agentLabel={inspectedSession ? agentLabels.get(inspectedSession.agent) ?? inspectedSession.agent : ''}
        agentColor={
          inspectedSession
            ? agentColors.get(inspectedSession.agent) ?? tokens.series[0]
            : tokens.series[0]
        }
        onClose={() => setInspectedSession(null)}
        onFilterProject={(dir) => {
          setSelectedProjectDir(dir)
          setActiveView('board')
        }}
      />

      {/* Ctrl+K 全局命令面板 */}
      <CommandPalette
        open={cmdkOpen}
        onClose={() => setCmdkOpen(false)}
        activeView={activeView}
        onSelectView={setActiveView}
        range={range}
        onSelectRange={switchRangeQuick}
        nodes={meshStatus?.nodes ?? []}
        selectedNodeId={selectedNodeId}
        onSelectNode={setSelectedNodeId}
        projects={data?.byProject ?? []}
        selectedProjectDir={selectedProjectDir}
        onSelectProjectDir={setSelectedProjectDir}
        agents={agents}
        selectedAgent={agent}
        onSelectAgent={setAgent}
        theme={theme}
        onToggleTheme={() => void toggleTheme()}
        uiStyle={uiStyle}
        onToggleUiStyle={() => void changeUiStyle(uiStyle === 'nexus' ? 'classic' : 'nexus')}
        lang={getLang()}
        onToggleLang={() => {
          const next: Lang = getLang() === 'zh-CN' ? 'en' : 'zh-CN'
          setLang(next)
          void nexus.setTheme(theme)
        }}
        cursorEnabled={cursorEnabled}
        onToggleCursor={() => {
          const next = !readCursorEnabled()
          if (next) clearCursorDegraded()
          writeCursorEnabled(next)
        }}
        onSyncNow={() => void nexus.syncNow()}
        onExportFormat={(fmt) => void handleExport(fmt)}
        onOpenSettings={() => void openSettings()}
        onQuickPair={() => {
          setActiveView('mesh')
          setQuickPairNonce((n) => n + 1)
        }}
      />

      {/* Toast */}
      {toast && (
        <div className="nx-fade-in fixed bottom-4 right-4 max-w-md rounded-lg border border-border bg-card px-3 py-1.5 text-ui-sm text-foreground">
          {toast}
        </div>
      )}
    </div>
  )
}
