// preload：以最小暴露面把 IPC 通道桥接为 window.nexus（contextIsolation 安全）。

import { contextBridge, ipcRenderer } from 'electron'
import type { NexusApi, Settings, SyncProgress } from '@shared/types'

const api: NexusApi = {
  getOverview: (range, agent) => ipcRenderer.invoke('nexus:getOverview', range, agent),
  getBoard: (range, agent) => ipcRenderer.invoke('nexus:getBoard', range, agent),
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
  getRetentionDays: () => ipcRenderer.invoke('nexus:getRetentionDays'),
  setRetentionDays: (days: number) => ipcRenderer.invoke('nexus:setRetentionDays', days),
  getDataDir: () => ipcRenderer.invoke('nexus:getDataDir'),
  getSystemSnapshot: () => ipcRenderer.invoke('nexus:getSystemSnapshot'),
  getRemoteStatus: () => ipcRenderer.invoke('nexus:getRemoteStatus'),
  regeneratePairing: () => ipcRenderer.invoke('nexus:regeneratePairing'),
  setRemoteEnabled: (enabled: boolean) => ipcRenderer.invoke('nexus:setRemoteEnabled', enabled),
  revokeDevice: (deviceId: string) => ipcRenderer.invoke('nexus:revokeDevice', deviceId),
  quotaPlatforms: () => ipcRenderer.invoke('nexus:quotaPlatforms'),
  quotaAccounts: () => ipcRenderer.invoke('nexus:quotaAccounts'),
  quotaLogin: (platform: string, mode?: 'normal' | 'incognito') =>
    ipcRenderer.invoke('nexus:quotaLogin', platform, mode ?? 'normal'),
  quotaLogout: (platform: string, accountId: string) =>
    ipcRenderer.invoke('nexus:quotaLogout', platform, accountId),
  quotaRefresh: () => ipcRenderer.invoke('nexus:quotaRefresh'),
  getAccountUsage: (platform: string, accountId: string, days: number) =>
    ipcRenderer.invoke('nexus:getAccountUsage', platform, accountId, days),
  getDshStatus: () => ipcRenderer.invoke('nexus:getDshStatus'),
  getDshSessions: () => ipcRenderer.invoke('nexus:getDshSessions'),
  sendDshPrompt: (sessionId: string | null, text: string) =>
    ipcRenderer.invoke('nexus:sendDshPrompt', sessionId, text),
  cancelDshSession: (sessionId: string) => ipcRenderer.invoke('nexus:cancelDshSession', sessionId),
  getSavedRange: () => ipcRenderer.invoke('nexus:getSavedRange'),
  setSavedRange: (range: string) => ipcRenderer.invoke('nexus:setSavedRange', range),
  getQuotaAlertThreshold: () => ipcRenderer.invoke('nexus:getQuotaAlertThreshold'),
  setQuotaAlertThreshold: (percent: number) => ipcRenderer.invoke('nexus:setQuotaAlertThreshold', percent),
  onQuotaUpdate: (cb: (views: import('@shared/quotas').AccountQuotaView[]) => void) => {
    const listener = (_e: unknown, views: unknown): void => cb(views as import('@shared/quotas').AccountQuotaView[])
    ipcRenderer.on('nexus:quota-update', listener)
    return (): void => {
      ipcRenderer.removeListener('nexus:quota-update', listener)
    }
  },
  exportBoard: () => ipcRenderer.invoke('nexus:exportBoard'),
  openPath: (path) => ipcRenderer.invoke('nexus:openPath', path),
  onSyncProgress: (cb: (p: SyncProgress) => void) => {
    const listener = (_e: unknown, p: SyncProgress): void => cb(p)
    ipcRenderer.on('nexus:sync-progress', listener)
    return () => ipcRenderer.removeListener('nexus:sync-progress', listener)
  }
}

contextBridge.exposeInMainWorld('nexus', api)
