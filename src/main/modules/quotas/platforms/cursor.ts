// Cursor 平台集成。证据：cockpit-tools src-tauri/src/modules/cursor_account.rs
// - 本地导入: %APPDATA%/Cursor/User/globalStorage/state.vscdb (ItemTable)
//   keys: cursorAuth/accessToken, cursorAuth/cachedEmail, cursorAuth/refreshToken (read_local_cursor_auth)
// - 配额: CURSOR_USAGE_SUMMARY_URL = https://cursor.com/api/usage-summary (:1335)
//   Cookie: WorkosCursorSessionToken=<accessToken>%3A%3A<userId>（userId 取自 access token JWT sub，
//   build_session_cookie :1426）；401/403 → 会话过期
// - 解析: individualUsage.plan.totalPercentUsed / autoPercentUsed / apiPercentUsed
//   （read_usage_percent :1900，另支持 used/limit 比率与 planUsage 兜底）

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DiscoveredCredential, PlatformIntegration, PlatformQuota } from '../types'
import { QuotaAuthError } from '../types'
import type { QuotaWindow } from '@shared/quotas'
import { clampPercent, fetchJson, jwtPayload, pickNumber, pickString } from '../http'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

function stateVscdbPath(): string {
  const appdata = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return join(appdata, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}

function readVscdbItem(db: DatabaseSync, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as
      | { value: unknown }
      | undefined
    const v = row?.value
    if (typeof v !== 'string' || !v.trim()) return null
    return v
  } catch {
    return null
  }
}

export const integration: PlatformIntegration = {
  id: 'cursor',
  label: 'Cursor',

  async discoverLocalCredentials(): Promise<DiscoveredCredential[]> {
    const creds: DiscoveredCredential[] = []
    const dbPath = stateVscdbPath()
    try {
      if (!exists(dbPath)) return creds
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const accessToken = readVscdbItem(db, 'cursorAuth/accessToken')
        const email = readVscdbItem(db, 'cursorAuth/cachedEmail')
        if (!accessToken || !email) return creds
        creds.push({
          kind: 'oauth',
          accessToken,
          refreshToken: readVscdbItem(db, 'cursorAuth/refreshToken') ?? undefined,
          accountId: email,
          label: email,
          source: dbPath,
          expiresAt: null
        })
      } finally {
        db.close()
      }
    } catch {
      // 容错：未安装 Cursor / DB 被锁
    }
    return creds
  },

  async fetchQuota(cred: DiscoveredCredential): Promise<PlatformQuota> {
    const token = cred.accessToken ?? ''
    const payload = jwtPayload(token)
    const userId = typeof payload?.sub === 'string' ? payload.sub : ''
    const cookie = `WorkosCursorSessionToken=${encodeURIComponent(`${token}::${userId}`)}`
    const { status, body } = await fetchJson('https://cursor.com/api/usage-summary', {
      headers: {
        Accept: 'application/json',
        Cookie: cookie,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
      }
    })
    if (status === 401 || status === 403) {
      throw new QuotaAuthError('Cursor 会话已过期，请在 Cursor 内重新登录')
    }
    if (status !== 200) throw new Error(`usage-summary 返回 ${status}`)
    const obj = (body ?? {}) as Record<string, unknown>
    const plan =
      (obj.individualUsage as Record<string, unknown> | undefined)?.plan ??
      (obj.individual_usage as Record<string, unknown> | undefined)?.plan ??
      obj.planUsage ??
      obj.plan_usage
    const membership = pickString(obj, ['membershipType', 'membership_type']) ??
      pickString(plan, ['membershipType'])
    const windows: QuotaWindow[] = []
    const totalUsed = pickNumber(plan, ['totalPercentUsed', 'total_percent_used'])
    const autoUsed = pickNumber(plan, ['autoPercentUsed', 'auto_percent_used'])
    const apiUsed = pickNumber(plan, ['apiPercentUsed', 'api_percent_used'])
    const usedRaw = pickNumber(plan, ['used', 'totalSpend', 'total_spend'])
    const limitRaw = pickNumber(plan, ['limit'])
    const ratioUsed =
      usedRaw != null && limitRaw != null && limitRaw > 0 ? (usedRaw / limitRaw) * 100 : null
    const total = totalUsed ?? ratioUsed
    if (total != null) {
      windows.push({
        label: '套餐总量',
        usedPercent: clampPercent(total),
        remainingPercent: clampPercent(100 - total),
        resetAt: null
      })
    }
    if (autoUsed != null) {
      windows.push({
        label: 'Auto',
        usedPercent: clampPercent(autoUsed),
        remainingPercent: clampPercent(100 - autoUsed),
        resetAt: null
      })
    }
    if (apiUsed != null) {
      windows.push({
        label: 'API Keys',
        usedPercent: clampPercent(apiUsed),
        remainingPercent: clampPercent(100 - apiUsed),
        resetAt: null
      })
    }
    if (!windows.length) throw new Error('usage-summary 响应无可用窗口')
    return {
      planLabel: membership ?? undefined,
      windows,
      extra:
        usedRaw != null && limitRaw != null
          ? { usageText: `${Math.round(usedRaw)} / ${Math.round(limitRaw)}` }
          : undefined
    }
  }
}

function exists(p: string): boolean {
  try {
    
    return existsSync(p)
  } catch {
    return false
  }
}
