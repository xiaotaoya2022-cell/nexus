// 看板数据 Hook：按 [range, agent, trendGroup] 拉取全部看板数据；
// 同步完成后自动刷新（主进程每 60s 增量同步一次并广播）。

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentInfo,
  BoardData,
  HeatmapData,
  NamedStat,
  Overview,
  ProjectStat,
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
  byProject: ProjectStat[]
  breakdown: TokenTypeStat[]
  heatmap: HeatmapData
  tools: ToolStat[]
  sessions: SessionRow[]
}

/** 看板变化签名：覆盖看板全部数据切片（总量/分布/趋势双分组/热力图/工具/会话边界）。
    60s 周期刷新数据无变化时跳过 setData —— data 引用稳定，全部图表 useMemo /
    EChart effect 自动短路，主线程不再出现"无变化也全量重建 8 图"的长任务。 */
function boardSignature(board: BoardData): string {
  const sessions = board.sessions
  const trendSig = (points: TrendPoint[]): string =>
    points.map((p) => `${p.total}:${Object.values(p.series).join('.')}`).join(',')
  return [
    board.overview.totals.total,
    board.overview.totals.requests,
    board.overview.totals.estimatedCostUsd,
    board.overview.sessionCount,
    board.overview.toolCallCount,
    board.byModel.map((m) => `${m.name}:${m.tokens}:${m.requests}`).join(','),
    board.byAgent.map((a) => `${a.name}:${a.tokens}`).join(','),
    board.byProject.map((p) => `${p.projectDir ?? ''}:${p.tokens}:${p.estimatedCostUsd}`).join(','),
    trendSig(board.trendByModel),
    trendSig(board.trendByAgent),
    board.breakdown.map((b) => `${b.key}:${b.tokens}`).join(','),
    board.heatmap.cells.map((c) => c.join(',')).join(';'),
    board.tools.map((tool) => `${tool.tool}:${tool.count}`).join(','),
    sessions.length,
    sessions.length > 0 ? `${sessions[0].sessionId}:${sessions[0].updatedAt ?? 0}` : ''
  ].join('|')
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
  const selectedNodeId = useUi((s) => s.selectedNodeId)
  const selectedProjectDir = useUi((s) => s.selectedProjectDir)
  const customRange = useUi((s) => s.customRange)
  const pricingRevision = useUi((s) => s.pricingRevision)
  const [data, setData] = useState<DashboardData | null>(null)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [trendGroup, setTrendGroup] = useState<'model' | 'agent'>('model')
  // 双分组趋势都随 getBoard 一次取回，切换"按模型/按 Agent"零查询
  const trendRef = useRef<BoardData | null>(null)
  const reloadRef = useRef<() => Promise<void>>(async () => {})
  const reloadSeq = useRef(0)
  const boardSigRef = useRef('')

  const reload = useCallback(async (): Promise<void> => {
    // getCalendar 通道保留在 IPC 契约中备用，看板已改用 trend 呈现每日强度（红队 N-16）
    const seq = ++reloadSeq.current
    setLoading(true)
    useUi.getState().setBoardLoading(true)
    try {
      const custom = range === 'custom' && customRange ? customRange : undefined
      const [board, agentInfos] = await Promise.all([
        nexus.getBoard(
          range,
          agent,
          custom?.start,
          custom?.end,
          selectedNodeId,
          selectedProjectDir
        ),
        nexus.getAgents(
          range,
          custom?.start,
          custom?.end,
          selectedNodeId,
          selectedProjectDir
        )
      ])
      if (seq !== reloadSeq.current) return // 过期响应丢弃（竞态守卫）
      trendRef.current = board
      // 签名门控：数据无变化时跳过 setData（data 引用稳定 → 图表全链路短路）。
      // 60s 周期刷新在无新用量时不再触发 8 图全量重建（主线程长任务主源）。
      const sig = boardSignature(board)
      if (sig !== boardSigRef.current) {
        boardSigRef.current = sig
        setData({
          overview: board.overview,
          trend: trendGroup === 'model' ? board.trendByModel : board.trendByAgent,
          byAgent: board.byAgent,
          byModel: board.byModel,
          byProject: board.byProject,
          breakdown: board.breakdown,
          heatmap: board.heatmap,
          tools: board.tools,
          sessions: board.sessions
        })
      }
      setAgents(agentInfos)
    } finally {
      if (seq === reloadSeq.current) {
        setLoading(false)
        useUi.getState().setBoardLoading(false)
      }
    }
  }, [range, agent, selectedNodeId, selectedProjectDir, trendGroup, customRange, pricingRevision])

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
    const unsubSync = nexus.onSyncProgress((p) => {
      useUi.getState().setSync(p)
      if (p.phase === 'done') void reloadRef.current()
    })
    let lastMeshRecordsSig: string | null = null
    const unsubMesh = nexus.onMeshUpdate((status) => {
      const sig = status.nodes
        .filter((n) => !n.isLocal)
        .map((n) => `${n.nodeId}:${n.recordCount}:${n.totalTokens}`)
        .join('|')
      if (lastMeshRecordsSig !== null && sig !== lastMeshRecordsSig) {
        void reloadRef.current()
      }
      lastMeshRecordsSig = sig
    })
    return () => {
      unsubSync()
      unsubMesh()
    }
  }, [])

  return { data, agents, loading, trendGroup, setTrendGroup, reload }
}
