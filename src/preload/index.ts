// preload：以最小暴露面把 IPC 通道桥接为 window.nexus（contextIsolation 安全）。

import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppAlertEvent,
  AppPreferences,
  ExportFilter,
  ExportFormat,
  MeshStatusInfo,
  NexusApi,
  PricingConfig,
  Settings,
  SyncProgress,
  UiStyle
} from '@shared/types'

const api: NexusApi = {
  getOverview: (range, agent) => ipcRenderer.invoke('nexus:getOverview', range, agent),
  getBoard: (
    range,
    agent,
    customStart?: number,
    customEnd?: number,
    nodeId?: string | null,
    projectDir?: string | null
  ) => ipcRenderer.invoke('nexus:getBoard', range, agent, customStart, customEnd, nodeId, projectDir),
  getCustomRange: () => ipcRenderer.invoke('nexus:getCustomRange'),
  setCustomRange: (start: number, end: number) =>
    ipcRenderer.invoke('nexus:setCustomRange', start, end),
  minimizeWindow: () => ipcRenderer.invoke('nexus:minimizeWindow'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('nexus:toggleMaximizeWindow'),
  closeWindow: () => ipcRenderer.invoke('nexus:closeWindow'),
  isMaximized: () => ipcRenderer.invoke('nexus:isMaximized'),
  onMaximizeChange: (cb: (maximized: boolean) => void) => {
    const listener = (_e: unknown, maximized: unknown): void => cb(Boolean(maximized))
    ipcRenderer.on('nexus:maximize-changed', listener)
    return (): void => {
      ipcRenderer.removeListener('nexus:maximize-changed', listener)
    }
  },
  getTrend: (range, agent, groupBy) => ipcRenderer.invoke('nexus:getTrend', range, agent, groupBy),
  getByAgent: (range) => ipcRenderer.invoke('nexus:getByAgent', range),
  getByModel: (range, agent) => ipcRenderer.invoke('nexus:getByModel', range, agent),
  getTokenTypeBreakdown: (range, agent) =>
    ipcRenderer.invoke('nexus:getTokenTypeBreakdown', range, agent),
  getHeatmap: (range, agent) => ipcRenderer.invoke('nexus:getHeatmap', range, agent),
  getCalendar: (range, agent) => ipcRenderer.invoke('nexus:getCalendar', range, agent),
  getToolStats: (range, agent) => ipcRenderer.invoke('nexus:getToolStats', range, agent),
  getAgents: (range, customStart, customEnd, nodeId, projectDir) =>
    ipcRenderer.invoke('nexus:getAgents', range, customStart, customEnd, nodeId, projectDir),
  getSessions: (range, agent, limit) => ipcRenderer.invoke('nexus:getSessions', range, agent, limit),
  getSessionDetail: (agent, sessionId, nodeId) =>
    ipcRenderer.invoke('nexus:getSessionDetail', agent, sessionId, nodeId),
  getMeshStatus: () => ipcRenderer.invoke('nexus:getMeshStatus'),
  setLocalNodeAlias: (alias) => ipcRenderer.invoke('nexus:setLocalNodeAlias', alias),
  setLocalNodeRole: (role) => ipcRenderer.invoke('nexus:setLocalNodeRole', role),
  pairWithHub: (input) => ipcRenderer.invoke('nexus:pairWithHub', input),
  disconnectHub: () => ipcRenderer.invoke('nexus:disconnectHub'),
  triggerMeshSync: () => ipcRenderer.invoke('nexus:triggerMeshSync'),
  removeMeshNode: (nodeId) => ipcRenderer.invoke('nexus:removeMeshNode', nodeId),
  onMeshUpdate: (cb: (status: MeshStatusInfo) => void) => {
    const listener = (_e: unknown, status: MeshStatusInfo): void => cb(status)
    ipcRenderer.on('nexus:mesh-update', listener)
    return () => ipcRenderer.removeListener('nexus:mesh-update', listener)
  },
  getSyncStatus: () => ipcRenderer.invoke('nexus:getSyncStatus'),
  syncNow: () => ipcRenderer.invoke('nexus:syncNow'),
  getSettings: () => ipcRenderer.invoke('nexus:getSettings'),
  setTheme: (theme: Settings['theme']) => ipcRenderer.invoke('nexus:setTheme', theme),
  setUiStyle: (style: UiStyle) => ipcRenderer.invoke('nexus:setUiStyle', style),
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
  getPricingConfig: () => ipcRenderer.invoke('nexus:getPricingConfig'),
  setPricingConfig: (config: PricingConfig) => ipcRenderer.invoke('nexus:setPricingConfig', config),
  getAppPreferences: () => ipcRenderer.invoke('nexus:getAppPreferences'),
  setAppPreferences: (prefs: Partial<AppPreferences>) =>
    ipcRenderer.invoke('nexus:setAppPreferences', prefs),
  onAppAlert: (cb: (alert: AppAlertEvent) => void) => {
    const listener = (_e: unknown, alert: unknown): void => cb(alert as AppAlertEvent)
    ipcRenderer.on('nexus:app-alert', listener)
    return (): void => {
      ipcRenderer.removeListener('nexus:app-alert', listener)
    }
  },
  exportBoard: () => ipcRenderer.invoke('nexus:exportBoard'),
  exportReport: (format: ExportFormat, filter: ExportFilter) =>
    ipcRenderer.invoke('nexus:exportReport', format, filter),
  openPath: (path) => ipcRenderer.invoke('nexus:openPath', path),
  onSyncProgress: (cb: (p: SyncProgress) => void) => {
    const listener = (_e: unknown, p: SyncProgress): void => cb(p)
    ipcRenderer.on('nexus:sync-progress', listener)
    return () => ipcRenderer.removeListener('nexus:sync-progress', listener)
  }
}

contextBridge.exposeInMainWorld('nexus', api)
