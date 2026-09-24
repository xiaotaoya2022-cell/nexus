// preload：以最小暴露面把 IPC 通道桥接为 window.nexus（contextIsolation 安全）。

import { contextBridge, ipcRenderer } from 'electron'
import type { NexusApi, Settings, SyncProgress } from '@shared/types'

const api: NexusApi = {
  getOverview: (range, agent) => ipcRenderer.invoke('nexus:getOverview', range, agent),
  getTrend: (range, agent, groupBy) => ipcRenderer.invoke('nexus:getTrend', range, agent, groupBy),
  getByAgent: (range) => ipcRenderer.invoke('nexus:getByAgent', range),
  getByModel: (range, agent) => ipcRenderer.invoke('nexus:getByModel', range, agent),
  getTokenTypeBreakdown: (range, agent) =>
    ipcRenderer.invoke('nexus:getTokenTypeBreakdown', range, agent),
  getHeatmap: (range, agent) => ipcRenderer.invoke('nexus:getHeatmap', range, agent),
  getCalendar: (range, agent) => ipcRenderer.invoke('nexus:getCalendar', range, agent),
  getToolStats: (range, agent) => ipcRenderer.invoke('nexus:getToolStats', range, agent),
  getAgents: () => ipcRenderer.invoke('nexus:getAgents'),
  getSessions: (range, agent, limit) => ipcRenderer.invoke('nexus:getSessions', range, agent, limit),
  getSyncStatus: () => ipcRenderer.invoke('nexus:getSyncStatus'),
  syncNow: () => ipcRenderer.invoke('nexus:syncNow'),
  getSettings: () => ipcRenderer.invoke('nexus:getSettings'),
  setTheme: (theme: Settings['theme']) => ipcRenderer.invoke('nexus:setTheme', theme),
  exportBoard: () => ipcRenderer.invoke('nexus:exportBoard'),
  openPath: (path) => ipcRenderer.invoke('nexus:openPath', path),
  onSyncProgress: (cb: (p: SyncProgress) => void) => {
    const listener = (_e: unknown, p: SyncProgress): void => cb(p)
    ipcRenderer.on('nexus:sync-progress', listener)
    return () => ipcRenderer.removeListener('nexus:sync-progress', listener)
  }
}

contextBridge.exposeInMainWorld('nexus', api)
