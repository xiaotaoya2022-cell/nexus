// DeepSeek 开放平台 国际版入口。实现见 deepseek-base.ts 工厂。
// 调研结论（2026-10-24）：DeepSeek 无独立国际域名，与国内版同域
// platform.deepseek.com、同账号体系、同 API；差异仅在登录通道——国际区显示
// 邮箱/Google/Apple（"Only email registration is supported in your region"，
// 区域由平台按 IP 判定）。因此国际版=独立持久分区（与国内版可同时各登录一个
// 账号）+ 分区会话偏好英文（en-US，尽力偏向国际登录通道与英文界面）。
// 国际账号计费多为 USD，fetchQuota/fetchUsage 已兼容 USD/CNY 双币种。

import type { PlatformIntegration } from '../types'
import { createDeepSeekIntegration } from './deepseek-base'

export const integration: PlatformIntegration = createDeepSeekIntegration({
  id: 'deepseek-intl',
  label: 'DeepSeek 开放平台（国际版）',
  endpoint: 'https://platform.deepseek.com',
  partition: 'persist:deepseek-intl',
  displayName: 'DeepSeek 开放平台（国际版）',
  intl: true
})
