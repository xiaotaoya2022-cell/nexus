// Gemini CLI 适配器（Google 官方终端 Agent）。数据源（调研 2026-11-07，tokscale 佐证）：
// ~/.gemini/tmp/<projectHash>/chats/session-*.json（GEMINI_CLI_HOME 可改，默认按 home）。
// JSON 结构（防御式解析）：顶层 messages 数组；assistant 消息带 tokens{input, output, cached, thoughts}
// 与 timestamp（ISO 串）。cached 为 input 子集（官方 Responses 语义）→ 归一：input'=input-cached。
// 会话清理默认关闭，文件即历史。本机未装时 detect() 为 false。

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentAdapter,
  SyncContext,
  SyncResult,
  StoreWriter
} from '@main/modules/adapter/domain/types'

const TMP_DIR = join(homedir(), '.gemini', 'tmp')

interface GeminiTokens {
  input?: number
  output?: number
  cached?: number
  thoughts?: number
}

interface GeminiMessage {
  role?: string
  type?: string
  timestamp?: string
  model?: string
  tokens?: GeminiTokens
  usage?: GeminiTokens
}

interface GeminiChatFile {
  messages?: GeminiMessage[]
  [key: string]: unknown
}

function listChatFiles(dir: string, out: string[], depth: number): void {
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
    if (isDir) listChatFiles(p, out, depth + 1)
    else if (e.endsWith('.json')) out.push(p)
  }
}

function parseTokens(m: GeminiMessage): GeminiTokens | null {
  const t = m.tokens ?? m.usage
  return t && typeof t === 'object' ? t : null
}

export class GeminiCliAdapter implements AgentAdapter {
  readonly id = 'gemini-cli'
  readonly label = 'Gemini CLI'
  private readonly tmpDir = TMP_DIR

  constructor(private readonly store: StoreWriter) {}

  detect(): boolean {
    return existsSync(this.tmpDir)
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    if (!this.detect()) {
      return { records: 0, sessions: 0, tools: 0, lastTs: ctx.state.lastTs, meta: ctx.state.meta }
    }
    // projectHash 目录即会话容器；chats/session-*.json 每文件一条会话
    let projectDirs: string[] = []
    try {
      projectDirs = readdirSync(this.tmpDir)
    } catch {
      return { records: 0, sessions: 0, tools: 0, lastTs: ctx.now, meta: ctx.state.meta }
    }
    const usage: Parameters<StoreWriter['insertUsage']>[0] = []
    const sessions: Parameters<StoreWriter['upsertSessions']>[0] = []
    const files: string[] = []
    for (const pd of projectDirs) listChatFiles(join(this.tmpDir, pd), files, 0)

    for (const file of files) {
      let chat: GeminiChatFile
      try {
        chat = JSON.parse(readFileSync(file, 'utf8')) as GeminiChatFile
      } catch {
        continue
      }
      if (!chat || !Array.isArray(chat.messages)) continue
      const sessionId = file // 聊天文件路径做会话 id（稳定唯一）
      sessions.push({
        agent: this.id,
        sessionId,
        title: null,
        projectDir: null,
        model: null,
        startedAt: null,
        updatedAt: null
      })
      chat.messages.forEach((m, i) => {
        const tk = parseTokens(m)
        if (!tk) return
        const inputRaw = tk.input ?? 0
        const cached = tk.cached ?? 0
        const thoughts = tk.thoughts ?? 0
        const outputRaw = tk.output ?? 0
        const input = Math.max(0, inputRaw - cached)
        const output = Math.max(0, outputRaw - thoughts)
        const total = input + output + thoughts + cached
        if (total <= 0) return
        const ts = typeof m.timestamp === 'string' ? Date.parse(m.timestamp) || 0 : 0
        if (ts <= 0) return
        usage.push({
          agent: this.id,
          model: typeof m.model === 'string' && m.model ? m.model : 'unknown',
          provider: 'google',
          ts,
          inputTokens: input,
          outputTokens: output,
          reasoningTokens: thoughts,
          cacheReadTokens: cached,
          cacheWriteTokens: 0,
          sessionId,
          dedupeKey: `gemini-cli:${file}:${i}`,
          isEstimated: false
        })
      })
    }

    let records = 0
    if (usage.length > 0) records = this.store.insertUsage(usage)
    const sessionCount = sessions.length > 0 ? this.store.upsertSessions(sessions) : 0
    return { records, sessions: sessionCount, tools: 0, lastTs: ctx.now, meta: ctx.state.meta }
  }
}
