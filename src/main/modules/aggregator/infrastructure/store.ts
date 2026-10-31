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
    try {
      // 增量迁移（已存在时抛错忽略）：usage_records.requests——官方账单合成行每行代表 N 次请求
      this.db.prepare('ALTER TABLE usage_records ADD COLUMN requests INTEGER NOT NULL DEFAULT 1').run()
    } catch {
      // 列已存在
    }
    this.prepareStatements()
  }

  private stmtUsage!: ReturnType<DatabaseSync['prepare']>
  private stmtSession!: ReturnType<DatabaseSync['prepare']>
  private stmtTool!: ReturnType<DatabaseSync['prepare']>

  private prepareStatements(): void {
    // 幂等且可刷新：重叠窗重读时同 dedupe_key 更新时间与用量（红队 N-01 修复）
    this.stmtUsage = this.db.prepare(`
      INSERT INTO usage_records
        (agent, model, provider, ts, input_tokens, output_tokens, reasoning_tokens,
         cache_read_tokens, cache_write_tokens, session_id, dedupe_key, is_estimated, requests)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dedupe_key) DO UPDATE SET
        ts = excluded.ts,
        model = excluded.model,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        session_id = COALESCE(excluded.session_id, usage_records.session_id)
    `)
    this.stmtSession = this.db.prepare(`
      INSERT INTO sessions (agent, session_id, title, project_dir, model, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent, session_id) DO UPDATE SET
        title = COALESCE(excluded.title, sessions.title),
        project_dir = COALESCE(excluded.project_dir, sessions.project_dir),
        model = COALESCE(excluded.model, sessions.model),
        started_at = COALESCE(sessions.started_at, excluded.started_at),
        updated_at = MAX(COALESCE(sessions.updated_at, 0), COALESCE(excluded.updated_at, 0))
    `)
    this.stmtTool = this.db.prepare(`
      INSERT INTO tool_calls (agent, tool_name, ts, session_id, dedupe_key)
      VALUES (?, ?, ?, ?, ?)
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
        this.stmtSession.run(
          r.agent,
          r.sessionId,
          r.title ?? null,
          r.projectDir ?? null,
          r.model ?? null,
          r.startedAt ?? null,
          r.updatedAt ?? null
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

  close(): void {
    this.db.close()
  }
}
