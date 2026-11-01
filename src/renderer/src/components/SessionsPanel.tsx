// 会话明细面板（右栏）：按所选范围与 Agent 过滤，按 Token 降序。
// 眼睛开关：一键隐藏/部分显示敏感信息（标题/项目路径/会话 ID/token 数模糊化），
// 状态持久化 localStorage（截屏/演示/共享屏幕场景）。

import { useState } from 'react'
import type { JSX } from 'react'
import type { SessionRow } from '@shared/types'
import { compactNumber, fullNumber, relativeTime, shortDir, shortId } from '@renderer/lib/format'
import { EmptyState } from './ui'

const EYE_KEY = 'nexus.sessionsHidden'

function loadHidden(): boolean {
  try {
    return localStorage.getItem(EYE_KEY) === '1'
  } catch {
    return false
  }
}

/** 隐藏态的等长遮罩：保留字符数/量级，看不出具体内容 */
function maskText(text: string): string {
  return text.replace(/[^\s·/\\:.-]/g, '•')
}

function maskTokens(n: number): string {
  // 保留量级：如 12.6M → xx.xM，4.3 亿 → xx 亿
  return compactNumber(n).replace(/\d/g, '•')
}

export function SessionsPanel({
  sessions,
  agentColors
}: {
  sessions: SessionRow[]
  /** 与环形图/侧栏一致的全局 Agent 配色（红队 N-15） */
  agentColors: Map<string, string>
}): JSX.Element {
  const [hidden, setHidden] = useState(loadHidden)

  const toggle = (): void => {
    setHidden((v) => {
      const next = !v
      try {
        localStorage.setItem(EYE_KEY, next ? '1' : '0')
      } catch {
        // localStorage 不可用时仅失去持久化
      }
      return next
    })
  }

  return (
    <aside className="flex w-[320px] shrink-0 flex-col gap-2 rounded-xl bg-panel p-3">
      <header className="flex items-center justify-between px-1">
        <h2 className="text-ui-base font-medium text-foreground">会话明细</h2>
        <span className="flex items-center gap-1.5">
          <span
            className="font-mono text-ui-xs tabular-nums text-foreground-subtlest"
            title={`共 ${sessions.length} 条（最多显示前 120 条）`}
          >
            {hidden ? '•••' : sessions.length > 120 ? `120 / ${sessions.length}` : sessions.length}
          </span>
          <button
            type="button"
            title={hidden ? '显示敏感信息（标题/路径/Token 数）' : '隐藏敏感信息（截屏/演示用）'}
            aria-pressed={hidden}
            onClick={toggle}
            className="flex size-6 items-center justify-center rounded-md text-foreground-subtle transition-colors duration-150 hover:bg-hover hover:text-foreground"
          >
            {hidden ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <EmptyState title="暂无会话" description="该范围内没有会话记录，试试切换时间范围。" />
        ) : (
          <ul className="space-y-0.5">
            {sessions.map((s) => {
              const title = s.title ?? shortId(s.sessionId)
              const sub = `${s.agent} · ${shortDir(s.projectDir)} · ${relativeTime(s.updatedAt)}`
              return (
                <li
                  key={`${s.agent}:${s.sessionId}`}
                  className="flex items-center gap-2 rounded-lg px-2 py-1 transition-colors duration-150 hover:bg-surface"
                  title={hidden ? undefined : `${s.agent} · ${s.sessionId}`}
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: agentColors.get(s.agent) ?? 'var(--nx-chart-1)' }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui-caption text-foreground">
                      {hidden ? maskText(title) : title}
                    </span>
                    <span className="block truncate font-mono text-ui-xs text-foreground-subtlest">
                      {hidden
                        ? `${maskText(s.agent)} · ${relativeTime(s.updatedAt)}`
                        : sub}
                    </span>
                  </span>
                  <span
                    className="shrink-0 font-mono text-ui-xs tabular-nums text-foreground-subtle"
                    title={hidden ? undefined : `${fullNumber(s.tokens)} tokens / ${s.requests} 次请求`}
                  >
                    {hidden ? (s.tokens > 0 ? maskTokens(s.tokens) : '—') : s.tokens > 0 ? compactNumber(s.tokens) : '—'}
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

function EyeIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  )
}

function EyeOffIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 4.5 20 20M9.9 5.9A9.4 9.4 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17.6 17.6 0 0 1-2.8 3.5M6.6 8A16.4 16.4 0 0 0 2.5 12S6 18.5 12 18.5c1.1 0 2.1-.2 3-.5M9.9 9.5a3.5 3.5 0 0 0 4.7 4.6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
