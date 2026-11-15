// 全局 UI 状态：视图页、选中设备节点、项目筛选、时间范围、选中 Agent、主题、同步状态、定价配置。

import { create } from 'zustand'
import {
  DEFAULT_PRICING_CONFIG,
  type PricingConfig,
  type RangeKey,
  type Settings,
  type SyncProgress,
  type UiStyle
} from '@shared/types'
import { setPricingDisplay } from './lib/format'

export interface CustomRange {
  start: number // epoch ms（含）
  end: number // epoch ms（含）
}

export type ActiveView = 'board' | 'mesh'

interface UiState {
  activeView: ActiveView
  selectedNodeId: string | null
  selectedProjectDir: string | null
  range: RangeKey
  agent: string | null
  theme: Settings['theme']
  uiStyle: UiStyle
  /** 看板加载中（刷新动效窗口）：CustomCursor 据此临时归还系统光标，主线程再卡鼠标也可用 */
  boardLoading: boolean
  sync: SyncProgress
  customRange: CustomRange | null
  pricingConfig: PricingConfig
  pricingRevision: number
  setActiveView: (v: ActiveView) => void
  setSelectedNodeId: (nodeId: string | null) => void
  setSelectedProjectDir: (projectDir: string | null) => void
  setRange: (r: RangeKey) => void
  setAgent: (a: string | null) => void
  setTheme: (t: Settings['theme']) => void
  setUiStyle: (s: UiStyle) => void
  setBoardLoading: (b: boolean) => void
  setSync: (p: SyncProgress) => void
  setCustomRange: (r: CustomRange | null) => void
  setPricingConfig: (cfg: PricingConfig, bump?: boolean) => void
}

export const useUi = create<UiState>((set) => ({
  activeView: 'board',
  selectedNodeId: null,
  selectedProjectDir: null,
  range: '7d',
  agent: null,
  theme: 'dark',
  uiStyle: 'porcelain',
  boardLoading: false,
  sync: { phase: 'idle', agent: null, message: '', startedAt: 0, finishedAt: null, results: [] },
  customRange: null,
  pricingConfig: DEFAULT_PRICING_CONFIG,
  pricingRevision: 0,
  setActiveView: (activeView) => set({ activeView }),
  setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),
  setSelectedProjectDir: (selectedProjectDir) => set({ selectedProjectDir }),
  setRange: (range) => set({ range }),
  setAgent: (agent) => set({ agent }),
  setTheme: (theme) => set({ theme }),
  setUiStyle: (uiStyle) => set({ uiStyle }),
  setBoardLoading: (boardLoading) => set({ boardLoading }),
  setSync: (sync) => set({ sync }),
  setCustomRange: (customRange) => set({ customRange }),
  setPricingConfig: (pricingConfig, bump = false) => {
    setPricingDisplay(pricingConfig)
    set((s) => ({
      pricingConfig,
      pricingRevision: bump ? s.pricingRevision + 1 : s.pricingRevision
    }))
  }
}))
