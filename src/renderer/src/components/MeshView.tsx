// 算力组网 Mesh 一级视图（Nexus Mesh Phase 3）：
// 涵盖动态硬件拓扑画布、全网节点硬件刀片卡、以及 Hub 配对凭据生成 / Spoke 粘入入网双向面板。

import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { parsePairUri, type PairingInfo, type RemoteStatusInfo } from '@shared/protocol'
import type {
  MeshStatusInfo,
  NodeRole,
  SessionRow
} from '@shared/types'
import { nexus } from '../lib/api'
import { compactNumber, fullNumber, relativeTime } from '../lib/format'
import { t, useLang } from '../i18n'
import type { MeshActions } from '../useMesh'
import {
  formatRamGb,
  MeshGlyph,
  nodeDisplayName,
  NodeKindIcon,
  nodeKindLabel,
  osSummary,
  transportLabel
} from './NodeVisuals'
import { SlidingTabIndicator } from './SmoothHighlight'

export interface MeshViewProps {
  meshStatus: MeshStatusInfo | null
  actions: MeshActions
  sessions: SessionRow[]
  agentLabels: Map<string, string>
  onInspectNode: (nodeId: string | null) => void
  onToast: (message: string) => void
}

export function MeshView({
  meshStatus,
  actions,
  sessions,
  agentLabels,
  onInspectNode,
  onToast
}: MeshViewProps): JSX.Element {
  useLang()
  const [syncing, setSyncing] = useState(false)
  const [roleBusy, setRoleBusy] = useState(false)
  const [editingAlias, setEditingAlias] = useState(false)
  const [aliasDraft, setAliasDraft] = useState('')
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)

  const [remoteStatus, setRemoteStatus] = useState<RemoteStatusInfo | null>(null)
  const [pairing, setPairing] = useState<PairingInfo | null>(null)
  const [pairingBusy, setPairingBusy] = useState(false)
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))

  const [pairUriInput, setPairUriInput] = useState('')
  const [pairBusy, setPairBusy] = useState(false)
  const [pairError, setPairError] = useState<string | null>(null)

  useEffect(() => {
    void nexus.getRemoteStatus().then(setRemoteStatus).catch(() => undefined)
  }, [])

  // 配对码 60s 倒计时刷新
  useEffect(() => {
    if (!pairing) return
    const timer = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(timer)
  }, [pairing])

  const parsedUri = useMemo(() => {
    const raw = pairUriInput.trim()
    if (!raw) return null
    try {
      const p = parsePairUri(raw)
      if (!p.host || !Number.isInteger(p.port) || p.port <= 0 || !/^\d{6}$/.test(p.pin)) {
        return { valid: false as const, preview: null }
      }
      return { valid: true as const, preview: `${p.host}:${p.port} · PIN ${p.pin}` }
    } catch {
      return { valid: false as const, preview: null }
    }
  }, [pairUriInput])

  // 检测哪些工作区目录同时出现在多个设备节点上（用于拓扑协作提示）
  const sharedProjects = useMemo(() => {
    const byDir = new Map<string, Set<string>>()
    for (const s of sessions) {
      if (!s.projectDir) continue
      const norm = s.projectDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      const set = byDir.get(norm) ?? new Set<string>()
      set.add(s.sourceNodeId ?? meshStatus?.localNode.nodeId ?? 'local')
      byDir.set(norm, set)
    }
    return [...byDir.entries()].filter(([, nodes]) => nodes.size > 1).length
  }, [sessions, meshStatus?.localNode.nodeId])

  if (!meshStatus) {
    return (
      <main className="nx-shell-bg min-w-0 flex-1 overflow-y-auto rounded-xl border border-hairline bg-panel p-6">
        <div className="rounded-xl border border-dashed border-border px-4 py-12 text-center text-ui-sm text-foreground-subtle">
          {t('mesh.loading')}
        </div>
      </main>
    )
  }

  const { localNode, nodes, hubConnection } = meshStatus
  const onlineCount = nodes.filter((n) => n.status === 'online').length
  const totalTokens = nodes.reduce((sum, n) => sum + n.totalTokens, 0)

  // 拓扑核心锚点：优先展示角色为 hub 的在线节点，否则展示本机
  const hubNode =
    nodes.find((n) => n.role === 'hub' && n.status === 'online') ??
    nodes.find((n) => n.role === 'hub') ??
    localNode
  const peerNodes = nodes.filter((n) => n.nodeId !== hubNode.nodeId)

  const pairingSecondsLeft = pairing ? Math.max(0, Math.ceil(pairing.expiresAt / 1000) - nowSec) : 0
  const primaryUri = pairing?.addresses[0]?.uri ?? ''

  const handleSyncCluster = async (): Promise<void> => {
    if (syncing) return
    setSyncing(true)
    try {
      await nexus.syncNow()
      if (localNode.role === 'spoke' && hubConnection?.connected) {
        const res = await actions.triggerSync()
        onToast(t('mesh.toast.syncedDelta', { n: res.pushed }))
      } else {
        await actions.refreshStatus()
        onToast(t('mesh.toast.refreshed'))
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : t('toast.unknownError'))
    } finally {
      setSyncing(false)
    }
  }

  const handleRoleSwitch = async (next: NodeRole): Promise<void> => {
    if (roleBusy || localNode.role === next) return
    setRoleBusy(true)
    try {
      await actions.setRole(next)
      const rs = await nexus.getRemoteStatus()
      setRemoteStatus(rs)
      onToast(t('mesh.toast.roleChanged', { role: next.toUpperCase() }))
    } catch (err) {
      onToast(err instanceof Error ? err.message : t('toast.unknownError'))
    } finally {
      setRoleBusy(false)
    }
  }

  const handleSaveAlias = async (): Promise<void> => {
    const trimmed = aliasDraft.trim()
    try {
      await actions.setAlias(trimmed || null)
      setEditingAlias(false)
      onToast(t('mesh.toast.aliasSaved'))
    } catch (err) {
      onToast(err instanceof Error ? err.message : t('toast.unknownError'))
    }
  }

  const handleGeneratePairing = async (): Promise<void> => {
    if (pairingBusy) return
    setPairingBusy(true)
    try {
      const p = await nexus.regeneratePairing()
      setPairing(p)
      setNowSec(Math.floor(Date.now() / 1000))
      const rs = await nexus.getRemoteStatus()
      setRemoteStatus(rs)
    } catch (err) {
      onToast(err instanceof Error ? err.message : t('toast.unknownError'))
    } finally {
      setPairingBusy(false)
    }
  }

  const handlePairWithHub = async (): Promise<void> => {
    const raw = pairUriInput.trim()
    if (!raw || pairBusy) return
    setPairBusy(true)
    setPairError(null)
    try {
      await actions.pairWithHub({ uri: raw })
      setPairUriInput('')
      onToast(t('mesh.toast.paired'))
    } catch (err) {
      setPairError(err instanceof Error ? err.message : t('toast.unknownError'))
    } finally {
      setPairBusy(false)
    }
  }

  const handleDisconnectHub = async (): Promise<void> => {
    try {
      await actions.disconnectHub()
      onToast(t('mesh.toast.disconnected'))
    } catch (err) {
      onToast(err instanceof Error ? err.message : t('toast.unknownError'))
    }
  }

  const copyText = (text: string, notice: string): void => {
    void navigator.clipboard.writeText(text).then(() => onToast(notice))
  }

  return (
    <main className="nx-shell-bg min-w-0 flex-1 space-y-4 overflow-y-auto rounded-xl border border-hairline bg-panel p-4 md:p-5">
      {/* 顶部标题与角色控制栏 */}
      <section className="nx-card-elevated flex flex-wrap items-center justify-between gap-4 rounded-xl bg-card px-5 py-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <MeshGlyph className="size-5 text-signal" />
            <h1 className="text-ui-lg font-semibold text-foreground">{t('mesh.title')}</h1>
            <span className="rounded-full bg-signal-soft px-2 py-0.5 font-mono text-[10px] font-medium text-signal">
              {onlineCount}/{nodes.length} ONLINE
            </span>
            {totalTokens > 0 && (
              <span className="rounded-full bg-surface px-2 py-0.5 font-mono text-[10px] tabular-nums text-foreground-subtle">
                {compactNumber(totalTokens)} tokens
              </span>
            )}
          </div>
          <p className="text-ui-xs text-foreground-subtle">{t('mesh.subtitle')}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative isolate flex h-7 items-center rounded-full bg-surface p-0.5">
            <SlidingTabIndicator activeSelector='button[data-active="true"]' />
            {(['hub', 'spoke'] as const).map((r) => (
              <button
                key={r}
                type="button"
                disabled={roleBusy}
                data-active={localNode.role === r ? 'true' : undefined}
                onClick={() => void handleRoleSwitch(r)}
                className={`relative z-10 h-6 cursor-pointer rounded-full px-3 text-ui-xs transition-colors duration-150 ${
                  localNode.role === r
                    ? 'font-medium text-foreground'
                    : 'text-foreground-subtle hover:text-foreground'
                }`}
              >
                {r === 'hub' ? t('mesh.role.hub') : t('mesh.role.spoke')}
              </button>
            ))}
          </div>

          <button
            type="button"
            disabled={syncing}
            onClick={() => void handleSyncCluster()}
            className="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg bg-signal px-3 text-ui-xs font-medium text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-60"
          >
            <span className={syncing ? 'nx-spin inline-block' : undefined}>↻</span>
            <span>{syncing ? t('mesh.action.syncing') : t('mesh.action.sync')}</span>
          </button>
        </div>
      </section>

      {/* 动态硬件拓扑画布 */}
      <section className="nx-card-elevated relative overflow-hidden rounded-xl bg-card p-5">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-ui-base font-medium text-foreground">{t('mesh.topology.title')}</h2>
            <p className="text-ui-xs text-foreground-subtlest">
              {sharedProjects > 0
                ? t('mesh.topology.sharedWorkspaces', { n: sharedProjects })
                : t('mesh.topology.desc')}
            </p>
          </div>
          <span className="font-mono text-ui-xs text-foreground-subtlest">
            Hub Port {remoteStatus?.port ?? '—'}
          </span>
        </header>

        <div className="grid grid-cols-1 items-center gap-4 lg:grid-cols-12">
          {/* Hub 核心节点 */}
          <div className="lg:col-span-4">
            <button
              type="button"
              onClick={() => onInspectNode(hubNode.nodeId)}
              className="group w-full cursor-pointer rounded-xl border border-signal/35 bg-surface p-4 text-left transition-colors duration-150 hover:border-signal"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 font-mono text-[10px] font-semibold text-signal">
                  <span className="nx-breathe h-2 w-2 rounded-full bg-signal" />
                  HUB · {nodeKindLabel(hubNode.kind)}
                </span>
                {hubNode.isLocal && (
                  <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] text-foreground-subtle">
                    {t('mesh.node.thisMachine')}
                  </span>
                )}
              </div>
              <div className="mt-2 flex items-center gap-2.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-signal-soft text-signal">
                  <NodeKindIcon kind={hubNode.kind} className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-ui-base font-medium text-foreground">
                    {nodeDisplayName(hubNode)}
                  </div>
                  <div className="truncate font-mono text-ui-xs text-foreground-subtlest">
                    {hubNode.hwSummary.cpuCores}C · {formatRamGb(hubNode.hwSummary.ramTotalBytes, 0)}GB
                    {hubNode.hwSummary.gpuModel ? ` · ${hubNode.hwSummary.gpuModel}` : ''}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-hairline pt-2 font-mono text-ui-xs tabular-nums text-foreground-subtle">
                <span>{compactNumber(hubNode.totalTokens)} tokens</span>
                <span className="text-signal opacity-80 group-hover:opacity-100">
                  {t('mesh.node.inspect')} →
                </span>
              </div>
            </button>
          </div>

          {/* 链路脉冲背板 */}
          <div className="flex flex-col items-center justify-center py-2 lg:col-span-3">
            {peerNodes.length === 0 ? (
              <div className="flex flex-col items-center gap-1.5 text-center text-ui-xs text-foreground-subtlest">
                <div className="h-px w-24 border-t border-dashed border-border" />
                <span>{t('mesh.topology.awaitingPeers')}</span>
              </div>
            ) : (
              <div className="flex w-full flex-col items-center gap-1">
                <svg viewBox="0 0 220 100" className="h-24 w-full overflow-visible" aria-hidden>
                  {peerNodes.slice(0, 4).map((peer, idx, arr) => {
                    const yEnd = arr.length === 1 ? 50 : 16 + (idx / (arr.length - 1)) * 68
                    const online = peer.status === 'online'
                    const stroke = online ? 'var(--nx-cobalt)' : 'var(--nx-border)'
                    return (
                      <g key={peer.nodeId}>
                        <path
                          d={`M 8 50 C 90 50, 130 ${yEnd}, 212 ${yEnd}`}
                          fill="none"
                          stroke={stroke}
                          strokeWidth={online ? 2 : 1.5}
                          strokeDasharray={online ? '5 4' : '3 4'}
                          opacity={online ? 0.9 : 0.45}
                        >
                          {online && (
                            <animate
                              attributeName="stroke-dashoffset"
                              from="18"
                              to="0"
                              dur="1.4s"
                              repeatCount="indefinite"
                            />
                          )}
                        </path>
                        <circle cx="8" cy="50" r="3" fill="var(--nx-signal)" />
                        <circle cx="212" cy={yEnd} r="3" fill={stroke} />
                      </g>
                    )
                  })}
                </svg>
                <span className="rounded-full bg-surface px-2.5 py-0.5 font-mono text-[10px] text-foreground-subtle">
                  {peerNodes.filter((p) => p.status === 'online').length}/{peerNodes.length} WS LINK
                </span>
              </div>
            )}
          </div>

          {/* Peer Spoke 列表 */}
          <div className="space-y-2 lg:col-span-5">
            {peerNodes.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-surface/50 p-4 text-ui-xs text-foreground-subtle">
                {t('mesh.topology.emptyPeerHint')}
              </div>
            ) : (
              peerNodes.map((peer) => (
                <button
                  key={peer.nodeId}
                  type="button"
                  onClick={() => onInspectNode(peer.nodeId)}
                  className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl border border-border bg-surface px-3.5 py-2.5 text-left transition-colors duration-150 hover:border-cobalt/60 hover:bg-card"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        peer.status === 'online' ? 'bg-success' : 'bg-border'
                      }`}
                    />
                    <NodeKindIcon kind={peer.kind} className="size-4 shrink-0 text-cobalt" />
                    <div className="min-w-0">
                      <div className="truncate text-ui-sm font-medium text-foreground">
                        {nodeDisplayName(peer)}
                      </div>
                      <div className="truncate font-mono text-[10px] text-foreground-subtlest">
                        {transportLabel(peer.transport)}
                        {peer.rttMs != null ? ` · ${peer.rttMs}ms` : ''}
                        {peer.hwSummary.cpuCores > 0 ? ` · ${peer.hwSummary.cpuCores}C` : ''}
                      </div>
                    </div>
                  </div>
                  <span className="shrink-0 font-mono text-ui-xs tabular-nums text-foreground-subtle">
                    {compactNumber(peer.totalTokens)} tk
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </section>

      {/* 设备硬件刀片卡矩阵 */}
      <section className="space-y-3">
        <header className="flex items-center justify-between">
          <h2 className="text-ui-base font-medium text-foreground">{t('mesh.nodes.title')}</h2>
          <span className="text-ui-xs text-foreground-subtlest">
            {t('mesh.nodes.count', { n: nodes.length })}
          </span>
        </header>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {nodes.map((node) => {
            const memPct = Math.round(
              Math.max(0, Math.min(100, node.hwSummary.ramUsedPercent || 0))
            )
            const isConfirming = confirmRemoveId === node.nodeId
            return (
              <article
                key={node.nodeId}
                className="nx-card-elevated flex flex-col justify-between gap-3 rounded-xl bg-card p-4"
              >
                <div className="space-y-3">
                  {/* 卡头：图标、别名编辑、角色与在线灯 */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span
                        className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${
                          node.role === 'hub'
                            ? 'bg-signal-soft text-signal'
                            : 'bg-cobalt/12 text-cobalt'
                        }`}
                      >
                        <NodeKindIcon kind={node.kind} className="size-5" />
                      </span>
                      <div className="min-w-0">
                        {node.isLocal && editingAlias ? (
                          <form
                            onSubmit={(e) => {
                              e.preventDefault()
                              void handleSaveAlias()
                            }}
                            className="flex items-center gap-1"
                          >
                            <input
                              type="text"
                              value={aliasDraft}
                              onChange={(e) => setAliasDraft(e.target.value)}
                              placeholder={node.hostname}
                              autoFocus
                              maxLength={40}
                              className="h-6 w-32 rounded border border-border bg-surface px-1.5 text-ui-xs text-foreground focus:border-cobalt focus:outline-none"
                            />
                            <button
                              type="submit"
                              className="rounded bg-signal px-1.5 py-0.5 text-[10px] text-white"
                            >
                              {t('mesh.alias.save')}
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingAlias(false)}
                              className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-foreground-subtle"
                            >
                              ✕
                            </button>
                          </form>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <h3 className="truncate text-ui-base font-medium text-foreground">
                              {nodeDisplayName(node)}
                            </h3>
                            {node.isLocal && (
                              <button
                                type="button"
                                onClick={() => {
                                  setAliasDraft(node.alias ?? '')
                                  setEditingAlias(true)
                                }}
                                title={t('mesh.alias.edit')}
                                className="rounded px-1 text-ui-xs text-foreground-subtlest hover:bg-hover hover:text-foreground"
                              >
                                ✎
                              </button>
                            )}
                          </div>
                        )}
                        <div className="truncate font-mono text-[10px] text-foreground-subtlest">
                          {nodeKindLabel(node.kind)} · {node.hostname}
                        </div>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      <span
                        className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${
                          node.role === 'hub'
                            ? 'bg-signal-soft text-signal'
                            : 'bg-cobalt/12 text-cobalt'
                        }`}
                      >
                        {node.role.toUpperCase()}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] ${
                          node.status === 'online'
                            ? 'bg-success-surface text-success'
                            : 'bg-surface text-foreground-subtlest'
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            node.status === 'online' ? 'bg-success' : 'bg-border'
                          }`}
                        />
                        {node.status === 'online'
                          ? t('mesh.status.online')
                          : t('mesh.status.offline')}
                      </span>
                    </div>
                  </div>

                  {/* 硬件画像区 */}
                  <div className="space-y-1.5 rounded-lg bg-surface p-2.5 text-ui-xs">
                    <div className="flex items-center justify-between gap-2 text-foreground-subtle">
                      <span className="truncate" title={node.hwSummary.cpuModel}>
                        {node.hwSummary.cpuModel || 'CPU'}
                      </span>
                      <span className="shrink-0 font-mono tabular-nums text-foreground">
                        {node.hwSummary.cpuCores}C · {Math.round(node.hwSummary.cpuLoadPercent)}%
                      </span>
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-center justify-between font-mono text-[10px] text-foreground-subtlest">
                        <span>{t('system.memory')}</span>
                        <span className="tabular-nums text-foreground-subtle">
                          {formatRamGb(node.hwSummary.ramUsedBytes)}/
                          {formatRamGb(node.hwSummary.ramTotalBytes)} GB ({memPct}%)
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-hairline">
                        <div
                          className="h-full rounded-full transition-[width] duration-300"
                          style={{
                            width: `${Math.max(4, memPct)}%`,
                            backgroundColor: memPct > 85 ? 'var(--nx-signal)' : 'var(--nx-cobalt)'
                          }}
                        />
                      </div>
                    </div>

                    {node.hwSummary.gpuModel && (
                      <div className="truncate font-mono text-[10px] text-foreground-subtlest">
                        GPU · {node.hwSummary.gpuModel}
                      </div>
                    )}
                    <div className="truncate font-mono text-[10px] text-foreground-subtlest">
                      OS · {osSummary(node.hwSummary)}
                    </div>
                  </div>

                  {/* 链路、水位线与活跃 Agent */}
                  <div className="grid grid-cols-2 gap-2 text-ui-xs">
                    <div>
                      <div className="text-[10px] text-foreground-subtlest">{t('mesh.node.link')}</div>
                      <div className="truncate font-mono text-foreground">
                        {transportLabel(node.transport)}
                        {node.rttMs != null ? ` · ${node.rttMs}ms` : ''}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] text-foreground-subtlest">{t('mesh.node.tokens')}</div>
                      <div
                        className="font-mono tabular-nums text-foreground"
                        title={t('mesh.node.recordsTip', {
                          tokens: fullNumber(node.totalTokens),
                          n: fullNumber(node.recordCount)
                        })}
                      >
                        {compactNumber(node.totalTokens)} ({node.recordCount})
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-foreground-subtlest">
                        {t('mesh.node.watermark')}
                      </div>
                      <div className="truncate font-mono text-[10px] tabular-nums text-foreground-subtle">
                        U{node.ackedWatermark.usageId} · S{node.ackedWatermark.sessionSeq} · T
                        {node.ackedWatermark.toolId}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] text-foreground-subtlest">
                        {t('mesh.node.lastSeen')}
                      </div>
                      <div className="font-mono text-[10px] text-foreground-subtle">
                        {node.isLocal ? t('time.justNow') : relativeTime(node.lastSeenAt)}
                      </div>
                    </div>
                  </div>

                  {node.activeAgents.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {node.activeAgents.map((aid) => (
                        <span
                          key={aid}
                          className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-foreground-subtle"
                        >
                          {agentLabels.get(aid) ?? aid}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* 卡脚操作 */}
                <div className="flex items-center justify-between gap-2 border-t border-hairline pt-2.5">
                  <button
                    type="button"
                    onClick={() => onInspectNode(node.nodeId)}
                    className="cursor-pointer rounded-lg bg-secondary px-2.5 py-1 text-ui-xs font-medium text-foreground transition-colors hover:bg-surface-hover"
                  >
                    {t('mesh.node.filterBoard')}
                  </button>

                  {!node.isLocal &&
                    (isConfirming ? (
                      <span className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmRemoveId(null)
                            void actions.removeNode(node.nodeId).then(() =>
                              onToast(t('mesh.toast.removed', { name: nodeDisplayName(node) }))
                            )
                          }}
                          className="cursor-pointer rounded-md bg-destructive px-2 py-1 text-ui-xs text-white"
                        >
                          {t('mesh.node.confirmRemove')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRemoveId(null)}
                          className="cursor-pointer rounded-md px-1.5 py-1 text-ui-xs text-foreground-subtle hover:bg-hover"
                        >
                          {t('custom.cancel')}
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmRemoveId(node.nodeId)}
                        className="cursor-pointer rounded-md px-2 py-1 text-ui-xs text-destructive transition-colors hover:bg-destructive-surface"
                      >
                        {t('mesh.node.remove')}
                      </button>
                    ))}
                </div>
              </article>
            )
          })}
        </div>
      </section>

      {/* 双向极简配对面板 */}
      <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* 左：Hub 端生成配对码 & 多网段地址 */}
        <div className="nx-card-elevated flex flex-col justify-between gap-3 rounded-xl bg-card p-5">
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-ui-base font-medium text-foreground">{t('mesh.hub.title')}</h2>
                <p className="text-ui-xs text-foreground-subtlest">{t('mesh.hub.desc')}</p>
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] ${
                  remoteStatus?.enabled
                    ? 'bg-success-surface text-success'
                    : 'bg-surface text-foreground-subtlest'
                }`}
              >
                {remoteStatus?.enabled ? `PORT ${remoteStatus.port}` : t('settings.remote.off')}
              </span>
            </div>

            <button
              type="button"
              disabled={pairingBusy}
              onClick={() => void handleGeneratePairing()}
              className="h-8 w-full cursor-pointer rounded-lg bg-secondary px-3 text-ui-sm font-medium text-foreground transition-colors duration-150 hover:bg-surface-hover disabled:opacity-60"
            >
              {pairingBusy ? t('mesh.hub.generating') : t('mesh.hub.generate')}
            </button>

            {pairing && (
              <div className="space-y-3 rounded-xl border border-border bg-surface p-3.5">
                <div className="flex flex-wrap items-center gap-4">
                  {pairing.qrDataUrl && (
                    <img
                      src={pairing.qrDataUrl}
                      alt={t('settings.remote.qrAlt')}
                      className="h-28 w-28 shrink-0 rounded-lg border border-border bg-white p-1"
                    />
                  )}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="text-ui-xs text-foreground-subtle">{t('mesh.hub.pinLabel')}</div>
                    <div className="font-mono text-2xl font-semibold tracking-[0.18em] tabular-nums text-foreground">
                      {pairing.pin}
                    </div>
                    <div className="font-mono text-ui-xs text-foreground-subtlest">
                      {pairingSecondsLeft > 0
                        ? t('mesh.hub.ttl', { sec: pairingSecondsLeft })
                        : t('mesh.hub.expired')}
                    </div>
                  </div>
                </div>

                {pairing.addresses.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-ui-xs text-foreground-subtle">
                      {t('mesh.hub.addressesTitle')}
                    </div>
                    {pairing.addresses.map((a) => (
                      <div
                        key={a.host}
                        className="flex items-center justify-between gap-2 rounded-lg bg-card px-2.5 py-1.5"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 text-ui-xs">
                            <span className="font-medium text-foreground">
                              {a.transport ? transportLabel(a.transport) : a.label}
                            </span>
                            <span className="truncate font-mono text-foreground-subtlest">
                              {a.host}
                            </span>
                          </div>
                          <div className="truncate font-mono text-[10px] text-foreground-subtlest">
                            {a.uri}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => copyText(a.uri, t('mesh.hub.copiedUri'))}
                          className="shrink-0 cursor-pointer rounded-md bg-secondary px-2 py-1 text-ui-xs text-foreground transition-colors hover:bg-surface-hover"
                        >
                          {t('settings.remote.copy')}
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {primaryUri && (
                  <div className="rounded-lg border border-hairline bg-panel p-2.5">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-[10px] font-medium text-foreground-subtle">
                        {t('mesh.hub.cliHint')}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          copyText(
                            `node out/main/mesh-agent.js --pair "${primaryUri}" --alias "Linux-VM"`,
                            t('mesh.hub.copiedCli')
                          )
                        }
                        className="cursor-pointer text-[10px] text-cobalt hover:underline"
                      >
                        {t('mesh.hub.copyCmd')}
                      </button>
                    </div>
                    <code className="block break-all font-mono text-[10px] text-foreground-subtlest">
                      node out/main/mesh-agent.js --pair &quot;{primaryUri}&quot; --alias &quot;Linux-VM&quot;
                    </code>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* 右：Spoke 端接入主 Hub */}
        <div className="nx-card-elevated flex flex-col justify-between gap-3 rounded-xl bg-card p-5">
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-ui-base font-medium text-foreground">{t('mesh.spoke.title')}</h2>
                <p className="text-ui-xs text-foreground-subtlest">{t('mesh.spoke.desc')}</p>
              </div>
              {hubConnection && (
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] ${
                    hubConnection.connected
                      ? 'bg-success-surface text-success'
                      : 'bg-warning-surface text-warning'
                  }`}
                >
                  {hubConnection.connected
                    ? t('mesh.spoke.connected')
                    : t('mesh.spoke.reconnecting')}
                </span>
              )}
            </div>

            {hubConnection && (
              <div className="space-y-2 rounded-xl border border-border bg-surface p-3.5 text-ui-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-foreground-subtle">{t('mesh.spoke.hubAddr')}</span>
                  <span className="truncate font-mono text-foreground">{hubConnection.hubUrl}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-foreground-subtle">{t('mesh.spoke.lastSync')}</span>
                  <span className="font-mono text-foreground-subtle">
                    {relativeTime(hubConnection.lastSyncAt)}
                    {hubConnection.rttMs != null ? ` · ${hubConnection.rttMs}ms` : ''}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-foreground-subtle">{t('mesh.node.watermark')}</span>
                  <span className="font-mono tabular-nums text-foreground-subtle">
                    U{hubConnection.ackedWatermark.usageId} · S
                    {hubConnection.ackedWatermark.sessionSeq} · T
                    {hubConnection.ackedWatermark.toolId}
                  </span>
                </div>
                {hubConnection.lastError && (
                  <div className="rounded bg-destructive-surface px-2 py-1 text-destructive">
                    {hubConnection.lastError}
                  </div>
                )}
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => void handleSyncCluster()}
                    className="h-7 flex-1 cursor-pointer rounded-lg bg-secondary px-2 text-ui-xs font-medium text-foreground hover:bg-surface-hover"
                  >
                    {t('mesh.spoke.pushNow')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDisconnectHub()}
                    className="h-7 cursor-pointer rounded-lg px-3 text-ui-xs text-destructive hover:bg-destructive-surface"
                  >
                    {t('mesh.spoke.disconnect')}
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <label className="block text-ui-xs text-foreground-subtle">
                {t('mesh.spoke.pasteLabel')}
              </label>
              <input
                type="text"
                value={pairUriInput}
                onChange={(e) => {
                  setPairUriInput(e.target.value)
                  if (pairError) setPairError(null)
                }}
                placeholder="nexus-pair://192.168.x.x:19836?n=...&s=...#123456"
                className="h-8 w-full rounded-lg border border-border bg-surface px-2.5 font-mono text-ui-xs text-foreground placeholder:text-foreground-subtlest focus:border-cobalt focus:outline-none"
              />
              {parsedUri && (
                <div
                  className={`font-mono text-[10px] ${
                    parsedUri.valid ? 'text-success' : 'text-warning'
                  }`}
                >
                  {parsedUri.valid ? `✓ ${parsedUri.preview}` : t('mesh.spoke.invalidUri')}
                </div>
              )}
              {pairError && <div className="text-ui-xs text-destructive">{pairError}</div>}
              <button
                type="button"
                disabled={pairBusy || !parsedUri?.valid}
                onClick={() => void handlePairWithHub()}
                className="h-8 w-full cursor-pointer rounded-lg bg-cobalt px-3 text-ui-sm font-medium text-white transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {pairBusy ? t('mesh.spoke.pairing') : t('mesh.spoke.pairBtn')}
              </button>
            </div>
          </div>

          <div className="rounded-lg bg-surface/60 px-3 py-2 text-ui-xs text-foreground-subtlest">
            {t('mesh.spoke.tip')}
          </div>
        </div>
      </section>
    </main>
  )
}
