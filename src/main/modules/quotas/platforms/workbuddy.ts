// WorkBuddy 平台集成。证据：cockpit-tools src-tauri/src/modules/workbuddy_oauth.rs
// - 登录: GET {WORKBUDDY_API_ENDPOINT=https://copilot.tencent.com}/login?state=<state>（:231）
//   打开浏览器完成授权
// - 轮询: GET {ENDPOINT}/auth/token?state=（:298）
//   响应 data.accessToken / data.refreshToken / data.expires_at / data.domain / data.tokenType
// 配额/用量路径在 cockpit 中未见专用端点（账号内含 tokenType/domain 等字段），本批先接
// 登录 + 会话有效性探测，配额窗口待路径定位（报告已记录）。
// 凭据：本地导入返回 []（登录态在云端），走应用内 OAuth。

import { randomBytes } from 'node:crypto'
import { shell } from 'electron'
import type { DiscoveredCredential, OAuthSession, PlatformIntegration, PlatformQuota } from '../types'
import { QuotaAuthError } from '../types'
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

  /** 应用内 OAuth（cockpit workbuddy_oauth.rs：login?state= → 浏览器 → 轮询 auth/token）。 */
  async oauthLogin(): Promise<OAuthSession> {
    const state = randomBytes(16).toString('hex')
    await shell.openExternal(`${ENDPOINT}/login?state=${state}`)
    const deadline = Date.now() + LOGIN_TIMEOUT_MS
    for (;;) {
      if (Date.now() > deadline) throw new Error('WorkBuddy 登录超时（5 分钟）')
      await new Promise((r) => setTimeout(r, POLL_MS))
      const res = await fetchJson(`${ENDPOINT}/auth/token?state=${encodeURIComponent(state)}`)
      if (res.status !== 200) continue
      const data = (res.body as { data?: Record<string, unknown> })?.data
      const accessToken = pickString(data, ['accessToken', 'access_token'])
      if (!accessToken) continue
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
  }
}
