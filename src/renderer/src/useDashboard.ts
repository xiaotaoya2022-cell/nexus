// 看板数据 Hook：按 [range, agent, trendGroup] 拉取全部看板数据；
// 同步完成后自动刷新（主进程每 60s 增量同步一次并广播）。

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentInfo,
  HeatmapData,
  NamedStat,
  Overview,
  SessionRow,
  TokenTypeStat,
  ToolStat,
  TrendPoint
} from '@shared/types'
import { nexus } from './lib/api'
import { useUi } from './store'

export interface DashboardData {
  overview: Overview
  trend: TrendPoint[]
  byAgent: NamedStat[]
  byModel: NamedStat[]
  breakdown: TokenTypeStat[]
  heatmap: HeatmapData
  tools: ToolStat[]
  sessions: SessionRow[]
}

export function useDashboard(): {
  data: DashboardData | null
  agents: AgentInfo[]
  trendGroup: 'model' | 'agent'
  setTrendGroup: (g: 'model' | 'agent') => void
  reload: () => Promise<void>
} {
  const range = useUi((s) => s.range)
  const agent = useUi((s) => s.agent)
  const [data, setData] = useState<DashboardData | null>(null)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [trendGroup, setTrendGroup] = useState<'model' | 'agent'>('model')
  const reloadRef = useRef<() => Promise<void>>(async () => {})
  const reloadSeq = useRef(0)

  const reload = useCallback(async (): Promise<void> => {
    // getCalendar 通道保留在 IPC 契约中备用，看板已改用 trend 呈现每日强度（红队 N-16）
    const seq = ++reloadSeq.current
    const [overview, trend, byAgent, byModel, breakdown, heatmap, tools, sessions, agentInfos] =
      await Promise.all([
        nexus.getOverview(range, agent),
        nexus.getTrend(range, agent, trendGroup),
        nexus.getByAgent(range),
        nexus.getByModel(range, agent),
        nexus.getTokenTypeBreakdown(range, agent),
        nexus.getHeatmap(range, agent),
        nexus.getToolStats(range, agent),
        nexus.getSessions(range, agent, 120),
        nexus.getAgents()
      ])
    if (seq !== reloadSeq.current) return // 过期响应丢弃（竞态守卫）
    setData({ overview, trend, byAgent, byModel, breakdown, heatmap, tools, sessions })
    setAgents(agentInfos)
  }, [range, agent, trendGroup])

  reloadRef.current = reload

  useEffect(() => {
    reload().catch((err) => {
      // 拉取失败静默保留旧数据，控制台可见（避免 unhandled rejection）
      console.error('dashboard reload failed', err)
    })
  }, [reload])

  useEffect(() => {
    void nexus.getSyncStatus().then((p) => useUi.getState().setSync(p))
    const unsub = nexus.onSyncProgress((p) => {
      useUi.getState().setSync(p)
      if (p.phase === 'done') void reloadRef.current()
    })
    return unsub
  }, [])

  return { data, agents, trendGroup, setTrendGroup, reload }
}
