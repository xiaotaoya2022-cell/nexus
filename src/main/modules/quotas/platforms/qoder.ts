// Qoder 平台集成（占位）。cockpit 源码证据：
// - OAuth: https://qoder.com/device/selectAccounts + openapi.qoder.sh（qoder_oauth.rs:19-20，设备码流程）
// - 配额字段存在于账号记录（qoder_account.rs quota_query_last_error 等），专用配额端点待下一批从
//   cockpit 的配额刷新链路中定位移植。
// 本轮：凭据发现返回 []（Qoder IDE 登录态在云端），fetchQuota 抛出明确错误。

import type { DiscoveredCredential, PlatformIntegration } from '../types'
import { QuotaAuthError } from '../types'

export const integration: PlatformIntegration = {
  id: 'qoder',
  label: 'Qoder',

  async discoverLocalCredentials(): Promise<DiscoveredCredential[]> {
    return []
  },

  async fetchQuota(): Promise<never> {
    throw new QuotaAuthError('Qoder 配额端点待应用内 OAuth 接入（设备码流程已定位，下一批移植）')
  }
}
