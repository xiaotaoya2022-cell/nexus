// WorkBuddy 平台集成。证据：cockpit-tools src-tauri/src/modules/workbuddy_oauth.rs
// - 登录: GET {WORKBUDDY_API_ENDPOINT=https://copilot.tencent.com}/login?state=<state>（:231）
//   打开浏览器完成授权
// - 轮询: GET {ENDPOINT}/auth/token?state=（:298）
//   响应 data.accessToken / data.refreshToken / data.expires_at / data.domain / data.tokenType
// 配额/用量路径在 cockpit 中未见专用端点（账号内含 tokenType/domain 等字段），本批先接
// 登录 + 会话有效性探测，配额窗口待路径定位（报告已记录）。
// 凭据：本地导入返回 []（登录态在云端），走应用内 OAuth。

import { randomBytes } from 'node:crypto'
import { BrowserWindow, session as electronSession, shell } from 'electron'
import type { DiscoveredCredential, LoginMode, OAuthSession, PlatformIntegration, PlatformQuota } from '../types'
import type { AccountUsagePoint } from '../types'
import { QuotaAuthError } from '../types'
import { fetchRequestUsageDaily } from './request-usage'
import { fetchJson, pickString } from '../http'

const ENDPOINT = 'https://copilot.tencent.com'
const LOGIN_TIMEOUT_MS = 5 * 60_000
const POLL_MS = 1500

export const integration: PlatformIntegration = {
  id: 'workbuddy',
  label: 'WorkBuddy',

  async discoverLocalCredentials(): Promise<DiscoveredCredential[]> {
    return []
  },

  /** 应用内 OAuth（cockpit workbuddy_oauth.rs：login?state= → 浏览器 → 轮询 auth/token）。
   *  incognito=应用内无痕窗口，适合登录第二个账号。 */
  async oauthLogin(mode: LoginMode = 'normal'): Promise<OAuthSession> {
    const state = randomBytes(16).toString('hex')
    const loginUrl = `${ENDPOINT}/login?state=${state}`
    let win: BrowserWindow | null = null
    if (mode === 'incognito') {
      win = new BrowserWindow({
        show: true,
        width: 1020,
        height: 720,
        autoHideMenuBar: true,
        alwaysOnTop: true, // 前台锁：防被主窗口压住
        title: '登录 WorkBuddy（无痕）',
        webPreferences: {
          session: electronSession.fromPartition(`incognito-login-workbuddy-${Date.now()}`),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      })
      win.show()
      win.focus()
      void win.loadURL(loginUrl)
    } else {
      await shell.openExternal(loginUrl)
    }
    const deadline = Date.now() + LOGIN_TIMEOUT_MS
    for (;;) {
      if (Date.now() > deadline) {
        if (win != null && !win.isDestroyed()) win.destroy()
        throw new Error('WorkBuddy 登录超时（5 分钟）')
      }
      await new Promise((r) => setTimeout(r, POLL_MS))
      const res = await fetchJson(`${ENDPOINT}/auth/token?state=${encodeURIComponent(state)}`)
      if (res.status !== 200) continue
      const data = (res.body as { data?: Record<string, unknown> })?.data
      const accessToken = pickString(data, ['accessToken', 'access_token'])
      if (!accessToken) continue
      if (win != null && !win.isDestroyed()) win.destroy()
      const expiresAt = Number(data?.expires_at ?? data?.expiresAt) || null
      return {
        accountId: pickString(data, ['uid', 'userId', 'email']) ?? 'workbuddy',
        label: pickString(data, ['email', 'nickname']) ?? 'WorkBuddy 账号',
        accessToken,
        refreshToken: pickString(data, ['refreshToken', 'refresh_token']) ?? undefined,
        expiresAt: expiresAt && expiresAt > 1e12 ? expiresAt : expiresAt && expiresAt > 1e9 ? expiresAt * 1000 : null
      }
    }
  },

  async fetchQuota(cred: DiscoveredCredential): Promise<PlatformQuota> {
    // 会话有效性探测（配额窗口路径待 cockpit 生态定位后移植）
    const res = await fetchJson(`${ENDPOINT}/api/user/info`, {
      headers: { Authorization: `Bearer ${cred.accessToken ?? ''}`, Accept: 'application/json' }
    }).catch(() => null)
    if (!res) throw new Error('WorkBuddy API 不可达')
    if (res.status === 401 || res.status === 403) {
      throw new QuotaAuthError('WorkBuddy 登录态已过期，请重新登录')
    }
    if (res.status !== 200) throw new Error(`user/info 返回 ${res.status}`)
    throw new QuotaAuthError('WorkBuddy 配额窗口字段待端点定位（token 已有效）')
  },

  /** 云端逐请求用量（31 天窗口，credit 口径）。令牌域需一致，按序尝试多个域名。 */
  async fetchUsage(cred: DiscoveredCredential): Promise<AccountUsagePoint[]> {
    return fetchRequestUsageDaily(
      ['https://www.workbuddy.cn', ENDPOINT, 'https://www.codebuddy.cn'],
      cred.accessToken ?? '',
      cred.accountId
    )
  }
}
