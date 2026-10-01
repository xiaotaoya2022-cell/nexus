// DeepSeek Harness（DSH）适配器：直接解析本机 ~/.dsh/sessions/ 的多帧 zstd 会话文件，
// 提取每步 LLM 用量（assistant/message.usage + compaction/summary.usage）、
// 模型、工具调用与会话元数据，落库到 usage_records/sessions/tool_calls。
// 增量策略：按文件 mtime+size 变化检测；每轮按时间预算处理最新文件，剩余留给下一轮。

import type {
  AgentAdapter,
  SyncContext,
  SyncResult,
  StoreWriter
} from '@main/modules/adapter/domain/types'
import { DshLocalSessionReader, type DshSessionFile } from '@main/modules/dsh/sessions-reader'

/** 单轮解压解析的时间预算（ms）。首轮积压靠多轮消化，最新文件优先。 */
const ROUND_TIME_BUDGET_MS = 20_000
const MIN_FILES_PER_ROUND = 5

interface FileStamp {
  m: number
  s: number
}

function stampsFromMeta(meta: Record<string, unknown>): Map<string, FileStamp> {
  const out = new Map<string, FileStamp>()
  const raw = meta.fileStamps
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const st = v as { m?: unknown; s?: unknown }
      if (typeof st?.m === 'number' && typeof st?.s === 'number') out.set(k, { m: st.m, s: st.s })
    }
  }
  return out
}

export class DshAdapter implements AgentAdapter {
  readonly id = 'dsh'
  readonly label = 'DeepSeek Harness'
  private readonly reader = new DshLocalSessionReader()

  constructor(private readonly store: StoreWriter) {}

  detect(): boolean {
    return this.reader.available()
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    if (!this.detect()) {
      return { records: 0, sessions: 0, tools: 0, lastTs: ctx.state.lastTs, meta: ctx.state.meta }
    }
    const stamps = stampsFromMeta(ctx.state.meta)
    const files = this.reader.enumerate()
    const changed = files.filter((f) => {
      const st = stamps.get(f.path)
      return !st || st.m !== f.mtimeMs || st.s !== f.size
    })

    let records = 0
    let sessions = 0
    let tools = 0
    const startedAt = Date.now()
    const processed: DshSessionFile[] = []

    for (const file of changed) {
      try {
        const parsed = await this.reader.parse(file)
        if (parsed.usageRows.length > 0) {
          records += this.store.insertUsage(parsed.usageRows.map((r) => ({ ...r, agent: this.id })))
        }
        if (parsed.toolRows.length > 0) {
          tools += this.store.insertToolCalls(parsed.toolRows.map((r) => ({ ...r, agent: this.id })))
        }
        this.store.upsertSessions([
          {
            agent: this.id,
            sessionId: parsed.sessionId,
            title: parsed.title,
            projectDir: parsed.cwd ?? parsed.workspaceLabel,
            model: parsed.models[0] ?? null,
            startedAt: parsed.startedAt,
            updatedAt: parsed.updatedAt
          }
        ])
        sessions += 1
        stamps.set(file.path, { m: file.mtimeMs, s: file.size })
        processed.push(file)
      } catch {
        // 单文件损坏跳过；不标记时间戳，下轮重试一次仍失败则被新 mtime 覆盖
      }
      if (Date.now() - startedAt >= ROUND_TIME_BUDGET_MS && processed.length >= MIN_FILES_PER_ROUND) break
    }

    const fileStamps: Record<string, FileStamp> = {}
    for (const [k, v] of stamps) fileStamps[k] = v
    return {
      records,
      sessions,
      tools,
      lastTs: ctx.now,
      meta: { ...ctx.state.meta, fileStamps, pendingFiles: changed.length - processed.length }
    }
  }
}
