// CodeBuddy CN（国内版，www.codebuddy.cn）。实现见 codebuddy-base.ts 工厂。
// 证据：cockpit-tools src-tauri/src/modules/codebuddy_cn_oauth.rs

import type { PlatformIntegration } from '../types'
import { createCodeBuddyIntegration } from './codebuddy-base'

export const integration: PlatformIntegration = createCodeBuddyIntegration({
  id: 'codebuddy-cn',
  label: 'CodeBuddy CN',
  endpoint: 'https://www.codebuddy.cn',
  displayName: 'CodeBuddy CN'
})
