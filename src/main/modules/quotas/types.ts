// 配额集成（v2 补强：完全原生化 cockpit-tools 的账号/配额能力）。
// 平台集成契约：每平台一个 PlatformIntegration 实现，放在 platforms/ 目录并在 registry.ts 注册。
// 设计红线：
// - 凭据来源两种：应用内 OAuth 登录（engine 持久化到 userData/quotas-auth.json）与
//   本地导入（discoverLocalCredentials 轮询时读取 Agent 自身已登录的凭据文件，只在内存使用，绝不落 Nexus 库）。
// - 平台实现内禁止打印/记录任何 token 值；只允许记录路径与结果状态。
// - 所有端点/路径常量必须附 cockpit 源码证据（文件:行），见 docs/research/v2/quota-integration-spec.md。
// 视图类型（QuotaWindow/PlatformQuota/AccountQuotaView）定义在 @shared/quotas，此处 re-export 保持契约单一。

import type { AccountQuotaView, AccountUsagePoint, PlatformQuota, QuotaWindow } from '@shared/quotas'

export type { AccountQuotaView, AccountUsagePoint, PlatformQuota, QuotaWindow }

export interface DiscoveredCredential {
  kind: 'oauth' | 'apikey'
  accessToken?: string
  refreshToken?: string
  /** 平台侧账号标识（邮箱/accountId 等），用于展示与区分多账号 */
  accountId?: string
  /** 展示名（脱敏） */
  label: string
  /** 凭据来源路径（仅记录路径，不记录值） */
  source: string
  /** 过期时间（epoch ms，若可知） */
  expiresAt?: number | null
}

export interface OAuthSession {
  accountId: string
  label: string
  accessToken: string
  refreshToken?: string
  expiresAt: number | null
}

export interface PlatformIntegration {
  id: string
  label: string
  /**
   * 本地凭据发现：读取该平台 Agent 自身已登录的凭据文件（只读）。
   * 找不到/未登录返回 []。实现必须容错（文件不存在/字段缺失/JSON 坏）。
   */
  discoverLocalCredentials(): Promise<DiscoveredCredential[]>
  /**
   * 应用内 OAuth 登录（可选）：打开系统浏览器完成授权，回环回调换 token。
   * 不支持的平台不实现（UI 显示"需在 Agent 内登录"）。
   */
  oauthLogin?(): Promise<OAuthSession>
  /** 用凭据拉配额。401/403 时抛 QuotaAuthError 以便引擎标记需要重登。 */
  fetchQuota(cred: DiscoveredCredential): Promise<PlatformQuota>
  /**
   * 可选：拉账号级每日真实消耗（官方账单口径，如 DeepSeek usage API）。
   * 引擎把结果交给 onUsage 落库，供账号面板绘制趋势。
   */
  fetchUsage?(cred: DiscoveredCredential): Promise<AccountUsagePoint[]>
  /** 刷新 oauth 凭据（若平台有 refresh 端点）；不支持则原样返回 */
  refreshCredential?(cred: DiscoveredCredential): Promise<DiscoveredCredential>
}

export class QuotaAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuotaAuthError'
  }
}
