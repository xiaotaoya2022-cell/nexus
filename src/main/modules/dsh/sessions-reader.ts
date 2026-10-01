// DSH 本地会话读取器：解压 ~/.dsh/sessions/ 下的 zstd 会话文件，
// 不依赖 DSH 进程运行（用户要求：数据在本机即可见）。
// 结构：~/.dsh/sessions/<workspace-dir>/session-<uuid>/session.jsonl.zstd
//
// 两个关键事实（2026-10 实测）：
// 1. 会话文件是**多帧拼接 zstd**（DSH 追加写入产生多帧），node:zlib 只能解出
//    第一帧（session 头），必须用 fzstd（纯 JS，天然逐帧循环解压）。
// 2. 事件字段：顶层 type/seq/time(ms)；用量在 assistant/message 的
//    data.usage{inputTokens,outputTokens,cacheReadTokens,reasoningTokens}，模型在
//    data.message.source.model；compaction/summary 的 data.usage/data.model 也是真实
//    LLM 消耗；tool/call 的 data.name/data.callId 即工具调用。

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { decompress as fzstdDecompress } from 'fzstd'
import { readFile } from 'node:fs/promises'
import type { ToolCallRecordInput, UsageRecordInput } from '@main/modules/adapter/domain/types'

export interface DshLocalSession {
  sessionId: string
  workspaceDir: string
  workspaceLabel: string
  startedAt: number | null
  updatedAt: number | null
  messageCount: number
  title: string | null
}

/** 单个会话文件的完整解析结果（适配器据此落库）。 */
export interface DshParsedSession {
  sessionId: string
  workspaceLabel: string
  cwd: string | null
  title: string | null
  startedAt: number | null
  updatedAt: number | null
  requestCount: number
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  models: string[]
  usageRows: Array<Omit<UsageRecordInput, 'agent'>>
  toolRows: Array<Omit<ToolCallRecordInput, 'agent'>>
}

export interface DshSessionFile {
  path: string
  sessionId: string
  workspaceLabel: string
  mtimeMs: number
  size: number
}

const SESSIONS_DIR = join(homedir(), '.dsh', 'sessions')

/** 解码 workspace 目录名（~0020 = 空格等 URL 编码片段） */
function decodeWorkspaceDir(name: string): string {
  return name
    .replace(/~0020/g, ' ')
    .replace(/~002D/gi, '-')
    .replace(/~005F/gi, '_')
    .replace(/~2D/gi, '-')
    .replace(/~5F/gi, '_')
}

/** 顶层 user/message 文本（标题兜底；正文常以 openviking-context 开头，需剥壳）。 */
function userText(o: Record<string, unknown>): string {
  const content = (o.data as Record<string, unknown> | undefined)?.content
  const parts =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? (content as Array<{ type?: string; text?: string }>)
            .filter((c) => c?.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text)
        : []
  const joined = parts
    .join(' ')
    .replace(/<openviking-context[\s\S]*?<\/openviking-context>/g, ' ')
    .replace(/<think>[\s\S]*?<\/think>/g, ' ')
    .trim()
  return joined
}

/** 解压并解析单个会话文件。异常向上抛（调用方按文件粒度容错）。 */
export async function parseSessionFile(
  filePath: string,
  sessionId: string,
  workspaceLabel: string,
  fileMtimeMs: number
): Promise<DshParsedSession> {
  const buf = await readFile(filePath)
  const jsonl = Buffer.from(fzstdDecompress(new Uint8Array(buf)).buffer).toString('utf8')

  let cwd: string | null = null
  let createdAt: number | null = null
  let title: string | null = null
  let fallbackTitle: string | null = null
  let firstTime: number | null = null
  let lastTime: number | null = null
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  const models = new Set<string>()
  const usageRows: Array<Omit<UsageRecordInput, 'agent'>> = []
  const toolRows: Array<Omit<ToolCallRecordInput, 'agent'>> = []
  let lineIdx = 0

  for (const line of jsonl.split('\n')) {
    const idx = lineIdx++
    if (!line.trim()) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const type = typeof o.type === 'string' ? o.type : ''
    const time = typeof o.time === 'number' ? o.time : null
    if (time != null) {
      if (firstTime == null) firstTime = time
      lastTime = time
    }
    const seq = typeof o.seq === 'number' ? o.seq : null
    const data = (o.data ?? {}) as Record<string, unknown>

    if (type === 'session') {
      if (typeof data.cwd === 'string') cwd = data.cwd
      if (typeof data.createdAt === 'number') createdAt = data.createdAt
      continue
    }
    if (type === 'session/title' && typeof data.title === 'string' && data.title) {
      title = data.title.slice(0, 120)
      continue
    }
    if (type === 'assistant/message') {
      const usage = data.usage as Record<string, number> | undefined
      if (usage && typeof usage.inputTokens === 'number') {
        const input = usage.inputTokens | 0
        const output = usage.outputTokens | 0
        const reasoning = (usage.reasoningTokens ?? 0) | 0
        const cacheRead = (usage.cacheReadTokens ?? 0) | 0
        tokens.input += input
        tokens.output += output
        tokens.reasoning += reasoning
        tokens.cacheRead += cacheRead
        const message = data.message as Record<string, unknown> | undefined
        const source = message?.source as Record<string, unknown> | undefined
        const model = typeof source?.model === 'string' && source.model ? source.model : 'unknown'
        models.add(model)
        usageRows.push({
          model,
          provider: typeof source?.provider === 'string' ? (source.provider as string) : null,
          ts: time ?? createdAt ?? fileMtimeMs,
          inputTokens: input,
          outputTokens: output,
          reasoningTokens: reasoning,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: 0,
          sessionId,
          dedupeKey: `dsh:${sessionId}:${seq ?? `l${idx}`}`,
          isEstimated: true
        })
      }
      continue
    }
    if (type === 'compaction/summary') {
      // 压缩摘要是独立的真实 LLM 请求（不计入 assistant/message），照常入账
      const usage = data.usage as Record<string, number> | undefined
      if (usage && typeof usage.inputTokens === 'number') {
        const input = usage.inputTokens | 0
        const output = usage.outputTokens | 0
        const model = typeof data.model === 'string' && data.model ? data.model : 'unknown'
        models.add(model)
        tokens.input += input
        tokens.output += output
        usageRows.push({
          model,
          provider: typeof data.provider === 'string' ? (data.provider as string) : null,
          ts: time ?? createdAt ?? fileMtimeMs,
          inputTokens: input,
          outputTokens: output,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          sessionId,
          dedupeKey: `dsh:${sessionId}:${seq ?? `l${idx}`}`,
          isEstimated: true
        })
      }
      continue
    }
    if (type === 'tool/call' && typeof data.name === 'string' && data.name) {
      const callId = typeof data.callId === 'string' ? data.callId : null
      toolRows.push({
        toolName: data.name.slice(0, 200),
        ts: time ?? null,
        sessionId,
        dedupeKey: callId ? `dsh:${sessionId}:tc:${callId}` : `dsh:${sessionId}:tcl${idx}`
      })
      continue
    }
    if (type === 'user/message' && fallbackTitle == null) {
      const t = userText(o)
      if (t) fallbackTitle = t.slice(0, 120)
    }
  }

  return {
    sessionId,
    workspaceLabel,
    cwd,
    title: title ?? fallbackTitle,
    startedAt: createdAt ?? firstTime,
    updatedAt: lastTime ?? createdAt ?? fileMtimeMs,
    requestCount: usageRows.length,
    tokens,
    models: [...models],
    usageRows,
    toolRows
  }
}

function byRecency(a: DshLocalSession, b: DshLocalSession): number {
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
}

export class DshLocalSessionReader {
  private readonly base = SESSIONS_DIR

  available(): boolean {
    return existsSync(this.base)
  }

  /** 轻量枚举：仅目录/mtime，不解压 zstd（侧栏/状态用，毫秒级）。 */
  listSummaries(): DshLocalSession[] {
    return this.enumerate().map((f) => ({
      sessionId: f.sessionId,
      workspaceDir: f.workspaceLabel,
      workspaceLabel: f.workspaceLabel,
      startedAt: null,
      updatedAt: f.mtimeMs || null,
      messageCount: 0,
      title: null
    }))
  }

  /** 文件系统枚举（不解压），按修改时间倒序。 */
  enumerate(): DshSessionFile[] {
    if (!existsSync(this.base)) return []
    const out: DshSessionFile[] = []
    for (const ws of readdirSync(this.base)) {
      const wsdir = join(this.base, ws)
      let sessDirs: string[] = []
      try {
        sessDirs = readdirSync(wsdir).filter((d) => d.startsWith('session-'))
      } catch {
        continue
      }
      for (const sess of sessDirs) {
        const zstdPath = join(wsdir, sess, 'session.jsonl.zstd')
        try {
          const st = statSync(zstdPath)
          out.push({
            path: zstdPath,
            sessionId: sess.replace('session-', ''),
            workspaceLabel: decodeWorkspaceDir(ws),
            mtimeMs: st.mtimeMs,
            size: st.size
          })
        } catch {
          continue
        }
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  parse(file: DshSessionFile): Promise<DshParsedSession> {
    return parseSessionFile(file.path, file.sessionId, file.workspaceLabel, file.mtimeMs)
  }
}

export { byRecency, decodeWorkspaceDir }
