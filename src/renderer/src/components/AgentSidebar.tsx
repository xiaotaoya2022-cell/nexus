// 侧栏：全部汇总入口 + Agent 列表（规范 §4.3）+ 同步状态。

import type { AgentInfo } from '@shared/types'
import type { JSX } from 'react'
import { relativeTime } from '@renderer/lib/format'
import { AnimatedNumber } from './RollingNumber'
import { STATUS_TEXT, StatusDot } from './ui'
import { useUi } from '@renderer/store'

export function AgentSidebar({
  agents,
  lastSyncAt
}: {
  agents: AgentInfo[]
  lastSyncAt: number | null
}): JSX.Element {
  const agent = useUi((s) => s.agent)
  const setAgent = useUi((s) => s.setAgent)

  const todayTotal = agents.reduce((sum, a) => sum + a.todayTokens, 0)
  const anyActive = agents.some((a) => a.status === 'active' || a.status === 'idle')

  return (
    <aside className="flex w-[264px] shrink-0 flex-col bg-background">
      <div className="px-2.5 pb-1 pt-3 text-ui-xs font-medium text-foreground-subtlest">
        AGENTS · {agents.length}
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {/* 全部：跨 Agent 汇总（对应全局 agent=null 视图） */}
        <button
          type="button"
          onClick={() => setAgent(null)}
          title={`全部 Agent · 今日合计 ${todayTotal} tokens`}
          className={`mb-1 flex w-full cursor-pointer items-center gap-2 rounded-lg border-b border-hairline pb-1.5 pl-2.5 pr-1 pt-1 transition-colors duration-150 ${
            agent === null ? 'bg-selected' : 'hover:bg-surface-hover'
          }`}
        >
          <span
            title={anyActive ? '有 Agent 活跃' : '无活跃 Agent'}
            className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
              anyActive ? 'bg-chart-1 nx-breathe' : 'bg-border'
            }`}
          />
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-ui-base font-medium text-foreground">全部 Agent</span>
            <span className="block truncate text-ui-xs text-foreground-subtlest">跨 Agent 汇总视图</span>
          </span>
          <span className="font-mono text-ui-xs tabular-nums text-foreground-subtle">
            {todayTotal > 0 ? <AnimatedNumber num={todayTotal} toggleable={false} /> : ''}
          </span>
        </button>
        {agents.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => setAgent(agent === a.id ? null : a.id)}
            title={`${a.label} · ${STATUS_TEXT[a.status]}`}
            className={`group flex w-full cursor-pointer items-center gap-2 rounded-lg pl-2.5 pr-1 py-1 transition-colors duration-150 ${
              agent === a.id ? 'bg-selected' : 'hover:bg-surface-hover'
            }`}
          >
            <StatusDot status={a.status} />
            <span className="min-w-0 flex-1 text-left">
              <span className="block truncate text-ui-base text-foreground">{a.label}</span>
              <span className="block truncate font-mono text-ui-xs text-foreground-subtlest">
                {a.note ?? relativeTime(a.lastActivityAt)}
              </span>
            </span>
            <span className="font-mono text-ui-xs tabular-nums text-foreground-subtle">
              {a.todayTokens > 0 ? <AnimatedNumber num={a.todayTokens} toggleable={false} /> : ''}
            </span>
          </button>
        ))}
      </nav>
      <footer className="border-t border-hairline px-3 py-2 text-ui-xs text-foreground-subtlest">
        <span className="font-mono">
          {lastSyncAt ? `上次同步 ${formatClock(lastSyncAt)}` : '尚未同步'}
        </span>
      </footer>
    </aside>
  )
}

function formatClock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds()
  ).padStart(2, '0')}`
}
