// Muse Code 适配器（Meta Superintelligence Labs 终端编程 Agent，closed source `muse`）。
// 数据源（调研 2026-11-07，官方 dev.meta.ai 文档与 tokscale 佐证）：
// ~/.local/share/muse/sessions/YYYY/MM/DD/<uuid>/session.jsonl（官方注释：Windows 同 XDG 风格路径）
// - JSONL 事件流；model_completed 事件携带 Responses 形状 usage：
//   {input_tokens, output_tokens, cached_tokens, cache_write_tokens, reasoning_tokens} + duration_ms
//   recorded_at 为微秒时间戳；子 agent 转录在 subagent/<uuid>/（同格式）。
// 口径（官方 Responses 语义）：cached_tokens ⊆ input_tokens、reasoning_tokens ⊆ output_tokens。
// 归一为 Nexus 互斥桶（与 codex "字段天然互斥" 口径对齐，避免总量双计）：
//   input' = input - cached（纯 MISS）；output' = output - reasoning；reasoning/cacheRead/cacheWrite 单列。
// 本机未安装时 detect() 为 false，安装即自动生效。

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentAdapter,
  SyncContext,
  SyncResult,
  StoreWriter
} from '@main/modules/adapter/domain/types'

const SESSIONS_DIR = join(homedir(), '.local', 'share', 'muse', 'sessions')

interface MuseUsage {
  input_tokens?: number
  output_tokens?: number
  cached_tokens?: number
  cache_write_tokens?: number
  reasoning_tokens?: number
}

interface MuseEvent {
  type?: string
  recorded_at?: number
  model?: string
  usage?: MuseUsage
  session_id?: string
}

function isDir(p: string): boolean {
  try {
    return existsSync(p) && readdirSync(p) !== undefined
  } catch {
    return false
  }
}

function listSessionFiles(dir: string, out: string[], depth: number): void {
  if (depth > 6 || out.length >= 5000) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e)
    if (p.endsWith('.jsonl')) {
      out.push(p)
      continue
    }
    listSessionFiles(p, out, depth + 1)
  }
}

const SESSION_UUID_RE = /([0-9a-fA-F-]{36})\\[^\\]*\.jsonl$/

export class MuseAdapter implements AgentAdapter {
  readonly id = 'muse'
  readonly label = 'Muse Code'
  private readonly sessionsDir = SESSIONS_DIR

  constructor(private readonly store: StoreWriter) {}

  detect(): boolean {
    return isDir(this.sessionsDir)
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    if (!this.detect()) {
      return { records: 0, sessions: 0, tools: 0, lastTs: ctx.state.lastTs, meta: ctx.state.meta }
    }
    const files: string[] = []
    listSessionFiles(this.sessionsDir, files, 0)
    if (files.length === 0) {
      return { records: 0, sessions: 0, tools: 0, lastTs: ctx.now, meta: ctx.state.meta }
    }

    const usage: Parameters<StoreWriter['insertUsage']>[0] = []
    const sessionIds = new Set<string>()
    for (const file of files) {
      // 会话 uuid 取路径中目录名（…/<uuid>/session.jsonl）；无目录结构的取不到则置空
      const m = file.replace(/\//g, '\\').match(SESSION_UUID_RE)
      const sessionId = m ? m[1] : null
      if (sessionId) sessionIds.add(sessionId)
      let lines: string[]
      try {
        lines = readFileSync(file, 'utf8').split('\n')
      } catch {
        continue
      }
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim()
        if (!line) continue
        let ev: MuseEvent
        try {
          ev = JSON.parse(line) as MuseEvent
        } catch {
          continue
        }
        if (ev.type !== 'model_completed' || !ev.usage) continue
        const u = ev.usage
        const inputRaw = u.input_tokens ?? 0
        const outputRaw = u.output_tokens ?? 0
        const cached = u.cached_tokens ?? 0
        const reasoning = u.reasoning_tokens ?? 0
        const cacheWrite = u.cache_write_tokens ?? 0
        const input = Math.max(0, inputRaw - cached) // 纯 MISS
        const output = Math.max(0, outputRaw - reasoning) // 纯可见输出
        const total = input + output + reasoning + cached + cacheWrite
        if (total <= 0) continue
        // recorded_at 为微秒
        const ts =
          typeof ev.recorded_at === 'number' && ev.recorded_at > 0
            ? Math.floor(ev.recorded_at / 1000)
            : 0
        if (ts <= 0) continue
        usage.push({
          agent: this.id,
          model: typeof ev.model === 'string' && ev.model ? ev.model : 'unknown',
          provider: null,
          ts,
          inputTokens: input,
          outputTokens: output,
          reasoningTokens: reasoning,
          cacheReadTokens: cached,
          cacheWriteTokens: cacheWrite,
          sessionId,
          dedupeKey: `muse:${file}:${i}`,
          isEstimated: false
        })
      }
    }

    let records = 0
    if (usage.length > 0) records = this.store.insertUsage(usage)

    // 会话：目录 uuid 即会话 id；标题官方未提供独立字段，置空（侧栏显示 Session id）
    const sessionRows: Parameters<StoreWriter['upsertSessions']>[0] = [...sessionIds].map((id) => ({
      agent: this.id,
      sessionId: id,
      title: null,
      projectDir: null,
      model: null,
      startedAt: null,
      updatedAt: null
    }))
    const sessions = sessionRows.length > 0 ? this.store.upsertSessions(sessionRows) : 0

    return { records, sessions, tools: 0, lastTs: ctx.now, meta: ctx.state.meta }
  }
}
