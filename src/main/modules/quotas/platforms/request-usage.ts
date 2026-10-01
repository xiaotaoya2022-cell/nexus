// CodeBuddy / WorkBuddy 共享的云端逐请求用量端点封装。
// 证据（2026-10-02 调研，多仓库交叉验证）：
// - POST {host}/billing/meter/get-user-request-usage（注意无 /v2 前缀）
//   body {startTime:"YYYY-MM-DD HH:MM:SS", endTime, pageNum, pageSize}
//   → {code:0, data:{total, data:[{requestId, credit, model, client, requestTime}]}}
// - 硬约束：仅近 31 天；单页上限 3000 且 total 截断 → sweep（startTime 推进到本页最新
//   requestTime 继续翻）；(requestId) 去重；缺 User-Agent 会 403/code=10085；
//   令牌域与请求域需一致（workbuddy 需按序尝试多个 host）。
// - 响应行可能带 input 等明文字段——本封装只取 credit/model/client/requestTime，其余丢弃。

import type { AccountUsagePoint } from '../types'
import { QuotaAuthError } from '../types'
import { fetchJson } from '../http'

const UA = 'CLI/2.108.1 CodeBuddy/2.108.1'
const PAGE_SIZE = 3000
const MAX_PAGES = 5

export interface RequestUsageRow {
  requestId?: string
  credit?: number | string
  model?: string
  client?: string
  requestTime?: string
}

interface UsageBody {
  code?: number
  msg?: string
  data?: { data?: RequestUsageRow[] } | null
}

function fmtLocal(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

async function fetchPage(
  host: string,
  token: string,
  userId: string | null | undefined,
  startTime: string,
  endTime: string,
  pageNum: number
): Promise<RequestUsageRow[]> {
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': UA,
    Origin: host
  }
  if (userId) headers['X-User-Id'] = userId
  const { status, body } = await fetchJson(`${host}/billing/meter/get-user-request-usage`, {
    headers,
    method: 'POST',
    body: JSON.stringify({ startTime, endTime, pageNum, pageSize: PAGE_SIZE })
  })
  if (status === 401 || status === 403) throw new QuotaAuthError('登录态已过期，请重新登录')
  if (status !== 200) throw new Error(`get-user-request-usage 返回 ${status}`)
  const b = body as UsageBody
  if (b.code === 10085) throw new QuotaAuthError('网关拒绝（10085），请重新登录')
  if (b.code !== 0) throw new Error(`get-user-request-usage code=${b.code} ${b.msg ?? ''}`)
  return Array.isArray(b.data?.data) ? b.data!.data! : []
}

/** 拉取 [now-31d, now] 的逐请求用量，按日聚合为 credits 口径。 */
export async function fetchRequestUsageDaily(
  hosts: string[],
  token: string,
  userId: string | null | undefined
): Promise<AccountUsagePoint[]> {
  const endTime = fmtLocal(new Date())
  const startTime = fmtLocal(new Date(Date.now() - 31 * 86400_000))

  // 令牌域一致性：按序尝试 host，成功后本进程内记住
  let working: string | null = null
  let lastErr: unknown = null
  for (const host of hosts) {
    try {
      await fetchPage(host, token, userId, startTime, endTime, 1)
      working = host
      break
    } catch (err) {
      if (err instanceof QuotaAuthError) throw err
      lastErr = err
    }
  }
  if (!working) {
    throw lastErr instanceof Error ? lastErr : new Error('所有用量域名均不可用')
  }

  const byDay = new Map<string, { requests: number; credit: number }>()
  let cursor = startTime
  for (let page = 1; page <= MAX_PAGES; page++) {
    const rows = await fetchPage(working, token, userId, cursor, endTime, page)
    for (const r of rows) {
      if (typeof r.requestTime !== 'string' || r.requestTime.length < 10) continue
      const day = r.requestTime.slice(0, 10)
      const credit = typeof r.credit === 'number' ? r.credit : Number(r.credit ?? 0) || 0
      const cur = byDay.get(day) ?? { requests: 0, credit: 0 }
      cur.requests += 1
      cur.credit += credit
      byDay.set(day, cur)
    }
    if (rows.length < PAGE_SIZE) break
    const lastTime = rows[rows.length - 1]?.requestTime
    if (typeof lastTime !== 'string') break
    cursor = lastTime
  }

  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, v]) => ({
      day,
      requests: v.requests,
      tokens: 0,
      costAmount: Math.round(v.credit * 100) / 100,
      currency: 'CRED'
    }))
}
