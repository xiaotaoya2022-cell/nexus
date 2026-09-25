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

export interface PlatformMetaView {
  id: string
  label: string
  oauthSupported: boolean
  accountCount: number
}
