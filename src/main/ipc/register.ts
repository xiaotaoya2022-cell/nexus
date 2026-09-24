// transport 层：把 query/sync/设置/导出能力以 IPC 通道暴露给渲染进程。
// 依赖方向：transport → application → domain ← infrastructure。

import { ipcMain, dialog, BrowserWindow, nativeTheme, shell } from 'electron'
import type { NexusApi, RangeKey, Settings, SyncProgress } from '@shared/types'
import type { QueryService } from '../modules/aggregator/application/query-service'
import type { SyncService } from '../modules/aggregator/application/sync-service'
import type { NexusStore } from '../modules/aggregator/infrastructure/store'
import type { AgentAdapter, PresenceOnlyAgent } from '../modules/adapter/domain/types'
import { detectPresence } from '../modules/adapter/application/registry'
import type { AgentInfo } from '@shared/types'
import { rangeStartMs } from '../modules/aggregator/application/query-service'

const ACTIVE_WINDOW_MS = 15 * 60_000
const IDLE_WINDOW_MS = 24 * 60 * 60_000

export interface IpcDeps {
  store: NexusStore
  query: QueryService
  sync: SyncService
  adapters: AgentAdapter[]
  presence: PresenceOnlyAgent[]
  getMainWindow: () => BrowserWindow | null
}

function buildAgentInfos(deps: IpcDeps): AgentInfo[] {
  const now = Date.now()
  const todayStart = rangeStartMs('today', now)
  const known = new Map<string, { label: string; note: string | null }>()
  for (const a of deps.adapters) known.set(a.id, { label: a.label, note: null })
  for (const p of deps.presence) known.set(p.id, { label: p.label, note: p.note })

  const todayByAgent = new Map<string, { tokens: number; requests: number }>()
  {
    const rows = deps.store.db
      .prepare(
        `SELECT agent, SUM(input_tokens+output_tokens+reasoning_tokens+cache_read_tokens+cache_write_tokens) t,
                COUNT(*) n FROM usage_records WHERE ts >= ? GROUP BY agent`
      )
      .all(todayStart) as Array<Record<string, unknown>>
    for (const r of rows) {
      todayByAgent.set(String(r.agent), { tokens: Number(r.t) || 0, requests: Number(r.n) || 0 })
    }
  }
  const activity = new Map<string, { last: number | null; sessions: number }>()
  {
    const rows = deps.store.db
      .prepare(
        `SELECT agent, MAX(ts) last, COUNT(DISTINCT session_id) s FROM usage_records GROUP BY agent`
      )
      .all() as Array<Record<string, unknown>>
    for (const r of rows) {
      activity.set(String(r.agent), {
        last: r.last == null ? null : Number(r.last),
        sessions: Number(r.s) || 0
      })
    }
  }
  const sessionOnly = new Map<string, { last: number | null; sessions: number }>()
  {
    const rows = deps.store.db
      .prepare(`SELECT agent, MAX(COALESCE(updated_at, started_at, 0)) last, COUNT(*) s FROM sessions GROUP BY agent`)
      .all() as Array<Record<string, unknown>>
    for (const r of rows) {
      sessionOnly.set(String(r.agent), {
        last: Number(r.last) || null,
        sessions: Number(r.s) || 0
      })
    }
  }

  const infos: AgentInfo[] = []
  for (const [id, meta] of known) {
    const adapter = deps.adapters.find((a) => a.id === id)
    const detected = adapter ? adapter.detect() : detectPresence(deps.presence.find((p) => p.id === id)?.detectPaths ?? [])
    const today = todayByAgent.get(id)
    const act = activity.get(id)
    const so = sessionOnly.get(id)
    const last = act?.last ?? so?.last ?? null
    const sessions = (act?.sessions ?? 0) + (so?.sessions ?? 0)
    let status: AgentInfo['status']
    if (!detected && !today && !act) status = 'nodata'
    else if (last != null && now - last <= ACTIVE_WINDOW_MS) status = 'active'
    else if (last != null && now - last <= IDLE_WINDOW_MS) status = 'idle'
    else if (today || act || so) status = 'offline'
    else status = 'nodata'
    infos.push({
      id,
      label: meta.label,
      detected,
      status,
      todayTokens: today?.tokens ?? 0,
      todayRequests: today?.requests ?? 0,
      lastActivityAt: last,
      sessionCount: sessions,
      note: detected ? meta.note : null
    })
  }
  // 有数据的排前，其余按名称
  return infos.sort((a, b) => {
    const ta = a.todayTokens + a.sessionCount
    const tb = b.todayTokens + b.sessionCount
    if (ta !== tb) return tb - ta
    return a.label.localeCompare(b.label)
  })
}

export function registerIpc(deps: IpcDeps): void {
  const q = deps.query

  ipcMain.handle('nexus:getOverview', (_e, range: RangeKey, agent: string | null) =>
    q.getOverview(range, agent)
  )
  ipcMain.handle(
    'nexus:getTrend',
    (_e, range: RangeKey, agent: string | null, groupBy: 'model' | 'agent') =>
      q.getTrend(range, agent, groupBy)
  )
  ipcMain.handle('nexus:getByAgent', (_e, range: RangeKey) => q.getByAgent(range))
  ipcMain.handle('nexus:getByModel', (_e, range: RangeKey, agent: string | null) =>
    q.getByModel(range, agent)
  )
  ipcMain.handle('nexus:getTokenTypeBreakdown', (_e, range: RangeKey, agent: string | null) =>
    q.getTokenTypeBreakdown(range, agent)
  )
  ipcMain.handle('nexus:getHeatmap', (_e, range: RangeKey, agent: string | null) =>
    q.getHeatmap(range, agent)
  )
  ipcMain.handle('nexus:getCalendar', (_e, range: RangeKey, agent: string | null) =>
    q.getCalendar(range, agent)
  )
  ipcMain.handle('nexus:getToolStats', (_e, range: RangeKey, agent: string | null) =>
    q.getToolStats(range, agent)
  )
  ipcMain.handle('nexus:getAgents', () => buildAgentInfos(deps))
  ipcMain.handle('nexus:getSessions', (_e, range: RangeKey, agent: string | null, limit: number) =>
    q.getSessions(range, agent, Math.min(Math.max(1, limit), 200))
  )
  ipcMain.handle('nexus:getSyncStatus', () => deps.sync.getStatus())
  ipcMain.handle('nexus:syncNow', async () => {
    await deps.sync.syncNow()
  })

  ipcMain.handle('nexus:getSettings', (): Settings => {
    const theme = deps.store.getSetting('theme')
    return { theme: theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'dark' }
  })
  ipcMain.handle('nexus:setTheme', (_e, theme: Settings['theme']): Settings => {
    deps.store.setSetting('theme', theme)
    nativeTheme.themeSource = theme
    return { theme }
  })

  ipcMain.handle('nexus:exportBoard', async () => {
    const win = deps.getMainWindow()
    if (!win) return { ok: false, error: '窗口不可用' }
    try {
      const image = await win.webContents.capturePage()
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: '导出看板为图片',
        defaultPath: `nexus-board-${new Date().toISOString().slice(0, 10)}.png`,
        filters: [{ name: 'PNG 图片', extensions: ['png'] }]
      })
      if (canceled || !filePath) return { ok: false, canceled: true }
      const buf = image.toPNG()
      await import('node:fs').then((fs) => fs.promises.writeFile(filePath, buf))
      return { ok: true, path: filePath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('nexus:openPath', async (_e, path: string) => {
    if (typeof path === 'string' && path.length > 0) {
      await shell.openPath(path)
    }
  })

  ipcMain.on('nexus:sync-progress', () => {
    // 渲染端订阅通道由 main → renderer 推送（见 broadcast），此处仅为占位防误用
  })
}

export function broadcastSyncProgress(
  win: BrowserWindow | null,
  progress: SyncProgress
): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('nexus:sync-progress', progress)
  }
}

export type { NexusApi }
