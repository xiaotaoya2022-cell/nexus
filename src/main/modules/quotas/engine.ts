// 配额引擎：平台注册、凭据存储（仅应用内 OAuth 会话）、轮询调度、缓存与视图。
// 红线：本地导入凭据只在内存使用不落库；token 永不进入视图/缓存/日志。

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AccountQuotaView,
  PlatformMetaView
} from '@shared/quotas'
import type { DiscoveredCredential, LoginMode, OAuthSession, PlatformIntegration } from './types'
import { QuotaAuthError } from './types'
import { logger } from '@main/modules/shared/logger'

const AUTH_FILE = 'quotas-auth.json'
const CACHE_FILE = 'quotas-cache.json'
const POLL_MS = 5 * 60_000

interface StoredAuth {
  version: 1
  sessions: Record<string, OAuthSession[]> // platform → sessions（应用内 OAuth 登录的才持久化）
}

interface StoredCache {
  version: 1
  views: Record<string, AccountQuotaView[]> // platform → views（无凭据字段，可安全落盘）
}

const EMPTY_VIEWS: Record<string, AccountQuotaView[]> = {}

/** 账号每日真实消耗落库回调（platform, accountId, rows） */
export type UsageSink = (platform: string, accountId: string, rows: import('@shared/quotas').AccountUsagePoint[]) => void

export class QuotaEngine {
  private integrations: PlatformIntegration[] = []
  private views: Record<string, AccountQuotaView[]> = {}
  private pollTimer: NodeJS.Timeout | null = null
  private refreshing = false
  /** 告警去重：account:window → 上次告警时间（6h 内不重复） */
  private lastAlertAt = new Map<string, number>()
  private onUsage?: UsageSink
  /** 查询某平台账号已采集的最早账单日（YYYY-MM-DD），用于 fetchUsage 增量起点 */
  private earliestDayQuery?: (platform: string, accountId: string) => string | null

  constructor(
    private readonly userDataDir: string,
    private readonly depsStoreSetting: (key: string) => string | null,
    private readonly onUpdate?: (views: AccountQuotaView[]) => void,
    private readonly onAlert?: (alert: { level: 'warn' | 'error'; title: string; body: string }) => void
  ) {
    this.views = this.loadCache().views ?? EMPTY_VIEWS
  }

  /** 注入账号用量落库通道（main 侧接 NexusStore.upsertAccountUsage）。 */
  setUsageSink(sink: UsageSink): void {
    this.onUsage = sink
  }

  /** 注入已采集最早日查询（main 侧接 NexusStore.earliestAccountUsageDay）。 */
  setEarliestDayQuery(q: (platform: string, accountId: string) => string | null): void {
    this.earliestDayQuery = q
  }

  registerIntegrations(list: PlatformIntegration[]): void {
    this.integrations = list
    // 清理已下线/改 id 平台的陈旧缓存视图（如 deepseek → deepseek-cn 拆分后的旧键）
    const known = new Set(list.map((p) => p.id))
    let pruned = false
    for (const key of Object.keys(this.views)) {
      if (!known.has(key)) {
        delete this.views[key]
        pruned = true
      }
    }
    if (pruned) this.saveCache()
  }

  // ── 持久化 ──
  private authPath(): string {
    return join(this.userDataDir, AUTH_FILE)
  }

  private loadAuth(): StoredAuth {
    try {
      if (!existsSync(this.authPath())) return { version: 1, sessions: {} }
      const parsed = JSON.parse(readFileSync(this.authPath(), 'utf8')) as StoredAuth
      const auth: StoredAuth =
        parsed.version === 1 && parsed.sessions ? parsed : { version: 1, sessions: {} }
      // 一次性迁移：deepseek → deepseek-cn（v0.2.7 平台拆分，保留既有登录态不强制重登）
      if (auth.sessions['deepseek']?.length) {
        auth.sessions['deepseek-cn'] = [
          ...(auth.sessions['deepseek-cn'] ?? []),
          ...auth.sessions['deepseek']
        ]
        delete auth.sessions['deepseek']
        this.saveAuth(auth)
      }
      return auth
    } catch {
      return { version: 1, sessions: {} }
    }
  }

  private saveAuth(auth: StoredAuth): void {
    try {
      writeFileSync(this.authPath(), JSON.stringify(auth), { encoding: 'utf8' })
      try {
        chmodSync(this.authPath(), 0o600)
      } catch {
        // Windows 上 chmod 语义有限，尽力而为
      }
    } catch (err) {
      logger.error('quota.auth_save_failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  private cachePath(): string {
    return join(this.userDataDir, CACHE_FILE)
  }

  private loadCache(): { version: 1; views: Record<string, AccountQuotaView[]> } {
    try {
      if (!existsSync(this.cachePath())) return { version: 1, views: {} }
      const parsed = JSON.parse(readFileSync(this.cachePath(), 'utf8')) as StoredCache
      return parsed.version === 1 && parsed.views ? parsed : { version: 1, views: {} }
    } catch {
      return { version: 1, views: {} }
    }
  }

  private saveCache(): void {
    try {
      writeFileSync(this.cachePath(), JSON.stringify({ version: 1, views: this.views } satisfies StoredCache), 'utf8')
    } catch {
      // 缓存写失败不影响内存视图
    }
    // 通知渲染层/远程订阅方（视图不含凭据，可安全推送）
    this.onUpdate?.(this.listAccounts())
  }

  // ── 查询 ──
  listPlatformMeta(): PlatformMetaView[] {
    const auth = this.loadAuth()
    return this.integrations.map((p) => ({
      id: p.id,
      label: p.label,
      oauthSupported: typeof p.oauthLogin === 'function',
      accountCount: (auth.sessions[p.id]?.length ?? 0) + (this.views[p.id]?.length ?? 0)
    }))
  }

  listAccounts(): AccountQuotaView[] {
    return Object.values(this.views).flat()
  }

  // ── 登录/登出 ──
  async login(platformId: string, mode: LoginMode = 'normal'): Promise<void> {
    const integration = this.integrations.find((p) => p.id === platformId)
    if (!integration?.oauthLogin) throw new Error('该平台未支持应用内登录，请先在对应 Agent 内登录后自动导入')
    const session = await integration.oauthLogin(mode)
    const auth = this.loadAuth()
    const list = auth.sessions[platformId] ?? []
    const filtered = list.filter((s) => s.accountId !== session.accountId)
    auth.sessions[platformId] = [...filtered, session]
    this.saveAuth(auth)
    logger.info('quota.login', { platform: platformId, account: session.accountId })
    await this.refreshPlatform(platformId)
  }

  logout(platformId: string, accountId: string): void {
    const auth = this.loadAuth()
    auth.sessions[platformId] = (auth.sessions[platformId] ?? []).filter((s) => s.accountId !== accountId)
    this.saveAuth(auth)
    this.views[platformId] = (this.views[platformId] ?? []).filter(
      (v) => !(v.source === 'oauth' && v.accountId === accountId)
    )
    this.saveCache()
  }

  // ── 刷新 ──
  async refreshNow(): Promise<AccountQuotaView[]> {
    if (this.refreshing) return this.listAccounts()
    this.refreshing = true
    try {
      for (const integration of this.integrations) {
        await this.refreshPlatform(integration.id)
      }
    } finally {
      this.refreshing = false
    }
    return this.listAccounts()
  }

  private async toCredential(session: OAuthSession): Promise<DiscoveredCredential> {
    return {
      kind: 'oauth',
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      accountId: session.accountId,
      label: session.label,
      source: 'nexus-oauth',
      expiresAt: session.expiresAt
    }
  }

  private async refreshPlatform(platformId: string): Promise<void> {
    const integration = this.integrations.find((p) => p.id === platformId)
    if (!integration) return
    const auth = this.loadAuth()
    const oauthSessions = auth.sessions[platformId] ?? []
    let localCreds: DiscoveredCredential[] = []
    try {
      localCreds = await integration.discoverLocalCredentials()
    } catch (err) {
      logger.warn('quota.discover_failed', {
        platform: platformId,
        error: err instanceof Error ? err.message : String(err)
      })
    }
    // 本地导入凭据去重：按 accountId+source
    const seen = new Set(oauthSessions.map((s) => s.accountId))
    const creds: DiscoveredCredential[] = [
      ...(await Promise.all(oauthSessions.map((s) => this.toCredential(s)))),
      ...localCreds.filter((c) => c.accountId == null || !seen.has(c.accountId))
    ]
    if (creds.length === 0) {
      delete this.views[platformId]
      this.saveCache()
      return
    }
    const views: AccountQuotaView[] = []
    for (const cred of creds) {
      const base: AccountQuotaView = {
        platform: platformId,
        platformLabel: integration.label,
        accountId: cred.accountId ?? cred.label,
        label: cred.label,
        source: cred.kind === 'oauth' && cred.source === 'nexus-oauth' ? 'oauth' : 'local',
        windows: [],
        fetchedAt: Date.now()
      }
      try {
        const quota = await this.fetchWithRefresh(integration, cred, platformId)
        views.push({ ...base, planLabel: quota.planLabel, windows: quota.windows, extra: quota.extra })
        this.checkAlerts(base, quota.windows)
        // 账号级每日真实消耗（如 DeepSeek 官方账单）→ 落库。
        // sinceDay=库内已采集最早日：全量回溯只在首采时发生，之后每轮覆盖最早日至今。
        if (typeof integration.fetchUsage === 'function') {
          try {
            const earliest = this.earliestDayQuery?.(platformId, base.accountId) ?? undefined
            const rows = await integration.fetchUsage(cred, earliest)
            if (rows.length > 0) this.onUsage?.(platformId, base.accountId, rows)
          } catch (usageErr) {
            logger.warn('quota.usage_failed', {
              platform: platformId,
              error: usageErr instanceof Error ? usageErr.message : String(usageErr)
            })
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn('quota.fetch_failed', { platform: platformId, error: message })
        views.push({ ...base, windows: [], error: message })
      }
    }
    this.views[platformId] = views
    this.saveCache()
  }

  /** 拉配额；401/403 且有 refresh 能力时刷新凭据重试一次，并回写 OAuth 会话。 */
  private async fetchWithRefresh(
    integration: PlatformIntegration,
    cred: DiscoveredCredential,
    platformId: string
  ) {
    try {
      return await integration.fetchQuota(cred)
    } catch (err) {
      const isAuth =
        err instanceof QuotaAuthError &&
        typeof integration.refreshCredential === 'function' &&
        !!cred.refreshToken
      if (!isAuth) throw err
      const refreshed = await integration.refreshCredential!(cred)
      const quota = await integration.fetchQuota(refreshed)
      if (cred.source === 'nexus-oauth') {
        const auth = this.loadAuth()
        auth.sessions[platformId] = (auth.sessions[platformId] ?? []).map((s) =>
          s.accountId === cred.accountId
            ? {
                ...s,
                accessToken: refreshed.accessToken ?? s.accessToken,
                refreshToken: refreshed.refreshToken ?? s.refreshToken
              }
            : s
        )
        this.saveAuth(auth)
      }
      return quota
    }
  }

  /** 阈值告警（settings.quotaAlertThreshold，默认 90；≥100 固定 error），同账号同窗口 6h 内不重复。 */
  private checkAlerts(base: AccountQuotaView, windows: { label: string; usedPercent: number | null }[]): void {
    const thresholdRaw = Number(this.depsStoreSetting('quotaAlertThreshold') ?? 90)
    const threshold = Number.isFinite(thresholdRaw) && thresholdRaw > 0 ? thresholdRaw : 90
    for (const w of windows) {
      const used = w.usedPercent
      if (used == null) continue
      const level: 'warn' | 'error' | null = used >= 100 ? 'error' : used >= threshold ? 'warn' : null
      if (!level) continue
      const key = `${base.platform}:${base.accountId}:${w.label}`
      const last = this.lastAlertAt.get(key) ?? 0
      if (Date.now() - last < 6 * 3600_000) continue
      this.lastAlertAt.set(key, Date.now())
      this.onAlert?.({
        level,
        title: `${base.platformLabel} 配额告警`,
        body: `${base.label} 的「${w.label}」已用 ${used}%${used >= 100 ? '（已用尽）' : ''}`
      })
    }
  }

  // ── 轮询 ──
  startPolling(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      void this.refreshNow().catch(() => {})
    }, POLL_MS)
    // 首轮延迟 3s，避免与启动同步抢 IO
    setTimeout(() => {
      void this.refreshNow().catch(() => {})
    }, 3000)
  }

  stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }
}
