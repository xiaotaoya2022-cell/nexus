// Claude Code 适配器（预留）：解析 ~/.claude/projects/**/*.jsonl。
// 行格式（业界已知）：assistant 行 message.usage = {input_tokens, output_tokens,
// cache_creation_input_tokens, cache_read_input_tokens}（input 不含缓存，与统一口径一致）。
// 本机当前 projects 下无 JSONL（已清理），适配器就绪，一旦产生数据即生效。

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { basename } from 'node:path'
import type {
  AgentAdapter,
  SyncContext,
  SyncResult,
  StoreWriter
} from '@main/modules/adapter/domain/types'
import { collectFiles, parseTimestampMs, readJsonlIncremental } from '../util'

interface ClaudeMeta {
  offsets: Record<string, number>
}

interface SessionAcc {
  sessionId: string
  cwd: string | null
  startedAt: number | null
  updatedAt: number | null
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude-code'
  readonly label = 'Claude Code'
  private readonly root = join(homedir(), '.claude', 'projects')

  constructor(private readonly store: StoreWriter) {}

  detect(): boolean {
    return existsSync(this.root)
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const meta = (ctx.state.meta as unknown as Partial<ClaudeMeta> | undefined) ?? {}
    const offsets: Record<string, number> = meta.offsets ?? {}
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
      const tag = basename(file)
      const st: { session: SessionAcc | null } = { session: null }

      const newOffset = await readJsonlIncremental(file, prevOffset, (line) => {
        if (!line.trim()) return
        let ev: {
          type?: string
          timestamp?: string
          sessionId?: string
          cwd?: string
          uuid?: string
          message?: Record<string, unknown>
        }
        try {
          ev = JSON.parse(line)
        } catch {
          return
        }
        const ts = parseTimestampMs(ev.timestamp)
        if (typeof ev.sessionId === 'string' && ev.sessionId) {
          let acc = st.session
          if (!acc || acc.sessionId !== ev.sessionId) {
            acc = { sessionId: ev.sessionId, cwd: null, startedAt: ts, updatedAt: ts }
            st.session = acc
            sessions.set(acc.sessionId, acc)
          }
          if (typeof ev.cwd === 'string' && ev.cwd) acc.cwd = ev.cwd
          if (ts != null) acc.updatedAt = Math.max(acc.updatedAt ?? 0, ts)
        }
        if (ev.type !== 'assistant' || !ev.message) return
        const usage = ev.message.usage as Record<string, unknown> | undefined
        if (!usage) return
        const n = (k: string): number =>
          typeof usage[k] === 'number' && Number.isFinite(usage[k]) ? (usage[k] as number) : 0
        const input = n('input_tokens')
        const output = n('output_tokens')
        const cacheRead = n('cache_read_input_tokens')
        const cacheWrite = n('cache_creation_input_tokens')
        if (input + output + cacheRead + cacheWrite === 0) return
        usageRows.push({
          agent: this.id,
          model:
            typeof ev.message.model === 'string' && ev.message.model
              ? ev.message.model
              : 'unknown',
          provider: null,
          ts: ts ?? 0,
          inputTokens: input,
          outputTokens: output,
          reasoningTokens: 0,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          sessionId: st.session ? st.session.sessionId : null,
          dedupeKey: `claude:ln:${tag}:${ev.uuid ?? `${prevOffset}:${line.length}`}`
        })
        if (ts != null && ts > result.lastTs) result.lastTs = ts
      })
      offsets[file] = newOffset
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
    result.meta = { offsets }
    return result
  }
}
