// 配额集成：渲染层可见的视图类型（不含任何凭据字段）。

export interface QuotaWindow {
  label: string
  usedPercent: number | null
  remainingPercent: number | null
  resetAt: number | null
}

export interface PlatformQuota {
  planLabel?: string
  windows: QuotaWindow[]
  extra?: Record<string, string>
}

export interface AccountQuotaView {
  platform: string
  platformLabel: string
  accountId: string
  label: string
  source: 'oauth' | 'local'
  planLabel?: string
  windows: QuotaWindow[]
  extra?: Record<string, string>
  fetchedAt: number
  error?: string
}

/** 账号级每日真实消耗（官方账单口径，如 DeepSeek 开放平台 usage API） */
export interface AccountUsagePoint {
  day: string // YYYY-MM-DD（平台时区）
  requests: number
  tokens: number // 全部 token 类型合计（响应+缓存命中+未命中）
  costAmount: number // 花费数额（配 currency）
  currency: string // 'CNY' | 'USD'
}

export interface PlatformMetaView {
  id: string
  label: string
  oauthSupported: boolean
  accountCount: number
}
