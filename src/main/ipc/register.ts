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
import type { MeshService } from '../modules/mesh/service'
import type { MeshStatusInfo, NodeRole } from '@shared/types'
import { rangeStartMs } from '../modules/aggregator/application/query-service'
import { TOTAL_EXPR } from '../modules/aggregator/infrastructure/store'

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
  mesh?: MeshService
  getMainWindow: () => BrowserWindow | null
}

function resolveNodeFilter(store: NexusStore, nodeId?: string | null): string | null {
  if (!nodeId || nodeId === 'all') return null
  const localId = store.getSetting('meshNodeId') ?? 'local'
  return nodeId === 'local' || nodeId === localId ? 'local' : nodeId
}

function buildAgentInfos(
  deps: IpcDeps,
  range: RangeKey = 'today',
  custom?: { start: number; end: number },
  nodeId: string | null = null
): AgentInfo[] {
  const now = Date.now()
  const todayStart = rangeStartMs('today', now)
  const nodeFilter = resolveNodeFilter(deps.store, nodeId)
  const isRemoteOnly = nodeFilter != null && nodeFilter !== 'local'
  const remoteActiveAgents = new Set<string>()
  for (const n of deps.store.listMeshNodeRecords()) {
    if (!nodeFilter || n.nodeId === nodeFilter) {
      for (const ag of n.activeAgents) remoteActiveAgents.add(ag)
    }
  }
  const known = new Map<string, { label: string; note: string | null }>()
  for (const a of deps.adapters) known.set(a.id, { label: a.label, note: null })
  for (const p of deps.presence) known.set(p.id, { label: p.label, note: p.note })

  const todayByAgent = new Map<string, { tokens: number; requests: number }>()
  {
    const sql = `SELECT agent, SUM(input_tokens+output_tokens+reasoning_tokens+cache_read_tokens+cache_write_tokens) t,
                 COALESCE(SUM(requests), COUNT(*)) n FROM usage_records
                 WHERE ts >= ? ${nodeFilter ? 'AND source_node_id = ?' : ''} GROUP BY agent`
    const rows = (
      nodeFilter
        ? deps.store.db.prepare(sql).all(todayStart, nodeFilter)
        : deps.store.db.prepare(sql).all(todayStart)
    ) as Array<Record<string, unknown>>
    for (const r of rows) {
      todayByAgent.set(String(r.agent), { tokens: Number(r.t) || 0, requests: Number(r.n) || 0 })
    }
  }
  const activity = new Map<string, { last: number | null; sessions: number; tokens: number }>()
  {
    const sql = `SELECT agent, MAX(ts) last, COUNT(DISTINCT session_id) s,
                 SUM(input_tokens+output_tokens+reasoning_tokens+cache_read_tokens+cache_write_tokens) t
                 FROM usage_records ${nodeFilter ? 'WHERE source_node_id = ?' : ''} GROUP BY agent`
    const rows = (
      nodeFilter ? deps.store.db.prepare(sql).all(nodeFilter) : deps.store.db.prepare(sql).all()
    ) as Array<Record<string, unknown>>
    for (const r of rows) {
      activity.set(String(r.agent), {
        last: r.last == null ? null : Number(r.last),
        sessions: Number(r.s) || 0,
        tokens: Number(r.t) || 0
      })
    }
  }
  const rangeByAgent = new Map<string, number>()
  if (range === 'today' && !custom) {
    for (const [k, v] of todayByAgent) rangeByAgent.set(k, v.tokens)
  } else if (range === 'all' && !custom) {
    for (const [k, v] of activity) rangeByAgent.set(k, v.tokens)
  } else {
    const since = custom ? custom.start : rangeStartMs(range, now)
    let until = custom ? custom.end : now
    if (!custom && range === 'yesterday') {
      const d = new Date(now)
      d.setHours(0, 0, 0, 0)
      until = d.getTime()
    }
    const sql = `SELECT agent, SUM(input_tokens+output_tokens+reasoning_tokens+cache_read_tokens+cache_write_tokens) t
                 FROM usage_records WHERE ts >= ? AND ts <= ? ${nodeFilter ? 'AND source_node_id = ?' : ''} GROUP BY agent`
    const rows = (
      nodeFilter
        ? deps.store.db.prepare(sql).all(since, until, nodeFilter)
        : deps.store.db.prepare(sql).all(since, until)
    ) as Array<Record<string, unknown>>
    for (const r of rows) {
      rangeByAgent.set(String(r.agent), Number(r.t) || 0)
    }
  }
  const sessionOnly = new Map<string, { last: number | null; sessions: number }>()
  {
    const sql = `SELECT agent, MAX(COALESCE(updated_at, started_at, 0)) last, COUNT(*) s
                 FROM sessions ${nodeFilter ? 'WHERE source_node_id = ?' : ''} GROUP BY agent`
    const rows = (
      nodeFilter ? deps.store.db.prepare(sql).all(nodeFilter) : deps.store.db.prepare(sql).all()
    ) as Array<Record<string, unknown>>
    for (const r of rows) {
      sessionOnly.set(String(r.agent), {
        last: Number(r.last) || null,
        sessions: Number(r.s) || 0
      })
    }
  }

  // 会话数：sessions 表与 usage_records 去重会话的「并集」计数，按 (source_node_id, agent, session_id) 防跨机碰撞
  const sessionUnion = new Map<string, number>()
  {
    const sql = `SELECT agent, COUNT(*) c FROM (
                   SELECT source_node_id, agent, session_id FROM sessions ${nodeFilter ? 'WHERE source_node_id = ?' : ''}
                   UNION
                   SELECT source_node_id, agent, session_id FROM usage_records
                   WHERE session_id IS NOT NULL ${nodeFilter ? 'AND source_node_id = ?' : ''}
                 ) GROUP BY agent`
    const rows = (
      nodeFilter
        ? deps.store.db.prepare(sql).all(nodeFilter, nodeFilter)
        : deps.store.db.prepare(sql).all()
    ) as Array<Record<string, unknown>>
    for (const r of rows) {
      sessionUnion.set(String(r.agent), Number(r.c) || 0)
    }
  }

  // DSH 已并入适配器体系（DshAdapter 直接解析本地 zstd 会话），无需特殊分支

  const infos: AgentInfo[] = []
  for (const [id, meta] of known) {
    const adapter = deps.adapters.find((a) => a.id === id)
    const localDetected = adapter
      ? adapter.detect()
      : detectPresence(deps.presence.find((p) => p.id === id)?.detectPaths ?? [])
    const detected = isRemoteOnly
      ? remoteActiveAgents.has(id)
      : nodeFilter === 'local'
        ? localDetected
        : localDetected || remoteActiveAgents.has(id)
    const today = todayByAgent.get(id)
    const act = activity.get(id)
    const so = sessionOnly.get(id)
    const last = act?.last ?? so?.last ?? null
    const sessions = sessionUnion.get(id) ?? 0
    // Antigravity：原生日志已可直接采集；仅当本地无任何原生用量或会话记录时才用 Cockpit 提示兜底
    const cockpitNote =
      !isRemoteOnly && id === 'antigravity' && !today && !act && sessions === 0
        ? deps.cockpit.noteFor()
        : null
    let note = cockpitNote ?? (detected ? meta.note : null)
    // ZCode：多开实例感知仅针对包含本机节点的视图
    if (!isRemoteOnly && id === 'zcode') {
      try {
        const insts = deps.zcode.instances()
        const running = insts.filter((i) => i.running).length
        if (running > 0) {
          const instText = `${running} 个实例运行中`
          note = note ? `${instText} · ${note}` : instText
        }
      } catch {
        // 实例枚举失败不影响主统计
      }
    }
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
      rangeTokens: rangeByAgent.get(id) ?? 0,
      totalTokens: act?.tokens ?? 0,
      lastActivityAt: last,
      sessionCount: sessions,
      note,
    })
  }
  // 当前时间范围有消耗的排前，其次按历史总消耗与会话数，最后按名称
  return infos.sort((a, b) => {
    const ra = a.rangeTokens ?? a.todayTokens
    const rb = b.rangeTokens ?? b.todayTokens
    if (ra !== rb) return rb - ra
    const ta = (a.totalTokens ?? 0) + a.sessionCount
    const tb = (b.totalTokens ?? 0) + b.sessionCount
    if (ta !== tb) return tb - ta
    return a.label.localeCompare(b.label)
  })
}

export function registerIpc(deps: IpcDeps): void {
  const q = deps.query

  ipcMain.handle('nexus:getOverview', (_e, range: RangeKey, agent: string | null) =>
    q.getOverview(range, agent)
  )
  // 看板全量：单遍扫描聚合（代替渲染层 9 个 IPC 串行全表扫）
  // 自定义范围：customStart/customEnd（epoch ms）提供时覆盖 range 推导
  ipcMain.handle(
    'nexus:getBoard',
    (
      _e,
      range: RangeKey,
      agent: string | null,
      customStart: unknown,
      customEnd: unknown,
      nodeId: unknown
    ) => {
      const custom =
        typeof customStart === 'number' &&
        typeof customEnd === 'number' &&
        Number.isFinite(customStart) &&
        Number.isFinite(customEnd) &&
        customEnd > customStart
          ? { start: customStart, end: customEnd }
          : undefined
      const safeNodeId =
        typeof nodeId === 'string' && nodeId.length > 0 && nodeId.length <= 128 ? nodeId : null
      return q.getBoard(range, agent, Date.now(), custom, safeNodeId)
    }
  )
  // 自定义时间范围持久化（重启保持）
  ipcMain.handle('nexus:getCustomRange', () => {
    const raw = deps.store.getSetting('customRange')
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as { start?: unknown; end?: unknown }
      if (typeof parsed.start === 'number' && typeof parsed.end === 'number') {
        return { start: parsed.start, end: parsed.end }
      }
    } catch {
      // 坏数据按未设置处理
    }
    return null
  })
  ipcMain.handle('nexus:setCustomRange', (_e, start: unknown, end: unknown) => {
    if (typeof start !== 'number' || typeof end !== 'number' || end <= start) {
      throw new Error('自定义范围无效')
    }
    deps.store.setSetting('customRange', JSON.stringify({ start, end }))
    return { start, end }
  })
  // 自绘窗口控制钮（frame:false，主题随渲染层同步）
  ipcMain.handle('nexus:minimizeWindow', () => deps.getMainWindow()?.minimize())
  ipcMain.handle('nexus:toggleMaximizeWindow', () => {
    const win = deps.getMainWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('nexus:closeWindow', () => deps.getMainWindow()?.close())
  ipcMain.handle('nexus:isMaximized', () => deps.getMainWindow()?.isMaximized() ?? false)
  ipcMain.handle(
    'nexus:getTrend',
    (_e, range: RangeKey, agent: string | null, groupBy: 'model' | 'agent') =>
      q.getTrend(range, agent, groupBy === 'agent' ? 'agent' : 'model')
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
  ipcMain.handle(
    'nexus:getAgents',
    (_e, range?: unknown, customStart?: unknown, customEnd?: unknown, nodeId?: unknown) => {
      const r: RangeKey =
        range === 'today' ||
        range === 'yesterday' ||
        range === '7d' ||
        range === '30d' ||
        range === 'month' ||
        range === 'year' ||
        range === 'all' ||
        range === 'custom'
          ? range
          : 'today'
      const custom =
        typeof customStart === 'number' &&
        typeof customEnd === 'number' &&
        Number.isFinite(customStart) &&
        Number.isFinite(customEnd) &&
        customEnd > customStart
          ? { start: customStart, end: customEnd }
          : undefined
      const safeNodeId =
        typeof nodeId === 'string' && nodeId.length > 0 && nodeId.length <= 128 ? nodeId : null
      return buildAgentInfos(deps, r, custom, safeNodeId)
    }
  )
  ipcMain.handle('nexus:getSessions', (_e, range: RangeKey, agent: string | null, limit: number) =>
    q.getSessions(range, agent, Math.min(Math.max(1, limit), 200))
  )
  ipcMain.handle('nexus:getSyncStatus', () => deps.sync.getStatus())
  ipcMain.handle('nexus:syncNow', async () => {
    await deps.sync.syncNow()
  })

  const readSettings = (): Settings => {
    const capture = Boolean(process.env.NEXUS_CAPTURE)
    const theme = (capture && process.env.NEXUS_CAPTURE_THEME) || deps.store.getSetting('theme')
    const uiStyle = (capture && process.env.NEXUS_CAPTURE_STYLE) || deps.store.getSetting('uiStyle')
    return {
      // 只提供 dark/light 两档：'system' 在渲染层有时序歧义（红队 N-13），存量为 system 时归一为 dark
      theme: theme === 'light' ? 'light' : 'dark',
      uiStyle: uiStyle === 'classic' ? 'classic' : 'nexus'
    }
  }

  ipcMain.handle('nexus:getSettings', (): Settings => readSettings())
  ipcMain.handle('nexus:setTheme', (_e, theme: Settings['theme']): Settings => {
    const normalized = theme === 'light' ? 'light' : 'dark'
    deps.store.setSetting('theme', normalized)
    nativeTheme.themeSource = normalized
    return readSettings()
  })
  ipcMain.handle('nexus:setUiStyle', (_e, style: NonNullable<Settings['uiStyle']>): Settings => {
    const normalized = style === 'classic' ? 'classic' : 'nexus'
    deps.store.setSetting('uiStyle', normalized)
    return readSettings()
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

  // ── Nexus Mesh：多机硬件识别、配对与增量组网 ──
  ipcMain.handle('nexus:getMeshStatus', async () => {
    if (!deps.mesh) throw new Error('Mesh 服务尚未初始化')
    return deps.mesh.getStatus()
  })
  ipcMain.handle('nexus:setLocalNodeAlias', async (_e, alias: unknown) => {
    if (!deps.mesh) throw new Error('Mesh 服务尚未初始化')
    const val = typeof alias === 'string' ? alias.slice(0, 48) : null
    return deps.mesh.setLocalAlias(val)
  })
  ipcMain.handle('nexus:setLocalNodeRole', async (_e, role: unknown) => {
    if (!deps.mesh) throw new Error('Mesh 服务尚未初始化')
    const val: NodeRole | null = role === 'hub' || role === 'spoke' ? role : null
    return deps.mesh.setLocalRole(val)
  })
  ipcMain.handle('nexus:pairWithHub', async (_e, input: unknown) => {
    if (!deps.mesh) throw new Error('Mesh 服务尚未初始化')
    const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    return deps.mesh.pairWithHub({
      uri: typeof obj.uri === 'string' ? obj.uri.slice(0, 1024) : undefined,
      host: typeof obj.host === 'string' ? obj.host.slice(0, 256) : undefined,
      port: typeof obj.port === 'number' ? obj.port : undefined,
      pin: typeof obj.pin === 'string' ? obj.pin.slice(0, 12) : undefined,
      nonce: typeof obj.nonce === 'string' ? obj.nonce.slice(0, 128) : undefined,
      pairingSecret: typeof obj.pairingSecret === 'string' ? obj.pairingSecret.slice(0, 256) : undefined
    })
  })
  ipcMain.handle('nexus:disconnectHub', async () => {
    if (!deps.mesh) throw new Error('Mesh 服务尚未初始化')
    return deps.mesh.disconnectHub()
  })
  ipcMain.handle('nexus:triggerMeshSync', async () => {
    if (!deps.mesh) throw new Error('Mesh 服务尚未初始化')
    return deps.mesh.triggerSync()
  })
  ipcMain.handle('nexus:removeMeshNode', async (_e, nodeId: unknown) => {
    if (!deps.mesh) throw new Error('Mesh 服务尚未初始化')
    const safeId = typeof nodeId === 'string' && nodeId !== 'local' ? nodeId.slice(0, 128) : ''
    if (!safeId) throw new Error('节点 ID 无效')
    return deps.mesh.removeNode(safeId)
  })

  // ── v2：账号与配额 ──
  ipcMain.handle('nexus:quotaPlatforms', () => deps.quota.listPlatformMeta())
  ipcMain.handle('nexus:quotaAccounts', () => deps.quota.listAccounts())
  ipcMain.handle('nexus:quotaLogin', async (_e, platform: string, mode: unknown) => {
    if (typeof platform === 'string' && /^[a-z0-9-]{1,32}$/.test(platform)) {
      await deps.quota.login(platform, mode === 'incognito' ? 'incognito' : 'normal')
    }
  })
  ipcMain.handle('nexus:quotaLogout', (_e, platform: string, accountId: string) => {
    if (typeof platform === 'string' && typeof accountId === 'string') {
      deps.quota.logout(platform, accountId)
    }
  })
  ipcMain.handle('nexus:quotaRefresh', async () => deps.quota.refreshNow())
  ipcMain.handle('nexus:getAccountUsage', (_e, platform: unknown, accountId: unknown, days: unknown) => {
    const p = typeof platform === 'string' && platform.length <= 64 ? platform : ''
    const a = typeof accountId === 'string' && accountId.length <= 256 ? accountId : ''
    const d = Number.isFinite(Number(days)) ? Math.min(365, Math.max(1, Number(days))) : 30
    if (!p || !a) return []
    return deps.store.queryAccountUsage(p, a, d)
  })
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
  ipcMain.handle('nexus:getDshSessions', async () => {
    // 本地 zstd 会话（DshAdapter 已落库）：从 Nexus 库聚合每会话消耗，不依赖 DSH 运行
    try {
      const rows = deps.store.db
        .prepare(
          `SELECT s.session_id, s.title, s.project_dir, s.model, s.started_at, s.updated_at,
                  COALESCE(SUM(${TOTAL_EXPR}), 0) AS tokens, COUNT(u.id) AS requests
           FROM sessions s
           LEFT JOIN usage_records u ON u.agent = s.agent AND u.session_id = s.session_id
           WHERE s.agent = 'dsh'
           GROUP BY s.agent, s.session_id
           ORDER BY COALESCE(s.updated_at, s.started_at, 0) DESC
           LIMIT 120`
        )
        .all() as Array<Record<string, unknown>>
      return rows.map((r) => ({
        sessionId: String(r.session_id),
        title: r.title == null ? null : String(r.title),
        projectDir: r.project_dir == null ? null : String(r.project_dir),
        model: r.model == null ? null : String(r.model),
        startedAt: r.started_at == null ? null : Number(r.started_at),
        updatedAt: r.updated_at == null ? null : Number(r.updated_at),
        tokens: Number(r.tokens) || 0,
        requests: Number(r.requests) || 0
      }))
    } catch {
      return []
    }
  })
  ipcMain.handle('nexus:sendDshPrompt', async (_e, sessionId: unknown, text: unknown) => {
    const sid = typeof sessionId === 'string' && sessionId.length <= 256 ? sessionId : null
    if (typeof text !== 'string' || text.trim() === '' || text.length > 32000) {
      throw new Error('prompt 内容为空或超长（上限 32000 字符）')
    }
    const created = !sid
    const r = (await deps.dsh.prompt(sid, text.trim())) as { sessionId?: string }
    const finalId = typeof r?.sessionId === 'string' && r.sessionId ? r.sessionId : (sid ?? '')
    void created
    return { sessionId: finalId }
  })
  ipcMain.handle('nexus:cancelDshSession', async (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 256) {
      throw new Error('sessionId 无效')
    }
    await deps.dsh.cancel(sessionId)
  })
  ipcMain.handle('nexus:getSavedRange', (): RangeKey => {
    const v = deps.store.getSetting('range')
    return v === 'today' || v === '7d' || v === '30d' || v === 'month' || v === 'year' || v === 'all' || v === 'custom'
      ? v
      : '7d'
  })
  ipcMain.handle('nexus:setSavedRange', (_e, range: unknown): RangeKey => {
    const v = String(range)
    const valid: RangeKey =
      v === 'today' || v === '7d' || v === '30d' || v === 'month' || v === 'year' || v === 'all' || v === 'custom'
        ? (v as RangeKey)
        : '7d'
    deps.store.setSetting('range', valid)
    return valid
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

// 自绘窗口控制钮：最大化状态变化广播（渲染层切换 □/❐ 图标）
export function broadcastMaximizeState(win: BrowserWindow | null, maximized: boolean): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('nexus:maximize-changed', maximized)
  }
}

export function broadcastMeshStatus(win: BrowserWindow | null, status: MeshStatusInfo): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('nexus:mesh-update', status)
  }
}

export type { NexusApi }
