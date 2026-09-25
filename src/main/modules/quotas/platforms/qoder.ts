// Qoder 平台集成。证据：cockpit-tools src-tauri/src/modules/qoder_oauth.rs + qoder_account.rs
// - 设备登录: nonce 自生成，登录页 https://qoder.com/device/selectAccounts?nonce=&challenge=
//   &challenge_method=S256（build_cli_device_login_url :148）
//   轮询: GET https://openapi.qoder.sh/api/v1/deviceToken/poll?nonce=（:23,571）
// - 本机配额: user-data-dir 的 state.vscdb ItemTable
//   secret://aicoding.auth.userPlan / creditUsage（qoder_account.rs:14-15）
//   值为 VS Code v10 AES-256-GCM（DPAPI os_crypt 链，vscode_inject.rs:153+；解密见 ../dpapi）
// 无本地数据/未登录时返回空（不报错），登录或数据出现即自动接入。

import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve, sep } from 'node:path'
import { join } from 'node:path'
import { shell } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import type { DiscoveredCredential, OAuthSession, PlatformIntegration, PlatformQuota } from '../types'
import { QuotaAuthError } from '../types'
import type { QuotaWindow } from '@shared/quotas'
import { fetchJson, pickNumber, pickString } from '../http'
import { decryptSecretValue } from '../dpapi'

const LOGIN_BASE = 'https://qoder.com/device/selectAccounts'
const OPENAPI = 'https://openapi.qoder.sh'
const POLL_PATH = '/api/v1/deviceToken/poll'
const LOGIN_TIMEOUT_MS = 5 * 60_000
const POLL_MS = 2000

const KEY_CREDIT_USAGE = 'secret://aicoding.auth.creditUsage'

/** 白名单内定位 Qoder user-data（候选均为 Roaming 下已知安装名） */
function stateDbPath(): string | null {
  const appdata = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  for (const name of ['Qoder', 'com.qodercn.app.stable', 'Qoder CN']) {
    const root = resolve(appdata, name)
    if (!isAbsolute(root) || !root.startsWith(resolve(appdata) + sep)) continue
    const p = join(root, 'User', 'globalStorage', 'state.vscdb')
    if (existsSync(p)) return p
  }
  return null
}

function readItem(db: DatabaseSync, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as
      | { value: unknown }
      | undefined
    return typeof row?.value === 'string' ? row.value : null
  } catch {
    return null
  }
}

/** 读本地 creditUsage 并解密解析（无数据/解密失败返回 null）。 */
async function readLocalQuota(dbPath: string): Promise<{ windows: QuotaWindow[] } | null> {
  const dataRoot = resolve(dbPath, '..', '..', '..')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const raw = readItem(db, KEY_CREDIT_USAGE)
    const json = raw ? await decryptSecretValue(dataRoot, raw) : null
    if (!json) return null
    const obj = JSON.parse(json) as Record<string, unknown>
    const total = pickNumber(obj, ['totalCredit', 'total', 'creditLimit', 'limit'])
    const used = pickNumber(obj, ['usedCredit', 'used', 'creditUsed'])
    const remain = pickNumber(obj, ['remainingCredit', 'remain', 'creditRemaining'])
    const pct =
      total != null && total > 0 ? ((total - (remain ?? total - (used ?? 0))) / total) * 100 : null
    const windows: QuotaWindow[] = [
      {
        label: 'Credit 额度',
        usedPercent: pct != null ? Math.max(0, Math.min(100, Math.round(pct * 10) / 10)) : null,
        remainingPercent: remain != null ? remain : null,
        resetAt: null
      }
    ]
    return { windows }
  } finally {
    db.close()
  }
}

export const integration: PlatformIntegration = {
  id: 'qoder',
  label: 'Qoder',

  async discoverLocalCredentials(): Promise<DiscoveredCredential[]> {
    const creds: DiscoveredCredential[] = []
    const dbPath = stateDbPath()
    if (!dbPath) return creds
    try {
      // 探测本地数据可用性（解密成功即视为一个可读账号）
      const quota = await readLocalQuota(dbPath)
      if (quota) {
        creds.push({
          kind: 'oauth',
          accessToken: '',
          accountId: 'qoder-local',
          label: 'Qoder（本机导入）',
          source: dbPath,
          expiresAt: null
        })
      }
    } catch {
      // DPAPI 失败/库被锁 → 空
    }
    return creds
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
    // 本机导入路径：creditUsage 解密
    const dbPath = stateDbPath()
    if (dbPath && cred.source === dbPath) {
      try {
        const quota = await readLocalQuota(dbPath)
        if (quota) return quota
        throw new QuotaAuthError('Qoder creditUsage 解密为空（IDE 未登录或字段变化）')
      } catch (err) {
        if (err instanceof QuotaAuthError) throw err
        throw new Error(`Qoder 本地配额读取失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    // OAuth 会话路径：openapi 用户信息（配额窗口字段待官方暴露）
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
