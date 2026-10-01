// CodeBuddy 国际版（www.codebuddy.ai）。实现见 codebuddy-base.ts 工厂。
// 证据：cockpit-tools src-tauri/src/modules/codebuddy_oauth.rs
// （CODEBUDDY_API_ENDPOINT=https://www.codebuddy.ai，auth 流程与 CN 版完全同构）

import type { PlatformIntegration } from '../types'
import { createCodeBuddyIntegration } from './codebuddy-base'

export const integration: PlatformIntegration = createCodeBuddyIntegration({
  id: 'codebuddy-intl',
  label: 'CodeBuddy 国际版',
  endpoint: 'https://www.codebuddy.ai',
  displayName: 'CodeBuddy 国际版'
})
