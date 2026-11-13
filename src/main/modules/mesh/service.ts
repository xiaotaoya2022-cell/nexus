// Mesh 编排服务（Nexus Mesh）：整合本机硬件画像、远端节点档案、统计汇总与状态推送。

import type { NexusStore } from '@main/modules/aggregator/infrastructure/store'
import type { SystemCollector } from '@main/modules/system/collector'
import type { RemoteServer } from '@main/modules/remote/server'
import type {
  MeshNodeInfo,
  MeshStatusInfo,
  MeshWatermark,
  NodeRole
} from '@shared/types'
import { type NodeIdentityService } from './identity'
import { type MeshClient, type PairHubInput } from './client'

const NODE_ONLINE_TTL_MS = 45_000

export interface MeshServiceDeps {
  store: NexusStore
  identity: NodeIdentityService
  system: SystemCollector
  remote: RemoteServer
  client: MeshClient
  getActiveAgents: () => string[]
  onInvalidateBoard?: () => void
  onStatusChanged?: (status: MeshStatusInfo) => void
}

export class MeshService {
  constructor(private readonly deps: MeshServiceDeps) {}

  async getStatus(): Promise<MeshStatusInfo> {
    const now = Date.now()
    const snap = await Promise.race([
      this.deps.system.snapshot().catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), 500))
    ])
    const profile = this.deps.identity.buildProfile(snap, this.deps.getActiveAgents())
    const stats = this.deps.store.getNodeUsageStats()
    const localStats = stats.get('local') ?? { recordCount: 0, totalTokens: 0 }
    const hubConnection = this.deps.client.status()
    const liveConns = this.deps.remote.getConnectedMeshNodes()

    const localNode: MeshNodeInfo = {
      nodeId: profile.nodeId,
      hostname: profile.hostname,
      alias: profile.alias,
      kind: profile.kind,
      role: profile.role,
      isLocal: true,
      status: 'online',
      transport: 'local',
      endpoint: profile.ipHints[0]?.host ?? null,
      rttMs: 0,
      lastSeenAt: now,
      ackedWatermark: this.deps.client.loadWatermark(),
      recordCount: localStats.recordCount,
      totalTokens: localStats.totalTokens,
      hwSummary: profile.hwSummary,
      activeAgents: profile.activeAgents
    }

    const remoteNodes: MeshNodeInfo[] = this.deps.store
      .listMeshNodeRecords()
      .filter((r) => r.nodeId !== profile.nodeId)
      .map((r) => {
        const live = liveConns.get(r.nodeId)
        const isHubLive = Boolean(hubConnection?.connected && hubConnection.hubNodeId === r.nodeId)
        const online = Boolean(live) || isHubLive || now - r.lastSeenAt <= NODE_ONLINE_TTL_MS
        const nodeStat = stats.get(r.nodeId) ?? { recordCount: 0, totalTokens: 0 }
        return {
          nodeId: r.nodeId,
          hostname: r.hostname,
          alias: r.alias,
          kind: r.kind,
          role: r.role,
          isLocal: false,
          status: online ? 'online' : 'offline',
          transport: live?.transport ?? r.transport,
          endpoint: live?.endpoint ?? r.endpoint,
          rttMs: isHubLive ? (hubConnection?.rttMs ?? r.rttMs) : r.rttMs,
          lastSeenAt: r.lastSeenAt,
          ackedWatermark: r.ackedWatermark,
          recordCount: nodeStat.recordCount,
          totalTokens: nodeStat.totalTokens,
          hwSummary: r.hwSummary ?? this.deps.identity.buildHardwareSummary(null),
          activeAgents: r.activeAgents
        }
      })

    return {
      localNode,
      nodes: [localNode, ...remoteNodes],
      hubConnection
    }
  }

  async notifyChanged(): Promise<MeshStatusInfo> {
    const status = await this.getStatus()
    this.deps.onStatusChanged?.(status)
    return status
  }

  async setLocalAlias(alias: string | null): Promise<MeshStatusInfo> {
    this.deps.identity.setAlias(alias)
    return this.notifyChanged()
  }

  async setLocalRole(role: NodeRole | null): Promise<MeshStatusInfo> {
    this.deps.identity.setRoleOverride(role)
    const effective = this.deps.identity.getEffectiveRole()
    if (effective === 'hub') {
      this.deps.client.stop()
      if (!this.deps.remote.isEnabled) this.deps.remote.start()
    } else {
      this.deps.client.start()
    }
    return this.notifyChanged()
  }

  async pairWithHub(input: PairHubInput): Promise<MeshStatusInfo> {
    await this.deps.client.pairWithHub(input)
    return this.notifyChanged()
  }

  async disconnectHub(): Promise<MeshStatusInfo> {
    this.deps.client.disconnectHub()
    return this.notifyChanged()
  }

  async triggerSync(): Promise<{ pushed: number; watermark: MeshWatermark }> {
    const res = await this.deps.client.syncDelta()
    await this.notifyChanged()
    return res
  }

  async removeNode(nodeId: string): Promise<MeshStatusInfo> {
    if (nodeId && nodeId !== this.deps.identity.nodeId && nodeId !== 'local') {
      this.deps.store.removeMeshNodeRecord(nodeId, true)
      this.deps.onInvalidateBoard?.()
    }
    return this.notifyChanged()
  }
}
