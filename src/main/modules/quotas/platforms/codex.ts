// Codex 平台集成。证据：cockpit-tools crates/cockpit-core/src/modules/codex_quota.rs + codex_oauth.rs
// - 配额: USAGE_URL = https://chatgpt.com/backend-api/wham/usage (codex_quota.rs:10)
//   Bearer + 可选 ChatGPT-Account-Id 头（codex_quota.rs:141-170）
//   解析: plan_type + rate_limit.primary_window/secondary_window
//   (WindowInfo: used_percent / reset_at / reset_after_seconds)
// - OAuth: CLIENT_ID app_EMoamEEZ73f0CkXaXp7hrann（codex_oauth.rs:16）
//   authorize https://auth.openai.com/oauth/authorize（:17）、
//   令牌交换 https://auth.openai.com/oauth/token（:18，grant_type
//   authorization_code/refresh_token，响应 id_token/access_token/refresh_token :908-928）
//   SCOPES（:19）、PKCE S256（:123）、回环 http://localhost:<port>/auth/callback（:603）
// 凭据来源：~/.codex/auth.json（CLI 本地登录）与应用内 OAuth 会话。

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DiscoveredCredential, OAuthSession, PlatformIntegration, PlatformQuota } from '../types'
import { QuotaAuthError } from '../types'
import type { QuotaWindow } from '@shared/quotas'
import { clampPercent, fetchJson, jwtPayload, parseTimeLoose, readJsonFile } from '../http'
import { base64urlToken, runLoopbackOAuth, s256Challenge } from '../oauth'

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

// OAuth 端点与参数（cockpit codex_oauth.rs:16-19；公开客户端 ID，非秘密）
const OAUTH = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authorize: 'https://auth.openai.com/oauth/authorize',
  tokenExchange: 'https://auth.openai.com/oauth/token',
  scopes: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
  originator: 'Codex Desktop'
} as const

interface CodexWindowRaw {
  used_percent?: number
  limit_window_seconds?: number
  reset_after_seconds?: number
  reset_at?: number
}

interface CodexUsageResponse {
  plan_type?: string
  rate_limit?: {
    primary_window?: CodexWindowRaw
    secondary_window?: CodexWindowRaw
  }
  code_review_rate_limit?: unknown
}

function parseWindow(raw: CodexWindowRaw | undefined, label: string): QuotaWindow | null {
  if (!raw) return null
  const usedPercent =
    typeof raw.used_percent === 'number' ? clampPercent(raw.used_percent) : null
  let resetAt: number | null = parseTimeLoose(raw.reset_at)
  if (resetAt == null && typeof raw.reset_after_seconds === 'number' && raw.reset_after_seconds >= 0) {
    resetAt = Date.now() + raw.reset_after_seconds * 1000
  }
  if (usedPercent == null && resetAt == null) return null
  return {
    label,
    usedPercent,
    remainingPercent: usedPercent != null ? clampPercent(100 - usedPercent) : null,
    resetAt
  }
}

export const integration: PlatformIntegration = {
  id: 'codex',
  label: 'Codex',

  async discoverLocalCredentials(): Promise<DiscoveredCredential[]> {
    const creds: DiscoveredCredential[] = []
    // Codex CLI 本地登录（auth.json）：OAuth token 或 API Key
    try {
      const auth = readJsonFile<Record<string, unknown>>(join(homedir(), '.codex', 'auth.json'))
      if (auth) {
        const tokens = auth.tokens as Record<string, unknown> | undefined
        const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token : null
        const accountId = typeof auth.account_id === 'string' ? auth.account_id : null
        if (accessToken) {
          const payload = jwtPayload(accessToken)
          const chatgptAccountId =
            accountId ??
            ((payload?.['https://api.openai.com/auth'] as Record<string, unknown> | undefined)
              ?.chatgpt_account_id as string | undefined) ??
            null
          creds.push({
            kind: 'oauth',
            accessToken,
            refreshToken: typeof tokens?.refresh_token === 'string' ? tokens.refresh_token : undefined,
            accountId: chatgptAccountId ?? 'codex-cli',
            label: 'Codex CLI 登录',
            source: join(homedir(), '.codex', 'auth.json'),
            expiresAt: null
          })
        } else if (typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY) {
          creds.push({
            kind: 'apikey',
            accessToken: auth.OPENAI_API_KEY,
            accountId: 'codex-apikey',
            label: 'Codex CLI (API Key)',
            source: join(homedir(), '.codex', 'auth.json'),
            expiresAt: null
          })
        }
      }
    } catch {
      // 容错：未安装 Codex / 文件不可读
    }
    return creds
  },

  /** 应用内 OAuth（PKCE + 回环回调，cockpit codex_oauth.rs 流程）。
   * 注意：~/.codex/auth.json 若已有 OAuth tokens，本地导入即可用，无需再登录。 */
  async oauthLogin(): Promise<OAuthSession> {
    const verifier = base64urlToken()
    const challenge = s256Challenge(verifier)
    const state = base64urlToken()
    const { code, redirectUri } = await runLoopbackOAuth({
      redirectUriBase: 'http://localhost:0/auth/callback',
      expectedState: state,
      buildAuthUrl: (redirectUri) =>
        // build_auth_url（codex_oauth.rs:543-554）
        `${OAUTH.authorize}?response_type=code&client_id=${OAUTH.clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(OAUTH.scopes)}&code_challenge=${challenge}&code_challenge_method=S256&id_token_add_organizations=true&codex_cli_simplified_flow=true&state=${state}&originator=${encodeURIComponent(OAUTH.originator)}`
    })
    // 令牌交换（exchange_code_for_token_internal：form 表单，含 client_id）
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: OAUTH.clientId,
      code_verifier: verifier
    })
    const { status, body } = await fetchJson(OAUTH.tokenExchange, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString()
    })
    if (status !== 200) throw new Error(`令牌交换失败 status=${status}`)
    const tokens = body as Record<string, unknown>
    const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : null
    if (!accessToken) throw new Error('令牌响应缺少 access_token')
    const payload = jwtPayload(accessToken)
    const authClaim = payload?.['https://api.openai.com/auth'] as Record<string, unknown> | undefined
    const accountId =
      (typeof authClaim?.chatgpt_account_id === 'string' ? authClaim.chatgpt_account_id : null) ??
      (typeof payload?.sub === 'string' ? payload.sub : 'codex-oauth')
    const email = typeof payload?.email === 'string' ? payload.email : 'Codex 账号'
    return {
      accountId,
      label: email,
      accessToken,
      refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : undefined,
      expiresAt: null
    }
  },

  /** 刷新令牌（grant_type=refresh_token，cockpit codex_oauth.rs 刷新分支） */
  async refreshCredential(cred: DiscoveredCredential): Promise<DiscoveredCredential> {
    if (!cred.refreshToken) throw new QuotaAuthError('无 refresh_token，请重新登录')
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: cred.refreshToken,
      client_id: OAUTH.clientId
    })
    const { status, body } = await fetchJson(OAUTH.tokenExchange, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString()
    })
    if (status !== 200) throw new QuotaAuthError(`刷新失败 status=${status}`)
    const tokens = body as Record<string, unknown>
    const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : null
    if (!accessToken) throw new QuotaAuthError('刷新响应缺少 access_token')
    return {
      ...cred,
      accessToken,
      refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : cred.refreshToken
    }
  },

  async fetchQuota(cred: DiscoveredCredential): Promise<PlatformQuota> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${cred.accessToken ?? ''}`,
      Accept: 'application/json'
    }
    if (cred.accountId && cred.accountId !== 'codex-apikey') {
      headers['ChatGPT-Account-Id'] = cred.accountId
    }
    const { status, body } = await fetchJson(USAGE_URL, { headers })
    if (status === 401 || status === 403) {
      throw new QuotaAuthError(
        cred.kind === 'apikey'
          ? 'API Key 不能查询订阅配额（wham/usage 需 OAuth 登录态）'
          : 'Codex 登录态已过期，请重新登录'
      )
    }
    if (status !== 200) throw new Error(`wham/usage 返回 ${status}`)
    const usage = body as CodexUsageResponse
    const windows: QuotaWindow[] = []
    const primary = parseWindow(usage.rate_limit?.primary_window, '5 小时窗口')
    if (primary) windows.push(primary)
    const secondary = parseWindow(usage.rate_limit?.secondary_window, '每周')
    if (secondary) windows.push(secondary)
    if (!windows.length) throw new Error('wham/usage 响应无可用窗口')
    return {
      planLabel: usage.plan_type ?? undefined,
      windows,
      extra:
        usage.code_review_rate_limit != null ? { codeReview: '有独立限流' } : undefined
    }
  }
}
