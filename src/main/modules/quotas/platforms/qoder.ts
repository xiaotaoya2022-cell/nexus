// Qoder 平台集成。证据：cockpit-tools src-tauri/src/modules/qoder_oauth.rs
// - 设备登录：nonce 自生成，登录页 https://qoder.com/device/selectAccounts?nonce=&challenge=
//   &challenge_method=S256&redirect_uri=<ide 回调>（build_cli_device_login_url :148）
//   challenge = sha256(nonce) 十六进制（同款 S256 风格）
// - 轮询: GET https://openapi.qoder.sh/api/v1/deviceToken/poll?nonce=（:23,571）
//   响应含 token 字段
// - 配额: IDE 内配额存 DPAPI 加密的 secret storage（qoder_account.rs:14-15
//   secret://aicoding.auth.userPlan / creditUsage），解密链需 DPAPI——本批以
//   device token 接入 openapi 为准，DPAPI 路线下批评估（报告已记录）。
// 凭据：本地导入返回 []（IDE 登录态加密），走应用内设备码登录。

import { createHash, randomBytes } from 'node:crypto'
import { shell } from 'electron'
import type { DiscoveredCredential, OAuthSession, PlatformIntegration, PlatformQuota } from '../types'
import { QuotaAuthError } from '../types'
import { fetchJson, pickString } from '../http'

const LOGIN_BASE = 'https://qoder.com/device/selectAccounts'
const OPENAPI = 'https://openapi.qoder.sh'
const POLL_PATH = '/api/v1/deviceToken/poll'
const LOGIN_TIMEOUT_MS = 5 * 60_000
const POLL_MS = 2000

export const integration: PlatformIntegration = {
  id: 'qoder',
  label: 'Qoder',

  async discoverLocalCredentials(): Promise<DiscoveredCredential[]> {
    return []
  },

  /** 设备码登录：nonce 挑选账号授权，本端轮询 openapi 换 token。 */
  async oauthLogin(): Promise<OAuthSession> {
    const nonce = randomBytes(16).toString('hex')
    const challenge = createHash('sha256').update(nonce).digest('hex')
    const loginUrl = `${LOGIN_BASE}?nonce=${nonce}&challenge=${challenge}&challenge_method=S256`
    await shell.openExternal(loginUrl)

    const deadline = Date.now() + LOGIN_TIMEOUT_MS
    for (;;) {
      if (Date.now() > deadline) throw new Error('Qoder 登录超时（5 分钟）')
      await new Promise((r) => setTimeout(r, POLL_MS))
      const res = await fetchJson(`${OPENAPI}${POLL_PATH}?nonce=${encodeURIComponent(nonce)}`)
      if (res.status !== 200) continue
      const token = pickString(res.body, ['token', 'access_token'])
      if (!token) continue
      return {
        accountId: pickString(res.body, ['user_id', 'uid', 'email']) ?? 'qoder-device',
        label: pickString(res.body, ['email', 'nickname']) ?? 'Qoder 账号',
        accessToken: token,
        refreshToken: pickString(res.body, ['refresh_token']) ?? undefined,
        expiresAt: null
      }
    }
  },

  async fetchQuota(cred: DiscoveredCredential): Promise<PlatformQuota> {
    // openapi 侧配额端点待官方暴露；当前以 token 有效性探测（401 → 需重登）
    const res = await fetchJson(`${OPENAPI}/api/v1/user/info`, {
      headers: { Authorization: `Bearer ${cred.accessToken ?? ''}`, Accept: 'application/json' }
    }).catch(() => null)
    if (!res) throw new Error('Qoder openapi 不可达')
    if (res.status === 401 || res.status === 403) {
      throw new QuotaAuthError('Qoder 登录态已过期，请重新登录')
    }
    if (res.status !== 200) throw new Error(`Qoder user/info 返回 ${res.status}`)
    throw new QuotaAuthError('Qoder 配额窗口字段待官方接口暴露（token 已有效）')
  }
}
