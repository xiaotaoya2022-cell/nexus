// transport 层：把 query/sync/设置/导出能力以 IPC 通道暴露给渲染进程。
// 依赖方向：transport → application → domain ← infrastructure。

import { ipcMain, dialog, BrowserWindow, nativeTheme, shell, app } from 'electron'
import type { NexusApi, RangeKey, Settings, SyncProgress } from '@shared/types'
import type { QueryService } from '../modules/aggregator/application/query-service'
import type { SyncService } from '../modules/aggregator/application/sync-service'
import type { NexusStore } from '../modules/aggregator/infrastructure/store'
import type { AgentAdapter, PresenceOnlyAgent } from '../modules/adapter/domain/types'
import { detectPresence } from '../modules/adapter/application/registry'
import type { AgentInfo } from '@shared/types'
import type { SystemCollector } from '../modules/system/collector'
import type { ZcodeManager } from '../modules/zcode/manager'
import type { DshBridge } from '../modules/dsh/bridge'
import type { CockpitBridge } from '../modules/cockpit/bridge'
import type { QuotaEngine } from '../modules/quotas/engine'
import type { RemoteServer } from '../modules/remote/server'
import { rangeStartMs } from '../modules/aggregator/application/query-service'

const ACTIVE_WINDOW_MS = 15 * 60_000
const IDLE_WINDOW_MS = 24 * 60 * 60_000

export interface IpcDeps {
  store: NexusStore
  query: QueryService
  sync: SyncService
  adapters: AgentAdapter[]
  presence: PresenceOnlyAgent[]
  system: SystemCollector
  zcode: ZcodeManager
  dsh: DshBridge
  cockpit: CockpitBridge
  quota: QuotaEngine
  remote: RemoteServer
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

  // 会话数：sessions 表与 usage_records 去重会话的「并集」计数，避免双计（红队 N-02）
  const sessionUnion = new Map<string, number>()
  {
    const rows = deps.store.db
      .prepare(
        `SELECT agent, COUNT(*) c FROM (
           SELECT agent, session_id FROM sessions
           UNION
           SELECT agent, session_id FROM usage_records WHERE session_id IS NOT NULL
         ) GROUP BY agent`
      )
      .all() as Array<Record<string, unknown>>
    for (const r of rows) {
      sessionUnion.set(String(r.agent), Number(r.c) || 0)
    }
  }

  const infos: AgentInfo[] = []
  for (const [id, meta] of known) {
    const adapter = deps.adapters.find((a) => a.id === id)
    const detected = adapter ? adapter.detect() : detectPresence(deps.presence.find((p) => p.id === id)?.detectPaths ?? [])
    // Antigravity：接入 Cockpit 感知——把"如何启用采集"写进 note（调研报告 §落地建议）
    const cockpitNote = id === 'antigravity' ? deps.cockpit.noteFor() : null
    const note = cockpitNote ?? (detected ? meta.note : null)
    const today = todayByAgent.get(id)
    const act = activity.get(id)
    const so = sessionOnly.get(id)
    const last = act?.last ?? so?.last ?? null
    const sessions = sessionUnion.get(id) ?? 0
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
      note,
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
    // 只提供 dark/light 两档：'system' 在渲染层有时序歧义（红队 N-13），存量为 system 时归一为 dark
    return { theme: theme === 'light' ? 'light' : 'dark' }
  })
  ipcMain.handle('nexus:setTheme', (_e, theme: Settings['theme']): Settings => {
    const normalized = theme === 'light' ? 'light' : 'dark'
    deps.store.setSetting('theme', normalized)
    nativeTheme.themeSource = normalized
    return { theme: normalized }
  })

  ipcMain.handle('nexus:getRetentionDays', (): number => {
    const v = Number(deps.store.getSetting('retentionDays') ?? 0)
    return Number.isFinite(v) && v > 0 ? v : 0
  })
  ipcMain.handle('nexus:setRetentionDays', (_e, days: number): number => {
    const normalized = Number.isFinite(days) && days > 0 ? Math.round(days) : 0
    deps.store.setSetting('retentionDays', String(normalized))
    return normalized
  })
  ipcMain.handle('nexus:getDataDir', () => app.getPath('userData'))

  // ── v2：系统状态 / 远程服务 ──
  ipcMain.handle('nexus:getSystemSnapshot', async () => {
    try {
      return await deps.system.snapshot()
    } catch {
      return null
    }
  })
  ipcMain.handle('nexus:getRemoteStatus', () => deps.remote.status())
  ipcMain.handle('nexus:regeneratePairing', async () => deps.remote.regeneratePairing())
  ipcMain.handle('nexus:setRemoteEnabled', (_e, enabled: boolean) => {
    if (enabled === true) deps.remote.start()
    else deps.remote.stop()
  })
  ipcMain.handle('nexus:revokeDevice', (_e, deviceId: string) => {
    if (typeof deviceId === 'string' && deviceId.startsWith('dev_')) deps.remote.revokeDevice(deviceId)
  })

  // ── v2：账号与配额 ──
  ipcMain.handle('nexus:quotaPlatforms', () => deps.quota.listPlatformMeta())
  ipcMain.handle('nexus:quotaAccounts', () => deps.quota.listAccounts())
  ipcMain.handle('nexus:quotaLogin', async (_e, platform: string) => {
    if (typeof platform === 'string' && /^[a-z0-9-]{1,32}$/.test(platform)) {
      await deps.quota.login(platform)
    }
  })
  ipcMain.handle('nexus:quotaLogout', (_e, platform: string, accountId: string) => {
    if (typeof platform === 'string' && typeof accountId === 'string') {
      deps.quota.logout(platform, accountId)
    }
  })
  ipcMain.handle('nexus:quotaRefresh', async () => deps.quota.refreshNow())
  ipcMain.handle('nexus:getDshStatus', async () => {
    const st = await deps.dsh.status()
    let sessionCount = 0
    if (st.available) {
      try {
        sessionCount = (await deps.dsh.listSessions()).length
      } catch {
        // 会话拉取失败不影响状态展示
      }
    }
    return { ...st, sessionCount }
  })
  ipcMain.handle('nexus:getQuotaAlertThreshold', (): number => {
    const v = Number(deps.store.getSetting('quotaAlertThreshold') ?? 90)
    return Number.isFinite(v) && v > 0 ? v : 90
  })
  ipcMain.handle('nexus:setQuotaAlertThreshold', (_e, percent: number): number => {
    const normalized = Number.isFinite(percent) && percent > 0 ? Math.min(99, Math.round(percent)) : 90
    deps.store.setSetting('quotaAlertThreshold', String(normalized))
    return normalized
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
    // 防御纵深（红队 N-09）：路径数据源自外部 Agent 库的不可控字符串，
    // 只在文件管理器中定位，绝不直接执行/打开。
    if (typeof path === 'string' && path.length > 0) {
      shell.showItemInFolder(path)
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
