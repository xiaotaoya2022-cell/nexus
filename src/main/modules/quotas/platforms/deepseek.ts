// DeepSeek 开放平台（platform.deepseek.com）集成。
// 证据：2026-10-02 实测 usage 页网络请求（用户已登录会话）：
// - 认证：GET/POST /api/v0/* 头 Authorization: Bearer <userToken>；userToken 由
//   SPA 登录后写入 localStorage.userToken（{"value":"..."}），cookie 会话经
//   /auth-api/v0/users/oauth/get_token 换取；401/40002 = Missing Token。
// - GET /api/v0/users/get_user_summary
//   → data.biz_data.{normal_wallets[],bonus_wallets[],total_costs[]}
//     （wallet: {currency,balance,token_estimation}；total_costs: {currency,amount}）
// - GET /api/v0/usage/by_api_key/amount?start=<unix秒>&end=<unix秒>&tz=<偏移秒>
//   → data.biz_data.{models[],series:[{api_key{tracking_id,name,sensitive_id},model,
//     buckets:[{time,usage{RESPONSE_TOKEN,REQUEST,PROMPT_CACHE_HIT_TOKEN,PROMPT_CACHE_MISS_TOKEN}}]}]}
//   start/end 必须按 tz 对齐零点，否则 biz_code=1 INVALID_PARAM。
// - GET /api/v0/usage/by_api_key/cost?同上
//   → data.biz_data.data:[{currency,series:[{api_key,model,buckets:[{time,cost}]}]}]
// 登录：应用内 BrowserWindow（persist:deepseek 分区）打开 sign_in 页，SPA 完成登录后
// 直接读 localStorage.userToken + __appKit_userInfo.id；刷新凭据=隐藏窗口静默重取。

import { BrowserWindow } from 'electron'
import type { AccountUsagePoint, DiscoveredCredential, LoginMode, OAuthSession, PlatformIntegration, PlatformQuota } from '../types'
import { QuotaAuthError } from '../types'
import type { QuotaWindow } from '@shared/quotas'
import { fetchJson, pickNumber } from '../http'

const ENDPOINT = 'https://platform.deepseek.com'
const PARTITION = 'persist:deepseek'
const LOGIN_TIMEOUT_MS = 5 * 60_000
const LOGIN_POLL_MS = 1500

/** Mimosa 约束：仅 https + 固定 host，拒绝环回/私有/保留地址。 */
function assertPlatformUrl(url: string): void {
  const u = new URL(url)
  if (u.protocol !== 'https:' || u.hostname !== 'platform.deepseek.com') {
    throw new Error(`拒绝非平台地址：${u.protocol}//${u.hostname}`)
  }
}

interface Wallet {
  currency?: string
  balance?: string | number
}

interface BizBody {
  code?: number
  msg?: string
  data?: { biz_code?: number; biz_msg?: string; biz_data?: unknown } | null
}

function bizData(body: unknown): Record<string, unknown> {
  const b = body as BizBody
  if (b?.code === 40002 || b?.code === 401) throw new QuotaAuthError('DeepSeek 登录态失效，请重新登录')
  if (b?.code !== 0) throw new Error(`DeepSeek API code=${b?.code} ${b?.msg ?? ''}`)
  if (b.data?.biz_code !== 0) throw new Error(`DeepSeek 业务错误 ${b.data?.biz_code}: ${b.data?.biz_msg ?? ''}`)
  return (b.data?.biz_data ?? {}) as Record<string, unknown>
}

function walletSum(wallets: unknown, currency: string): number {
  if (!Array.isArray(wallets)) return 0
  return wallets.reduce((acc, w) => {
    const v = pickNumber(w, ['balance']) ?? 0
    return (w as Wallet).currency === currency ? acc + v : acc
  }, 0)
}

function costSum(costs: unknown, currency: string): number {
  if (!Array.isArray(costs)) return 0
  return costs.reduce((acc, c) => acc + (pickNumber(c, ['amount', 'cost']) ?? 0), (currency === '' ? 0 : 0))
}

function costsByCurrency(costs: unknown): { usd: number; cny: number } {
  let usd = 0
  let cny = 0
  if (Array.isArray(costs)) {
    for (const c of costs) {
      const rec = c as { currency?: string; amount?: string | number }
      const v = pickNumber(rec, ['amount']) ?? 0
      if (rec.currency === 'USD') usd += v
      else if (rec.currency === 'CNY') cny += v
    }
  }
  return { usd, cny }
}

/** UTC+8 当日零点（秒）。平台账单按其账期时区对齐。 */
function dayStartSec(offsetDays: number): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return Math.floor(d.getTime() / 1000) - offsetDays * 86400
}

function tzOffsetSec(): number {
  return -new Date().getTimezoneOffset() * 60
}

interface UsageBucket {
  time?: number
  usage?: Record<string, number | string>
  cost?: string | number
}

interface UsageSeries {
  api_key?: { tracking_id?: string; name?: string }
  model?: string
  buckets?: UsageBucket[]
}

const f2 = (n: number): string => n.toFixed(2)

/** 拉窗口内 usage（amount+cost 两个端点），返回聚合与逐日序列。 */
async function fetchUsageWindow(
  token: string,
  startSec: number,
  endSec: number
): Promise<{
  points: AccountUsagePoint[]
  totalTokens: number
  totalRequests: number
  totalCost: { usd: number; cny: number }
}> {
  assertPlatformUrl(`${ENDPOINT}/api/v0/usage/by_api_key/amount`)
  const H = { accept: 'application/json', authorization: `Bearer ${token}` }
  const q = `start=${startSec}&end=${endSec}&tz=${tzOffsetSec()}`
  const amountRes = await fetchJson(`${ENDPOINT}/api/v0/usage/by_api_key/amount?${q}`, { headers: H })
  const costRes = await fetchJson(`${ENDPOINT}/api/v0/usage/by_api_key/cost?${q}`, { headers: H })
  const amount = bizData(amountRes.body)
  const cost = bizData(costRes.body)

  // tokens/requests：按日合并全部 api_key×model 序列
  const tokensByDay = new Map<number, { tokens: number; requests: number }>()
  for (const s of (Array.isArray(amount.series) ? amount.series : []) as UsageSeries[]) {
    for (const b of s.buckets ?? []) {
      if (typeof b.time !== 'number') continue
      const u = b.usage ?? {}
      const tokens =
        (pickNumber(u, ['RESPONSE_TOKEN']) ?? 0) +
        (pickNumber(u, ['PROMPT_CACHE_HIT_TOKEN']) ?? 0) +
        (pickNumber(u, ['PROMPT_CACHE_MISS_TOKEN']) ?? 0)
      const requests = pickNumber(u, ['REQUEST']) ?? 0
      const cur = tokensByDay.get(b.time) ?? { tokens: 0, requests: 0 }
      cur.tokens += tokens
      cur.requests += requests
      tokensByDay.set(b.time, cur)
    }
  }
  // 花费：按日合并（多币种分列；当前牌价只有 CNY/USD）
  const costByDay = new Map<number, { usd: number; cny: number }>()
  const costData = (Array.isArray(cost.data) ? cost.data : []) as Array<{ currency?: string; series?: UsageSeries[] }>
  for (const cur of costData) {
    for (const s of cur.series ?? []) {
      for (const b of s.buckets ?? []) {
        if (typeof b.time !== 'number') continue
        const v = pickNumber(b, ['cost']) ?? 0
        const rec = costByDay.get(b.time) ?? { usd: 0, cny: 0 }
        if (cur.currency === 'USD') rec.usd += v
        else if (cur.currency === 'CNY') rec.cny += v
        costByDay.set(b.time, rec)
      }
    }
  }

  const days = new Set<number>([...tokensByDay.keys(), ...costByDay.keys()])
  const points: AccountUsagePoint[] = []
  let totalTokens = 0
  let totalRequests = 0
  let usd = 0
  let cny = 0
  for (const t of days) {
    const tk = tokensByDay.get(t) ?? { tokens: 0, requests: 0 }
    const cst = costByDay.get(t) ?? { usd: 0, cny: 0 }
    const day = new Date(t * 1000)
    const p = (n: number): string => String(n).padStart(2, '0')
    const dayStr = `${day.getFullYear()}-${p(day.getMonth() + 1)}-${p(day.getDate())}`
    const costAmount = cst.usd > 0 ? cst.usd : cst.cny
    points.push({
      day: dayStr,
      requests: tk.requests,
      tokens: tk.tokens,
      costAmount,
      currency: cst.usd > 0 ? 'USD' : 'CNY'
    })
    totalTokens += tk.tokens
    totalRequests += tk.requests
    usd += cst.usd
    cny += cst.cny
  }
  return { points, totalTokens, totalRequests, totalCost: { usd, cny } }
}

/** 在指定分区上读取 SPA 登录产物（userToken + 用户 id）。 */
async function readUserToken(hidden: boolean): Promise<{ token: string | null; userId: string | null }> {
  const ses = (await import('electron')).session
  const partition = ses.fromPartition(PARTITION)
  const win = new BrowserWindow({
    show: !hidden,
    width: hidden ? 0 : 1020,
    height: hidden ? 0 : 720,
    alwaysOnTop: false,
    autoHideMenuBar: true,
    title: hidden ? undefined : '登录 DeepSeek 开放平台',
    webPreferences: {
      session: partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  try {
    await win.loadURL(`${ENDPOINT}/usage`)
    const deadline = Date.now() + (hidden ? 20_000 : LOGIN_TIMEOUT_MS)
    while (Date.now() < deadline) {
      if (win.isDestroyed()) return { token: null, userId: null }
      try {
        const r = (await win.webContents.executeJavaScript(
          `(() => {
             let token = null
             try { token = JSON.parse(localStorage.getItem('userToken') || '{}').value || null } catch {}
             let userId = null
             try { userId = JSON.parse(localStorage.getItem('__appKit_userInfo') || '{}').value?.id || null } catch {}
             return { token, userId }
           })()`,
          false
        )) as { token: string | null; userId: string | null }
        if (r?.token) return { token: r.token, userId: r.userId }
      } catch {
        // 页面尚未就绪，继续轮询
      }
      if (hidden) await new Promise((res) => setTimeout(res, 1000))
      else await new Promise((res) => setTimeout(res, LOGIN_POLL_MS))
    }
    return { token: null, userId: null }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

export const integration: PlatformIntegration = {
  id: 'deepseek',
  label: 'DeepSeek 开放平台',

  async discoverLocalCredentials(): Promise<DiscoveredCredential[]> {
    // 平台登录态在浏览器/应用内会话，无本地明文凭据可导入；走应用内登录。
    return []
  },

  /** 应用内登录：打开平台登录页，SPA 完成后读回 userToken。
   *  normal=persist 分区（保留登录态供静默续期）；incognito=非持久分区（第二个账号，凭据直接入库不依赖 cookie）。 */
  async oauthLogin(mode: LoginMode = 'normal'): Promise<OAuthSession> {
    assertPlatformUrl(`${ENDPOINT}/sign_in`)
    const partition =
      mode === 'incognito' ? `incognito-deepseek-${Date.now()}` : PARTITION
    const win = new BrowserWindow({
      show: true,
      width: 1020,
      height: 720,
      autoHideMenuBar: true,
      title: mode === 'incognito' ? '登录 DeepSeek 开放平台（无痕）' : '登录 DeepSeek 开放平台',
      webPreferences: {
        session: (await import('electron')).session.fromPartition(partition),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    await win.loadURL(`${ENDPOINT}/sign_in`)
    const deadline = Date.now() + LOGIN_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (win.isDestroyed()) break
      try {
        const r = (await win.webContents.executeJavaScript(
          `(() => {
             let token = null
             try { token = JSON.parse(localStorage.getItem('userToken') || '{}').value || null } catch {}
             let userId = null
             try { userId = JSON.parse(localStorage.getItem('__appKit_userInfo') || '{}').value?.id || null } catch {}
             return { token, userId }
           })()`,
          false
        )) as { token: string | null; userId: string | null }
        if (r?.token) {
          if (!win.isDestroyed()) win.destroy()
          return {
            accountId: r.userId ?? 'deepseek-default',
            label: 'DeepSeek 开放平台',
            accessToken: r.token,
            expiresAt: null
          }
        }
      } catch {
        // 页面跳转中读取失败属正常，继续等
      }
      await new Promise((res) => setTimeout(res, LOGIN_POLL_MS))
    }
    if (!win.isDestroyed()) win.destroy()
    throw new Error('登录超时：未在 5 分钟内完成 DeepSeek 登录')
  },

  /** 余额 + 累计消费 + 近 30 天用量（extra 文案）；fetchUsage 负责逐日落库。 */
  async fetchQuota(cred: DiscoveredCredential): Promise<PlatformQuota> {
    const token = cred.accessToken ?? ''
    assertPlatformUrl(`${ENDPOINT}/api/v0/users/get_user_summary`)
    const H = { accept: 'application/json', authorization: `Bearer ${token}` }
    const summary = bizData((await fetchJson(`${ENDPOINT}/api/v0/users/get_user_summary`, { headers: H })).body)

    const toppedUp = walletSum(summary.normal_wallets, 'CNY') + walletSum(summary.normal_wallets, 'USD')
    const granted = walletSum(summary.bonus_wallets, 'CNY') + walletSum(summary.bonus_wallets, 'USD')
    const costs = costsByCurrency(summary.total_costs)

    let usage30: Awaited<ReturnType<typeof fetchUsageWindow>> | null = null
    try {
      usage30 = await fetchUsageWindow(token, dayStartSec(30), dayStartSec(0) + 86400)
    } catch {
      // 用量窗口失败不影响余额/累计消费展示
    }

    const windows: QuotaWindow[] = [
      {
        label: '余额（充值+赠送）',
        usedPercent: null,
        remainingPercent: null,
        resetAt: null
      }
    ]
    const extra: Record<string, string> = {
      balanceText: `¥${f2(walletSum(summary.normal_wallets, 'CNY') + walletSum(summary.bonus_wallets, 'CNY'))}`,
      usdBalanceText: `$${f2(walletSum(summary.normal_wallets, 'USD') + walletSum(summary.bonus_wallets, 'USD'))}`,
      totalCostText: costs.usd > 0 ? `$${f2(costs.usd)} + ¥${f2(costs.cny)}` : `¥${f2(costs.cny)}`
    }
    if (usage30) {
      extra.usage30Tokens = String(usage30.totalTokens)
      extra.usage30Requests = String(usage30.totalRequests)
      extra.usage30CostText =
        usage30.totalCost.usd > 0
          ? `$${f2(usage30.totalCost.usd)} + ¥${f2(usage30.totalCost.cny)}`
          : `¥${f2(usage30.totalCost.cny)}`
    }
    void toppedUp
    void granted
    void costSum
    return { planLabel: '按量付费', windows, extra }
  },

  /** 逐日真实消耗（近 30 天），引擎落库供账号面板画趋势。 */
  async fetchUsage(cred: DiscoveredCredential): Promise<AccountUsagePoint[]> {
    const r = await fetchUsageWindow(cred.accessToken ?? '', dayStartSec(30), dayStartSec(0) + 86400)
    return r.points
  },

  /** 静默刷新：持久化分区 cookie 未失效时直接换新 userToken。 */
  async refreshCredential(cred: DiscoveredCredential): Promise<DiscoveredCredential> {
    const r = await readUserToken(true)
    if (!r.token) throw new QuotaAuthError('DeepSeek 会话已过期，请重新登录')
    return { ...cred, accessToken: r.token }
  }
}
