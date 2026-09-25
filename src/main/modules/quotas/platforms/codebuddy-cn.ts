// CodeBuddy CN 平台集成。证据：cockpit-tools src-tauri/src/modules/codebuddy_cn_oauth.rs
// - 端点: POST {CODEBUDDY_API_ENDPOINT=https://www.codebuddy.cn}/v2/billing/meter/get-user-resource
//   （:899 post_user_resource；头: Authorization Bearer + X-User-Id(可选)）
// - 请求体: build_user_resource_request_body（PageNumber/PageSize/ProductCode=p_tcaca/Status=[0,3]/
//   PackageEndTimeRangeBegin=now/End=now+365*101 天，本地时间 "YYYY-MM-DD HH:mm:ss"）
// - 解析: data.resources | data.data.resources | data.Response.Data.Accounts ...
//   （user_resource_items :883），字段 CycleCapacitySize/Remain/Used/PackageName/CycleResetTime
// 凭据：官方 IDE 的登录态存腾讯云端/加密存储，本地无明文 token（调研报告 §四）——
// 本地导入暂返回 []，待 Nexus 应用内 OAuth（device/网页流程）接入后即生效。

import type { DiscoveredCredential, PlatformIntegration, PlatformQuota } from '../types'
import { QuotaAuthError } from '../types'
import type { QuotaWindow } from '@shared/quotas'
import { fetchJson, parseTimeLoose, pickNumber, pickString } from '../http'

const ENDPOINT = 'https://www.codebuddy.cn'

interface ResourceAccount {
  PackageName?: string
  PackageCode?: string
  CycleCapacitySize?: number | string
  CycleCapacityRemain?: number | string
  CycleCapacityUsed?: number | string
  CapacityUnit?: string
  CycleResetTime?: string
  Unlimited?: boolean
}

function findAccounts(body: unknown): ResourceAccount[] {
  const paths = [
    'data/resources',
    'data/data/resources',
    'data/Response/Data/Accounts',
    'data/data/Response/Data/Accounts',
    'Response/Data/Accounts'
  ]
  let node: unknown = body
  for (const key of paths.flatMap((p) => p.split('/'))) {
    if (!key) continue
    if (node != null && typeof node === 'object' && key in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[key]
    } else {
      return []
    }
  }
  return Array.isArray(node) ? (node as ResourceAccount[]) : []
}

function fmtLocal(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export const integration: PlatformIntegration = {
  id: 'codebuddy-cn',
  label: 'CodeBuddy CN',

  async discoverLocalCredentials(): Promise<DiscoveredCredential[]> {
    // 官方 IDE 登录态在云端/加密存储（调研报告 §四），本地无明文凭据可导入。
    // 应用内 OAuth 接入后此函数保持 []，凭据由 engine 的 OAuth 会话提供。
    return []
  },

  async fetchQuota(cred: DiscoveredCredential): Promise<PlatformQuota> {
    const now = new Date()
    const end = new Date(now.getTime() + 365 * 101 * 86400_000)
    const { status, body } = await fetchJson(`${ENDPOINT}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Authorization: `Bearer ${cred.accessToken ?? ''}`,
        'Content-Type': 'application/json',
        ...(cred.accountId ? { 'X-User-Id': cred.accountId } : {})
      },
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: 'p_tcaca',
        Status: [0, 3],
        PackageEndTimeRangeBegin: fmtLocal(now),
        PackageEndTimeRangeEnd: fmtLocal(end)
      })
    })
    if (status === 401 || status === 403) {
      throw new QuotaAuthError('CodeBuddy CN 登录态已过期，请重新登录')
    }
    if (status !== 200) throw new Error(`get-user-resource 返回 ${status}`)
    const accounts = findAccounts(body)
    if (!accounts.length) throw new Error('user resource 响应未包含可用资源')
    const windows: QuotaWindow[] = []
    for (const a of accounts) {
      const size = pickNumber(a, ['CycleCapacitySize', 'CapacitySize'])
      const remain = pickNumber(a, ['CycleCapacityRemain', 'CapacityRemain'])
      const used = pickNumber(a, ['CycleCapacityUsed', 'CapacityUsed'])
      const unlimited = a.Unlimited === true
      const percent =
        unlimited || size == null ? null : size > 0 ? ((size - (remain ?? 0)) / size) * 100 : null
      windows.push({
        label: pickString(a, ['PackageName', 'PackageCode']) ?? '套餐',
        usedPercent: percent != null ? Math.max(0, Math.min(100, Math.round(percent * 10) / 10)) : null,
        remainingPercent: unlimited ? null : percent != null ? 100 - Math.round(percent * 10) / 10 : null,
        resetAt: parseTimeLoose(a.CycleResetTime)
      })
      void used
    }
    if (!windows.length) throw new Error('配额资源解析为空')
    return { windows }
  }
}

