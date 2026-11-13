// 侧栏：全部汇总入口 + Agent 列表（规范 §4.3）+ 同步状态。
// 两种分类视图（用户需求）：按 Agent（默认）/ 按厂商（分组聚合，可展开下钻）。
// 视图选择持久化在 localStorage。

import { useRef, useState } from 'react'
import type { JSX } from 'react'
import type { AgentInfo } from '@shared/types'
import { vendorOf, type VendorMeta } from '@shared/vendors'
import { relativeTime } from '@renderer/lib/format'
import { AnimatedNumber } from './RollingNumber'
import { VendorBadge } from './VendorBadge'
import { AgentLogo } from './AgentLogo'
import { AutoListHighlight, SlidingTabIndicator } from './SmoothHighlight'
import { StatusDot, statusText } from './ui'
import { t, useLang } from '../i18n'
import { useUi } from '@renderer/store'

type SidebarView = 'agent' | 'vendor'

const VIEW_KEY = 'nexus.sidebarView'

function loadView(): SidebarView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'vendor' ? 'vendor' : 'agent'
  } catch {
    return 'agent'
  }
}

export function AgentSidebar({
  agents,
  lastSyncAt
}: {
  agents: AgentInfo[]
  lastSyncAt: number | null
}): JSX.Element {
  useLang() // 语言切换时重渲染侧栏
  const agent = useUi((s) => s.agent)
  const setAgent = useUi((s) => s.setAgent)
  const [view, setView] = useState<SidebarView>(loadView)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const rangeTotal = agents.reduce((sum, a) => sum + (a.rangeTokens ?? a.todayTokens), 0)
  const anyActive = agents.some((a) => a.status === 'active' || a.status === 'idle')

  const switchView = (v: SidebarView): void => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      // localStorage 不可用时仅失去持久化
    }
  }

  // 厂商分组：保持 agents 原顺序（有数据的在前），组内同序
  const vendorGroups: Array<{ vendor: VendorMeta; items: AgentInfo[] }> = []
  if (view === 'vendor') {
    const byId = new Map<string, { vendor: VendorMeta; items: AgentInfo[] }>()
    for (const a of agents) {
      const v = vendorOf(a.id)
      let g = byId.get(v.id)
      if (!g) {
        g = { vendor: v, items: [] }
        byId.set(v.id, g)
        vendorGroups.push(g)
      }
      g.items.push(a)
    }
    vendorGroups.sort((x, y) => {
      const tx = x.items.reduce((s, a) => s + (a.rangeTokens ?? a.todayTokens), 0)
      const ty = y.items.reduce((s, a) => s + (a.rangeTokens ?? a.todayTokens), 0)
      return ty - tx
    })
  }

  const toggleGroup = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const navRef = useRef<HTMLElement>(null)

  const agentRow = (a: AgentInfo, indent = false): JSX.Element => {
    const tokens = a.rangeTokens ?? a.todayTokens
    const active = agent === a.id
    return (
      <button
        key={a.id}
        type="button"
        data-list-row=""
        data-active={active ? 'true' : undefined}
        onClick={() => setAgent(active ? null : a.id)}
        title={`${a.label} · ${statusText(a.status)}`}
        className={`group flex w-full cursor-pointer items-center gap-2 rounded-lg pr-1 py-1 transition-colors duration-150 ${
          indent ? 'pl-5' : 'pl-2.5'
        } ${active ? 'bg-selected nx-nav-active' : 'hover:bg-surface-hover'}`}
      >
        <StatusDot status={a.status} />
        <AgentLogo agentId={a.id} vendor={vendorOf(a.id)} />
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate text-ui-base text-foreground">{a.label}</span>
          <span className="block truncate font-mono text-ui-xs text-foreground-subtlest">
            {a.note ?? relativeTime(a.lastActivityAt)}
          </span>
        </span>
        <span className="font-mono text-ui-xs tabular-nums text-foreground-subtle">
          {tokens > 0 ? <AnimatedNumber num={tokens} toggleable={false} /> : ''}
        </span>
      </button>
    )
  }

  return (
    <aside className="flex w-[264px] shrink-0 flex-col bg-background">
      <div className="flex items-center justify-between px-2.5 pb-1 pt-3">
        <span className="text-ui-xs font-medium text-foreground-subtlest">
          {view === 'agent' ? `AGENTS · ${agents.length}` : `${t('sidebar.vendor')} · ${new Set(agents.map((a) => vendorOf(a.id).id)).size}`}
        </span>
        {/* 视图切换：按 Agent / 按厂商 */}
        <span className="relative isolate flex h-5 items-center rounded-full bg-surface p-0.5">
          <SlidingTabIndicator activeSelector='button[data-active="true"]' />
          {(
            [
              ['agent', t('sidebar.agent')],
              ['vendor', t('sidebar.vendor')]
            ] as Array<[SidebarView, string]>
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              data-active={view === v ? 'true' : undefined}
              onClick={() => switchView(v)}
              className={`relative z-10 h-4 cursor-pointer rounded-full px-1.5 text-ui-xs leading-4 transition-colors duration-150 ${
                view === v ? 'font-medium text-foreground' : 'text-foreground-subtle hover:text-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </span>
      </div>
      <nav ref={navRef} className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        <AutoListHighlight
          rootRef={navRef}
          rowSelector="[data-list-row]"
          activeRowSelector='[data-list-row][data-active="true"]'
        />
        {/* 全部：跨 Agent 汇总（对应全局 agent=null 视图） */}
        <button
          type="button"
          data-list-row=""
          data-active={agent === null ? 'true' : undefined}
          onClick={() => setAgent(null)}
          title={t('sidebar.todayTotal', { tokens: rangeTotal })}
          className={`flex w-full cursor-pointer items-center gap-2 rounded-lg py-1.5 pl-2.5 pr-1 transition-colors duration-150 ${
            agent === null ? 'bg-selected nx-nav-active' : 'hover:bg-surface-hover'
          }`}
        >
          <span
            title={anyActive ? t('sidebar.someActive') : t('sidebar.noneActive')}
            className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
              anyActive ? 'bg-chart-1 nx-breathe' : 'bg-border'
            }`}
          />
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-ui-base font-medium text-foreground">{t('sidebar.allAgents')}</span>
            <span className="block truncate text-ui-xs text-foreground-subtlest">{t('sidebar.allAgents.sub')}</span>
          </span>
          <span className="font-mono text-ui-xs tabular-nums text-foreground-subtle">
            {rangeTotal > 0 ? <AnimatedNumber num={rangeTotal} toggleable={false} /> : ''}
          </span>
        </button>
        <div className="my-1 border-b border-hairline" />
        {view === 'agent'
          ? agents.map((a) => agentRow(a))
          : vendorGroups.map((g) => {
              const groupTotal = g.items.reduce((sum, a) => sum + (a.rangeTokens ?? a.todayTokens), 0)
              const latest = g.items.reduce((m, a) => Math.max(m, a.lastActivityAt ?? 0), 0)
              const isCollapsed = collapsed.has(g.vendor.id)
              return (
                <div key={g.vendor.id}>
                  <button
                    type="button"
                    data-list-row=""
                    onClick={() => toggleGroup(g.vendor.id)}
                    title={t('sidebar.groupSummary', { vendor: g.vendor.label, n: g.items.length, tokens: groupTotal })}
                    className="group flex w-full cursor-pointer items-center gap-2 rounded-lg pl-2.5 pr-1 py-1 transition-colors duration-150 hover:bg-surface-hover"
                  >
                    <span
                      className={`inline-block shrink-0 text-ui-xs text-foreground-subtlest transition-transform duration-150 ${
                        isCollapsed ? '' : 'rotate-90'
                      }`}
                    >
                      ▶
                    </span>
                    <VendorBadge vendor={g.vendor} />
                    <span className="min-w-0 flex-1 text-left">
                      <span className="block truncate text-ui-base font-medium text-foreground">{g.vendor.label}</span>
                      <span className="block truncate font-mono text-ui-xs text-foreground-subtlest">
                        {t('sidebar.groupShort', { n: g.items.length })} · {latest ? relativeTime(latest) : t('sidebar.nodata')}
                      </span>
                    </span>
                    <span className="font-mono text-ui-xs tabular-nums text-foreground-subtle">
                      {groupTotal > 0 ? <AnimatedNumber num={groupTotal} toggleable={false} /> : ''}
                    </span>
                  </button>
                  {!isCollapsed && g.items.map((a) => agentRow(a, true))}
                </div>
              )
            })}
      </nav>
      <footer className="border-t border-hairline px-3 py-2 text-ui-xs text-foreground-subtlest">
        <span className="font-mono">
          {lastSyncAt ? t('sidebar.lastSync', { time: formatClock(lastSyncAt) }) : t('sidebar.neverSynced')}
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
