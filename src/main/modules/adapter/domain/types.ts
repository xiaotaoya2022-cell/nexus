// 适配器领域层：接口与实体（零外部依赖）。
// 立项书 §4.1 的 AgentAdapter 接口的 TypeScript 平移：
// Go 版 Parse(path) 返回全量数组；这里改为 sync(state) 增量拉取并直接落库，
// 以适配 JSONL 文件 offset 续读与 SQLite 大表增量查询两类数据源。

export interface UsageRecordInput {
  agent: string
  model: string
  provider?: string | null
  ts: number // epoch ms
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  sessionId?: string | null
  dedupeKey: string
  isEstimated?: boolean
  /** 该行代表的请求数（官方账单合成行 >1；适配器逐请求行缺省 1） */
  requests?: number
}

export interface SessionRecordInput {
  agent: string
  sessionId: string
  title?: string | null
  projectDir?: string | null
  model?: string | null
  startedAt?: number | null
  updatedAt?: number | null
}

export interface ToolCallRecordInput {
  agent: string
  toolName: string
  ts: number | null
  sessionId?: string | null
  dedupeKey: string
}

export interface AdapterSyncState {
  lastTs: number
  meta: Record<string, unknown>
}

export interface SyncResult {
  records: number
  sessions: number
  tools: number
  lastTs: number
  meta: Record<string, unknown>
}

export interface SyncContext {
  state: AdapterSyncState
  now: number
}

export interface AgentAdapter {
  /** Agent 标识（同时是库内 agent 字段值） */
  id: string
  /** 展示名 */
  label: string
  /** 检测该 Agent 是否安装在本机 */
  detect(): boolean
  /**
   * 增量同步：读取数据源，将记录写入 store。
   * 实现必须保证幂等（重复调用不产生重复记录）。
   */
  sync(ctx: SyncContext): Promise<SyncResult>
}

export interface StoreWriter {
  insertUsage(rows: UsageRecordInput[]): number
  upsertSessions(rows: SessionRecordInput[]): number
  insertToolCalls(rows: ToolCallRecordInput[]): number
}

// 供 registry 声明"已检测到安装、但本地无结构化用量数据"的 Agent
export interface PresenceOnlyAgent {
  id: string
  label: string
  detectPaths: string[]
  note: string
}
