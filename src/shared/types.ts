// Nexus 共享类型：主进程 / preload / 渲染进程共用。
// 只放纯数据结构与 API 契约，禁止引入 Node 专用模块。

export type RangeKey = 'today' | '7d' | '30d' | 'month' | 'year' | 'all'

export type AgentStatus = 'active' | 'idle' | 'offline' | 'nodata'

export interface TokenTotals {
  requests: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  estimatedCostUsd: number
}

export interface Overview {
  range: RangeKey
  agent: string | null
  totals: TokenTotals
  sessionCount: number
  toolCallCount: number
  activeModels: number
}

export interface TrendPoint {
  bucket: string // 日期 YYYY-MM-DD 或今日的小时 HH:00
  total: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  series: Record<string, number> // 分组维度（模型/Agent）→ token 数
}

export interface NamedStat {
  name: string
  tokens: number
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface TokenTypeStat {
  key: 'input' | 'output' | 'reasoning' | 'cacheRead' | 'cacheWrite'
  label: string
  tokens: number
}

export interface HeatmapData {
  cells: Array<[hour: number, weekday: number, tokens: number]> // hour 0-23, weekday 0(周一)-6
  max: number
}

export interface CalendarDay {
  day: string // YYYY-MM-DD
  tokens: number
}

export interface ToolStat {
  tool: string
  count: number
}

export interface AgentInfo {
  id: string
  label: string
  detected: boolean
  status: AgentStatus
  todayTokens: number
  todayRequests: number
  lastActivityAt: number | null
  sessionCount: number
  note: string | null // 如"无本地用量数据（云端存储）"
}

export interface SessionRow {
  agent: string
  sessionId: string
  title: string | null
  projectDir: string | null
  model: string | null
  startedAt: number | null
  updatedAt: number | null
  tokens: number
  requests: number
}

export interface SyncProgress {
  phase: 'idle' | 'running' | 'done' | 'error'
  agent: string | null
  message: string
  startedAt: number
  finishedAt: number | null
  results: Array<{ agent: string; records: number; sessions: number; tools: number; error: string | null }>
}

export interface Settings {
  theme: 'dark' | 'light'
}

export interface TimeRange {
  sinceMs: number
  untilMs: number
  bucket: 'hour' | 'day'
}

// ── IPC 契约（renderer 经 window.nexus 调用）──
export interface NexusApi {
  getOverview(range: RangeKey, agent: string | null): Promise<Overview>
  getTrend(range: RangeKey, agent: string | null, groupBy: 'model' | 'agent'): Promise<TrendPoint[]>
  getByAgent(range: RangeKey): Promise<NamedStat[]>
  getByModel(range: RangeKey, agent: string | null): Promise<NamedStat[]>
  getTokenTypeBreakdown(range: RangeKey, agent: string | null): Promise<TokenTypeStat[]>
  getHeatmap(range: RangeKey, agent: string | null): Promise<HeatmapData>
  getCalendar(range: RangeKey, agent: string | null): Promise<CalendarDay[]>
  getToolStats(range: RangeKey, agent: string | null): Promise<ToolStat[]>
  getAgents(): Promise<AgentInfo[]>
  getSessions(range: RangeKey, agent: string | null, limit: number): Promise<SessionRow[]>
  getSyncStatus(): Promise<SyncProgress>
  syncNow(): Promise<void>
  getSettings(): Promise<Settings>
  setTheme(theme: Settings['theme']): Promise<Settings>
  getRetentionDays(): Promise<number>
  setRetentionDays(days: number): Promise<number>
  getDataDir(): Promise<string>
  getSystemSnapshot(): Promise<import('./protocol').SystemSnapshotLike | null>
  getRemoteStatus(): Promise<import('./protocol').RemoteStatusInfo>
  regeneratePairing(): Promise<import('./protocol').PairingInfo>
  setRemoteEnabled(enabled: boolean): Promise<void>
  revokeDevice(deviceId: string): Promise<void>
  quotaPlatforms(): Promise<import('./quotas').PlatformMetaView[]>
  quotaAccounts(): Promise<import('./quotas').AccountQuotaView[]>
  quotaLogin(platform: string): Promise<void>
  quotaLogout(platform: string, accountId: string): Promise<void>
  quotaRefresh(): Promise<import('./quotas').AccountQuotaView[]>
  getQuotaAlertThreshold(): Promise<number>
  setQuotaAlertThreshold(percent: number): Promise<number>
  onQuotaUpdate(cb: (views: import('./quotas').AccountQuotaView[]) => void): () => void
  exportBoard(): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
  openPath(path: string): Promise<void>
  onSyncProgress(cb: (p: SyncProgress) => void): () => void
}
