// Qwen Code 适配器（阿里通义千问 CLI，Gemini CLI fork）。数据源（调研 2026-11-07，tokscale 佐证）：
// ~/.qwen/projects/<PROJECT_PATH 编码>/chats/<CHAT_ID>.jsonl
// 每行一个事件；模型响应行含 usageMetadata：
//   {promptTokenCount, candidatesTokenCount, thoughtsTokenCount, cachedContentTokenCount}
// 与 Gemini 语义一致：cached ⊆ prompt、thoughts ⊆ candidates → 归一防双计。
// 时间戳：行内 timestamp（ISO）优先；缺失回退文件 mtime（isEstimated 标记）。
// 本机未装时 detect() 为 false（~/.qwen 存在但无 chats 数据同样静默为 0）。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentAdapter,
  SyncContext,
  SyncResult,
  StoreWriter
} from '@main/modules/adapter/domain/types'

const PROJECTS_DIR = join(homedir(), '.qwen', 'projects')

interface QwenUsageMeta {
  promptTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
  cachedContentTokenCount?: number
}

interface QwenLine {
  timestamp?: string
  model?: string
  role?: string
  type?: string
  usageMetadata?: QwenUsageMeta
}

function listJsonl(dir: string, out: string[], depth: number): void {
  if (depth > 4 || out.length >= 5000) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e)
    let isDir = false
    try {
      isDir = readdirSync(p) !== undefined
    } catch {
      isDir = false
    }
    if (isDir) listJsonl(p, out, depth + 1)
    else if (e.endsWith('.jsonl')) out.push(p)
  }
}

export class QwenAdapter implements AgentAdapter {
  readonly id = 'qwen'
  readonly label = 'Qwen Code'
  private readonly projectsDir = PROJECTS_DIR

  constructor(private readonly store: StoreWriter) {}

  detect(): boolean {
    return existsSync(this.projectsDir)
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    if (!this.detect()) {
      return { records: 0, sessions: 0, tools: 0, lastTs: ctx.state.lastTs, meta: ctx.state.meta }
    }
    const files: string[] = []
    let projectDirs: string[] = []
    try {
      projectDirs = readdirSync(this.projectsDir)
    } catch {
      return { records: 0, sessions: 0, tools: 0, lastTs: ctx.now, meta: ctx.state.meta }
    }
    for (const pd of projectDirs) listJsonl(join(this.projectsDir, pd), files, 0)

    const usage: Parameters<StoreWriter['insertUsage']>[0] = []
    const sessions: Parameters<StoreWriter['upsertSessions']>[0] = []
    for (const file of files) {
      let lines: string[]
      try {
        lines = readFileSync(file, 'utf8').split('\n')
      } catch {
        continue
      }
      const chatId = file
      sessions.push({
        agent: this.id,
        sessionId: chatId,
        title: null,
        projectDir: null,
        model: null,
        startedAt: null,
        updatedAt: null
      })
      let mtimeFallback = 0
      try {
        mtimeFallback = statSync(file).mtimeMs
      } catch {
        mtimeFallback = 0
      }
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim()
        if (!line) continue
        let ev: QwenLine
        try {
          ev = JSON.parse(line) as QwenLine
        } catch {
          continue
        }
        const u = ev.usageMetadata
        if (!u || typeof u !== 'object') continue
        const prompt = u.promptTokenCount ?? 0
        const cached = u.cachedContentTokenCount ?? 0
        const thoughts = u.thoughtsTokenCount ?? 0
        const candidates = u.candidatesTokenCount ?? 0
        const input = Math.max(0, prompt - cached)
        const output = Math.max(0, candidates - thoughts)
        const total = input + output + thoughts + cached
        if (total <= 0) continue
        const tsParsed = typeof ev.timestamp === 'string' ? Date.parse(ev.timestamp) || 0 : 0
        const ts = tsParsed > 0 ? tsParsed : Math.floor(mtimeFallback)
        if (ts <= 0) continue
        usage.push({
          agent: this.id,
          model: typeof ev.model === 'string' && ev.model ? ev.model : 'unknown',
          provider: 'alibaba',
          ts,
          inputTokens: input,
          outputTokens: output,
          reasoningTokens: thoughts,
          cacheReadTokens: cached,
          cacheWriteTokens: 0,
          sessionId: chatId,
          dedupeKey: `qwen:${file}:${i}`,
          isEstimated: tsParsed <= 0 && mtimeFallback > 0 // 无行内时间戳 → 文件级时间，粗粒度
        })
      }
    }

    let records = 0
    if (usage.length > 0) records = this.store.insertUsage(usage)
    const sessionCount = sessions.length > 0 ? this.store.upsertSessions(sessions) : 0
    return { records, sessions: sessionCount, tools: 0, lastTs: ctx.now, meta: ctx.state.meta }
  }
}
