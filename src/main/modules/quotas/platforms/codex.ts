// Codex 平台集成。证据：cockpit-tools crates/cockpit-core/src/modules/codex_quota.rs
// - 端点: USAGE_URL = https://chatgpt.com/backend-api/wham/usage (codex_quota.rs:10)
// - 头: Authorization Bearer + 可选 ChatGPT-Account-Id (codex_quota.rs:141-170)
// - 解析: plan_type + rate_limit.primary_window/secondary_window
//        (WindowInfo: used_percent / reset_at / reset_after_seconds, codex_quota.rs struct 段)
// 凭据来源：~/.codex/auth.json（Codex CLI 本地登录；本机为 API Key 模式——
// wham/usage 需订阅 OAuth token，API Key 会被上游 401 → 引擎显示需 OAuth 登录）。

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DiscoveredCredential, PlatformIntegration, PlatformQuota } from '../types'
import { QuotaAuthError } from '../types'
import type { QuotaWindow } from '@shared/quotas'
import { clampPercent, fetchJson, jwtPayload, parseTimeLoose, readJsonFile } from '../http'

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

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
