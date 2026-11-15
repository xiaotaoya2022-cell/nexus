// Ctrl+K / Cmd+K 全局命令面板：
// 支持模糊检索视图跳转、时间范围、算力组网节点、AI Agent 筛选与高频快捷操作，
// 并复用 AutoListHighlight 弹簧高亮板实现键盘 ↑/↓ 与鼠标悬停的一体化丝滑跟踪。

import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import type { AgentInfo, ExportFormat, MeshNodeInfo, ProjectStat, RangeKey } from '@shared/types'
import { vendorOf } from '@shared/vendors'
import { t, useLang, type Lang } from '../i18n'
import { compactNumber } from '../lib/format'
import { AgentLogo } from './AgentLogo'
import { MeshGlyph, nodeDisplayName, NodeKindIcon } from './NodeVisuals'
import { AutoListHighlight } from './SmoothHighlight'
import {
  ExportIcon,
  GearIcon,
  MoonIcon,
  RANGE_OPTIONS,
  RefreshIcon,
  SunIcon
} from './ui'

type GroupId = 'nav' | 'nodes' | 'projects' | 'range' | 'agents'

interface CommandEntry {
  id: string
  group: GroupId
  label: string
  subtitle?: string
  badge?: string
  keywords: string
  icon: ReactNode
  perform: () => void
}

export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  activeView: 'board' | 'mesh'
  onSelectView: (view: 'board' | 'mesh') => void
  range: RangeKey
  onSelectRange: (range: RangeKey) => void
  nodes: MeshNodeInfo[]
  selectedNodeId: string | null
  onSelectNode: (nodeId: string | null) => void
  projects: ProjectStat[]
  selectedProjectDir: string | null
  onSelectProjectDir: (dir: string | null) => void
  agents: AgentInfo[]
  selectedAgent: string | null
  onSelectAgent: (agentId: string | null) => void
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  uiStyle: 'nexus' | 'porcelain'
  onToggleUiStyle: () => void
  lang: Lang
  onToggleLang: () => void
  cursorEnabled: boolean
  onToggleCursor: () => void
  onSyncNow: () => void
  onExportFormat: (format: ExportFormat) => void
  onOpenSettings: () => void
  onQuickPair: () => void
}

const GROUP_ORDER: GroupId[] = ['nav', 'nodes', 'projects', 'range', 'agents']

export function CommandPalette({
  open,
  onClose,
  activeView,
  onSelectView,
  range,
  onSelectRange,
  nodes,
  selectedNodeId,
  onSelectNode,
  projects,
  selectedProjectDir,
  onSelectProjectDir,
  agents,
  selectedAgent,
  onSelectAgent,
  theme,
  onToggleTheme,
  uiStyle,
  onToggleUiStyle,
  lang,
  onToggleLang,
  cursorEnabled,
  onToggleCursor,
  onSyncNow,
  onExportFormat,
  onOpenSettings,
  onQuickPair
}: CommandPaletteProps): JSX.Element | null {
  useLang()
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listScrollRef = useRef<HTMLDivElement>(null)
  const navByKeyboardRef = useRef(false)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIdx(0)
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [open])

  const entries = useMemo<CommandEntry[]>(() => {
    const list: CommandEntry[] = [
      {
        id: 'nav.board',
        group: 'nav',
        label: t('nav.board'),
        badge: activeView === 'board' ? 'ACTIVE' : undefined,
        keywords: 'board overview dashboard 看板 总览 主页',
        icon: <BoardGlyph />,
        perform: () => onSelectView('board')
      },
      {
        id: 'nav.mesh',
        group: 'nav',
        label: t('nav.mesh'),
        badge: activeView === 'mesh' ? 'ACTIVE' : undefined,
        keywords: 'mesh cluster topology nodes vm wsl 算力 组网 拓扑 节点',
        icon: <MeshGlyph className="size-4 text-cobalt" />,
        perform: () => onSelectView('mesh')
      },
      {
        id: 'action.pair',
        group: 'nav',
        label: t('cmdk.action.pair'),
        keywords: 'pair pin qr websocket hub spoke 配对 二维码 组网',
        icon: <MeshGlyph className="size-4 text-signal" />,
        perform: () => onQuickPair()
      },
      {
        id: 'action.sync',
        group: 'nav',
        label: t('header.action.syncNow'),
        keywords: 'sync refresh scan delta 同步 刷新',
        icon: <RefreshIcon />,
        perform: () => onSyncNow()
      },
      {
        id: 'action.export.png',
        group: 'nav',
        label: t('cmdk.export.png'),
        keywords: 'export png image screenshot 导出 图片',
        icon: <ExportIcon />,
        perform: () => onExportFormat('png')
      },
      {
        id: 'action.export.csv',
        group: 'nav',
        label: t('cmdk.export.csv'),
        keywords: 'export csv excel table ledger 导出 表格 对账',
        icon: <ExportIcon />,
        perform: () => onExportFormat('csv')
      },
      {
        id: 'action.export.md',
        group: 'nav',
        label: t('cmdk.export.md'),
        keywords: 'export markdown report md 导出 报告 摘要',
        icon: <ExportIcon />,
        perform: () => onExportFormat('markdown')
      },
      {
        id: 'action.export.json',
        group: 'nav',
        label: t('cmdk.export.json'),
        keywords: 'export json snapshot data 导出 快照 数据',
        icon: <ExportIcon />,
        perform: () => onExportFormat('json')
      },
      {
        id: 'action.theme',
        group: 'nav',
        label: t('cmdk.action.toggleTheme', {
          current: theme === 'dark' ? 'Dark' : 'Light'
        }),
        keywords: 'theme dark light moon sun 主题 暗色 亮色',
        icon: theme === 'dark' ? <SunIcon /> : <MoonIcon />,
        perform: () => onToggleTheme()
      },
      {
        id: 'action.style',
        group: 'nav',
        label: t('cmdk.action.toggleStyle', {
          current: uiStyle === 'nexus' ? 'Nexus Studio' : 'Porcelain'
        }),
        keywords: 'style ui studio porcelain 瓷昼 风格',
        icon: <SparkGlyph />,
        perform: () => onToggleUiStyle()
      },
      {
        id: 'action.cursor',
        group: 'nav',
        label: t('cmdk.action.toggleCursor', {
          state: cursorEnabled ? 'ON' : 'OFF'
        }),
        keywords: 'cursor mouse pointer spring apispace 光标 鼠标 弹簧',
        icon: <CursorGlyph />,
        perform: () => onToggleCursor()
      },
      {
        id: 'action.lang',
        group: 'nav',
        label: t('cmdk.action.toggleLang', {
          current: lang === 'zh-CN' ? '中文' : 'English'
        }),
        keywords: 'language lang zh en locale 语言 中文 英文',
        icon: <GlobeGlyph />,
        perform: () => onToggleLang()
      },
      {
        id: 'action.settings',
        group: 'nav',
        label: t('cmdk.action.openSettings'),
        keywords: 'settings preferences retention dsh 设置',
        icon: <GearIcon />,
        perform: () => onOpenSettings()
      }
    ]

    if (nodes.length > 1) {
      list.push({
        id: 'node.all',
        group: 'nodes',
        label: t('mesh.switcher.all'),
        badge: selectedNodeId === null ? 'CURRENT' : `${nodes.length}`,
        keywords: 'all nodes cluster summary 全网 汇总 所有节点',
        icon: <MeshGlyph className="size-4 text-signal" />,
        perform: () => {
          onSelectNode(null)
          onSelectView('board')
        }
      })
    }

    for (const n of nodes) {
      const name = nodeDisplayName(n)
      list.push({
        id: `node.${n.nodeId}`,
        group: 'nodes',
        label: name,
        subtitle: `${n.hwSummary.cpuCores}C · ${compactNumber(n.totalTokens)} tk`,
        badge: selectedNodeId === n.nodeId ? 'CURRENT' : t(`mesh.status.${n.status}`),
        keywords: `${name} ${n.hostname} ${n.kind} ${n.role} node 节点`.toLowerCase(),
        icon: <NodeKindIcon kind={n.kind} className="size-4 text-cobalt" />,
        perform: () => {
          onSelectNode(n.nodeId)
          onSelectView('board')
        }
      })
    }

    if (selectedProjectDir !== null) {
      list.push({
        id: 'project.clear',
        group: 'projects',
        label: t('cmdk.project.clear'),
        subtitle: selectedProjectDir,
        badge: 'CLEAR',
        keywords: 'project workspace clear filter 清除 工作区 项目 筛选',
        icon: <BoardGlyph />,
        perform: () => {
          onSelectProjectDir(null)
          onSelectView('board')
        }
      })
    }

    for (const p of projects.filter((x) => x.projectDir).slice(0, 12)) {
      list.push({
        id: `project.${p.projectDir}`,
        group: 'projects',
        label: p.name,
        subtitle: `${p.projectDir} · ${compactNumber(p.tokens)} tk`,
        badge: selectedProjectDir === p.projectDir ? 'FILTERED' : undefined,
        keywords: `${p.name} ${p.projectDir ?? ''} project workspace 项目 工作区`.toLowerCase(),
        icon: <BoardGlyph />,
        perform: () => {
          onSelectProjectDir(p.projectDir)
          onSelectView('board')
        }
      })
    }

    for (const opt of RANGE_OPTIONS) {
      const label = t(`range.${opt.key}`)
      list.push({
        id: `range.${opt.key}`,
        group: 'range',
        label,
        badge: range === opt.key ? 'CURRENT' : undefined,
        keywords: `${opt.key} ${label} range time 时间 范围`,
        icon: <ClockGlyph />,
        perform: () => {
          onSelectRange(opt.key)
          onSelectView('board')
        }
      })
    }

    list.push({
      id: 'agent.all',
      group: 'agents',
      label: t('sidebar.allAgents'),
      badge: selectedAgent === null ? 'CURRENT' : undefined,
      keywords: 'all agents clear filter 全部 agent 清除筛选',
      icon: <BoardGlyph />,
      perform: () => {
        onSelectAgent(null)
        onSelectView('board')
      }
    })

    for (const a of agents) {
      const tk = a.rangeTokens ?? a.todayTokens
      list.push({
        id: `agent.${a.id}`,
        group: 'agents',
        label: a.label,
        subtitle: tk > 0 ? `${compactNumber(tk)} tk` : undefined,
        badge: selectedAgent === a.id ? 'FILTERED' : undefined,
        keywords: `${a.id} ${a.label} agent 模型`.toLowerCase(),
        icon: <AgentLogo agentId={a.id} vendor={vendorOf(a.id)} size={16} />,
        perform: () => {
          onSelectAgent(a.id)
          onSelectView('board')
        }
      })
    }

    return list
  }, [
    activeView,
    agents,
    cursorEnabled,
    lang,
    nodes,
    onExportFormat,
    onOpenSettings,
    onQuickPair,
    onSelectAgent,
    onSelectNode,
    onSelectProjectDir,
    onSelectRange,
    onSelectView,
    onSyncNow,
    onToggleCursor,
    onToggleLang,
    onToggleUiStyle,
    onToggleTheme,
    projects,
    range,
    selectedAgent,
    selectedNodeId,
    selectedProjectDir,
    theme,
    uiStyle
  ])

  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase()
    const terms = trimmed.split(/\s+/).filter(Boolean)
    if (terms.length === 0) return entries
    const scored: Array<{ item: CommandEntry; score: number; idx: number }> = []
    entries.forEach((item, idx) => {
      const labelLow = item.label.toLowerCase()
      const subLow = (item.subtitle ?? '').toLowerCase()
      const haystack = `${labelLow} ${subLow} ${item.keywords}`.toLowerCase()
      if (!terms.every((term) => haystack.includes(term))) return
      let score = 0
      if (labelLow.startsWith(trimmed)) score += 100
      else if (labelLow.includes(trimmed)) score += 60
      else if (terms.every((term) => labelLow.includes(term))) score += 40
      else if (terms.every((term) => subLow.includes(term))) score += 20
      scored.push({ item, score, idx })
    })
    scored.sort((a, b) => b.score - a.score || a.idx - b.idx)
    return scored.map((s) => s.item)
  }, [entries, query])

  useEffect(() => {
    setActiveIdx(0)
  }, [query])

  useEffect(() => {
    if (!open || !navByKeyboardRef.current) return
    navByKeyboardRef.current = false
    const container = listScrollRef.current
    if (!container) return
    const activeEl = container.querySelector<HTMLElement>('[data-cmd-row][data-active="true"]')
    activeEl?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, open, filtered.length])

  const groupedSections = useMemo(() => {
    if (query.trim().length > 0) {
      if (filtered.length === 0) return []
      return [
        {
          id: 'search',
          title: null as string | null,
          items: filtered.map((entry, flatIndex) => ({ entry, flatIndex }))
        }
      ]
    }
    const byGroup = new Map<GroupId, Array<{ entry: CommandEntry; flatIndex: number }>>()
    filtered.forEach((entry, flatIndex) => {
      const bucket = byGroup.get(entry.group) ?? []
      bucket.push({ entry, flatIndex })
      byGroup.set(entry.group, bucket)
    })
    return GROUP_ORDER.map((gid) => ({
      id: gid,
      title: t(`cmdk.group.${gid}`) as string | null,
      items: byGroup.get(gid) ?? []
    })).filter((g) => g.items.length > 0)
  }, [filtered, query])

  if (!open) return null

  const clampedIdx =
    filtered.length === 0 ? -1 : Math.min(Math.max(0, activeIdx), filtered.length - 1)

  const runItem = (entry: CommandEntry | undefined): void => {
    if (!entry) return
    onClose()
    entry.perform()
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (filtered.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      navByKeyboardRef.current = true
      setActiveIdx((i) => (i + 1) % filtered.length)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      navByKeyboardRef.current = true
      setActiveIdx((i) => (i - 1 + filtered.length) % filtered.length)
      return
    }
    if (e.key === 'Home') {
      e.preventDefault()
      navByKeyboardRef.current = true
      setActiveIdx(0)
      return
    }
    if (e.key === 'End') {
      e.preventDefault()
      navByKeyboardRef.current = true
      setActiveIdx(filtered.length - 1)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      runItem(filtered[clampedIdx])
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        data-cmdk-dialog=""
        onKeyDown={handleKeyDown}
        className="nx-fade-in nx-card-elevated flex w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
      >
        {/* 顶部搜索框 */}
        <div className="flex items-center gap-2.5 border-b border-hairline px-4 py-3">
          <SearchGlyph />
          <input
            ref={inputRef}
            data-cmdk-input=""
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('cmdk.placeholder')}
            className="min-w-0 flex-1 bg-transparent text-ui-base text-foreground placeholder:text-foreground-subtlest focus:outline-none"
          />
          <kbd className="rounded border border-hairline bg-surface px-1.5 py-0.5 font-mono text-[10px] text-foreground-subtlest">
            ESC
          </kbd>
        </div>

        {/* 命令结果列表 + 共享弹簧高亮板 */}
        <div
          ref={listScrollRef}
          className="relative max-h-[56vh] overflow-y-auto p-2"
        >
          <AutoListHighlight
            rootRef={listScrollRef}
            rowSelector="[data-cmd-row]"
            activeRowSelector='[data-cmd-row][data-active="true"]'
            showHover={false}
            roundedClassName="rounded-lg"
          />
          {groupedSections.length === 0 ? (
            <div className="py-10 text-center text-ui-sm text-foreground-subtlest">
              {t('cmdk.empty')}
            </div>
          ) : (
            <div className="space-y-3">
              {groupedSections.map((group) => (
                <section key={group.id}>
                  {group.title && (
                    <div className="px-2.5 pb-1 text-[11px] font-medium tracking-wider text-foreground-subtle">
                      {group.title}
                    </div>
                  )}
                  <div className="space-y-0.5">
                    {group.items.map(({ entry, flatIndex }) => {
                      const isActive = flatIndex === clampedIdx
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          data-cmd-row=""
                          data-no-press=""
                          data-cmd-id={entry.id}
                          data-active={isActive ? 'true' : undefined}
                          onMouseEnter={() => setActiveIdx(flatIndex)}
                          onClick={() => runItem(entry)}
                          className={`flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-100 ${
                            isActive ? 'text-foreground' : 'text-foreground-subtle'
                          }`}
                        >
                          <span className="flex min-w-0 items-center gap-2.5">
                            <span className="flex size-5 shrink-0 items-center justify-center text-foreground-subtle">
                              {entry.icon}
                            </span>
                            <span className="truncate text-ui-sm font-medium">{entry.label}</span>
                            {entry.subtitle && (
                              <span className="hidden truncate font-mono text-[11px] text-foreground-subtlest sm:inline">
                                {entry.subtitle}
                              </span>
                            )}
                          </span>
                          {entry.badge && (
                            <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 font-mono text-[11px] text-foreground-subtle">
                              {entry.badge}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>

        {/* 底部快捷键提示栏 */}
        <footer className="flex items-center justify-between border-t border-hairline bg-surface/65 px-4 py-2 font-mono text-[11px] text-foreground-subtle">
          <div className="flex items-center gap-3">
            <span>{t('cmdk.hint.navigate')}</span>
            <span>{t('cmdk.hint.execute')}</span>
            <span>{t('cmdk.hint.close')}</span>
          </div>
          <span>NEXUS CMDK</span>
        </footer>
      </div>
    </div>
  )
}

function SearchGlyph(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0 text-foreground-subtle" aria-hidden>
      <circle cx="7" cy="7" r="4.8" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.7 10.7 13.8 13.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function BoardGlyph(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="2.5" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.35" />
      <rect x="9" y="2.5" width="5" height="3.2" rx="1.1" stroke="currentColor" strokeWidth="1.35" />
      <rect x="9" y="7.8" width="5" height="5.7" rx="1.2" stroke="currentColor" strokeWidth="1.35" />
      <rect x="2" y="9.8" width="5" height="3.7" rx="1.1" stroke="currentColor" strokeWidth="1.35" />
    </svg>
  )
}

function ClockGlyph(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.35" />
      <path d="M8 4.8v3.5l2.3 1.3" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  )
}

function SparkGlyph(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 1.8 9.6 6.4 14.2 8 9.6 9.6 8 14.2 6.4 9.6 1.8 8 6.4 6.4 8 1.8Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CursorGlyph(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3.5 2.5 12.5 8 8.3 9.2 6.8 13.3 3.5 2.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function GlobeGlyph(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" />
      <ellipse cx="8" cy="8" rx="2.4" ry="5.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2.8 8h10.4" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}
