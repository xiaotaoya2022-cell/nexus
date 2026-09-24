// 会话明细面板（右栏）：按所选范围与 Agent 过滤，按 Token 降序。

import type { AgentInfo, SessionRow } from '@shared/types'
import type { JSX } from 'react'
import { compactNumber, fullNumber, relativeTime, shortDir, shortId } from '@renderer/lib/format'
import { EmptyState } from './ui'

export function SessionsPanel({
  sessions,
  agents
}: {
  sessions: SessionRow[]
  agents: AgentInfo[]
}): JSX.Element {
  const colorByAgent = new Map(agents.map((a, i) => [a.id, i]))
  return (
    <aside className="flex w-[320px] shrink-0 flex-col gap-2 rounded-xl bg-panel p-3">
      <header className="flex items-center justify-between px-1">
        <h2 className="text-ui-base font-medium text-foreground">会话明细</h2>
        <span className="font-mono text-ui-xs tabular-nums text-foreground-subtlest">
          {sessions.length}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <EmptyState title="暂无会话" description="该范围内没有会话记录，试试切换时间范围。" />
        ) : (
          <ul className="space-y-0.5">
            {sessions.map((s) => {
              const colorIdx = colorByAgent.get(s.agent) ?? 0
              return (
                <li
                  key={`${s.agent}:${s.sessionId}`}
                  className="flex items-center gap-2 rounded-lg px-2 py-1 transition-colors duration-150 hover:bg-surface"
                  title={`${s.agent} · ${s.sessionId}`}
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      backgroundColor: `var(--nx-chart-${(colorIdx % 6) + 1})`
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui-caption text-foreground">
                      {s.title ?? shortId(s.sessionId)}
                    </span>
                    <span className="block truncate font-mono text-ui-xs text-foreground-subtlest">
                      {s.agent} · {shortDir(s.projectDir)} · {relativeTime(s.updatedAt)}
                    </span>
                  </span>
                  <span
                    className="shrink-0 font-mono text-ui-xs tabular-nums text-foreground-subtle"
                    title={`${fullNumber(s.tokens)} tokens / ${s.requests} 次请求`}
                  >
                    {s.tokens > 0 ? compactNumber(s.tokens) : '—'}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </aside>
  )
}
