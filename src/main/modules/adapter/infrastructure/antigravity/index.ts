// Antigravity 适配器：
// 1) 原生对话转录：~/.gemini/antigravity/brain/<convId>/.system_generated/logs/transcript.jsonl
//    含每步 PLANNER_RESPONSE 的 created_at、input_tokens、output_tokens、cache_read_tokens 与 tool_calls，
//    以及 USER_INPUT 中的工作区路径、用户首条提问与 <USER_SETTINGS_CHANGE> 模型切换记录。
// 2) 原生生成元数据：~/.gemini/antigravity/conversations/<convId>.db 的 gen_metadata 表（Protobuf BLOB）
//    含每次生成的精确 input_tokens(f=2)、total_output(f=3)、cache_read_tokens(f=5)、
//    reasoning_tokens(f=9)、output_tokens(f=10) 及后端模型 ID(f=19)/展示名(f=21)，
//    可补齐 Claude 等模型在 transcript.jsonl 中未落盘的 token 字段并拆分推理 token。
// 3) 会话摘要与注解：~/.gemini/antigravity/conversation_summaries.db 与 annotations/<convId>.pbtxt。
// 4) 兼容源：~/.antigravity_cockpit/codex_local_access_logs.sqlite 的 request_logs 表。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentAdapter,
  SessionRecordInput,
  StoreWriter,
  SyncContext,
  SyncResult,
  ToolCallRecordInput,
  UsageRecordInput
} from '@main/modules/adapter/domain/types'
import {
  openReadonlyDb,
  parseTimestampMs,
  tableColumns,
  tableExists
} from '../util'

interface AgxMeta {
  sessionCursor?: string
  lastRowid?: number
  /** convId -> combined mtimeMs */
  convCursors?: Record<string, number>
}

interface ProtoField {
  f: number
  w: number
  v?: number
  buf?: Buffer
}

interface ParsedGenMeta {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  modelId: string | null
  modelLabel: string | null
}

interface PlannerStep {
  stepIndex: number
  createdAtMs: number | null
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  toolCalls: string[]
  contentLen: number
  thinkingLen: number
  settingsModel: string | null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function mtimeMsOf(p: string): number {
  try {
    return Math.floor(statSync(p).mtimeMs)
  } catch {
    return 0
  }
}

/** 轻量 Protobuf wire 解码器（仅解 varint w=0 与 length-delimited w=2） */
function decodeProto(buf: Buffer): ProtoField[] {
  const fields: ProtoField[] = []
  let offset = 0
  while (offset < buf.length) {
    let tag = 0
    let shift = 0
    while (offset < buf.length) {
      const b = buf[offset++]
      tag |= (b & 0x7f) << shift
      if ((b & 0x80) === 0) break
      shift += 7
      if (shift > 35) return fields
    }
    const fieldNo = tag >>> 3
    const wireType = tag & 0x7
    if (fieldNo === 0) break
    if (wireType === 0) {
      let val = 0n
      let s = 0n
      while (offset < buf.length) {
        const b = BigInt(buf[offset++])
        val |= (b & 0x7fn) << s
        if ((b & 0x80n) === 0n) break
        s += 7n
        if (s > 63n) return fields
      }
      fields.push({ f: fieldNo, w: 0, v: Number(val) })
    } else if (wireType === 2) {
      let len = 0
      let s = 0
      while (offset < buf.length) {
        const b = buf[offset++]
        len |= (b & 0x7f) << s
        if ((b & 0x80) === 0) break
        s += 7
      }
      if (len < 0 || offset + len > buf.length) break
      const sub = buf.subarray(offset, offset + len)
      offset += len
      fields.push({ f: fieldNo, w: 2, buf: sub })
    } else if (wireType === 1) {
      offset += 8
    } else if (wireType === 5) {
      offset += 4
    } else {
      break
    }
  }
  return fields
}

/** 解析 conversations/<convId>.db 中 gen_metadata.data 的 Protobuf 结构 */
function parseGenMetadataBlob(buf: Buffer): ParsedGenMeta | null {
  const top = decodeProto(buf)
  const f1 = top.find((x) => x.f === 1 && x.w === 2 && x.buf)
  if (!f1 || !f1.buf) return null
  const inner = decodeProto(f1.buf)
  let tokBuf = inner.find((x) => x.f === 4 && x.w === 2 && x.buf)?.buf
  if (!tokBuf) {
    const f17 = inner.find((x) => x.f === 17 && x.w === 2 && x.buf)
    if (f17?.buf) {
      tokBuf = decodeProto(f17.buf).find((x) => x.f === 2 && x.w === 2 && x.buf)?.buf
    }
  }
  let inputTokens = 0
  let totalOutput = 0
  let cacheReadTokens = 0
  let reasoningTokens = 0
  let outputTokens = 0
  if (tokBuf) {
    const tf = decodeProto(tokBuf)
    inputTokens = tf.find((x) => x.f === 2 && x.w === 0)?.v ?? 0
    totalOutput = tf.find((x) => x.f === 3 && x.w === 0)?.v ?? 0
    cacheReadTokens = tf.find((x) => x.f === 5 && x.w === 0)?.v ?? 0
    reasoningTokens = tf.find((x) => x.f === 9 && x.w === 0)?.v ?? 0
    outputTokens = tf.find((x) => x.f === 10 && x.w === 0)?.v ?? 0
    if (outputTokens === 0 && totalOutput > 0) {
      outputTokens = Math.max(0, totalOutput - reasoningTokens)
    }
  }
  const f19 = inner.find((x) => x.f === 19 && x.w === 2 && x.buf)
  const f21 = inner.find((x) => x.f === 21 && x.w === 2 && x.buf)
  const modelId = f19?.buf ? f19.buf.toString('utf8').trim() : null
  const modelLabel = f21?.buf ? f21.buf.toString('utf8').trim() : null
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    modelId: modelId || null,
    modelLabel: modelLabel || null
  }
}

/** 归一化 Antigravity 模型标识，避免内部实验后缀（-control/-n/-trial 等）拆碎排行榜 */
function normalizeAgModel(raw: string | null | undefined): string {
  if (!raw) return 'antigravity'
  const s = raw.trim()
  if (!s) return 'antigravity'
  if (/claude[- ]opus[- ]5[.-]5/i.test(s)) return 'claude-opus-5.5'
  if (/claude[- ]sonnet[- ]5[.-]5/i.test(s)) return 'claude-sonnet-5.5'
  if (/gemini[- ]4[- ]argon/i.test(s)) return 'gemini-4-argon'
  if (/gemini[- ]4[- ]hydrogen/i.test(s)) return 'gemini-4-hydrogen'
  if (/gemini[- ]3[.-]8[- ]flash/i.test(s)) return 'gemini-3.8-flash'
  return s
    .replace(/\s*\((High|Medium|Low|Thinking|Fast)\)\s*$/i, '')
    .replace(/-(trial|control|medium|high|low|n)$/i, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
}

/** 从 conversation_summaries.summary Base64 Protobuf 中提取可读标题 */
function extractSummaryTitle(b64: string | null): string | null {
  if (!b64) return null
  try {
    const buf = Buffer.from(b64, 'base64')
    const fields = decodeProto(buf)
    for (const f of fields) {
      if (f.w === 2 && f.buf) {
        const text = f.buf.toString('utf8').trim()
        if (text.length >= 2 && text.length <= 200 && !text.includes('\uFFFD')) {
          return text.split(/\r?\n/)[0].slice(0, 120)
        }
      }
    }
  } catch {
    // ignore
  }
  return null
}

/** 从 annotations/<convId>.pbtxt 提取 last_user_view_time (epoch ms) */
function readAnnotationTimeMs(pbtxtPath: string): number | null {
  if (!existsSync(pbtxtPath)) return null
  try {
    const text = readFileSync(pbtxtPath, 'utf8')
    const m = text.match(/seconds:\s*(\d+)/)
    if (m) return Number(m[1]) * 1000
  } catch {
    // ignore
  }
  return null
}

export class AntigravityAdapter implements AgentAdapter {
  readonly id = 'antigravity'
  readonly label = 'Antigravity'

  constructor(private readonly store: StoreWriter) {}

  private agDir(): string {
    return join(homedir(), '.gemini', 'antigravity')
  }

  private summariesDbPath(): string {
    return join(this.agDir(), 'conversation_summaries.db')
  }

  private accessLogsDbPath(): string {
    return join(homedir(), '.antigravity_cockpit', 'codex_local_access_logs.sqlite')
  }

  detect(): boolean {
    const ag = this.agDir()
    return (
      existsSync(join(ag, 'brain')) ||
      existsSync(join(ag, 'conversations')) ||
      existsSync(this.summariesDbPath()) ||
      existsSync(this.accessLogsDbPath())
    )
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const prev = (ctx.state.meta as unknown as AgxMeta) ?? {}
    let sessionCursor = prev.sessionCursor ?? ''
    let lastRowid = prev.lastRowid ?? 0
    const convCursors: Record<string, number> = { ...(prev.convCursors ?? {}) }
    let maxTs = ctx.state.lastTs

    let records = 0
    let sessions = 0
    let tools = 0

    const ag = this.agDir()
    const brainDir = join(ag, 'brain')
    const convDbDir = join(ag, 'conversations')
    const annotDir = join(ag, 'annotations')

    // 1. 先从 conversation_summaries.db 收集已知会话标题与时间
    const summaryTitles = new Map<string, string>()
    const summaryTimes = new Map<string, number>()
    const allConvIds = new Set<string>()

    const sumPath = this.summariesDbPath()
    if (existsSync(sumPath)) {
      let db
      try {
        db = openReadonlyDb(sumPath)
        if (tableExists(db, 'conversation_summaries')) {
          const cols = new Set(tableColumns(db, 'conversation_summaries'))
          const idCol = cols.has('conversation_id') ? 'conversation_id' : 'id'
          const sumCol = cols.has('summary') ? 'summary' : 'NULL'
          const timeCol = cols.has('last_modified_time') ? 'last_modified_time' : 'NULL'
          const rows = db
            .prepare(`SELECT ${idCol} AS id, ${sumCol} AS summary, ${timeCol} AS t FROM conversation_summaries`)
            .all() as Array<Record<string, unknown>>
          for (const r of rows) {
            const cid = str(r.id)
            if (!cid) continue
            allConvIds.add(cid)
            const tStr = str(r.t)
            if (tStr && tStr > sessionCursor) sessionCursor = tStr
            const ts = parseTimestampMs(r.t)
            if (ts) summaryTimes.set(cid, ts)
            const title = extractSummaryTitle(str(r.summary))
            if (title) summaryTitles.set(cid, title)
          }
        }
      } catch {
        // ignore
      } finally {
        try {
          db?.close()
        } catch {
          /* ignore */
        }
      }
    }

    // 2. 收集 brain/<convId> 与 conversations/<convId>.db
    if (existsSync(brainDir)) {
      try {
        for (const name of readdirSync(brainDir)) {
          if (name === 'tempmediaStorage' || name.startsWith('.')) continue
          const full = join(brainDir, name)
          try {
            if (statSync(full).isDirectory()) allConvIds.add(name)
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    }

    if (existsSync(convDbDir)) {
      try {
        for (const name of readdirSync(convDbDir)) {
          if (name.endsWith('.db')) {
            allConvIds.add(name.slice(0, -3))
          }
        }
      } catch {
        /* ignore */
      }
    }

    // 3. 逐会话解析 brain/<convId>/transcript.jsonl 与 conversations/<convId>.db
    const usageBatch: UsageRecordInput[] = []
    const sessionBatch: SessionRecordInput[] = []
    const toolBatch: ToolCallRecordInput[] = []

    for (const convId of allConvIds) {
      const transcriptPath = join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl')
      const convDbPath = join(convDbDir, `${convId}.db`)
      const annotPath = join(annotDir, `${convId}.pbtxt`)

      const combinedMtime = Math.max(
        mtimeMsOf(transcriptPath),
        mtimeMsOf(convDbPath),
        mtimeMsOf(annotPath),
        summaryTimes.get(convId) ?? 0
      )

      if (combinedMtime > 0 && convCursors[convId] === combinedMtime) {
        continue
      }

      // 3a. 读取 conversations/<convId>.db 的 gen_metadata
      const validGm: ParsedGenMeta[] = []
      if (existsSync(convDbPath)) {
        let cdb
        try {
          cdb = openReadonlyDb(convDbPath)
          if (tableExists(cdb, 'gen_metadata')) {
            const gmRows = cdb
              .prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC')
              .all() as Array<{ idx: number; data: Uint8Array }>
            for (const row of gmRows) {
              if (!row.data) continue
              const parsed = parseGenMetadataBlob(Buffer.from(row.data))
              if (
                parsed &&
                (parsed.inputTokens > 0 ||
                  parsed.outputTokens > 0 ||
                  parsed.reasoningTokens > 0 ||
                  parsed.cacheReadTokens > 0)
              ) {
                validGm.push(parsed)
              }
            }
          }
        } catch {
          // ignore
        } finally {
          try {
            cdb?.close()
          } catch {
            /* ignore */
          }
        }
      }

      // 3b. 读取 brain/<convId>/.system_generated/logs/transcript.jsonl
      const plannerSteps: PlannerStep[] = []
      let currentSettingsModel: string | null = null
      let firstUserTitle: string | null = null
      let projectDir: string | null = null
      let startedAt: number | null = null
      let updatedAt: number | null = readAnnotationTimeMs(annotPath) ?? summaryTimes.get(convId) ?? null

      if (existsSync(transcriptPath)) {
        try {
          const lines = readFileSync(transcriptPath, 'utf8').split('\n')
          for (const rawLine of lines) {
            const line = rawLine.trim()
            if (!line) continue
            let obj: Record<string, unknown>
            try {
              obj = JSON.parse(line)
            } catch {
              continue
            }
            const stepTs = parseTimestampMs(obj.created_at)
            if (stepTs != null) {
              if (startedAt == null || stepTs < startedAt) startedAt = stepTs
              if (updatedAt == null || stepTs > updatedAt) updatedAt = stepTs
            }

            const type = str(obj.type)
            const content = typeof obj.content === 'string' ? obj.content : ''

            if (type === 'USER_INPUT' && content) {
              // 检测模型切换：<USER_SETTINGS_CHANGE> ... from X to Y. No need
              if (content.includes('Model Selection')) {
                const m = content.match(/from\s+.+?\s+to\s+(.+?)\.\s+No need/s)
                if (m && m[1]) {
                  currentSettingsModel = m[1].trim()
                }
              }
              // 提取工作区路径
              if (!projectDir) {
                const wm =
                  content.match(/Command Working Directory:\s*([^\r\n<]+)/) ??
                  content.match(/Active Workspaces:\s*\r?\n-\s*([^\r\n<]+)/)
                if (wm && wm[1]) projectDir = wm[1].trim()
              }
              // 提取用户首条请求作为会话标题
              if (!firstUserTitle) {
                const reqMatch = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/)
                const candidate = (reqMatch ? reqMatch[1] : content)
                  .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '')
                  .trim()
                if (candidate && !candidate.startsWith('The user changed setting')) {
                  firstUserTitle = candidate.split(/\r?\n/)[0].trim().slice(0, 120)
                }
              }
            } else if (type === 'PLANNER_RESPONSE') {
              const stepIdx = typeof obj.step_index === 'number' ? obj.step_index : plannerSteps.length
              const rawTools = Array.isArray(obj.tool_calls) ? obj.tool_calls : []
              const toolNames: string[] = []
              for (const tc of rawTools) {
                if (tc && typeof tc === 'object') {
                  const name = str((tc as Record<string, unknown>).name)
                  if (name) toolNames.push(name)
                }
              }
              // 尝试从工具调用参数中提取项目路径（如 f:\Nexus）
              if (!projectDir && Array.isArray(obj.tool_calls)) {
                for (const tc of obj.tool_calls as Array<Record<string, unknown>>) {
                  const args = tc?.args as Record<string, unknown> | undefined
                  const p = str(args?.Path) ?? str(args?.DirectoryPath) ?? str(args?.SearchPath)
                  if (p && /^[a-zA-Z]:[\\/]/.test(p) && !p.includes('.gemini')) {
                    const parts = p.replace(/\//g, '\\').split('\\')
                    if (parts.length >= 2) {
                      projectDir = parts.slice(0, 2).join('\\')
                      break
                    }
                  }
                }
              }

              const thinking = typeof obj.thinking === 'string' ? obj.thinking : ''
              plannerSteps.push({
                stepIndex: stepIdx,
                createdAtMs: stepTs,
                inputTokens: typeof obj.input_tokens === 'number' ? obj.input_tokens : undefined,
                outputTokens: typeof obj.output_tokens === 'number' ? obj.output_tokens : undefined,
                cacheReadTokens:
                  typeof obj.cache_read_tokens === 'number' ? obj.cache_read_tokens : undefined,
                toolCalls: toolNames,
                contentLen: content.length,
                thinkingLen: thinking.length,
                settingsModel: currentSettingsModel
              })
            }
          }
        } catch {
          // ignore
        }
      }

      // 3c. 对齐合并 plannerSteps 与 validGm
      const count = Math.max(plannerSteps.length, validGm.length)
      let lastKnownModel = normalizeAgModel(currentSettingsModel)
      const fallbackTs = updatedAt ?? startedAt ?? (combinedMtime > 0 ? combinedMtime : ctx.now)

      for (let i = 0; i < count; i++) {
        const step = plannerSteps[i]
        const gm = validGm[i]
        const ts = step?.createdAtMs ?? fallbackTs

        if (step && step.toolCalls.length > 0) {
          for (let ti = 0; ti < step.toolCalls.length; ti++) {
            toolBatch.push({
              agent: this.id,
              toolName: step.toolCalls[ti],
              ts,
              sessionId: convId,
              dedupeKey: `${this.id}:tool:${convId}:${step.stepIndex}:${ti}`
            })
          }
        }

        let inputTokens = 0
        let outputTokens = 0
        let reasoningTokens = 0
        let cacheReadTokens = 0
        let model = lastKnownModel
        let isEstimated = false

        if (gm) {
          inputTokens = gm.inputTokens || (step?.inputTokens ?? 0)
          cacheReadTokens = gm.cacheReadTokens || (step?.cacheReadTokens ?? 0)
          reasoningTokens = gm.reasoningTokens
          outputTokens =
            gm.outputTokens || Math.max(0, (step?.outputTokens ?? 0) - reasoningTokens)
          model = normalizeAgModel(
            gm.modelId ?? gm.modelLabel ?? step?.settingsModel ?? lastKnownModel
          )
        } else if (step && (step.inputTokens !== undefined || step.outputTokens !== undefined)) {
          inputTokens = step.inputTokens ?? 0
          outputTokens = step.outputTokens ?? 0
          cacheReadTokens = step.cacheReadTokens ?? 0
          reasoningTokens = 0
          model = normalizeAgModel(step.settingsModel ?? lastKnownModel)
        } else if (step && (step.contentLen > 0 || step.thinkingLen > 0 || step.toolCalls.length > 0)) {
          // 兜底估算（若某步既无 gen_metadata 又未落盘 token 字段）
          outputTokens = Math.max(1, Math.round(step.contentLen / 3.5) + step.toolCalls.length * 40)
          reasoningTokens = Math.round(step.thinkingLen / 3.5)
          inputTokens = Math.max(500, outputTokens * 4)
          model = normalizeAgModel(step.settingsModel ?? lastKnownModel)
          isEstimated = true
        } else {
          continue
        }

        lastKnownModel = model
        if (inputTokens + outputTokens + reasoningTokens + cacheReadTokens <= 0) continue

        if (ts > maxTs) maxTs = ts
        usageBatch.push({
          agent: this.id,
          model,
          provider: model.startsWith('claude') ? 'anthropic' : 'google',
          ts,
          inputTokens,
          outputTokens,
          reasoningTokens,
          cacheReadTokens,
          cacheWriteTokens: 0,
          sessionId: convId,
          dedupeKey: `${this.id}:${convId}:gen:${i}`,
          isEstimated
        })
      }

      const sessionTitle = summaryTitles.get(convId) ?? firstUserTitle ?? null
      const finalStartedAt = startedAt ?? updatedAt ?? (combinedMtime > 0 ? combinedMtime : null)
      const finalUpdatedAt = updatedAt ?? startedAt ?? (combinedMtime > 0 ? combinedMtime : null)
      if (finalUpdatedAt && finalUpdatedAt > maxTs) maxTs = finalUpdatedAt

      sessionBatch.push({
        agent: this.id,
        sessionId: convId,
        title: sessionTitle,
        projectDir,
        model: lastKnownModel !== 'antigravity' ? lastKnownModel : null,
        startedAt: finalStartedAt,
        updatedAt: finalUpdatedAt
      })

      if (combinedMtime > 0) {
        convCursors[convId] = combinedMtime
      }
    }

    if (usageBatch.length > 0) records += this.store.insertUsage(usageBatch)
    if (sessionBatch.length > 0) sessions += this.store.upsertSessions(sessionBatch)
    if (toolBatch.length > 0) tools += this.store.insertToolCalls(toolBatch)

    // 4. 兼容源：Cockpit request_logs（按 rowid 增量）
    const logPath = this.accessLogsDbPath()
    if (existsSync(logPath)) {
      let db
      try {
        db = openReadonlyDb(logPath)
        if (tableExists(db, 'request_logs')) {
          const rows = db
            .prepare(
              `SELECT rowid AS rid, request_id, account_id, provider_id, model,
                      input_tokens, output_tokens, reasoning_tokens, cached_tokens, created_at
               FROM request_logs
               WHERE rowid > ?
               ORDER BY rowid ASC`
            )
            .all(lastRowid) as Array<Record<string, unknown>>

          const cockpitUsage: UsageRecordInput[] = []
          for (const r of rows) {
            const rid = num(r.rid)
            if (rid > lastRowid) lastRowid = rid
            const ts = parseTimestampMs(r.created_at) ?? ctx.now
            if (ts > maxTs) maxTs = ts

            const inputTokens = num(r.input_tokens)
            const outputTokens = num(r.output_tokens)
            const reasoningTokens = num(r.reasoning_tokens)
            const cacheReadTokens = num(r.cached_tokens)
            if (inputTokens + outputTokens + reasoningTokens + cacheReadTokens === 0) continue

            const reqId = str(r.request_id) ?? `rid-${rid}`
            cockpitUsage.push({
              agent: this.id,
              model: normalizeAgModel(str(r.model) ?? 'antigravity'),
              provider: str(r.provider_id) ?? 'antigravity',
              ts,
              inputTokens,
              outputTokens,
              reasoningTokens,
              cacheReadTokens,
              cacheWriteTokens: 0,
              sessionId: str(r.account_id),
              dedupeKey: `${this.id}:cockpit:${reqId}`
            })
          }
          if (cockpitUsage.length > 0) records += this.store.insertUsage(cockpitUsage)
        }
      } catch {
        // ignore
      } finally {
        try {
          db?.close()
        } catch {
          /* ignore */
        }
      }
    }

    const meta: AgxMeta = { sessionCursor, lastRowid, convCursors }
    return {
      records,
      sessions,
      tools,
      lastTs: maxTs,
      meta: meta as unknown as Record<string, unknown>
    }
  }
}
