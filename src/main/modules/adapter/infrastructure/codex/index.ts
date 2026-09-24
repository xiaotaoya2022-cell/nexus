// Codex 适配器（P1）：解析 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl。
// 数据源调研结论：token 数据在 event_msg/token_count 事件中；
// last_token_usage 为单次请求增量（input_tokens 不含 cached，字段天然互斥），直接累加入库；
// total_token_usage 是会话累计值（可能因 compact 重置），仅作参考不作求和依据。
// 增量策略：按文件字节 offset 续读，offset 存于 sync_state.meta；
// 去重键 = sessionId + 事件 ordinal（稳定，与从哪个 offset 开始读无关）。

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentAdapter,
  SyncContext,
  SyncResult,
  StoreWriter
} from '@main/modules/adapter/domain/types'
import { collectFiles, parseTimestampMs, readJsonlIncremental } from '../util'

interface CodexMeta {
  offsets: Record<string, number>
  models: Record<string, string | null>
}

interface SessionAcc {
  sessionId: string
  cwd: string | null
  startedAt: number | null
  updatedAt: number | null
}

interface FileScanState {
  session: SessionAcc | null
  model: string | null
}

function sessionIdFromFile(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file
  const m = base.match(/([0-9a-fA-F][0-9a-fA-F-]{15,})\.jsonl$/)
  return m ? m[1] : base.replace(/\.jsonl$/, '')
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex'
  readonly label = 'Codex'
  private readonly root = join(homedir(), '.codex', 'sessions')

  constructor(private readonly store: StoreWriter) {}

  detect(): boolean {
    return existsSync(this.root)
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const meta = (ctx.state.meta as Partial<CodexMeta> | undefined) ?? {}
    const offsets: Record<string, number> = meta.offsets ?? {}
    const models: Record<string, string | null> = meta.models ?? {}
    const result: SyncResult = {
      records: 0,
      sessions: 0,
      tools: 0,
      lastTs: ctx.state.lastTs,
      meta: ctx.state.meta
    }
    const files = collectFiles(this.root, '.jsonl', 4).sort()
    const sessions = new Map<string, SessionAcc>()
    const usageRows: Parameters<StoreWriter['insertUsage']>[0] = []

    for (const file of files) {
      const prevOffset = offsets[file] ?? 0
      const st: FileScanState = { session: null, model: models[file] ?? null }
      const fallbackSessionId = sessionIdFromFile(file)

      const newOffset = await readJsonlIncremental(file, prevOffset, (line) => {
        if (!line.trim()) return
        let ev: {
          timestamp?: string
          type?: string
          ordinal?: number
          payload?: Record<string, unknown>
        }
        try {
          ev = JSON.parse(line)
        } catch {
          return
        }
        const ts = parseTimestampMs(ev.timestamp)
        const payload = ev.payload as Record<string, unknown> | undefined
        if (ev.type === 'session_meta' && payload) {
          const sid = typeof payload.id === 'string' && payload.id ? payload.id : fallbackSessionId
          const acc: SessionAcc = {
            sessionId: sid,
            cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
            startedAt: ts,
            updatedAt: ts
          }
          st.session = acc
          sessions.set(sid, acc)
          return
        }
        if (ev.type === 'turn_context' && payload) {
          const m = payload.model
          if (typeof m === 'string' && m) st.model = m
          else if (m && typeof m === 'object') {
            const slug = (m as Record<string, unknown>).slug
            if (typeof slug === 'string' && slug) st.model = slug
          }
          if (st.session) st.session.updatedAt = ts
          return
        }
        if (ev.type === 'event_msg' && payload && payload.type === 'token_count') {
          const info = payload.info as Record<string, unknown> | undefined
          if (!info) return
          const last = info.last_token_usage as Record<string, unknown> | undefined
          if (!last) return
          const n = (k: string): number =>
            typeof last[k] === 'number' && Number.isFinite(last[k]) ? (last[k] as number) : 0
          const input = n('input_tokens')
          const output = n('output_tokens')
          const cacheRead = n('cached_input_tokens')
          const cacheWrite = n('cache_write_input_tokens')
          const reasoning = n('reasoning_output_tokens')
          if (input + output + cacheRead + cacheWrite + reasoning === 0) return
          usageRows.push({
            agent: this.id,
            model: st.model ?? 'unknown',
            provider: null,
            ts: ts ?? 0,
            inputTokens: input,
            outputTokens: output,
            reasoningTokens: reasoning,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            sessionId: st.session ? st.session.sessionId : fallbackSessionId,
            dedupeKey: `codex:tc:${fallbackSessionId}:${typeof ev.ordinal === 'number' ? ev.ordinal : line.length}`
          })
          if (st.session) st.session.updatedAt = ts
          if (ts != null && ts > result.lastTs) result.lastTs = ts
        }
      })
      offsets[file] = newOffset
      models[file] = st.model
    }

    if (usageRows.length) result.records = this.store.insertUsage(usageRows)
    if (sessions.size) {
      result.sessions = this.store.upsertSessions(
        [...sessions.values()].map((s) => ({
          agent: this.id,
          sessionId: s.sessionId,
          title: null,
          projectDir: s.cwd,
          model: null,
          startedAt: s.startedAt,
          updatedAt: s.updatedAt
        }))
      )
    }
    result.meta = { offsets, models }
    return result
  }
}
