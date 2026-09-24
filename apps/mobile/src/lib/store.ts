// 全局状态：设置持久化（localStorage）+ 连接状态桥接 + 订阅推送数据落库。

import { create } from 'zustand'
import type { SystemSnapshotLike } from '@shared/protocol'
import type { Overview } from '@shared/types'
import { conn, type ConnStatusInfo } from './conn'

export interface MobileSettings {
  host: string
  port: string
  deviceName: string
  deviceId: string
  token: string
}

const LS_KEY = 'nexus.mobile.settings.v1'

const DEFAULTS: MobileSettings = {
  host: '',
  port: '',
  deviceName: 'Android 手机',
  deviceId: '',
  token: ''
}

function loadSettings(): MobileSettings {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw != null) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<MobileSettings>) }
  } catch {
    /* 忽略损坏数据 */
  }
  return { ...DEFAULTS }
}

export interface NexusStore {
  settings: MobileSettings
  status: ConnStatusInfo
  overview: Overview | null // push agent.overview（今日，约 2s 一次）
  snapshot: SystemSnapshotLike | null // push system.snapshot（约 2s 一次）
  saveSettings: (patch: Partial<MobileSettings>) => void
  clearPairing: () => void
  applyConnect: () => void
  applyDisconnect: () => void
}

export const useStore = create<NexusStore>((set, get) => ({
  settings: loadSettings(),
  status: conn.status,
  overview: null,
  snapshot: null,
  saveSettings(patch) {
    const settings = { ...get().settings, ...patch }
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(settings))
    } catch {
      /* 存储失败不影响会话内使用 */
    }
    set({ settings })
  },
  clearPairing() {
    const settings = { ...get().settings, deviceId: '', token: '' }
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(settings))
    } catch {
      /* noop */
    }
    set({ settings })
    conn.disconnect()
  },
  applyConnect() {
    const { host, port, deviceId, token } = get().settings
    if (host === '' || port === '' || deviceId === '' || token === '') {
      set({ status: { status: 'error', detail: '缺少服务器地址或配对凭据', retryInMs: null } })
      return
    }
    conn.connect(`ws://${host}:${port}`, deviceId, token)
  },
  applyDisconnect() {
    conn.disconnect()
  }
}))

// 桥接：连接状态 → store
conn.onStatus((status) => useStore.setState({ status }))

// 桥接：订阅推送 → store（store 层持有订阅，页面切换不断流）
conn.onPush<Overview>('agent.overview', (payload) => useStore.setState({ overview: payload }))
conn.onPush<SystemSnapshotLike>('system.snapshot', (payload) => useStore.setState({ snapshot: payload }))
