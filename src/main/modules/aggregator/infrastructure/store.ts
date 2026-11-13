// Nexus 本地存储（aggregator 基础设施层）：node:sqlite（与 ZCode 同款内建驱动，零原生编译）。
// 库文件位于 Electron userData 目录，Nexus 完全拥有该库，可安全读写。
// 立项书 §4.3 的三类表：usage_records（原始记录，带 dedupe_key 幂等）/ sessions / sync_state。
// daily/agent 预聚合表暂不建：单机数据量（<100 万行）下 GROUP BY 实时聚合足够，
// 避免一致性维护成本（决策记录于 docs/modules/aggregator.md）。
// 全部 SQL 均为不含用户输入的常量（写入走参数绑定），DDL/事务经 prepare().run() 执行。

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  StoreWriter,
  UsageRecordInput,
  SessionRecordInput,
  ToolCallRecordInput
} from '@main/modules/adapter/domain/types'
import type {
  MeshUsageRecordWire,
  MeshSessionRecordWire,
  MeshToolCallRecordWire,
  MeshIngestBatch,
  MeshIngestAck
} from '@shared/protocol'
import type {
  LinkTransport,
  MeshWatermark,
  NodeHardwareSummary,
  NodeKind,
  NodeRole
} from '@shared/types'

export interface StoredMeshNode {
  nodeId: string
  hostname: string
  alias: string | null
  kind: NodeKind
  role: NodeRole
  transport: LinkTransport
  endpoint: string | null
  rttMs: number | null
  lastSeenAt: number
  ackedWatermark: MeshWatermark
  hwSummary: NodeHardwareSummary | null
  activeAgents: string[]
  createdAt: number
}

export interface UpsertMeshNodeInput {
  nodeId: string
  hostname: string
  alias?: string | null
  kind: NodeKind
  role: NodeRole
  transport: LinkTransport
  endpoint?: string | null
  rttMs?: number | null
  lastSeenAt: number
  ackedWatermark?: MeshWatermark
  hwSummary?: NodeHardwareSummary | null
  activeAgents?: string[]
}

const DEFAULT_INGEST_CHUNK_BYTES = 160 * 1024

export const TOTAL_EXPR =
  '(input_tokens + output_tokens + reasoning_tokens + cache_read_tokens + cache_write_tokens)'

const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS usage_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT 'unknown',
    provider TEXT,
    ts INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    session_id TEXT,
    dedupe_key TEXT NOT NULL UNIQUE,
    is_estimated INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 1
  )`,
  'CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_records(ts)',
  'CREATE INDEX IF NOT EXISTS idx_usage_agent_ts ON usage_records(agent, ts)',
  'CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_records(model)',
  'CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_records(agent, session_id)',
  `CREATE TABLE IF NOT EXISTS sessions (
    agent TEXT NOT NULL,
    session_id TEXT NOT NULL,
    title TEXT,
    project_dir TEXT,
    model TEXT,
    started_at INTEGER,
    updated_at INTEGER,
    PRIMARY KEY (agent, session_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at)',
  `CREATE TABLE IF NOT EXISTS tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    ts INTEGER,
    session_id TEXT,
    dedupe_key TEXT NOT NULL UNIQUE
  )`,
  'CREATE INDEX IF NOT EXISTS idx_tool_ts ON tool_calls(ts)',
  `CREATE TABLE IF NOT EXISTS sync_state (
    agent TEXT PRIMARY KEY,
    last_ts INTEGER NOT NULL DEFAULT 0,
    meta TEXT,
    updated_at INTEGER
  )`,
  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)',
  // Nexus Mesh 节点档案表（存储已配对物理机 / VM / WSL2 / 远程从节点档案与同步水位线）
  `CREATE TABLE IF NOT EXISTS mesh_nodes (
    node_id TEXT PRIMARY KEY,
    hostname TEXT NOT NULL,
    alias TEXT,
    kind TEXT NOT NULL DEFAULT 'physical',
    role TEXT NOT NULL DEFAULT 'spoke',
    transport TEXT NOT NULL DEFAULT 'lan',
    endpoint TEXT,
    rtt_ms INTEGER,
    last_seen_at INTEGER NOT NULL DEFAULT 0,
    acked_watermark INTEGER NOT NULL DEFAULT 0,
    acked_tool_watermark INTEGER NOT NULL DEFAULT 0,
    acked_session_seq INTEGER NOT NULL DEFAULT 0,
    hw_json TEXT,
    active_agents_json TEXT,
    created_at INTEGER NOT NULL DEFAULT 0
  )`,
  // 账号级每日真实消耗（官方账单口径，如 DeepSeek 开放平台 usage API）
  `CREATE TABLE IF NOT EXISTS account_usage_daily (
    platform TEXT NOT NULL,
    account_id TEXT NOT NULL,
    day TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    tokens INTEGER NOT NULL DEFAULT 0,
    cost_amount REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'CNY',
    updated_at INTEGER,
    PRIMARY KEY (platform, account_id, day)
  )`,
  // 账号配额快照（额度制平台如 Antigravity：每轮 fetchQuota 落一行，
  // ts 取整到分钟；remaining 随时间下行即为真实消耗曲线的数据源）
  `CREATE TABLE IF NOT EXISTS account_quota_snapshots (
    platform TEXT NOT NULL,
    account_id TEXT NOT NULL,
    label TEXT NOT NULL,
    ts INTEGER NOT NULL,
    used_percent REAL,
    remaining_percent REAL,
    reset_at INTEGER,
    PRIMARY KEY (platform, account_id, label, ts)
  )`,
  // 一次性口径修正（正确性审计 F1）：codex subset 型事件 input 含缓存、reasoning⊆output，
  // 按 total_tokens 判别归一。dedupe_key 含 total 不可得，故以"codex 存在且未标记"为条件全量重算：
  // 由增量同步以 upsert 方式刷新（总口径行 ts/model 不变），此处仅将明显双计的行做保守修正。
  // 注：完整重算由 codex 适配器下轮 24h 重叠窗 + 本迁移的组合覆盖。
  "UPDATE usage_records SET reasoning_tokens = 0 WHERE agent = 'codex' AND reasoning_tokens > 0",
  // 一次性口径修正（红队 N-03）：ZCode 的 reasoning 已含于 output，历史行单独累加会双计；
  // 适配器新写入恒为 0，此语句幂等，只纠正存量。
  "UPDATE usage_records SET reasoning_tokens = 0 WHERE agent = 'zcode' AND reasoning_tokens != 0"
]

export class NexusStore implements StoreWriter {
  readonly db: DatabaseSync

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.prepare('PRAGMA journal_mode = WAL').get()
    for (const stmt of SCHEMA_STATEMENTS) this.db.prepare(stmt).run()
    this.runMigrations()
    const maxSeqRow = this.db.prepare('SELECT COALESCE(MAX(mesh_seq), 0) m FROM sessions').get() as
      | { m?: number }
      | undefined
    this.sessionSeqCounter = Number(maxSeqRow?.m ?? 0) || 0
    this.prepareStatements()
  }

  private sessionSeqCounter = 0

  private hasColumn(table: string, col: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return rows.some((r) => r.name === col)
  }

  private runMigrations(): void {
    if (!this.hasColumn('usage_records', 'requests')) {
      this.db.prepare('ALTER TABLE usage_records ADD COLUMN requests INTEGER NOT NULL DEFAULT 1').run()
    }
    if (!this.hasColumn('usage_records', 'source_node_id')) {
      this.db.prepare("ALTER TABLE usage_records ADD COLUMN source_node_id TEXT NOT NULL DEFAULT 'local'").run()
    }
    this.db.prepare('CREATE INDEX IF NOT EXISTS idx_usage_node_ts ON usage_records(source_node_id, ts)').run()

    if (!this.hasColumn('tool_calls', 'source_node_id')) {
      this.db.prepare("ALTER TABLE tool_calls ADD COLUMN source_node_id TEXT NOT NULL DEFAULT 'local'").run()
    }
    this.db.prepare('CREATE INDEX IF NOT EXISTS idx_tool_node_ts ON tool_calls(source_node_id, ts)').run()

    if (!this.hasColumn('sessions', 'source_node_id')) {
      this.begin()
      try {
        this.db
          .prepare(
            `CREATE TABLE sessions_v2 (
              source_node_id TEXT NOT NULL DEFAULT 'local',
              agent TEXT NOT NULL,
              session_id TEXT NOT NULL,
              title TEXT,
              project_dir TEXT,
              model TEXT,
              started_at INTEGER,
              updated_at INTEGER,
              mesh_seq INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (source_node_id, agent, session_id)
            )`
          )
          .run()
        this.db
          .prepare(
            `INSERT INTO sessions_v2
              (source_node_id, agent, session_id, title, project_dir, model, started_at, updated_at, mesh_seq)
             SELECT 'local', agent, session_id, title, project_dir, model, started_at, updated_at, rowid FROM sessions`
          )
          .run()
        this.db.prepare('DROP TABLE sessions').run()
        this.db.prepare('ALTER TABLE sessions_v2 RENAME TO sessions').run()
        this.db.prepare('CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at)').run()
        this.commit()
      } catch (err) {
        this.rollback()
        throw err
      }
    } else if (!this.hasColumn('sessions', 'mesh_seq')) {
      this.db.prepare('ALTER TABLE sessions ADD COLUMN mesh_seq INTEGER NOT NULL DEFAULT 0').run()
      this.db.prepare('UPDATE sessions SET mesh_seq = rowid WHERE mesh_seq = 0').run()
    } else {
      this.db.prepare('UPDATE sessions SET mesh_seq = rowid WHERE mesh_seq = 0').run()
    }
    this.db.prepare('CREATE INDEX IF NOT EXISTS idx_sessions_node_seq ON sessions(source_node_id, mesh_seq)').run()
  }

  private stmtUsage!: ReturnType<DatabaseSync['prepare']>
  private stmtSession!: ReturnType<DatabaseSync['prepare']>
  private stmtTool!: ReturnType<DatabaseSync['prepare']>
  private stmtRemoteUsage!: ReturnType<DatabaseSync['prepare']>
  private stmtRemoteSession!: ReturnType<DatabaseSync['prepare']>
  private stmtRemoteTool!: ReturnType<DatabaseSync['prepare']>

  private prepareStatements(): void {
    // 幂等且可刷新：重叠窗重读时同 dedupe_key 更新时间与用量（红队 N-01 修复）
    this.stmtUsage = this.db.prepare(`
      INSERT INTO usage_records
        (source_node_id, agent, model, provider, ts, input_tokens, output_tokens, reasoning_tokens,
         cache_read_tokens, cache_write_tokens, session_id, dedupe_key, is_estimated, requests)
      VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dedupe_key) DO UPDATE SET
        ts = excluded.ts,
        model = excluded.model,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        session_id = COALESCE(excluded.session_id, usage_records.session_id),
        requests = excluded.requests
    `)
    this.stmtSession = this.db.prepare(`
      INSERT INTO sessions
        (source_node_id, agent, session_id, title, project_dir, model, started_at, updated_at, mesh_seq)
      VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_node_id, agent, session_id) DO UPDATE SET
        title = COALESCE(excluded.title, sessions.title),
        project_dir = COALESCE(excluded.project_dir, sessions.project_dir),
        model = COALESCE(excluded.model, sessions.model),
        started_at = COALESCE(sessions.started_at, excluded.started_at),
        updated_at = MAX(COALESCE(sessions.updated_at, 0), COALESCE(excluded.updated_at, 0)),
        mesh_seq = excluded.mesh_seq
    `)
    this.stmtTool = this.db.prepare(`
      INSERT INTO tool_calls (source_node_id, agent, tool_name, ts, session_id, dedupe_key)
      VALUES ('local', ?, ?, ?, ?, ?)
      ON CONFLICT(dedupe_key) DO UPDATE SET ts = excluded.ts, tool_name = excluded.tool_name
    `)
    this.stmtRemoteUsage = this.db.prepare(`
      INSERT INTO usage_records
        (source_node_id, agent, model, provider, ts, input_tokens, output_tokens, reasoning_tokens,
         cache_read_tokens, cache_write_tokens, session_id, dedupe_key, is_estimated, requests)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dedupe_key) DO UPDATE SET
        ts = excluded.ts,
        model = excluded.model,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        session_id = COALESCE(excluded.session_id, usage_records.session_id),
        requests = excluded.requests
    `)
    this.stmtRemoteSession = this.db.prepare(`
      INSERT INTO sessions
        (source_node_id, agent, session_id, title, project_dir, model, started_at, updated_at, mesh_seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_node_id, agent, session_id) DO UPDATE SET
        title = COALESCE(excluded.title, sessions.title),
        project_dir = COALESCE(excluded.project_dir, sessions.project_dir),
        model = COALESCE(excluded.model, sessions.model),
        started_at = COALESCE(sessions.started_at, excluded.started_at),
        updated_at = MAX(COALESCE(sessions.updated_at, 0), COALESCE(excluded.updated_at, 0)),
        mesh_seq = excluded.mesh_seq
    `)
    this.stmtRemoteTool = this.db.prepare(`
      INSERT INTO tool_calls (source_node_id, agent, tool_name, ts, session_id, dedupe_key)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(dedupe_key) DO UPDATE SET ts = excluded.ts, tool_name = excluded.tool_name
    `)
  }

  private begin(): void {
    this.db.prepare('BEGIN').run()
  }

  private commit(): void {
    this.db.prepare('COMMIT').run()
  }

  private rollback(): void {
    this.db.prepare('ROLLBACK').run()
  }

  insertUsage(rows: UsageRecordInput[]): number {
    let inserted = 0
    this.begin()
    try {
      for (const r of rows) {
        const res = this.stmtUsage.run(
          r.agent,
          r.model,
          r.provider ?? null,
          r.ts,
          r.inputTokens,
          r.outputTokens,
          r.reasoningTokens,
          r.cacheReadTokens,
          r.cacheWriteTokens,
          r.sessionId ?? null,
          r.dedupeKey,
          r.isEstimated ? 1 : 0,
          r.requests ?? 1
        )
        inserted += Number(res.changes)
      }
      this.commit()
    } catch (err) {
      this.rollback()
      throw err
    }
    return inserted
  }

  upsertSessions(rows: SessionRecordInput[]): number {
    this.begin()
    try {
      for (const r of rows) {
        if (!r.sessionId) continue
        const seq = ++this.sessionSeqCounter
        this.stmtSession.run(
          r.agent,
          r.sessionId,
          r.title ?? null,
          r.projectDir ?? null,
          r.model ?? null,
          r.startedAt ?? null,
          r.updatedAt ?? null,
          seq
        )
      }
      this.commit()
    } catch (err) {
      this.rollback()
      throw err
    }
    return rows.filter((r) => r.sessionId).length
  }

  insertToolCalls(rows: ToolCallRecordInput[]): number {
    let inserted = 0
    this.begin()
    try {
      for (const r of rows) {
        const res = this.stmtTool.run(
          r.agent,
          r.toolName,
          r.ts ?? null,
          r.sessionId ?? null,
          r.dedupeKey
        )
        inserted += Number(res.changes)
      }
      this.commit()
    } catch (err) {
      this.rollback()
      throw err
    }
    return inserted
  }

  /** 账号每日真实消耗 upsert（官方账单口径，多来源覆盖同一日时合并 requests/tokens/cost）。 */
  upsertAccountUsage(
    platform: string,
    accountId: string,
    rows: Array<{ day: string; requests: number; tokens: number; costAmount: number; currency: string }>
  ): number {
    if (rows.length === 0) return 0
    const stmt = this.db.prepare(`
      INSERT INTO account_usage_daily (platform, account_id, day, requests, tokens, cost_amount, currency, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, account_id, day) DO UPDATE SET
        requests = excluded.requests,
        tokens = excluded.tokens,
        cost_amount = excluded.cost_amount,
        currency = excluded.currency,
        updated_at = excluded.updated_at
    `)
    let n = 0
    this.begin()
    try {
      const now = Date.now()
      for (const r of rows) {
        stmt.run(platform, accountId, r.day, r.requests, r.tokens, r.costAmount, r.currency, now)
        n++
      }
      this.commit()
    } catch (err) {
      this.rollback()
      throw err
    }
    return n
  }

  /** 查询账号每日消耗（近 days 天，按日升序）。 */
  queryAccountUsage(
    platform: string,
    accountId: string,
    days: number
  ): Array<{ day: string; requests: number; tokens: number; costAmount: number; currency: string }> {
    const since = new Date(Date.now() - days * 86400_000)
    const p = (n: number): string => String(n).padStart(2, '0')
    const sinceDay = `${since.getFullYear()}-${p(since.getMonth() + 1)}-${p(since.getDate())}`
    const rows = this.db
      .prepare(
        `SELECT day, requests, tokens, cost_amount, currency FROM account_usage_daily
         WHERE platform = ? AND account_id = ? AND day >= ? ORDER BY day ASC`
      )
      .all(platform, accountId, sinceDay) as Array<{
      day: string
      requests: number
      tokens: number
      cost_amount: number
      currency: string
    }>
    return rows.map((r) => ({
      day: r.day,
      requests: Number(r.requests),
      tokens: Number(r.tokens),
      costAmount: Number(r.cost_amount),
      currency: String(r.currency)
    }))
  }

  /** 某平台账号已采集的最早账单日（YYYY-MM-DD）；无数据返回 null（fetchUsage 全量回溯起点）。 */
  earliestAccountUsageDay(platform: string, accountId: string): string | null {
    const row = this.db
      .prepare('SELECT MIN(day) d FROM account_usage_daily WHERE platform = ? AND account_id = ?')
      .get(platform, accountId) as { d: string | null } | undefined
    return row?.d ?? null
  }

  /**
   * 账号配额快照落库（额度制平台每轮 fetchQuota 调一次）。
   * ts 取整到 5 分钟：同窗多轮只保留最后一行（INSERT OR REPLACE），抑制轮询噪声。
   */
  upsertAccountQuotaSnapshots(
    platform: string,
    accountId: string,
    windows: Array<{ label: string; usedPercent: number | null; remainingPercent: number | null; resetAt: number | null }>
  ): number {
    if (windows.length === 0) return 0
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO account_quota_snapshots
        (platform, account_id, label, ts, used_percent, remaining_percent, reset_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    let n = 0
    this.begin()
    try {
      const ts = Math.floor(Date.now() / 300_000) * 300_000
      for (const w of windows) {
        stmt.run(
          platform,
          accountId,
          w.label,
          ts,
          w.usedPercent,
          w.remainingPercent,
          w.resetAt
        )
        n++
      }
      this.commit()
    } catch (err) {
      this.rollback()
      throw err
    }
    return n
  }

  /** 查询账号配额快照序列（近 days 天，按时间升序；画额度消耗趋势用）。 */
  queryAccountQuotaSnapshots(
    platform: string,
    accountId: string,
    days: number
  ): Array<{ label: string; ts: number; usedPercent: number | null; remainingPercent: number | null; resetAt: number | null }> {
    const since = Date.now() - days * 86400_000
    const rows = this.db
      .prepare(
        `SELECT label, ts, used_percent, remaining_percent, reset_at FROM account_quota_snapshots
         WHERE platform = ? AND account_id = ? AND ts >= ? ORDER BY ts ASC`
      )
      .all(platform, accountId, since) as Array<{
      label: string
      ts: number
      used_percent: number | null
      remaining_percent: number | null
      reset_at: number | null
    }>
    return rows.map((r) => ({
      label: String(r.label),
      ts: Number(r.ts),
      usedPercent: r.used_percent == null ? null : Number(r.used_percent),
      remainingPercent: r.remaining_percent == null ? null : Number(r.remaining_percent),
      resetAt: r.reset_at == null ? null : Number(r.reset_at)
    }))
  }

  // ── sync_state ──
  loadSyncState(agent: string): { lastTs: number; meta: Record<string, unknown> } {
    const row = this.db
      .prepare('SELECT last_ts, meta FROM sync_state WHERE agent = ?')
      .get(agent) as { last_ts: number | null; meta: string | null } | undefined
    if (!row) return { lastTs: 0, meta: {} }
    let meta: Record<string, unknown> = {}
    try {
      meta = row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {}
    } catch {
      meta = {}
    }
    return { lastTs: row.last_ts ?? 0, meta }
  }

  saveSyncState(agent: string, lastTs: number, meta: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (agent, last_ts, meta, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(agent) DO UPDATE SET last_ts = excluded.last_ts,
           meta = excluded.meta, updated_at = excluded.updated_at`
      )
      .run(agent, lastTs, JSON.stringify(meta), Date.now())
  }

  // ── settings ──
  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row ? row.value : null
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value)
  }

  // ── Nexus Mesh（跨机多节点数据分片导出 / 幂等汇流 / 档案维护）──

  /** 提取本机（source_node_id = 'local'）在指定水位线之后的增量记录，严格控制单帧体积 */
  exportLocalDelta(
    after: MeshWatermark,
    maxBytes = DEFAULT_INGEST_CHUNK_BYTES
  ): {
    usage: MeshUsageRecordWire[]
    sessions: MeshSessionRecordWire[]
    tools: MeshToolCallRecordWire[]
    nextWatermark: MeshWatermark
    hasMore: boolean
  } {
    const usageOut: MeshUsageRecordWire[] = []
    const sessionsOut: MeshSessionRecordWire[] = []
    const toolsOut: MeshToolCallRecordWire[] = []
    const nextWatermark: MeshWatermark = { ...after }
    let bytes = 256
    let hasMore = false

    const usageRows = this.db
      .prepare(
        `SELECT id, agent, model, provider, ts, input_tokens, output_tokens, reasoning_tokens,
                cache_read_tokens, cache_write_tokens, session_id, dedupe_key, is_estimated, requests
         FROM usage_records
         WHERE source_node_id = 'local' AND id > ?
         ORDER BY id ASC
         LIMIT 300`
      )
      .all(after.usageId) as Array<Record<string, unknown>>

    for (const r of usageRows) {
      const item: MeshUsageRecordWire = {
        id: Number(r.id),
        agent: String(r.agent),
        model: String(r.model ?? 'unknown'),
        provider: r.provider == null ? null : String(r.provider),
        ts: Number(r.ts),
        inputTokens: Number(r.input_tokens) || 0,
        outputTokens: Number(r.output_tokens) || 0,
        reasoningTokens: Number(r.reasoning_tokens) || 0,
        cacheReadTokens: Number(r.cache_read_tokens) || 0,
        cacheWriteTokens: Number(r.cache_write_tokens) || 0,
        sessionId: r.session_id == null ? null : String(r.session_id),
        dedupeKey: String(r.dedupe_key),
        isEstimated: Boolean(r.is_estimated),
        requests: Number(r.requests) || 1
      }
      const itemBytes = Buffer.byteLength(JSON.stringify(item)) + 2
      if (bytes + itemBytes > maxBytes && usageOut.length > 0) {
        hasMore = true
        return { usage: usageOut, sessions: sessionsOut, tools: toolsOut, nextWatermark, hasMore }
      }
      bytes += itemBytes
      usageOut.push(item)
      nextWatermark.usageId = item.id
    }
    if (usageRows.length === 300) {
      hasMore = true
      return { usage: usageOut, sessions: sessionsOut, tools: toolsOut, nextWatermark, hasMore }
    }

    const sessionRows = this.db
      .prepare(
        `SELECT agent, session_id, title, project_dir, model, started_at, updated_at, mesh_seq
         FROM sessions
         WHERE source_node_id = 'local' AND mesh_seq > ?
         ORDER BY mesh_seq ASC
         LIMIT 120`
      )
      .all(after.sessionSeq) as Array<Record<string, unknown>>

    for (const r of sessionRows) {
      const item: MeshSessionRecordWire = {
        agent: String(r.agent),
        sessionId: String(r.session_id),
        title: r.title == null ? null : String(r.title),
        projectDir: r.project_dir == null ? null : String(r.project_dir),
        model: r.model == null ? null : String(r.model),
        startedAt: r.started_at == null ? null : Number(r.started_at),
        updatedAt: r.updated_at == null ? null : Number(r.updated_at),
        meshSeq: Number(r.mesh_seq) || 0
      }
      const itemBytes = Buffer.byteLength(JSON.stringify(item)) + 2
      if (bytes + itemBytes > maxBytes && (usageOut.length + sessionsOut.length > 0)) {
        hasMore = true
        return { usage: usageOut, sessions: sessionsOut, tools: toolsOut, nextWatermark, hasMore }
      }
      bytes += itemBytes
      sessionsOut.push(item)
      nextWatermark.sessionSeq = item.meshSeq
    }
    if (sessionRows.length === 120) {
      hasMore = true
      return { usage: usageOut, sessions: sessionsOut, tools: toolsOut, nextWatermark, hasMore }
    }

    const toolRows = this.db
      .prepare(
        `SELECT id, agent, tool_name, ts, session_id, dedupe_key
         FROM tool_calls
         WHERE source_node_id = 'local' AND id > ?
         ORDER BY id ASC
         LIMIT 300`
      )
      .all(after.toolId) as Array<Record<string, unknown>>

    for (const r of toolRows) {
      const item: MeshToolCallRecordWire = {
        id: Number(r.id),
        agent: String(r.agent),
        toolName: String(r.tool_name),
        ts: r.ts == null ? null : Number(r.ts),
        sessionId: r.session_id == null ? null : String(r.session_id),
        dedupeKey: String(r.dedupe_key)
      }
      const itemBytes = Buffer.byteLength(JSON.stringify(item)) + 2
      if (bytes + itemBytes > maxBytes && (usageOut.length + sessionsOut.length + toolsOut.length > 0)) {
        hasMore = true
        return { usage: usageOut, sessions: sessionsOut, tools: toolsOut, nextWatermark, hasMore }
      }
      bytes += itemBytes
      toolsOut.push(item)
      nextWatermark.toolId = item.id
    }
    if (toolRows.length === 300) hasMore = true

    return { usage: usageOut, sessions: sessionsOut, tools: toolsOut, nextWatermark, hasMore }
  }

  /** Hub 幂等写入远端节点分片：以 mesh:<nodeId>:<dedupeKey> 隔离主键，绝不覆盖或双计本机数据 */
  ingestRemoteBatch(sourceNodeId: string, batch: MeshIngestBatch): MeshIngestAck {
    if (!sourceNodeId || sourceNodeId === 'local') {
      throw new Error('远端 sourceNodeId 无效')
    }
    let acceptedUsage = 0
    let acceptedSessions = 0
    let acceptedTools = 0
    const now = Date.now()
    const w = batch.watermarkAfter

    this.begin()
    try {
      for (const u of batch.usage) {
        const res = this.stmtRemoteUsage.run(
          sourceNodeId,
          u.agent,
          u.model,
          u.provider ?? null,
          u.ts,
          u.inputTokens,
          u.outputTokens,
          u.reasoningTokens,
          u.cacheReadTokens,
          u.cacheWriteTokens,
          u.sessionId ?? null,
          `mesh:${sourceNodeId}:${u.dedupeKey}`,
          u.isEstimated ? 1 : 0,
          u.requests ?? 1
        )
        acceptedUsage += Number(res.changes)
      }
      for (const s of batch.sessions) {
        if (!s.sessionId) continue
        this.stmtRemoteSession.run(
          sourceNodeId,
          s.agent,
          s.sessionId,
          s.title ?? null,
          s.projectDir ?? null,
          s.model ?? null,
          s.startedAt ?? null,
          s.updatedAt ?? null,
          s.meshSeq ?? 0
        )
        acceptedSessions += 1
      }
      for (const tc of batch.tools) {
        const res = this.stmtRemoteTool.run(
          sourceNodeId,
          tc.agent,
          tc.toolName,
          tc.ts ?? null,
          tc.sessionId ?? null,
          `mesh:${sourceNodeId}:${tc.dedupeKey}`
        )
        acceptedTools += Number(res.changes)
      }

      this.db
        .prepare(
          `UPDATE mesh_nodes SET
            last_seen_at = MAX(last_seen_at, ?),
            acked_watermark = MAX(acked_watermark, ?),
            acked_tool_watermark = MAX(acked_tool_watermark, ?),
            acked_session_seq = MAX(acked_session_seq, ?)
           WHERE node_id = ?`
        )
        .run(
          now,
          Math.max(0, Math.floor(w.usageId)),
          Math.max(0, Math.floor(w.toolId)),
          Math.max(0, Math.floor(w.sessionSeq)),
          sourceNodeId
        )

      this.commit()
    } catch (err) {
      this.rollback()
      throw err
    }

    const node = this.getMeshNodeRecord(sourceNodeId)
    return {
      acceptedUsage,
      acceptedSessions,
      acceptedTools,
      ackedWatermark: node?.ackedWatermark ?? w
    }
  }

  upsertMeshNode(input: UpsertMeshNodeInput): void {
    const now = Date.now()
    const w = input.ackedWatermark ?? { usageId: 0, toolId: 0, sessionSeq: 0 }
    this.db
      .prepare(
        `INSERT INTO mesh_nodes
          (node_id, hostname, alias, kind, role, transport, endpoint, rtt_ms, last_seen_at,
           acked_watermark, acked_tool_watermark, acked_session_seq, hw_json, active_agents_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           hostname = excluded.hostname,
           alias = COALESCE(excluded.alias, mesh_nodes.alias),
           kind = excluded.kind,
           role = excluded.role,
           transport = excluded.transport,
           endpoint = COALESCE(excluded.endpoint, mesh_nodes.endpoint),
           rtt_ms = COALESCE(excluded.rtt_ms, mesh_nodes.rtt_ms),
           last_seen_at = MAX(mesh_nodes.last_seen_at, excluded.last_seen_at),
           hw_json = COALESCE(excluded.hw_json, mesh_nodes.hw_json),
           active_agents_json = COALESCE(excluded.active_agents_json, mesh_nodes.active_agents_json)`
      )
      .run(
        input.nodeId,
        input.hostname,
        input.alias ?? null,
        input.kind,
        input.role,
        input.transport,
        input.endpoint ?? null,
        input.rttMs ?? null,
        input.lastSeenAt,
        w.usageId,
        w.toolId,
        w.sessionSeq,
        input.hwSummary ? JSON.stringify(input.hwSummary) : null,
        input.activeAgents ? JSON.stringify(input.activeAgents) : null,
        now
      )
  }

  private mapMeshNodeRow(r: Record<string, unknown>): StoredMeshNode {
    let hwSummary: NodeHardwareSummary | null = null
    let activeAgents: string[] = []
    try {
      if (r.hw_json) hwSummary = JSON.parse(String(r.hw_json)) as NodeHardwareSummary
    } catch {
      hwSummary = null
    }
    try {
      if (r.active_agents_json) activeAgents = JSON.parse(String(r.active_agents_json)) as string[]
    } catch {
      activeAgents = []
    }
    return {
      nodeId: String(r.node_id),
      hostname: String(r.hostname),
      alias: r.alias == null ? null : String(r.alias),
      kind: (r.kind ? String(r.kind) : 'physical') as NodeKind,
      role: (r.role === 'hub' ? 'hub' : 'spoke') as NodeRole,
      transport: (r.transport ? String(r.transport) : 'lan') as LinkTransport,
      endpoint: r.endpoint == null ? null : String(r.endpoint),
      rttMs: r.rtt_ms == null ? null : Number(r.rtt_ms),
      lastSeenAt: Number(r.last_seen_at) || 0,
      ackedWatermark: {
        usageId: Number(r.acked_watermark) || 0,
        toolId: Number(r.acked_tool_watermark) || 0,
        sessionSeq: Number(r.acked_session_seq) || 0
      },
      hwSummary,
      activeAgents,
      createdAt: Number(r.created_at) || 0
    }
  }

  getMeshNodeRecord(nodeId: string): StoredMeshNode | null {
    const row = this.db.prepare('SELECT * FROM mesh_nodes WHERE node_id = ?').get(nodeId) as
      | Record<string, unknown>
      | undefined
    return row ? this.mapMeshNodeRow(row) : null
  }

  listMeshNodeRecords(): StoredMeshNode[] {
    const rows = this.db
      .prepare('SELECT * FROM mesh_nodes ORDER BY last_seen_at DESC, created_at ASC')
      .all() as Array<Record<string, unknown>>
    return rows.map((r) => this.mapMeshNodeRow(r))
  }

  removeMeshNodeRecord(nodeId: string, purgeData = true): void {
    if (!nodeId || nodeId === 'local') return
    this.begin()
    try {
      this.db.prepare('DELETE FROM mesh_nodes WHERE node_id = ?').run(nodeId)
      if (purgeData) {
        this.db.prepare('DELETE FROM usage_records WHERE source_node_id = ?').run(nodeId)
        this.db.prepare('DELETE FROM sessions WHERE source_node_id = ?').run(nodeId)
        this.db.prepare('DELETE FROM tool_calls WHERE source_node_id = ?').run(nodeId)
      }
      this.commit()
    } catch (err) {
      this.rollback()
      throw err
    }
  }

  getNodeUsageStats(): Map<string, { recordCount: number; totalTokens: number }> {
    const rows = this.db
      .prepare(
        `SELECT source_node_id, COUNT(*) c, COALESCE(SUM(${TOTAL_EXPR}), 0) t
         FROM usage_records GROUP BY source_node_id`
      )
      .all() as Array<{ source_node_id: string; c: number; t: number }>
    const map = new Map<string, { recordCount: number; totalTokens: number }>()
    for (const r of rows) {
      map.set(String(r.source_node_id), {
        recordCount: Number(r.c) || 0,
        totalTokens: Number(r.t) || 0
      })
    }
    return map
  }

  close(): void {
    this.db.close()
  }
}
