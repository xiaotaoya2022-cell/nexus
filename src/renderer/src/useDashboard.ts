// 看板数据 Hook：按 [range, agent, trendGroup] 拉取全部看板数据；
// 同步完成后自动刷新（主进程每 60s 增量同步一次并广播）。

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentInfo,
  BoardData,
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
  loading: boolean
  trendGroup: 'model' | 'agent'
  setTrendGroup: (g: 'model' | 'agent') => void
  reload: () => Promise<void>
} {
  const range = useUi((s) => s.range)
  const agent = useUi((s) => s.agent)
  const [data, setData] = useState<DashboardData | null>(null)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [trendGroup, setTrendGroup] = useState<'model' | 'agent'>('model')
  // 双分组趋势都随 getBoard 一次取回，切换"按模型/按 Agent"零查询
  const trendRef = useRef<BoardData | null>(null)
  const reloadRef = useRef<() => Promise<void>>(async () => {})
  const reloadSeq = useRef(0)

  const reload = useCallback(async (): Promise<void> => {
    // getCalendar 通道保留在 IPC 契约中备用，看板已改用 trend 呈现每日强度（红队 N-16）
    const seq = ++reloadSeq.current
    setLoading(true)
    try {
      const [board, agentInfos] = await Promise.all([
        nexus.getBoard(range, agent),
        nexus.getAgents()
      ])
      if (seq !== reloadSeq.current) return // 过期响应丢弃（竞态守卫）
      trendRef.current = board
      setData({
        overview: board.overview,
        trend: trendGroup === 'model' ? board.trendByModel : board.trendByAgent,
        byAgent: board.byAgent,
        byModel: board.byModel,
        breakdown: board.breakdown,
        heatmap: board.heatmap,
        tools: board.tools,
        sessions: board.sessions
      })
      setAgents(agentInfos)
    } finally {
      if (seq === reloadSeq.current) setLoading(false)
    }
  }, [range, agent, trendGroup])

  // 切换趋势分组：数据已在手，仅重选 series，零查询
  useEffect(() => {
    const board = trendRef.current
    if (!board) return
    setData((prev) =>
      prev
        ? { ...prev, trend: trendGroup === 'model' ? board.trendByModel : board.trendByAgent }
        : prev
    )
  }, [trendGroup])

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

  return { data, agents, loading, trendGroup, setTrendGroup, reload }
}
