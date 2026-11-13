// Codex 适配器（P1）：解析 ~/.codex/{sessions,archived_sessions}/ 下的 rollout-*.jsonl(.zst/.zstd)，
// 以及 ~/.codex/state_5.sqlite（会话标题与目录）和 ~/.codex/thread_history_1.sqlite（工具调用历史）。
// 数据源调研结论：token 数据在 event_msg/token_count 事件中；
// last_token_usage 为单次请求增量（input_tokens 不含 cached，字段天然互斥），直接累加入库；
// total_token_usage 是会话累计值，用于对同一步重复触发的 token_count 事件去重。

import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentAdapter,
  SyncContext,
  SyncResult,
  StoreWriter
} from '@main/modules/adapter/domain/types'
import {
  collectFilesMultiAsync,
  openReadonlyDb,
  parseTimestampMs,
  readJsonlOrZstdLines,
  sqliteFileStamp,
  tableExists
} from '../util'

interface CodexMeta {
  /** 文件路径 → mtimeMs:size 指纹（兼容 .jsonl 与 .jsonl.zst 多帧压缩文件） */
  fileStamps?: Record<string, string>
  models?: Record<string, string | null>
  sessionIds?: Record<string, string>
  lastHistoryMs?: number
  sqliteStamps?: Record<string, string>
}

interface SessionAcc {
  sessionId: string
  title: string | null
  cwd: string | null
  model: string | null
  startedAt: number | null
  updatedAt: number | null
}

function cleanWinPath(p: string | null | undefined): string | null {
  if (!p || typeof p !== 'string') return null
  return p.replace(/^\\\\\?\\/, '')
}

function sessionIdFromFile(file: string): string {
  const base = (file.split(/[\\/]/).pop() ?? file).replace(/\.jsonl(\.zstd?|\.zst)?$/i, '')
  const m = base.match(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)
  return m ? m[1] : `file:${base}`
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex'
  readonly label = 'Codex'
  private readonly codexHome = join(homedir(), '.codex')
  private readonly sessionsDir = join(this.codexHome, 'sessions')
  private readonly archivedDir = join(this.codexHome, 'archived_sessions')
  private readonly stateDbPath = join(this.codexHome, 'state_5.sqlite')
  private readonly historyDbPath = join(this.codexHome, 'thread_history_1.sqlite')

  constructor(private readonly store: StoreWriter) {}

  detect(): boolean {
    return (
      existsSync(this.sessionsDir) ||
      existsSync(this.archivedDir) ||
      existsSync(this.stateDbPath)
    )
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const meta = (ctx.state.meta as Partial<CodexMeta> | undefined) ?? {}
    const fileStamps: Record<string, string> = { ...(meta.fileStamps ?? {}) }
    const models: Record<string, string | null> = { ...(meta.models ?? {}) }
    const sessionIds: Record<string, string> = { ...(meta.sessionIds ?? {}) }
    const sqliteStamps: Record<string, string> = { ...(meta.sqliteStamps ?? {}) }
    let lastHistoryMs = typeof meta.lastHistoryMs === 'number' ? meta.lastHistoryMs : 0

    const result: SyncResult = {
      records: 0,
      sessions: 0,
      tools: 0,
      lastTs: ctx.state.lastTs,
      meta: ctx.state.meta
    }

    const files = [
      ...(await collectFilesMultiAsync(this.sessionsDir, ['.jsonl', '.jsonl.zst', '.jsonl.zstd'], 5)),
      ...(await collectFilesMultiAsync(this.archivedDir, ['.jsonl', '.jsonl.zst', '.jsonl.zstd'], 5))
    ].sort()

    const sessions = new Map<string, SessionAcc>()
    const usageRows: Parameters<StoreWriter['insertUsage']>[0] = []
    const toolRows: Parameters<StoreWriter['insertToolCalls']>[0] = []

    for (const file of files) {
      let stamp = ''
      try {
        const st = statSync(file)
        stamp = `${Math.floor(st.mtimeMs)}:${st.size}`
      } catch {
        continue
      }
      if (fileStamps[file] === stamp) continue

      const lines = readJsonlOrZstdLines(file)
      let currentModel: string | null = models[file] ?? null
      let currentSessionId = sessionIds[file] ?? sessionIdFromFile(file)
      let lastCumulativeTotal = -1

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx]
        if (!line.trim()) continue
        let ev: {
          timestamp?: string
          type?: string
          ordinal?: number
          payload?: Record<string, unknown>
        }
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        const ts = parseTimestampMs(ev.timestamp)
        const payload = ev.payload as Record<string, unknown> | undefined

        if (ev.type === 'session_meta' && payload) {
          const sid = typeof payload.id === 'string' && payload.id ? payload.id : currentSessionId
          currentSessionId = sid
          sessionIds[file] = sid
          const existing = sessions.get(sid)
          sessions.set(sid, {
            sessionId: sid,
            title: existing?.title ?? null,
            cwd: cleanWinPath(typeof payload.cwd === 'string' ? payload.cwd : existing?.cwd),
            model: currentModel ?? existing?.model ?? null,
            startedAt: existing?.startedAt ?? ts,
            updatedAt: ts ?? existing?.updatedAt ?? null
          })
          continue
        }

        if (ev.type === 'turn_context' && payload) {
          const m = payload.model
          if (typeof m === 'string' && m) currentModel = m
          else if (m && typeof m === 'object') {
            const slug = (m as Record<string, unknown>).slug
            if (typeof slug === 'string' && slug) currentModel = slug
          }
          const acc = sessions.get(currentSessionId)
          if (acc) {
            if (currentModel) acc.model = currentModel
            if (ts != null) acc.updatedAt = ts
          }
          continue
        }

        if (ev.type === 'response_item' && payload) {
          const pType = typeof payload.type === 'string' ? payload.type : ''
          if (pType === 'function_call' || pType === 'custom_tool_call') {
            const toolName =
              typeof payload.name === 'string' && payload.name ? payload.name : pType
            const callId =
              typeof payload.call_id === 'string' && payload.call_id
                ? payload.call_id
                : `${lineIdx}`
            toolRows.push({
              agent: this.id,
              toolName: toolName.slice(0, 200),
              ts: ts ?? null,
              sessionId: currentSessionId,
              dedupeKey: `codex:tool:${currentSessionId}:${callId}`
            })
          }
          continue
        }

        if (ev.type === 'event_msg' && payload && payload.type === 'token_count') {
          const info = payload.info as Record<string, unknown> | undefined
          if (!info) continue
          const last = info.last_token_usage as Record<string, unknown> | undefined
          const totalUsage = info.total_token_usage as Record<string, unknown> | undefined
          if (!last) continue
          const cumTotal =
            typeof totalUsage?.total_tokens === 'number' ? (totalUsage.total_tokens as number) : -1
          // Codex 在同一轮末尾可能重发相同 total_tokens 的 token_count 快照，跳过重复快照
          if (cumTotal > 0 && cumTotal === lastCumulativeTotal) continue
          if (cumTotal > 0) lastCumulativeTotal = cumTotal

          const n = (k: string): number =>
            typeof last[k] === 'number' && Number.isFinite(last[k]) ? (last[k] as number) : 0
          let input = n('input_tokens')
          const output = n('output_tokens')
          let reasoning = n('reasoning_output_tokens')
          const cacheRead = n('cached_input_tokens')
          const cacheWrite = n('cache_write_input_tokens')
          const total = n('total_tokens')
          const sum5 = input + output + reasoning + cacheRead + cacheWrite
          if (total > 0 && total !== sum5 && total === input + output + cacheRead + cacheWrite) {
            const cacheTotal = cacheRead + cacheWrite
            input = Math.max(0, input - cacheTotal)
            reasoning = 0
          }
          if (input + output + reasoning + cacheRead + cacheWrite <= 0) continue

          const dedupeSuffix =
            cumTotal > 0
              ? `tot:${cumTotal}`
              : typeof ev.ordinal === 'number'
                ? `${ev.ordinal}`
                : `l:${lineIdx}`

          usageRows.push({
            agent: this.id,
            model: currentModel ?? 'gpt-5.4',
            provider: 'openai',
            ts: ts ?? 0,
            inputTokens: input,
            outputTokens: output,
            reasoningTokens: reasoning,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            sessionId: currentSessionId,
            dedupeKey: `codex:tc:${currentSessionId}:${dedupeSuffix}`
          })
          const acc = sessions.get(currentSessionId)
          if (acc) {
            if (ts != null) acc.updatedAt = ts
            if (currentModel && !acc.model) acc.model = currentModel
          }
          if (ts != null && ts > result.lastTs) result.lastTs = ts
        }
      }

      fileStamps[file] = stamp
      models[file] = currentModel
    }

    // 补充读取 state_5.sqlite 的 threads 表（完整会话标题、cwd、起止时间）
    const stateStamp = sqliteFileStamp(this.stateDbPath)
    if (stateStamp && sqliteStamps[this.stateDbPath] !== stateStamp) {
      try {
        const db = openReadonlyDb(this.stateDbPath)
        try {
          if (tableExists(db, 'threads')) {
            const rows = db
              .prepare(
                `SELECT id, title, cwd, created_at, updated_at FROM threads LIMIT 5000`
              )
              .all() as Array<Record<string, unknown>>
            for (const r of rows) {
              const sid = typeof r.id === 'string' ? r.id : null
              if (!sid) continue
              const rawTitle = typeof r.title === 'string' ? r.title.trim() : ''
              const firstLineTitle = rawTitle ? rawTitle.split(/\r?\n/)[0].slice(0, 120) : null
              const createdAtSec = typeof r.created_at === 'number' ? r.created_at : null
              const updatedAtSec = typeof r.updated_at === 'number' ? r.updated_at : null
              const startedAt =
                createdAtSec != null
                  ? createdAtSec < 1e11
                    ? createdAtSec * 1000
                    : createdAtSec
                  : null
              const updatedAt =
                updatedAtSec != null
                  ? updatedAtSec < 1e11
                    ? updatedAtSec * 1000
                    : updatedAtSec
                  : null
              const existing = sessions.get(sid)
              sessions.set(sid, {
                sessionId: sid,
                title: firstLineTitle ?? existing?.title ?? null,
                cwd: cleanWinPath(typeof r.cwd === 'string' ? r.cwd : existing?.cwd),
                model: existing?.model ?? null,
                startedAt: existing?.startedAt ?? startedAt,
                updatedAt: Math.max(existing?.updatedAt ?? 0, updatedAt ?? 0) || null
              })
            }
          }
          sqliteStamps[this.stateDbPath] = stateStamp
        } finally {
          db.close()
        }
      } catch {
        // state_5.sqlite 读取失败不阻塞主流程
      }
    }

    // 补充读取 thread_history_1.sqlite 的 thread_items 工具调用
    const historyStamp = sqliteFileStamp(this.historyDbPath)
    if (historyStamp && sqliteStamps[this.historyDbPath] !== historyStamp) {
      try {
        const db = openReadonlyDb(this.historyDbPath)
        try {
          if (tableExists(db, 'thread_items')) {
            const rows = db
              .prepare(
                `SELECT thread_id, item_id, item_type, created_at_ms, item_json
                 FROM thread_items
                 WHERE item_type IN ('commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange', 'imageView')
                   AND created_at_ms > ?
                 ORDER BY created_at_ms ASC
                 LIMIT 20000`
              )
              .all(lastHistoryMs) as Array<Record<string, unknown>>
            for (const r of rows) {
              const sid = typeof r.thread_id === 'string' ? r.thread_id : null
              const itemId = typeof r.item_id === 'string' ? r.item_id : null
              const itemType = typeof r.item_type === 'string' ? r.item_type : 'tool'
              const tsMs = typeof r.created_at_ms === 'number' ? r.created_at_ms : null
              if (!sid || !itemId) continue
              let toolName = itemType
              if (
                (itemType === 'mcpToolCall' || itemType === 'dynamicToolCall') &&
                typeof r.item_json === 'string'
              ) {
                try {
                  const parsed = JSON.parse(r.item_json) as Record<string, unknown>
                  if (typeof parsed.tool === 'string' && parsed.tool) toolName = parsed.tool
                  else if (typeof parsed.name === 'string' && parsed.name) toolName = parsed.name
                } catch {
                  // ignore
                }
              }
              toolRows.push({
                agent: this.id,
                toolName: toolName.slice(0, 200),
                ts: tsMs,
                sessionId: sid,
                dedupeKey: `codex:hist:${sid}:${itemId}`
              })
              if (tsMs != null && tsMs > lastHistoryMs) lastHistoryMs = tsMs
            }
          }
          sqliteStamps[this.historyDbPath] = historyStamp
        } finally {
          db.close()
        }
      } catch {
        // thread_history_1.sqlite 失败不阻塞
      }
    }

    if (usageRows.length > 0) result.records = this.store.insertUsage(usageRows)
    if (toolRows.length > 0) result.tools = this.store.insertToolCalls(toolRows)
    if (sessions.size > 0) {
      result.sessions = this.store.upsertSessions(
        [...sessions.values()].map((s) => ({
          agent: this.id,
          sessionId: s.sessionId,
          title: s.title,
          projectDir: s.cwd,
          model: s.model,
          startedAt: s.startedAt,
          updatedAt: s.updatedAt
        }))
      )
    }
    result.meta = { fileStamps, models, sessionIds, lastHistoryMs, sqliteStamps }
    return result
  }
}
