// WorkBuddy 平台集成（占位）。cockpit 源码证据：WORKBUDDY_API_ENDPOINT = https://copilot.tencent.com
// （workbuddy_oauth.rs:7），专用配额/用量路径待下一批定位移植。本轮占位（同 qoder）。

import type { DiscoveredCredential, PlatformIntegration } from '../types'
import { QuotaAuthError } from '../types'

export const integration: PlatformIntegration = {
  id: 'workbuddy',
  label: 'WorkBuddy',

  async discoverLocalCredentials(): Promise<DiscoveredCredential[]> {
    return []
  },

  async fetchQuota(): Promise<never> {
    throw new QuotaAuthError('WorkBuddy 配额端点待下一批移植（API 端点已定位 copilot.tencent.com）')
  }
}
