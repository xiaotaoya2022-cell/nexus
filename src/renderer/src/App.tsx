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
import { SystemCard } from './components/SystemCard'
import { QuotaCard } from './components/QuotaCard'
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
  const setTheme = useUi((s) => s.setTheme)
  const setAgent = useUi((s) => s.setAgent)
  const sync = useUi((s) => s.sync)
  const { data, agents, trendGroup, setTrendGroup } = useDashboard()
  const [toast, setToast] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [retention, setRetention] = useState<number>(0)
  const [remoteOn, setRemoteOn] = useState(false)
  const [remoteStatus, setRemoteStatus] = useState<Awaited<ReturnType<typeof nexus.getRemoteStatus>> | null>(null)
  const [pairing, setPairing] = useState<Awaited<ReturnType<typeof nexus.regeneratePairing>> | null>(null)
  const [quotaPlatforms, setQuotaPlatforms] = useState<Awaited<ReturnType<typeof nexus.quotaPlatforms>>>([])

  // 启动时读取主题设置
  useEffect(() => {
    void (async () => {
      const s = await nexus.getSettings()
      useUi.getState().setTheme(s.theme)
    })()
  }, [])

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
    if (r.ok && r.path) setToast(`看板已导出：${r.path}`)
    else if (!r.ok && !r.canceled) setToast(`导出失败：${r.error ?? '未知错误'}`)
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
      setQuotaPlatforms(await nexus.quotaPlatforms())
    }
    setSettingsOpen((v) => !v)
  }

  const changeRetention = async (days: number): Promise<void> => {
    const v = await nexus.setRetentionDays(days)
    setRetention(v)
    setToast(days > 0 ? `数据保留 ${days} 天，下轮同步后生效` : '数据永久保留')
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
    return rankBarOption(data.tools, tokens, false, '次')
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
      {/* 顶栏 */}
      <header className="relative flex h-12 shrink-0 items-center gap-4 border-b border-border bg-panel px-4">
        <div className="flex items-baseline gap-2">
          <span className="text-ui-base font-medium">Nexus</span>
          <span className="text-ui-sm text-foreground-subtlest">本地算力监控</span>
        </div>
        <div className="flex-1" />
        {sync.phase === 'running' && (
          <span className="text-ui-xs text-foreground-subtle">同步中…</span>
        )}
        <PillSwitcher options={RANGE_OPTIONS} value={range} onChange={(r: RangeKey) => useUi.getState().setRange(r)} />
        <IconButton title="立即同步" onClick={() => void nexus.syncNow()} spinning={sync.phase === 'running'}>
          <RefreshIcon />
        </IconButton>
        <IconButton title={theme === 'dark' ? '切换亮色' : '切换暗色'} onClick={() => void toggleTheme()}>
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </IconButton>
        <IconButton title="导出看板为图片" onClick={() => void handleExport()}>
          <ExportIcon />
        </IconButton>
        <IconButton title="设置" onClick={() => void openSettings()}>
          <GearIcon />
        </IconButton>
        {settingsOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setSettingsOpen(false)} />
            <div
              className="nx-fade-in absolute right-3 top-12 z-20 w-72 rounded-xl border border-border bg-card p-4"
              role="dialog"
            >
            <div className="mb-3 text-ui-base font-medium">设置</div>
            <label className="mb-1 block text-ui-xs text-foreground-subtle">数据保留</label>
            <select
              value={retention}
              onChange={(e) => void changeRetention(Number(e.target.value))}
              className="h-7 w-full rounded-lg border border-border bg-card px-2 text-ui-base text-foreground"
            >
              <option value={0}>永久保留（推荐）</option>
              <option value={90}>保留 90 天</option>
              <option value={180}>保留 180 天</option>
              <option value={365}>保留 365 天</option>
            </select>
            <div className="mt-1 text-ui-xs text-foreground-subtlest">
              清理仅作用于 Nexus 自有库，不改任何 Agent 数据。
            </div>
            <button
              type="button"
              onClick={() => {
                void nexus.getDataDir().then((dir) => nexus.openPath(dir))
              }}
              className="mt-3 h-7 w-full rounded-lg bg-secondary px-2 text-ui-base text-foreground transition-colors duration-150 hover:bg-surface-hover"
            >
              打开数据目录
            </button>

            <div className="my-3 h-px bg-hairline" />
            <div className="mb-1 text-ui-xs text-foreground-subtle">账号与配额</div>
            {quotaPlatforms.length === 0 ? (
              <div className="text-ui-xs text-foreground-subtlest">加载中…</div>
            ) : (
              <div className="flex flex-col gap-1">
                {quotaPlatforms.map((p) => (
                  <div key={p.id} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-ui-sm text-foreground" title={p.id}>
                      {p.label}
                      {p.accountCount > 0 && (
                        <span className="ml-1 font-mono text-ui-xs text-foreground-subtlest">
                          {p.accountCount} 账号
                        </span>
                      )}
                    </span>
                    {p.oauthSupported ? (
                      <button
                        type="button"
                        onClick={() => {
                          void nexus
                            .quotaLogin(p.id)
                            .then(() => setToast(`${p.label} 登录成功，配额稍后自动刷新`))
                            .catch((err) =>
                              setToast(`登录失败：${err instanceof Error ? err.message : String(err)}`)
                            )
                        }}
                        className="h-6 shrink-0 rounded-lg bg-secondary px-2 text-ui-xs text-foreground transition-colors duration-150 hover:bg-surface-hover"
                      >
                        登录
                      </button>
                    ) : (
                      <span className="shrink-0 text-ui-xs text-foreground-subtlest">待接入</span>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="mt-1 text-ui-xs text-foreground-subtlest">
              Cursor / Codex CLI 的本机登录态会自动导入；其余平台登录能力陆续接入。
            </div>

            <div className="my-3 h-px bg-hairline" />
            <div className="mb-1 text-ui-xs text-foreground-subtle">远程访问（局域网）</div>
            <div className="flex items-center justify-between">
              <span className="text-ui-sm text-foreground">{remoteOn ? '已开启' : '已关闭'}</span>
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
                {remoteOn ? '关闭' : '开启'}
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
                  生成配对二维码（60 秒有效）
                </button>
                {pairing?.qrDataUrl && (
                  <div className="mt-2 flex flex-col items-center gap-1">
                    <img src={pairing.qrDataUrl} alt="配对二维码" className="h-40 w-40 rounded-lg border border-border" />
                    <span className="font-mono text-ui-sm tabular-nums text-foreground-subtle">
                      PIN {pairing.pin}
                    </span>
                  </div>
                )}
                {remoteStatus && remoteStatus.devices.length > 0 && (
                  <div className="mt-2">
                    <div className="mb-1 text-ui-xs text-foreground-subtle">已配对设备</div>
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
                          撤销
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

        <main className="min-w-0 flex-1 space-y-4 overflow-y-auto rounded-xl border border-hairline bg-panel p-4">
          {!data ? (
            <EmptyState title="正在加载数据" description="首次同步可能需要几秒钟。" />
          ) : totalTokens === 0 && data.sessions.length === 0 ? (
            <EmptyState
              title="暂无用量数据"
              description="未在任何已接入 Agent 的本地数据源中发现 Token 记录。请确认对应 Agent 已产生对话，或切换时间范围。"
            />
          ) : (
            <>
              {/* 系统状态 */}
              <SystemCard />

              {/* 账号配额 */}
              <QuotaCard />

              {/* KPI 矩阵 */}
              <div className="grid grid-cols-2 gap-4 2xl:grid-cols-4">
                <KpiCard
                  label="Token 消耗"
                  value={<AnimatedNumber num={totalTokens} />}
                  sub={`${fullNumber(totalTokens)} tokens · ${data.overview.totals.requests} 次请求`}
                />
                <KpiCard
                  label="活跃会话"
                  value={<AnimatedNumber num={data.overview.sessionCount} />}
                  sub={`涉及 ${data.overview.activeModels} 个模型`}
                />
                <KpiCard
                  label="工具调用"
                  value={<AnimatedNumber num={data.overview.toolCallCount} />}
                  sub={data.tools.length ? `最高频 ${data.tools[0].tool}` : '范围内无记录'}
                />
                <KpiCard
                  label="估算成本"
                  value={
                    <AnimatedNumber
                      num={data.overview.totals.estimatedCostUsd}
                      compactFormat={formatCost}
                      fullFormat={(n) => `$${n.toFixed(4)}`}
                    />
                  }
                  sub="按公开牌价折算，仅供参考"
                />
              </div>

              {/* 趋势 + Token 类型 */}
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                <ChartCard
                  title="Token 趋势"
                  className="xl:col-span-2"
                  actions={
                    <PillSwitcher
                      options={[
                        { key: 'model', label: '按模型' },
                        { key: 'agent', label: '按 Agent' }
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
                    <EmptyState title="暂无趋势数据" description="当前范围内没有 Token 消耗记录。" />
                  )}
                </ChartCard>
                <ChartCard title="Token 类型">
                  {typeOpt != null ? (
                    <>
                      <EChart option={typeOpt} className="h-44 w-full" />
                      <div className="flex flex-wrap gap-x-3 gap-y-2">
                        {data.breakdown
                          .filter((b) => b.tokens > 0)
                          .map((b, i) => (
                            <LegendItem
                              key={b.key}
                              label={`${b.label} ${compactNumber(b.tokens)}`}
                              color={colorForIndex(tokens, TOKEN_TYPE_COLORS.find((t) => t.key === b.key)?.colorVarIndex ?? i)}
                            />
                          ))}
                      </div>
                    </>
                  ) : (
                    <EmptyState title="暂无数据" description="当前范围内没有 Token 记录。" />
                  )}
                </ChartCard>
              </div>

              {/* Agent 占比 + 模型排行 */}
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                <ChartCard
                  title="Agent 占比"
                  actions={
                    agent ? (
                      <button
                        type="button"
                        onClick={() => setAgent(null)}
                        className="rounded-lg px-2 py-0.5 text-ui-xs text-foreground-subtle transition-colors duration-150 hover:bg-hover hover:text-foreground"
                      >
                        已筛选 {agentLabels.get(agent) ?? agent} · 取消
                      </button>
                    ) : (
                      <span className="text-ui-xs text-foreground-subtlest">点击扇区可下钻</span>
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
                    <EmptyState title="暂无数据" description="当前范围内没有 Token 记录。" />
                  )}
                </ChartCard>
                <div className="xl:col-span-2">
                  <ChartCard title="模型排行 · Token">
                    {modelBarOpt != null ? (
                      <EChart option={modelBarOpt} className="h-60 w-full" />
                    ) : (
                      <EmptyState title="暂无数据" description="当前范围内没有模型调用记录。" />
                    )}
                  </ChartCard>
                </div>
              </div>

              {/* 热力图 + 工具排行 */}
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                <div className="xl:col-span-2">
                  <ChartCard
                    title="活跃热力图 · 7×24"
                    actions={
                      <span className="text-ui-xs text-foreground-subtlest">
                        {cacheHit != null ? `缓存命中率 ${cacheHit.toFixed(1)}%` : ''}
                      </span>
                    }
                  >
                    <EChart option={heatmapOpt ?? {}} className="h-48 w-full" />
                  </ChartCard>
                </div>
                <ChartCard title="工具调用排行">
                  {toolBarOpt != null ? (
                    <EChart option={toolBarOpt} className="h-48 w-full" />
                  ) : (
                    <EmptyState title="暂无工具调用" description="该 Agent 尚未上报工具调用数据。" />
                  )}
                </ChartCard>
              </div>

              {/* 每日强度 */}
              {dailyBarOpt != null && (
                <ChartCard title="每日强度 · 按日 Token">
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
