// 全局 UI 状态：时间范围、选中 Agent、主题、同步状态。

import { create } from 'zustand'
import type { RangeKey, Settings, SyncProgress } from '@shared/types'

interface UiState {
  range: RangeKey
  agent: string | null
  theme: Settings['theme']
  sync: SyncProgress
  setRange: (r: RangeKey) => void
  setAgent: (a: string | null) => void
  setTheme: (t: Settings['theme']) => void
  setSync: (p: SyncProgress) => void
}

export const useUi = create<UiState>((set) => ({
  range: '7d',
  agent: null,
  theme: 'dark',
  sync: { phase: 'idle', agent: null, message: '', startedAt: 0, finishedAt: null, results: [] },
  setRange: (range) => set({ range }),
  setAgent: (agent) => set({ agent }),
  setTheme: (theme) => set({ theme }),
  setSync: (sync) => set({ sync })
}))

export const RANGE_LABELS: Array<{ key: RangeKey; label: string }> = [
  { key: 'today', label: '今日' },
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
  { key: 'all', label: '全部' }
]
