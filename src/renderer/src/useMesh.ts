// Mesh 多机状态 Hook：拉取本机与集群节点档案并监听主进程推送。

import { useCallback, useEffect, useState } from 'react'
import type { MeshStatusInfo, MeshWatermark, NodeRole } from '@shared/types'
import { nexus } from './lib/api'
import { useUi } from './store'

export interface MeshActions {
  refreshStatus: () => Promise<MeshStatusInfo>
  setAlias: (alias: string | null) => Promise<MeshStatusInfo>
  setRole: (role: NodeRole | null) => Promise<MeshStatusInfo>
  pairWithHub: (input: {
    uri?: string
    host?: string
    port?: number
    pin?: string
    nonce?: string
    pairingSecret?: string
  }) => Promise<MeshStatusInfo>
  disconnectHub: () => Promise<MeshStatusInfo>
  triggerSync: () => Promise<{ pushed: number; watermark: MeshWatermark }>
  removeNode: (nodeId: string) => Promise<MeshStatusInfo>
}

export function useMesh(): { meshStatus: MeshStatusInfo | null; actions: MeshActions } {
  const [meshStatus, setMeshStatus] = useState<MeshStatusInfo | null>(null)

  useEffect(() => {
    let alive = true
    void nexus
      .getMeshStatus()
      .then((s) => {
        if (alive) setMeshStatus(s)
      })
      .catch(() => undefined)
    const unsub = nexus.onMeshUpdate((s) => {
      if (alive) setMeshStatus(s)
    })
    return () => {
      alive = false
      unsub()
    }
  }, [])

  const refreshStatus = useCallback(async () => {
    const s = await nexus.getMeshStatus()
    setMeshStatus(s)
    return s
  }, [])

  const setAlias = useCallback(async (alias: string | null) => {
    const s = await nexus.setLocalNodeAlias(alias)
    setMeshStatus(s)
    return s
  }, [])

  const setRole = useCallback(async (role: NodeRole | null) => {
    const s = await nexus.setLocalNodeRole(role)
    setMeshStatus(s)
    return s
  }, [])

  const pairWithHub = useCallback(
    async (input: Parameters<typeof nexus.pairWithHub>[0]) => {
      const s = await nexus.pairWithHub(input)
      setMeshStatus(s)
      return s
    },
    []
  )

  const disconnectHub = useCallback(async () => {
    const s = await nexus.disconnectHub()
    setMeshStatus(s)
    return s
  }, [])

  const triggerSync = useCallback(async () => {
    const res = await nexus.triggerMeshSync()
    const s = await nexus.getMeshStatus()
    setMeshStatus(s)
    return res
  }, [])

  const removeNode = useCallback(async (nodeId: string) => {
    const s = await nexus.removeMeshNode(nodeId)
    setMeshStatus(s)
    if (useUi.getState().selectedNodeId === nodeId) {
      useUi.getState().setSelectedNodeId(null)
    }
    return s
  }, [])

  return {
    meshStatus,
    actions: {
      refreshStatus,
      setAlias,
      setRole,
      pairWithHub,
      disconnectHub,
      triggerSync,
      removeNode
    }
  }
}
