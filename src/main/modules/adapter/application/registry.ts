// 适配器注册表：适配器优先级依据《Agent 数据源调研报告》
// P0 ZCode（请求级精确）→ P1 Codex（事件级精确）→ P2 Antigravity（Cockpit 代理日志）
// P3 Claude Code（预留）。CodeBuddy 仅会话元数据。
// 另有一批"仅感知安装"的 Agent（本地无结构化 token 数据），用于侧栏状态展示。

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentAdapter, PresenceOnlyAgent, StoreWriter } from '../domain/types'
import { ZCodeAdapter } from '../infrastructure/zcode'
import { CodexAdapter } from '../infrastructure/codex'
import { AntigravityAdapter } from '../infrastructure/antigravity'
import { ClaudeCodeAdapter } from '../infrastructure/claude-code'
import { CodeBuddyAdapter } from '../infrastructure/codebuddy'

export function createAdapters(store: StoreWriter): AgentAdapter[] {
  return [
    new ZCodeAdapter(store),
    new CodexAdapter(store),
    new AntigravityAdapter(store),
    new ClaudeCodeAdapter(store),
    new CodeBuddyAdapter(store)
  ]
}

export const PRESENCE_ONLY_AGENTS: PresenceOnlyAgent[] = [
  {
    id: 'workbuddy',
    label: 'WorkBuddy',
    detectPaths: [join(homedir(), '.workbuddy')],
    note: '状态云同步，无本地用量数据'
  },
  {
    id: 'qoder',
    label: 'Qoder',
    detectPaths: [
      join(homedir(), '.qoder'),
      join(process.env.APPDATA ?? '', 'com.qodercn.app.stable')
    ],
    note: '会话历史存云端'
  },
  {
    id: 'reasonix',
    label: 'Reasonix',
    detectPaths: [
      join(homedir(), '.reasonix'),
      join(process.env.APPDATA ?? '', 'reasonix')
    ],
    note: '本地仅对话快照，无 token 记录'
  },
  {
    id: 'trae',
    label: 'Trae',
    detectPaths: [join(homedir(), '.trae')],
    note: '本地无用量数据'
  },
  {
    id: 'cursor',
    label: 'Cursor',
    detectPaths: [join(homedir(), '.cursor')],
    note: '用量在服务端，无本地 token 记录'
  }
]

export function detectPresence(paths: string[]): boolean {
  return paths.some((p) => p.length > 0 && existsSync(p))
}
