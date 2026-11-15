// Nexus 共享类型：主进程 / preload / 渲染进程共用。
// 只放纯数据结构与 API 契约，禁止引入 Node 专用模块。

export type RangeKey = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'year' | 'all' | 'custom'

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
  nodeId?: string | null
  projectDir?: string | null
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
  /** 当前所选时间范围（range）内的 Token 消耗 */
  rangeTokens?: number
  /** 历史全量累计 Token 消耗 */
  totalTokens?: number
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
  sourceNodeId?: string
  sourceNodeLabel?: string
}

export interface ProjectStat extends NamedStat {
  projectDir: string | null
  estimatedCostUsd: number
}

export interface SessionModelStat {
  model: string
  requests: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  estimatedCostUsd: number
}

export interface SessionToolStat {
  tool: string
  count: number
}

export interface SessionDetail {
  session: SessionRow
  totals: TokenTotals
  cacheHitRate: number | null
  models: SessionModelStat[]
  tools: SessionToolStat[]
}

export type ExportFormat = 'png' | 'csv' | 'markdown' | 'json'

export type CurrencyCode = 'USD' | 'CNY'

export type PricingOverrideMode = 'free' | 'multiplier' | 'custom'

export interface PricingOverride {
  id: string
  pattern: string
  mode: PricingOverrideMode
  multiplier?: number
  input?: number
  output?: number
  cacheRead?: number
  label?: string
}

export interface PricingConfig {
  currency: CurrencyCode
  cnyRate: number
  globalMultiplier: number
  overrides: PricingOverride[]
}

export interface AppPreferences {
  closeToTray: boolean
  budgetDailyUsd: number
  spikeTokens10m: number
}

export interface AppAlertEvent {
  id: string
  kind: 'budget' | 'spike' | 'quota'
  title: string
  body: string
  ts: number
}

export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  currency: 'USD',
  cnyRate: 7.2,
  globalMultiplier: 1,
  overrides: []
}

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  closeToTray: true,
  budgetDailyUsd: 0,
  spikeTokens10m: 0
}

/** 看板全量数据（单遍扫描聚合，一次 IPC 代替 9 次独立查询） */
export interface BoardData {
  overview: Overview
  trendByModel: TrendPoint[]
  trendByAgent: TrendPoint[]
  byAgent: NamedStat[]
  byModel: NamedStat[]
  byProject: ProjectStat[]
  breakdown: TokenTypeStat[]
  heatmap: HeatmapData
  tools: ToolStat[]
  sessions: SessionRow[]
}

/** DSH（DeepSeek Harness）本地会话行：settings 面板展示用 */
export interface DshSessionRow {
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

export type UiStyle = 'nexus' | 'porcelain'

export type NodeKind = 'physical' | 'vmware' | 'hyperv' | 'wsl2' | 'vm' | 'mac' | 'linux'
export type NodeRole = 'hub' | 'spoke'
export type LinkTransport = 'local' | 'lan' | 'vmware_nat' | 'wsl' | 'tailscale' | 'other'
export type NodeOnlineStatus = 'online' | 'syncing' | 'offline'

export interface NodeHardwareSummary {
  osPlatform: string
  osRelease: string
  arch: string
  cpuModel: string
  cpuCores: number
  cpuLoadPercent: number
  ramTotalBytes: number
  ramUsedBytes: number
  ramUsedPercent: number
  gpuModel: string | null
  uptimeSec: number
}

export interface NodeIpHint {
  host: string
  transport: LinkTransport
  label: string
}

export interface NodeProfile {
  nodeId: string
  hostname: string
  alias: string | null
  kind: NodeKind
  role: NodeRole
  ipHints: NodeIpHint[]
  hwSummary: NodeHardwareSummary
  activeAgents: string[]
  updatedAt: number
}

export interface MeshWatermark {
  usageId: number
  toolId: number
  sessionSeq: number
}

export interface MeshNodeInfo {
  nodeId: string
  hostname: string
  alias: string | null
  kind: NodeKind
  role: NodeRole
  isLocal: boolean
  status: NodeOnlineStatus
  transport: LinkTransport
  endpoint: string | null
  rttMs: number | null
  lastSeenAt: number
  ackedWatermark: MeshWatermark
  recordCount: number
  totalTokens: number
  hwSummary: NodeHardwareSummary
  activeAgents: string[]
}

export interface MeshHubConnectionConfig {
  hubNodeId: string | null
  deviceId: string
  deviceName: string
  hubUrl: string
  token: string
  pairedAt: number
}

export interface MeshStatusInfo {
  localNode: MeshNodeInfo
  nodes: MeshNodeInfo[]
  hubConnection: {
    connected: boolean
    hubUrl: string | null
    hubNodeId: string | null
    lastSyncAt: number | null
    ackedWatermark: MeshWatermark
    lastError: string | null
    rttMs: number | null
  } | null
}

export interface Settings {
  theme: 'dark' | 'light'
  uiStyle?: UiStyle
}

export interface TimeRange {
  sinceMs: number
  untilMs: number
  bucket: 'hour' | 'day'
}

export interface ExportFilter {
  range: RangeKey
  agent: string | null
  customStart?: number
  customEnd?: number
  nodeId?: string | null
  projectDir?: string | null
}

// ── IPC 契约（renderer 经 window.nexus 调用）──
export interface NexusApi {
  getOverview(range: RangeKey, agent: string | null): Promise<Overview>
  getBoard(
    range: RangeKey,
    agent: string | null,
    customStart?: number,
    customEnd?: number,
    nodeId?: string | null,
    projectDir?: string | null
  ): Promise<import('./types').BoardData>
  getCustomRange(): Promise<{ start: number; end: number } | null>
  setCustomRange(start: number, end: number): Promise<{ start: number; end: number }>
  minimizeWindow(): Promise<void>
  toggleMaximizeWindow(): Promise<void>
  closeWindow(): Promise<void>
  isMaximized(): Promise<boolean>
  onMaximizeChange(cb: (maximized: boolean) => void): () => void
  startWindowDrag(ratioX?: number, clientY?: number): void
  moveWindowDrag(): void
  endWindowDrag(): void
  getTrend(range: RangeKey, agent: string | null, groupBy: 'model' | 'agent'): Promise<TrendPoint[]>
  getByAgent(range: RangeKey): Promise<NamedStat[]>
  getByModel(range: RangeKey, agent: string | null): Promise<NamedStat[]>
  getTokenTypeBreakdown(range: RangeKey, agent: string | null): Promise<TokenTypeStat[]>
  getHeatmap(range: RangeKey, agent: string | null): Promise<HeatmapData>
  getCalendar(range: RangeKey, agent: string | null): Promise<CalendarDay[]>
  getToolStats(range: RangeKey, agent: string | null): Promise<ToolStat[]>
  getAgents(
    range?: RangeKey,
    customStart?: number,
    customEnd?: number,
    nodeId?: string | null,
    projectDir?: string | null
  ): Promise<AgentInfo[]>
  getSessions(range: RangeKey, agent: string | null, limit: number): Promise<SessionRow[]>
  getSessionDetail(
    agent: string,
    sessionId: string,
    nodeId?: string | null
  ): Promise<SessionDetail | null>
  // Nexus Mesh（跨设备算力组网）
  getMeshStatus(): Promise<MeshStatusInfo>
  setLocalNodeAlias(alias: string | null): Promise<MeshStatusInfo>
  setLocalNodeRole(role: NodeRole | null): Promise<MeshStatusInfo>
  pairWithHub(input: {
    uri?: string
    host?: string
    port?: number
    pin?: string
    nonce?: string
    pairingSecret?: string
  }): Promise<MeshStatusInfo>
  disconnectHub(): Promise<MeshStatusInfo>
  triggerMeshSync(): Promise<{ pushed: number; watermark: MeshWatermark }>
  removeMeshNode(nodeId: string): Promise<MeshStatusInfo>
  onMeshUpdate(cb: (status: MeshStatusInfo) => void): () => void
  getSyncStatus(): Promise<SyncProgress>
  syncNow(): Promise<void>
  getSettings(): Promise<Settings>
  setTheme(theme: Settings['theme']): Promise<Settings>
  setUiStyle(style: UiStyle): Promise<Settings>
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
  quotaLogin(platform: string, mode?: 'normal' | 'incognito'): Promise<void>
  quotaLogout(platform: string, accountId: string): Promise<void>
  quotaRefresh(): Promise<import('./quotas').AccountQuotaView[]>
  getAccountUsage(platform: string, accountId: string, days: number): Promise<import('./quotas').AccountUsagePoint[]>
  getDshStatus(): Promise<{ available: boolean; degraded: boolean; port: number; sessionCount: number; detail?: string }>
  /** DSH 本地会话（含每会话 token 消耗聚合），来自 Nexus 库，不依赖 DSH 运行 */
  getDshSessions(): Promise<DshSessionRow[]>
  sendDshPrompt(sessionId: string | null, text: string): Promise<{ sessionId: string }>
  cancelDshSession(sessionId: string): Promise<void>
  getSavedRange(): Promise<RangeKey>
  setSavedRange(range: RangeKey): Promise<void>
  getQuotaAlertThreshold(): Promise<number>
  setQuotaAlertThreshold(percent: number): Promise<number>
  onQuotaUpdate(cb: (views: import('./quotas').AccountQuotaView[]) => void): () => void
  getPricingConfig(): Promise<PricingConfig>
  setPricingConfig(config: PricingConfig): Promise<PricingConfig>
  getAppPreferences(): Promise<AppPreferences>
  setAppPreferences(prefs: Partial<AppPreferences>): Promise<AppPreferences>
  onAppAlert(cb: (alert: AppAlertEvent) => void): () => void
  exportBoard(): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
  exportReport(
    format: ExportFormat,
    filter: ExportFilter
  ): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
  openPath(path: string): Promise<void>
  onSyncProgress(cb: (p: SyncProgress) => void): () => void
}
