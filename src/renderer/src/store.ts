// 全局 UI 状态：视图页、选中设备节点、时间范围、选中 Agent、主题、同步状态、自定义时间范围。

import { create } from 'zustand'
import type { RangeKey, Settings, SyncProgress, UiStyle } from '@shared/types'

export interface CustomRange {
  start: number // epoch ms（含）
  end: number // epoch ms（含）
}

export type ActiveView = 'board' | 'mesh'

interface UiState {
  activeView: ActiveView
  selectedNodeId: string | null
  range: RangeKey
  agent: string | null
  theme: Settings['theme']
  uiStyle: UiStyle
  sync: SyncProgress
  customRange: CustomRange | null
  setActiveView: (v: ActiveView) => void
  setSelectedNodeId: (nodeId: string | null) => void
  setRange: (r: RangeKey) => void
  setAgent: (a: string | null) => void
  setTheme: (t: Settings['theme']) => void
  setUiStyle: (s: UiStyle) => void
  setSync: (p: SyncProgress) => void
  setCustomRange: (r: CustomRange | null) => void
}

export const useUi = create<UiState>((set) => ({
  activeView: 'board',
  selectedNodeId: null,
  range: '7d',
  agent: null,
  theme: 'dark',
  uiStyle: 'nexus',
  sync: { phase: 'idle', agent: null, message: '', startedAt: 0, finishedAt: null, results: [] },
  customRange: null,
  setActiveView: (activeView) => set({ activeView }),
  setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),
  setRange: (range) => set({ range }),
  setAgent: (agent) => set({ agent }),
  setTheme: (theme) => set({ theme }),
  setUiStyle: (uiStyle) => set({ uiStyle }),
  setSync: (sync) => set({ sync }),
  setCustomRange: (customRange) => set({ customRange })
}))
