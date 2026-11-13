// 会话明细面板（右栏 / 窄屏抽屉）：按所选范围与 Agent 过滤，支持按消耗或最新时间排序、关键词搜索、
// 点击定位本地工作区目录，以及一键打码开关（截屏/演示/共享屏幕场景）。

import { useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { NodeKind, SessionRow } from '@shared/types'
import { vendorOf } from '@shared/vendors'
import { nexus } from '@renderer/lib/api'
import { compactNumber, fullNumber, relativeTime, shortDir, shortId } from '@renderer/lib/format'
import { t, useLang } from '../i18n'
import { useUi } from '@renderer/store'
import { AgentLogo } from './AgentLogo'
import { useDeltaFlashIds } from './MotionEffects'
import { NodeKindIcon } from './NodeVisuals'
import { AutoListHighlight, SlidingTabIndicator } from './SmoothHighlight'
import { EmptyState } from './ui'

const EYE_KEY = 'nexus.sessionsHidden'
const SORT_KEY = 'nexus.sessionsSort'

type SortBy = 'tokens' | 'recent'

function loadHidden(): boolean {
  try {
    return localStorage.getItem(EYE_KEY) === '1'
  } catch {
    return false
  }
}

function loadSort(): SortBy {
  try {
    return localStorage.getItem(SORT_KEY) === 'recent' ? 'recent' : 'tokens'
  } catch {
    return 'tokens'
  }
}

/** 隐藏态遮罩：保留首尾各 keep 个字符，中间打码（"业务轨"→"业•轨"，长路径→首2+•••+尾2） */
function maskKeepEnds(text: string, keep = 1): string {
  const s = text.trim()
  if (s.length <= keep * 2) return s.slice(0, 1) + '•'.repeat(3) + (s.length > 1 ? s.slice(-1) : '')
  return s.slice(0, keep) + '•'.repeat(4) + s.slice(-keep)
}

export interface SessionNodeMeta {
  label: string
  kind: NodeKind
  isLocal: boolean
}

export function SessionsPanel({
  sessions,
  agentColors,
  nodeMetaById,
  multiNode = false,
  selectedSessionKey,
  onSelectSession,
  onClose
}: {
  sessions: SessionRow[]
  /** 与环形图/侧栏一致的全局 Agent 配色 */
  agentColors: Map<string, string>
  nodeMetaById?: Map<string, SessionNodeMeta>
  multiNode?: boolean
  selectedSessionKey?: string | null
  onSelectSession?: (session: SessionRow) => void
  onClose?: () => void
}): JSX.Element {
  useLang() // 语言切换时重渲染
  const range = useUi((s) => s.range)
  const agent = useUi((s) => s.agent)
  const selectedNodeId = useUi((s) => s.selectedNodeId)
  const selectedProjectDir = useUi((s) => s.selectedProjectDir)
  const [hidden, setHidden] = useState(loadHidden)
  const [sortBy, setSortBy] = useState<SortBy>(loadSort)
  const [query, setQuery] = useState('')
  const listScrollRef = useRef<HTMLDivElement>(null)
  const sessionKey = (s: SessionRow): string => `${s.sourceNodeId ?? 'local'}:${s.agent}:${s.sessionId}`
  const flashingSessions = useDeltaFlashIds(
    sessions,
    sessionKey,
    (s) => s.tokens,
    `${range}:${agent ?? 'all'}:${selectedNodeId ?? 'all'}:${selectedProjectDir ?? 'all'}`
  )

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

  const switchSort = (next: SortBy): void => {
    setSortBy(next)
    try {
      localStorage.setItem(SORT_KEY, next)
    } catch {
      // ignore
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q
      ? sessions.filter((s) => {
          const nodeLabel = (
            (s.sourceNodeId ? nodeMetaById?.get(s.sourceNodeId)?.label : undefined) ??
            s.sourceNodeLabel ??
            ''
          ).toLowerCase()
          return (
            (s.title && s.title.toLowerCase().includes(q)) ||
            (s.projectDir && s.projectDir.toLowerCase().includes(q)) ||
            (s.model && s.model.toLowerCase().includes(q)) ||
            (nodeLabel && nodeLabel.includes(q)) ||
            s.agent.toLowerCase().includes(q) ||
            s.sessionId.toLowerCase().includes(q)
          )
        })
      : [...sessions]

    return list.sort((a, b) => {
      if (sortBy === 'recent') {
        const ta = a.updatedAt ?? a.startedAt ?? 0
        const tb = b.updatedAt ?? b.startedAt ?? 0
        return tb - ta || b.tokens - a.tokens
      }
      return b.tokens - a.tokens || (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
    })
  }, [sessions, query, sortBy, nodeMetaById])

  return (
    <aside className="flex h-full w-[320px] shrink-0 flex-col gap-2 rounded-xl bg-panel p-3">
      <header className="flex items-center justify-between px-1">
        <h2 className="text-ui-base font-medium text-foreground">{t('sessions.title')}</h2>
        <span className="flex items-center gap-1">
          <span
            className="font-mono text-ui-xs tabular-nums text-foreground-subtlest"
            title={t('sessions.count', { n: filtered.length })}
          >
            {filtered.length > 120 ? `120 / ${filtered.length}` : filtered.length}
          </span>
          <span className="relative isolate ml-1 flex h-5 items-center rounded-full bg-surface p-0.5">
            <SlidingTabIndicator activeSelector='button[data-active="true"]' />
            {(['tokens', 'recent'] as SortBy[]).map((k) => (
              <button
                key={k}
                type="button"
                data-active={sortBy === k ? 'true' : undefined}
                onClick={() => switchSort(k)}
                className={`relative z-10 h-4 cursor-pointer rounded-full px-1.5 text-ui-xs leading-4 transition-colors duration-150 ${
                  sortBy === k
                    ? 'font-medium text-foreground'
                    : 'text-foreground-subtle hover:text-foreground'
                }`}
              >
                {t(`sessions.sort.${k}`)}
              </button>
            ))}
          </span>
          <button
            type="button"
            title={hidden ? t('sessions.mask.off') : t('sessions.mask.on')}
            aria-pressed={hidden}
            onClick={toggle}
            className="flex size-6 items-center justify-center rounded-md text-foreground-subtle transition-colors duration-150 hover:bg-hover hover:text-foreground"
          >
            {hidden ? <EyeOffIcon /> : <EyeIcon />}
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title={t('win.close')}
              className="flex size-6 items-center justify-center rounded-md text-foreground-subtle transition-colors duration-150 hover:bg-hover hover:text-foreground"
            >
              ✕
            </button>
          )}
        </span>
      </header>
      <div className="px-1">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('sessions.search')}
          className="h-7 w-full rounded-lg border border-hairline bg-surface px-2.5 text-ui-xs text-foreground placeholder:text-foreground-subtlest focus:border-border focus:outline-none"
        />
      </div>
      <div ref={listScrollRef} data-sessions-scroll="" className="min-h-0 flex-1 overflow-y-auto">
        <AutoListHighlight
          rootRef={listScrollRef}
          rowSelector="[data-list-row]"
          showSelected={false}
        />
        {filtered.length === 0 ? (
          <EmptyState title={t('sessions.empty.title')} description={t('sessions.empty.desc')} />
        ) : (
          <ul className="space-y-0.5">
            {filtered.map((s) => {
              const title = s.title ?? shortId(s.sessionId)
              const dirLabel = shortDir(s.projectDir)
              const meta = s.sourceNodeId ? nodeMetaById?.get(s.sourceNodeId) : undefined
              const originLabel = meta?.label ?? s.sourceNodeLabel ?? null
              const isRemote = meta ? !meta.isLocal : Boolean(s.sourceNodeId && originLabel)
              const showOrigin = Boolean(originLabel && (multiNode || isRemote))
              const canOpen = Boolean(s.projectDir) && !isRemote
              const tip = hidden
                ? undefined
                : [
                    `${s.agent}${s.model ? ` · ${s.model}` : ''}${originLabel ? ` · ${originLabel}` : ''}`,
                    s.projectDir
                      ? isRemote
                        ? `${originLabel ?? 'Remote'}: ${s.projectDir}`
                        : t('sessions.openDir', { dir: s.projectDir })
                      : s.sessionId
                  ].join('\n')
              const rowKey = sessionKey(s)
              const isSelected = selectedSessionKey === rowKey
              return (
                <li
                  key={rowKey}
                  data-list-row=""
                  data-session-row=""
                  onClick={() => {
                    if (onSelectSession) {
                      onSelectSession(s)
                    } else if (canOpen && s.projectDir) {
                      void nexus.openPath(s.projectDir).catch(() => undefined)
                    }
                  }}
                  className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 transition-colors duration-150 hover:bg-surface ${
                    isSelected ? 'bg-selected ring-1 ring-inset ring-border' : ''
                  } ${flashingSessions.has(rowKey) ? 'nx-delta-flash' : ''}`}
                  title={tip}
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: agentColors.get(s.agent) ?? 'var(--nx-chart-1)' }}
                  />
                  <AgentLogo agentId={s.agent} vendor={vendorOf(s.agent)} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-ui-caption text-foreground">
                        {hidden ? maskKeepEnds(title) : title}
                      </span>
                      {showOrigin && originLabel && (
                        <span
                          className={`inline-flex max-w-[82px] shrink-0 items-center gap-1 rounded px-1 py-0.5 font-mono text-[9px] leading-none ${
                            isRemote
                              ? 'border border-cobalt/30 bg-cobalt/12 text-cobalt'
                              : 'bg-surface text-foreground-subtlest'
                          }`}
                        >
                          {meta && <NodeKindIcon kind={meta.kind} className="size-2.5 shrink-0" />}
                          <span className="truncate">
                            {hidden ? maskKeepEnds(originLabel) : originLabel}
                          </span>
                        </span>
                      )}
                    </span>
                    <span className="flex items-center gap-1 truncate font-mono text-ui-xs text-foreground-subtlest">
                      {s.model && !hidden && (
                        <span className="max-w-[110px] truncate rounded bg-surface px-1 text-[10px] text-foreground-subtle">
                          {s.model}
                        </span>
                      )}
                      <span className="truncate">
                        {hidden
                          ? `${maskKeepEnds(dirLabel || s.agent)} · ${relativeTime(s.updatedAt ?? s.startedAt)}`
                          : `${dirLabel || s.agent} · ${relativeTime(s.updatedAt ?? s.startedAt)}`}
                      </span>
                    </span>
                  </span>
                  {canOpen && s.projectDir && !hidden && (
                    <button
                      type="button"
                      title={t('sessions.revealFolder')}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (s.projectDir) void nexus.openPath(s.projectDir).catch(() => undefined)
                      }}
                      className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-foreground-subtlest transition-colors duration-150 hover:bg-hover hover:text-foreground group-hover:flex"
                    >
                      <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden>
                        <path
                          d="M1.75 3.5C1.75 2.95 2.2 2.5 2.75 2.5H5.5L6.75 3.75H11.25C11.8 3.75 12.25 4.2 12.25 4.75V10.5C12.25 11.05 11.8 11.5 11.25 11.5H2.75C2.2 11.5 1.75 11.05 1.75 10.5V3.5Z"
                          stroke="currentColor"
                          strokeWidth="1.2"
                        />
                      </svg>
                    </button>
                  )}
                  <span
                    className="shrink-0 text-right font-mono text-ui-xs tabular-nums text-foreground-subtle"
                    title={t('sessions.tip', { tokens: fullNumber(s.tokens), n: s.requests })}
                  >
                    <span className="block">{s.tokens > 0 ? compactNumber(s.tokens) : '—'}</span>
                    {s.requests > 0 && (
                      <span className="block text-[10px] text-foreground-subtlest">
                        {s.requests} req
                      </span>
                    )}
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
