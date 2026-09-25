// Trae 平台集成（占位）。cockpit 源码证据：trae_account* 模块管理本地存储注入与 token 刷新，
// 专用配额端点待下一批定位移植。本轮占位（同 qoder）。

import type { DiscoveredCredential, PlatformIntegration } from '../types'
import { QuotaAuthError } from '../types'

export const integration: PlatformIntegration = {
  id: 'trae',
  label: 'Trae',

  async discoverLocalCredentials(): Promise<DiscoveredCredential[]> {
    return []
  },

  async fetchQuota(): Promise<never> {
    throw new QuotaAuthError('Trae 配额端点待下一批移植（源码已定位 trae_account* 模块）')
  }
}
