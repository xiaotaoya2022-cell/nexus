// 全局 UI 状态：时间范围、选中 Agent、主题、同步状态、自定义时间范围。

import { create } from 'zustand'
import type { RangeKey, Settings, SyncProgress } from '@shared/types'

export interface CustomRange {
  start: number // epoch ms（含）
  end: number // epoch ms（含）
}

interface UiState {
  range: RangeKey
  agent: string | null
  theme: Settings['theme']
  sync: SyncProgress
  customRange: CustomRange | null
  setRange: (r: RangeKey) => void
  setAgent: (a: string | null) => void
  setTheme: (t: Settings['theme']) => void
  setSync: (p: SyncProgress) => void
  setCustomRange: (r: CustomRange | null) => void
}

export const useUi = create<UiState>((set) => ({
  range: '7d',
  agent: null,
  theme: 'dark',
  sync: { phase: 'idle', agent: null, message: '', startedAt: 0, finishedAt: null, results: [] },
  customRange: null,
  setRange: (range) => set({ range }),
  setAgent: (agent) => set({ agent }),
  setTheme: (theme) => set({ theme }),
  setSync: (sync) => set({ sync }),
  setCustomRange: (customRange) => set({ customRange })
}))
