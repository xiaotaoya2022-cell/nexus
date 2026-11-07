// Cline 系三件套适配器（VS Code 插件，同源同构）：Cline / Roo Code / Kilo Code。
// 数据源（调研 2026-11-07，tokscale 与各官方仓库佐证）：
//   Cline     %APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/<taskId>/ui_messages.json
//   Roo Code  %APPDATA%/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/<taskId>/ui_messages.json
//   Kilo Code %APPDATA%/Code/User/globalStorage/kilocode.kilo-code/tasks/<taskId>/ui_messages.json
// ui_messages.json = 事件数组；type=api_req_started 的 text 字段是 JSON 串：
//   {tokensIn, tokensOut, cacheReads, cacheWrites, cost, apiProtocol}；
//   事件自带 ts（epoch ms）。taskId 即任务目录名（时间戳形态）。
// 口径：tokensIn 不含 cacheReads（字段互斥，源码同 Anthropic 分桶），直接入库。
// 本机未装对应插件时 detect() 为 false；装了即自动生效。三个工具共用下方解析器。

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentAdapter,
  SyncContext,
  SyncResult,
  StoreWriter
} from '@main/modules/adapter/domain/types'

interface ClineApiReqText {
  tokensIn?: number
  tokensOut?: number
  cacheReads?: number
  cacheWrites?: number
  cost?: number
}

interface ClineEvent {
  type?: string
  ts?: number
  text?: string
}

interface TaskDirPaths {
  /** 扩展 globalStorage 下的 tasks 目录 */
  tasksDir: string
}

function clineTasksDir(extensionDir: string): TaskDirPaths | null {
  const tasksDir = join(
    process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
    'Code',
    'User',
    'globalStorage',
    extensionDir,
    'tasks'
  )
  return existsSync(tasksDir) ? { tasksDir } : null
}

/** 解析单个插件 tasks 目录下的全部 ui_messages.json（千级文件内为小数组，全量扫 + dedupe upsert）。 */
function parseClineUsage(
  tasksDir: string,
  agentId: string,
  store: StoreWriter
): { records: number; sessions: number } {
  let taskDirs: string[] = []
  try {
    taskDirs = readdirSync(tasksDir)
  } catch {
    return { records: 0, sessions: 0 }
  }
  const usage: Parameters<StoreWriter['insertUsage']>[0] = []
  const sessions: Parameters<StoreWriter['upsertSessions']>[0] = []
  for (const taskId of taskDirs) {
    const taskDir = join(tasksDir, taskId)
    let events: ClineEvent[]
    try {
      events = JSON.parse(readFileSync(join(taskDir, 'ui_messages.json'), 'utf8')) as ClineEvent[]
    } catch {
      continue
    }
    if (!Array.isArray(events)) continue
    // 会话：taskId 目录即会话 id；标题无独立字段（首个 ask/user 事件不稳定性高），置空
    sessions.push({
      agent: agentId,
      sessionId: taskId,
      title: null,
      projectDir: null,
      model: null,
      startedAt: Number.isFinite(Number(taskId)) ? Number(taskId) : null,
      updatedAt: null
    })
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]
      if (ev.type !== 'api_req_started' || typeof ev.text !== 'string') continue
      let d: ClineApiReqText
      try {
        d = JSON.parse(ev.text) as ClineApiReqText
      } catch {
        continue
      }
      const input = d.tokensIn ?? 0
      const output = d.tokensOut ?? 0
      const cacheRead = d.cacheReads ?? 0
      const cacheWrite = d.cacheWrites ?? 0
      const total = input + output + cacheRead + cacheWrite
      if (total <= 0) continue
      const ts = typeof ev.ts === 'number' && ev.ts > 0 ? ev.ts : 0
      if (ts <= 0) continue
      usage.push({
        agent: agentId,
        model: 'unknown', // ui_messages 不含模型字段；会话级模型在历史文件里，价值低不追
        provider: null,
        ts,
        inputTokens: input,
        outputTokens: output,
        reasoningTokens: 0,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        sessionId: taskId,
        dedupeKey: `${agentId}:${taskId}:${i}`,
        isEstimated: false
      })
    }
  }
  let records = 0
  if (usage.length > 0) records = store.insertUsage(usage)
  const sessionCount = sessions.length > 0 ? store.upsertSessions(sessions) : 0
  return { records, sessions: sessionCount }
}

abstract class ClineFamilyAdapter implements AgentAdapter {
  constructor(
    private readonly tasksDir: TaskDirPaths | null,
    private readonly store: StoreWriter
  ) {}

  detect(): boolean {
    return this.tasksDir != null
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    if (!this.detect() || !this.tasksDir) {
      return { records: 0, sessions: 0, tools: 0, lastTs: ctx.state.lastTs, meta: ctx.state.meta }
    }
    const r = parseClineUsage(this.tasksDir.tasksDir, this.id, this.store)
    return { records: r.records, sessions: r.sessions, tools: 0, lastTs: ctx.now, meta: ctx.state.meta }
  }

  abstract readonly id: string
  abstract readonly label: string
}

const GLOBAL_STORAGE = join('Code', 'User', 'globalStorage')

export class ClineAdapter extends ClineFamilyAdapter {
  readonly id = 'cline'
  readonly label = 'Cline'
  constructor(store: StoreWriter) {
    super(clineTasksDir(join(GLOBAL_STORAGE, 'saoudrizwan.claude-dev')), store)
  }
}

export class RooCodeAdapter extends ClineFamilyAdapter {
  readonly id = 'roo-code'
  readonly label = 'Roo Code'
  constructor(store: StoreWriter) {
    super(clineTasksDir(join(GLOBAL_STORAGE, 'rooveterinaryinc.roo-cline')), store)
  }
}

export class KiloCodeAdapter extends ClineFamilyAdapter {
  readonly id = 'kilo-code'
  readonly label = 'Kilo Code'
  constructor(store: StoreWriter) {
    super(clineTasksDir(join(GLOBAL_STORAGE, 'kilocode.kilo-code')), store)
  }
}
