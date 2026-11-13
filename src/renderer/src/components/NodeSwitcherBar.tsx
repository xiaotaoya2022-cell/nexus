// 多机全局设备切换条（Nexus Mesh Phase 3）：
// 集成于主看板顶部，直观展示所有设备的虚拟化形态、实时在线状态与链路延迟，点击即全局筛选 KPI/图表/侧栏/会话。

import type { JSX } from 'react'
import type { MeshStatusInfo } from '@shared/types'
import { t, useLang } from '../i18n'
import { compactNumber } from '../lib/format'
import { MeshGlyph, nodeDisplayName, NodeKindIcon, nodeShortMeta } from './NodeVisuals'
import { SlidingTabIndicator } from './SmoothHighlight'

export function NodeSwitcherBar({
  meshStatus,
  selectedNodeId,
  onSelectNode,
  onOpenMeshView
}: {
  meshStatus: MeshStatusInfo | null
  selectedNodeId: string | null
  onSelectNode: (nodeId: string | null) => void
  onOpenMeshView: () => void
}): JSX.Element | null {
  useLang()
  if (!meshStatus) return null

  const nodes = meshStatus.nodes
  const onlineCount = nodes.filter((n) => n.status === 'online').length
  const totalMeshTokens = nodes.reduce((acc, n) => acc + n.totalTokens, 0)
  const multiNode = nodes.length > 1

  return (
    <div className="nx-card-elevated flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface px-3 py-2">
      <div className="relative isolate flex min-w-0 flex-1 flex-wrap items-center gap-1">
        <SlidingTabIndicator
          activeSelector='button[data-active="true"]'
          className="rounded-lg bg-card"
        />

        {multiNode && (
          <button
            type="button"
            data-active={selectedNodeId === null ? 'true' : undefined}
            onClick={() => onSelectNode(null)}
            className={`relative z-10 flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-ui-xs transition-colors duration-150 ${
              selectedNodeId === null
                ? 'font-medium text-foreground'
                : 'text-foreground-subtle hover:text-foreground'
            }`}
          >
            <MeshGlyph className="size-3.5 text-signal" />
            <span>{t('mesh.switcher.all')}</span>
            <span className="rounded bg-raised px-1 font-mono text-[10px] tabular-nums text-foreground-subtle">
              {onlineCount}/{nodes.length}
            </span>
            {totalMeshTokens > 0 && (
              <span className="hidden font-mono text-[10px] tabular-nums text-foreground-subtlest xl:inline">
                {compactNumber(totalMeshTokens)}
              </span>
            )}
          </button>
        )}

        {nodes.map((node) => {
          const active =
            selectedNodeId === node.nodeId || (!multiNode && selectedNodeId === null)
          const label = nodeDisplayName(node)
          const meta = nodeShortMeta(node)
          return (
            <button
              key={node.nodeId}
              type="button"
              data-active={active ? 'true' : undefined}
              onClick={() => {
                if (!multiNode) {
                  onOpenMeshView()
                  return
                }
                onSelectNode(selectedNodeId === node.nodeId ? null : node.nodeId)
              }}
              title={`${label} (${node.hostname})\n${meta}`}
              className={`relative z-10 flex h-7 max-w-[260px] cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-ui-xs transition-colors duration-150 ${
                active
                  ? 'font-medium text-foreground'
                  : 'text-foreground-subtle hover:text-foreground'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  node.status === 'online' ? 'bg-success' : 'bg-border'
                }`}
              />
              <NodeKindIcon kind={node.kind} className="size-3.5 shrink-0" />
              <span className="truncate">{label}</span>
              <span
                className={`shrink-0 rounded px-1 font-mono text-[10px] tabular-nums ${
                  node.role === 'hub'
                    ? 'bg-signal-soft text-signal'
                    : 'bg-surface-hover text-foreground-subtlest'
                }`}
              >
                {meta}
              </span>
            </button>
          )
        })}
      </div>

      <button
        type="button"
        onClick={onOpenMeshView}
        className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-ui-xs text-foreground-subtle transition-colors duration-150 hover:border-border-hover hover:text-foreground"
      >
        <MeshGlyph className="size-3.5 text-cobalt" />
        <span>{multiNode ? t('mesh.switcher.manage') : t('mesh.switcher.connect')}</span>
      </button>
    </div>
  )
}
