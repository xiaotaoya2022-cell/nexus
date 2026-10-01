// CodeBuddy 平台集成工厂：国内版（www.codebuddy.cn）与国际版（www.codebuddy.ai）共用。
// 证据：cockpit-tools src-tauri/src/modules/codebuddy_cn_oauth.rs 与 codebuddy_oauth.rs
// 两文件除 ENDPOINT 外完全同构：
// - 登录: POST {ENDPOINT}/v2/plugin/auth/state?platform=ide（头 X-No-Authorization 等）
//   → data.state + auth_url → 浏览器完成授权 → 轮询 GET /v2/plugin/auth/token?state=
//   （1.5s 间隔），响应 data.accessToken/uid/email/refreshToken
// - 配额: POST {ENDPOINT}/v2/billing/meter/get-user-resource（ProductCode=p_tcaca）
// - 登录模式：normal=系统浏览器；incognito=应用内独立窗口（非持久分区，不影响已登录态，
//   用于登录第二个账号/切换版本）。

import { BrowserWindow, session as electronSession, shell } from 'electron'
import type {
  AccountUsagePoint,
  DiscoveredCredential,
  LoginMode,
  OAuthSession,
  PlatformIntegration,
  PlatformQuota
} from '../types'
import { QuotaAuthError } from '../types'
import type { QuotaWindow } from '@shared/quotas'
import { fetchJson, parseTimeLoose, pickNumber, pickString } from '../http'
import { fetchRequestUsageDaily } from './request-usage'

const API_PREFIX = '/v2/plugin'
const LOGIN_POLL_MS = 1500
const LOGIN_TIMEOUT_MS = 5 * 60_000

export interface CodeBuddyConfig {
  id: string
  label: string
  endpoint: string
  /** 错误文案/账号兜底名里的显示名（如 "CodeBuddy CN"） */
  displayName: string
}

interface ResourceAccount {
  PackageName?: string
  PackageCode?: string
  CycleCapacitySize?: number | string
  CycleCapacityRemain?: number | string
  CycleCapacityUsed?: number | string
  CapacityUnit?: string
  CycleResetTime?: string
  Unlimited?: boolean
}

function findAccounts(body: unknown): ResourceAccount[] {
  const paths = [
    'data/resources',
    'data/data/resources',
    'data/Response/Data/Accounts',
    'data/data/Response/Data/Accounts',
    'Response/Data/Accounts'
  ]
  let node: unknown = body
  for (const key of paths.flatMap((p) => p.split('/'))) {
    if (!key) continue
    if (node != null && typeof node === 'object' && key in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[key]
    } else {
      return []
    }
  }
  return Array.isArray(node) ? (node as ResourceAccount[]) : []
}

function fmtLocal(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 无痕登录窗口：非持久分区（内存态，关窗即弃），不污染系统浏览器与已持久会话。
 *  置顶：Windows 前台锁会把后台进程的窗口压到主窗口后面（用户视角="没反应"）。 */
function openIncognitoWindow(url: string, title: string, id: string): BrowserWindow {
  const partition = `incognito-login-${id}-${Date.now()}`
  const win = new BrowserWindow({
    show: true,
    width: 1020,
    height: 720,
    autoHideMenuBar: true,
    alwaysOnTop: true,
    title,
    webPreferences: {
      session: electronSession.fromPartition(partition), // 无 persist: 前缀 = 纯内存
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.show()
  win.focus()
  void win.loadURL(url)
  return win
}

export function createCodeBuddyIntegration(cfg: CodeBuddyConfig): PlatformIntegration {
  const { id, label, endpoint, displayName } = cfg
  return {
    id,
    label,

    async discoverLocalCredentials(): Promise<DiscoveredCredential[]> {
      // 官方 IDE 登录态在云端/加密存储，本地无明文凭据可导入；走应用内登录。
      return []
    },

    /** OAuth：auth/state → 打开登录页（普通=系统浏览器 / 无痕=应用内窗口）→ 轮询 auth/token。 */
    async oauthLogin(mode: LoginMode = 'normal'): Promise<OAuthSession> {
      const stateRes = await fetchJson(`${endpoint}${API_PREFIX}/auth/state?platform=ide`, {
        method: 'POST',
        headers: {
          'X-No-Authorization': 'true',
          'X-No-User-Id': 'true',
          'X-No-Enterprise-Id': 'true',
          'X-No-Department-Info': 'true'
        },
        body: JSON.stringify({})
      })
      if (stateRes.status !== 200) throw new Error(`auth/state 返回 ${stateRes.status}`)
      const stateData = (stateRes.body as { data?: Record<string, unknown> })?.data
      const state = typeof stateData?.state === 'string' ? stateData.state : null
      const authUrl =
        pickString(stateData, ['auth_url', 'url', 'authUrl']) ??
        pickString(stateData, ['loginUrl', 'login_url'])
      if (!state || !authUrl) throw new Error('auth/state 响应缺少 state/auth_url')

      let win: BrowserWindow | null = null
      if (mode === 'incognito') {
        win = openIncognitoWindow(authUrl, `登录 ${displayName}（无痕）`, id)
      } else {
        await shell.openExternal(authUrl)
      }

      try {
        // 轮询 auth/token 直到完成（complete_login，1.5s 间隔）
        const deadline = Date.now() + LOGIN_TIMEOUT_MS
        for (;;) {
          if (Date.now() > deadline) throw new Error(`${displayName} 登录超时（5 分钟）`)
          await new Promise((r) => setTimeout(r, LOGIN_POLL_MS))
          const tokenRes = await fetchJson(`${endpoint}${API_PREFIX}/auth/token?state=${encodeURIComponent(state)}`)
          if (tokenRes.status !== 200) continue // 未完成/瞬态错误继续轮询
          const data = (tokenRes.body as { data?: Record<string, unknown> })?.data
          const accessToken = pickString(data, ['accessToken']) ?? pickString(data, ['access_token']) ?? null
          if (!accessToken) continue
          const uid = pickString(data, ['uid', 'userId', 'user_id'])
          const email = pickString(data, ['email'])
          return {
            accountId: uid ?? email ?? id,
            label: email ?? uid ?? `${displayName} 账号`,
            accessToken,
            refreshToken: pickString(data, ['refreshToken', 'refresh_token']) ?? undefined,
            expiresAt: null
          } satisfies OAuthSession
        }
      } finally {
        if (win != null && !win.isDestroyed()) win.destroy()
      }
    },

    async fetchQuota(cred: DiscoveredCredential): Promise<PlatformQuota> {
      const now = new Date()
      const end = new Date(now.getTime() + 365 * 101 * 86400_000)
      const { status, body } = await fetchJson(`${endpoint}/v2/billing/meter/get-user-resource`, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Authorization: `Bearer ${cred.accessToken ?? ''}`,
          'Content-Type': 'application/json',
          ...(cred.accountId ? { 'X-User-Id': cred.accountId } : {})
        },
        body: JSON.stringify({
          PageNumber: 1,
          PageSize: 100,
          ProductCode: 'p_tcaca',
          Status: [0, 3],
          PackageEndTimeRangeBegin: fmtLocal(now),
          PackageEndTimeRangeEnd: fmtLocal(end)
        })
      })
      if (status === 401 || status === 403) {
        throw new QuotaAuthError(`${displayName} 登录态已过期，请重新登录`)
      }
      if (status !== 200) throw new Error(`get-user-resource 返回 ${status}`)
      const accounts = findAccounts(body)
      if (!accounts.length) throw new Error('user resource 响应未包含可用资源')
      const windows: QuotaWindow[] = []
      for (const a of accounts) {
        const size = pickNumber(a, ['CycleCapacitySize', 'CapacitySize'])
        const remain = pickNumber(a, ['CycleCapacityRemain', 'CapacityRemain'])
        const used = pickNumber(a, ['CycleCapacityUsed', 'CapacityUsed'])
        const unlimited = a.Unlimited === true
        const percent =
          unlimited || size == null ? null : size > 0 ? ((size - (remain ?? 0)) / size) * 100 : null
        windows.push({
          label: pickString(a, ['PackageName', 'PackageCode']) ?? '套餐',
          usedPercent: percent != null ? Math.max(0, Math.min(100, Math.round(percent * 10) / 10)) : null,
          remainingPercent: unlimited ? null : percent != null ? 100 - Math.round(percent * 10) / 10 : null,
          resetAt: parseTimeLoose(a.CycleResetTime)
        })
        void used
      }
      if (!windows.length) throw new Error('配额资源解析为空')
      return { windows }
    },

    /** 云端逐请求用量（31 天窗口，credit 口径）。 */
    async fetchUsage(cred: DiscoveredCredential): Promise<AccountUsagePoint[]> {
      return fetchRequestUsageDaily([endpoint], cred.accessToken ?? '', cred.accountId)
    }
  }
}
