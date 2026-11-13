// Qoder 适配器：采集 ~/.qoder-cn/projects、~/.qoder/projects、~/.qoder-cli/projects 下的会话转录 (.jsonl)，
// 以及 %APPDATA%/com.qodercn.app.stable/main.sqlite 中的 chat_sessions 元数据。
// Qoder 转录包含完整的 assistant turn、tool_use 工具调用、model/runtime-config，
// 当服务端隐藏原始 input/output token（返回 0 但提供 credits / context_usage_ratio 与完整消息内容）时，
// 基于内容字符数与 credits/context_usage_ratio 进行回合级估算（标记 isEstimated: true）。

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
  collectFilesAsync,
  openReadonlyDb,
  parseTimestampMs,
  readJsonlOrZstdLines,
  sqliteFileStamp,
  tableExists
} from '../util'

interface QoderMeta {
  fileStamps?: Record<string, string>
  sqliteStamps?: Record<string, string>
}

interface QoderSessionAcc {
  sessionId: string
  title: string | null
  cwd: string | null
  model: string | null
  startedAt: number | null
  updatedAt: number | null
}

function stripTags(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<attached_files>[\s\S]*?<\/attached_files>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export class QoderAdapter implements AgentAdapter {
  readonly id = 'qoder'
  readonly label = 'Qoder'
  private readonly projectRoots = [
    join(homedir(), '.qoder-cn', 'projects'),
    join(homedir(), '.qoder', 'projects'),
    join(homedir(), '.qoder-cli', 'projects')
  ]
  private readonly sqlitePaths = [
    join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'com.qodercn.app.stable', 'main.sqlite'),
    join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'com.qoder.app.stable', 'main.sqlite')
  ]

  constructor(private readonly store: StoreWriter) {}

  detect(): boolean {
    return (
      this.projectRoots.some((p) => existsSync(p)) ||
      this.sqlitePaths.some((p) => existsSync(p))
    )
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    if (!this.detect()) {
      return { records: 0, sessions: 0, tools: 0, lastTs: ctx.state.lastTs, meta: ctx.state.meta }
    }
    const meta = (ctx.state.meta as Partial<QoderMeta> | undefined) ?? {}
    const fileStamps: Record<string, string> = { ...(meta.fileStamps ?? {}) }
    const sqliteStamps: Record<string, string> = { ...(meta.sqliteStamps ?? {}) }

    const result: SyncResult = {
      records: 0,
      sessions: 0,
      tools: 0,
      lastTs: ctx.state.lastTs,
      meta: ctx.state.meta
    }

    const files: string[] = []
    for (const root of this.projectRoots) {
      if (existsSync(root)) {
        for (const f of await collectFilesAsync(root, '.jsonl', 4)) {
          if (!f.endsWith('-exec.jsonl')) files.push(f)
        }
      }
    }
    files.sort()

    const sessions = new Map<string, QoderSessionAcc>()
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
      const baseName = (file.split(/[\\/]/).pop() ?? file).replace(/\.jsonl$/i, '')
      let sessionId = baseName
      let currentModel: string | null = null
      let pendingInputChars = 0

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx]
        if (!line.trim()) continue
        let ev: Record<string, unknown>
        try {
          ev = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }

        if (typeof ev.sessionId === 'string' && ev.sessionId) {
          sessionId = ev.sessionId
        }
        const ts = parseTimestampMs(ev.timestamp)
        const cwd = typeof ev.cwd === 'string' && ev.cwd ? ev.cwd : null
        const evType = typeof ev.type === 'string' ? ev.type : ''

        let acc = sessions.get(sessionId)
        if (!acc) {
          acc = {
            sessionId,
            title: null,
            cwd,
            model: currentModel,
            startedAt: ts,
            updatedAt: ts
          }
          sessions.set(sessionId, acc)
        } else {
          if (cwd && !acc.cwd) acc.cwd = cwd
          if (ts != null) {
            if (acc.startedAt == null || ts < acc.startedAt) acc.startedAt = ts
            if (acc.updatedAt == null || ts > acc.updatedAt) acc.updatedAt = ts
          }
        }

        if (evType === 'runtime-config') {
          if (typeof ev.model === 'string' && ev.model) {
            currentModel = ev.model
            acc.model = currentModel
          }
          continue
        }

        const msg = ev.message as Record<string, unknown> | undefined
        if (!msg) continue

        if (evType === 'user' || msg.role === 'user') {
          const content = msg.content
          if (typeof content === 'string') {
            pendingInputChars += content.length
            if (!acc.title && !ev.isMeta) {
              const cleaned = stripTags(content)
              if (cleaned) acc.title = cleaned.slice(0, 120)
            }
          } else if (Array.isArray(content)) {
            for (const block of content as Array<Record<string, unknown>>) {
              if (!block || typeof block !== 'object') continue
              if (block.type === 'text' && typeof block.text === 'string') {
                pendingInputChars += block.text.length
                if (!acc.title && !ev.isMeta) {
                  const cleaned = stripTags(block.text)
                  if (cleaned) acc.title = cleaned.slice(0, 120)
                }
              } else if (block.type === 'tool_result') {
                const tc = block.content
                if (typeof tc === 'string') pendingInputChars += tc.length
                else if (tc != null) pendingInputChars += JSON.stringify(tc).length
              }
            }
          }
          continue
        }

        if (evType === 'assistant' || msg.role === 'assistant') {
          const msgModel: string =
            typeof msg.model === 'string' && msg.model ? msg.model : currentModel ?? 'qoder-model'
          currentModel = msgModel
          acc.model = msgModel

          let outChars = 0
          let thinkingChars = 0
          const content = msg.content
          if (typeof content === 'string') {
            outChars += content.length
          } else if (Array.isArray(content)) {
            for (let bi = 0; bi < content.length; bi++) {
              const block = content[bi] as Record<string, unknown> | undefined
              if (!block || typeof block !== 'object') continue
              if (block.type === 'text' && typeof block.text === 'string') {
                outChars += block.text.length
              } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
                thinkingChars += block.thinking.length
              } else if (block.type === 'tool_use' && typeof block.name === 'string' && block.name) {
                const inputStr = block.input != null ? JSON.stringify(block.input) : ''
                outChars += block.name.length + inputStr.length
                const toolId = typeof block.id === 'string' && block.id ? block.id : `${lineIdx}:${bi}`
                toolRows.push({
                  agent: this.id,
                  toolName: block.name.slice(0, 200),
                  ts: ts ?? null,
                  sessionId,
                  dedupeKey: `qoder:tool:${sessionId}:${toolId}`
                })
              }
            }
          }

          const usage = (msg.usage ?? {}) as Record<string, unknown>
          const rawIn = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
          const rawOut = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
          const rawCacheRead =
            typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0
          const rawCacheWrite =
            typeof usage.cache_creation_input_tokens === 'number'
              ? usage.cache_creation_input_tokens
              : 0
          const credits = typeof usage.credits === 'number' ? usage.credits : 0

          let inputTokens = rawIn
          let outputTokens = rawOut
          let reasoningTokens = 0
          let cacheReadTokens = rawCacheRead
          let cacheWriteTokens = rawCacheWrite
          let isEstimated = false

          if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0) {
            isEstimated = true
            outputTokens = Math.max(1, Math.round(outChars / 3.5))
            reasoningTokens = Math.round(thinkingChars / 3.5)
            const fromInputChars = Math.round(pendingInputChars / 3.5)
            const fromCredits = credits > 0 ? Math.round(credits * 4000) : 0
            inputTokens = Math.max(fromInputChars, fromCredits, 32)
          }
          pendingInputChars = 0

          const msgId =
            typeof ev.uuid === 'string' && ev.uuid
              ? ev.uuid
              : typeof msg.id === 'string' && msg.id
                ? `${msg.id}:${lineIdx}`
                : `${lineIdx}`

          if (ts != null && ts > 0) {
            usageRows.push({
              agent: this.id,
              model: msgModel,
              provider: 'qoder',
              ts,
              inputTokens,
              outputTokens,
              reasoningTokens,
              cacheReadTokens,
              cacheWriteTokens,
              sessionId,
              dedupeKey: `qoder:msg:${sessionId}:${msgId}`,
              isEstimated
            })
            if (ts > result.lastTs) result.lastTs = ts
          }
        }
      }

      fileStamps[file] = stamp
    }

    // 补充读取 main.sqlite 的 chat_sessions 表（完整会话标题与时间）
    for (const dbPath of this.sqlitePaths) {
      const dbStamp = sqliteFileStamp(dbPath)
      if (!dbStamp || sqliteStamps[dbPath] === dbStamp) continue
      try {
        const db = openReadonlyDb(dbPath)
        try {
          if (tableExists(db, 'chat_sessions')) {
            const rows = db
              .prepare(
                `SELECT session_id, title, cwd, model, created_at, updated_at
                 FROM chat_sessions LIMIT 5000`
              )
              .all() as Array<Record<string, unknown>>
            for (const r of rows) {
              const sid = typeof r.session_id === 'string' ? r.session_id : null
              if (!sid) continue
              const existing = sessions.get(sid)
              const title =
                typeof r.title === 'string' && r.title.trim()
                  ? r.title.trim().slice(0, 120)
                  : existing?.title ?? null
              const cwd = typeof r.cwd === 'string' && r.cwd ? r.cwd : existing?.cwd ?? null
              const model =
                typeof r.model === 'string' && r.model ? r.model : existing?.model ?? null
              const createdAt = typeof r.created_at === 'number' ? r.created_at : null
              const updatedAt = typeof r.updated_at === 'number' ? r.updated_at : null
              sessions.set(sid, {
                sessionId: sid,
                title,
                cwd,
                model,
                startedAt: existing?.startedAt ?? createdAt,
                updatedAt: Math.max(existing?.updatedAt ?? 0, updatedAt ?? 0) || null
              })
            }
          }
          sqliteStamps[dbPath] = dbStamp
        } finally {
          db.close()
        }
      } catch {
        // SQLite 忙/损坏不阻塞
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
    result.meta = { fileStamps, sqliteStamps }
    return result
  }
}
