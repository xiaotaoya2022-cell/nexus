// DeepSeek 开放平台集成工厂：国内版与国际版共用。
// 证据：2026-10-02 实测 usage 页网络请求（用户已登录会话）+ 2026-10-24 国际版调研：
// - DeepSeek 只有单一域名 platform.deepseek.com（无 .ai/.io 等国际分域）；
//   “国内/国际”差异在同一站点的登录通道：国内区显示 手机验证码+微信扫码，
//   国际区显示 邮箱/Google/Apple（"Only email registration is supported in your
//   region"，区域由平台按 IP 判定）。账号体系统一，API/计费同构（USD/CNY 钱包并存）。
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
// 登录：应用内 BrowserWindow（各自 persist 分区）打开 sign_in 页，SPA 完成登录后
// 直接读 localStorage.userToken + __appKit_userInfo.id；刷新凭据=隐藏窗口静默重取。
// 国内/国际版=两个独立分区入口，可同时登录两个账号（国内版沿用旧分区 persist:deepseek
// 以保留既有登录态；国际版偏好英文 UI，尽最大努力偏向国际登录通道）。

import { BrowserWindow } from 'electron'
import type { AccountUsagePoint, DiscoveredCredential, LoginMode, OAuthSession, PlatformIntegration, PlatformQuota } from '../types'
import { QuotaAuthError } from '../types'
import type { QuotaWindow } from '@shared/quotas'
import { pickNumber } from '../http'
import { logger } from '@main/modules/shared/logger'

const LOGIN_TIMEOUT_MS = 5 * 60_000
const LOGIN_POLL_MS = 1500

export interface DeepSeekConfig {
  id: string
  label: string
  /** 平台站点（两版同域 https://platform.deepseek.com）。 */
  endpoint: string
  /** 持久分区（国内版沿用 'persist:deepseek' 保留既有登录态；国际版独立分区）。 */
  partition: string
  /** 错误文案/账号兜底名里的显示名（如 "DeepSeek 开放平台（国际版）"）。 */
  displayName: string
  /** 国际版=true：分区会话偏好英文（acceptLanguages），尽力偏向国际登录通道。 */
  intl: boolean
}

/** Mimosa 约束：仅 https + 固定 host，拒绝环回/私有/保留地址。 */
function makeAssertPlatformUrl(endpoint: string): (url: string) => void {
  const host = new URL(endpoint).hostname
  return (url: string): void => {
    const u = new URL(url)
    if (u.protocol !== 'https:' || u.hostname !== host) {
      throw new Error(`拒绝非平台地址：${u.protocol}//${u.hostname}`)
    }
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

/** 全量回溯天数上限：usage API 按账号创建日期返回，创建前的段为空（滚动会在连续 2 个
 *  空段后停止，因此这里只需 ≥ 账号年龄；400 天覆盖一般个人账号全生命周期）。 */
const USAGE_LOOKBACK_DAYS = 400

/** DeepSeek API 专用直连 fetch：node 全局 fetch 不走系统代理。
 *  实测（2026-10-31）：net.fetch 走用户梯子（系统代理）时对 platform.deepseek.com
 *  CONNECT 成功但 TLS 后断流，每请求挂到 20s 超时，导致全量回溯 40 个请求卡死 20+ 分钟；
 *  而直连 373ms 即通（DeepSeek 为国内可达站点）。返回形状与 http.fetchJson 一致。 */
async function dsFetchJson(
  url: string,
  init: { headers?: Record<string, string>; timeoutMs?: number } = {}
): Promise<{ status: number; body: unknown; text: string }> {
  const { timeoutMs = 20_000, headers } = init
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers, signal: controller.signal })
    const text = await res.text()
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {
      // 非 JSON 响应保留文本
    }
    return { status: res.status, body, text }
  } finally {
    clearTimeout(timer)
  }
}

/** 隐藏窗口在指定持久分区上静默重取 SPA 登录产物（userToken + 用户 id）。 */
async function readUserTokenFromPartition(
  partition: string,
  endpoint: string
): Promise<{ token: string | null; userId: string | null }> {
  const part = (await import('electron')).session.fromPartition(partition)
  const win = new BrowserWindow({
    show: false,
    width: 0,
    height: 0,
    alwaysOnTop: false,
    autoHideMenuBar: true,
    webPreferences: {
      session: part,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  try {
    await win.loadURL(`${endpoint}/usage`)
    const deadline = Date.now() + 20_000
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
      await new Promise((res) => setTimeout(res, 1000))
    }
    return { token: null, userId: null }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

export function createDeepSeekIntegration(cfg: DeepSeekConfig): PlatformIntegration {
  const { id, label, endpoint, partition, displayName, intl } = cfg
  const assertPlatformUrl = makeAssertPlatformUrl(endpoint)

  /** 拉一个窗口（跨度 ≤31 天）的 usage（amount+cost 两个端点），返回按日 Map。
   *  API 硬限制：单请求 end-start ≤ 31 天（实测 32 天起 biz_code=1 INVALID_PARAM），
   *  但窗口可滑动回溯到账号创建（2026-10-31 实测 90 天前的段正常返回）。 */
  async function fetchUsageWindowMaps(
    token: string,
    startSec: number,
    endSec: number
  ): Promise<{
    tokensByDay: Map<number, { tokens: number; requests: number }>
    costByDay: Map<number, { usd: number; cny: number }>
  }> {
    assertPlatformUrl(`${endpoint}/api/v0/usage/by_api_key/amount`)
    const H = { accept: 'application/json', authorization: `Bearer ${token}` }
    const q = `start=${startSec}&end=${endSec}&tz=${tzOffsetSec()}`
    const amountRes = await dsFetchJson(`${endpoint}/api/v0/usage/by_api_key/amount?${q}`, { headers: H })
    const costRes = await dsFetchJson(`${endpoint}/api/v0/usage/by_api_key/cost?${q}`, { headers: H })
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
    return { tokensByDay, costByDay }
  }

  /** 全量回溯：从今天往回按 31 天跨度滚动分段拉取，直到 sinceSec 或连续 2 个空段
   *  （空段=账号创建之前，不会再有更早数据）。合并为逐日序列。 */
  async function fetchUsageAll(
    token: string,
    sinceSec: number
  ): Promise<{ points: AccountUsagePoint[]; totalTokens: number; totalRequests: number; totalCost: { usd: number; cny: number } }> {
    const tokensByDay = new Map<number, { tokens: number; requests: number }>()
    const costByDay = new Map<number, { usd: number; cny: number }>()
    const span = 31 * 86400
    let endSec = dayStartSec(0) + 86400 // 明天零点（与官方页面"到今天"口径一致）
    let emptyStreak = 0
    for (let seg = 0; seg < 20 && endSec > sinceSec && emptyStreak < 2; seg++) {
      const startSec = Math.max(sinceSec, endSec - span)
      let maps: Awaited<ReturnType<typeof fetchUsageWindowMaps>>
      try {
        maps = await fetchUsageWindowMaps(token, startSec, endSec)
      } catch (err) {
        // 单段失败不放弃全量（网络抖动），直接结束回滚保护已取数据
        if (seg === 0) throw err
        break
      }
      for (const [t, v] of maps.tokensByDay) {
        const cur = tokensByDay.get(t) ?? { tokens: 0, requests: 0 }
        cur.tokens += v.tokens
        cur.requests += v.requests
        tokensByDay.set(t, cur)
      }
      for (const [t, v] of maps.costByDay) {
        const cur = costByDay.get(t) ?? { usd: 0, cny: 0 }
        cur.usd += v.usd
        cur.cny += v.cny
        costByDay.set(t, cur)
      }
      if (maps.tokensByDay.size === 0 && maps.costByDay.size === 0) emptyStreak++
      else emptyStreak = 0
      endSec = startSec
    }

    const days = new Set<number>([...tokensByDay.keys(), ...costByDay.keys()])
    const points: AccountUsagePoint[] = []
    let totalTokens = 0
    let totalRequests = 0
    let usd = 0
    let cny = 0
    for (const t of [...days].sort((a, b) => a - b)) {
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

  return {
    id,
    label,

    async discoverLocalCredentials(): Promise<DiscoveredCredential[]> {
      // 平台登录态在浏览器/应用内会话，无本地明文凭据可导入；走应用内登录。
      return []
    },

    /** 应用内登录：打开平台登录页，SPA 完成后读回 userToken。
     *  normal=persist 分区（保留登录态供静默续期）；incognito=非持久分区（第二个账号，凭据直接入库不依赖 cookie）。
     *  国际版分区偏好英文（en-US），UI 尽力偏向邮箱/Google/Apple 通道；实际可选通道由平台按 IP 判定。 */
    async oauthLogin(mode: LoginMode = 'normal'): Promise<OAuthSession> {
      assertPlatformUrl(`${endpoint}/sign_in`)
      const loginPartition = mode === 'incognito' ? `incognito-${id}-${Date.now()}` : partition
      const ses = (await import('electron')).session.fromPartition(loginPartition)
      // Electron 41 无 session.setAcceptLanguages；setUserAgent 第二参即 acceptLanguages，
      // UA 原样回写只改语言偏好（SPA 界面语言/登录通道呈现尽力偏向国际版）
      if (intl) ses.setUserAgent(ses.getUserAgent(), 'en-US,en')
      const win = new BrowserWindow({
        show: true,
        width: 1020,
        height: 720,
        autoHideMenuBar: true,
        // Windows 前台锁：后台进程创建的窗口会被压到主窗口后面（用户视角="没反应"），
        // 置顶确保登录窗口一定可见；登录完成窗口销毁，置顶随之消失。
        alwaysOnTop: true,
        title: mode === 'incognito' ? `登录 ${displayName}（无痕）` : `登录 ${displayName}`,
        webPreferences: {
          session: ses,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      })
      win.show()
      win.focus()
      await win.loadURL(`${endpoint}/sign_in`)
      // 自动切换到邮箱密码登录通道：sign_in 页默认落在 +86 验证码/微信扫码（国内通道），
      // 国际账号只能走 "Login with password"（国际区仅邮箱注册，平台按 IP/区域决定可选通道）。
      // 这里等价于替用户点一次该链接；手机/微信通道仍可手动切回。找不到链接不报错
      // （可能已在密码表单或 DOM 变化）。注意：同文本的隐藏测量 span（ds-sign-in-form__social-link-measure）
      // 必须跳过，点它无效——只点可见元素或其 button/a 祖先。
      if (!win.isDestroyed()) {
        const switchDeadline = Date.now() + 15_000
        while (Date.now() < switchDeadline && !win.isDestroyed()) {
          try {
            const clicked = (await win.webContents.executeJavaScript(
              `(() => {
                 const match = [...document.querySelectorAll('a, button, span, div')]
                   .filter(e => /^(login with password|密码登录)$/i.test((e.textContent || '').trim()))
                 const visible = match.filter(e => e.offsetParent !== null).pop() || match[match.length - 1]
                 if (!visible) return false
                 const target = visible.closest('button, a') || visible
                 target.click()
                 return true
               })()`,
              false
            )) as boolean
            if (clicked === true) break
          } catch {
            // 页面尚未就绪，继续等
          }
          await new Promise((res) => setTimeout(res, 1000))
        }
      }
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
              accountId: r.userId ?? `${id}-default`,
              label: displayName,
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
      throw new Error('登录未完成：窗口已关闭或超过 5 分钟')
    },

    /** 余额 + 官方累计消费 + 全历史用量合计（extra 文案）；fetchUsage 负责逐日落库。 */
    async fetchQuota(cred: DiscoveredCredential): Promise<PlatformQuota> {
      const token = cred.accessToken ?? ''
      assertPlatformUrl(`${endpoint}/api/v0/users/get_user_summary`)
      const H = { accept: 'application/json', authorization: `Bearer ${token}` }
      const summary = bizData((await dsFetchJson(`${endpoint}/api/v0/users/get_user_summary`, { headers: H })).body)

      const costs = costsByCurrency(summary.total_costs)

      let usageAll: Awaited<ReturnType<typeof fetchUsageAll>> | null = null
      try {
        usageAll = await fetchUsageAll(token, dayStartSec(USAGE_LOOKBACK_DAYS))
      } catch (err) {
        // 用量窗口失败不影响余额/累计消费展示
        logger.warn('quota.deepseek_usage_all_failed', {
          error: err instanceof Error ? err.message : String(err)
        })
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
      if (usageAll) {
        extra.usageTotalTokens = String(usageAll.totalTokens)
        extra.usageTotalRequests = String(usageAll.totalRequests)
        extra.usageTotalCostText =
          usageAll.totalCost.usd > 0
            ? `$${f2(usageAll.totalCost.usd)} + ¥${f2(usageAll.totalCost.cny)}`
            : `¥${f2(usageAll.totalCost.cny)}`
      }
      return { planLabel: '按量付费', windows, extra }
    },

    /** 逐日真实消耗（全历史回溯，引擎落库供账号面板画趋势）。
     *  注意：恒定从 USAGE_LOOKBACK_DAYS 前全量回溯（空段×2 自动停在账号创建前），**不用**
     *  sinceDay 截断起点——若从已采集最早日截断，历史缺口（如安装升级前的月份）将永远无法回补。
     *  全量成本低（约 4-6 段 × 2 请求，直连几百 ms/段），upsert 幂等。 */
    async fetchUsage(cred: DiscoveredCredential, _sinceDay?: string): Promise<AccountUsagePoint[]> {
      const r = await fetchUsageAll(cred.accessToken ?? '', dayStartSec(USAGE_LOOKBACK_DAYS))
      return r.points
    },

    /** 静默刷新：持久化分区 cookie 未失效时直接换新 userToken。 */
    async refreshCredential(cred: DiscoveredCredential): Promise<DiscoveredCredential> {
      const r = await readUserTokenFromPartition(partition, endpoint)
      if (!r.token) throw new QuotaAuthError(`${displayName} 会话已过期，请重新登录`)
      return { ...cred, accessToken: r.token }
    }
  }
}
