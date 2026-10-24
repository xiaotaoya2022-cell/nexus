// DeepSeek 开放平台 国内版入口。实现见 deepseek-base.ts 工厂。
// 国内版=沿用既有分区 persist:deepseek（保留旧版已登录态，无需重登）；
// 登录页按国内区显示 手机验证码/微信扫码 通道（区域由平台按 IP 判定）。

import type { PlatformIntegration } from '../types'
import { createDeepSeekIntegration } from './deepseek-base'

export const integration: PlatformIntegration = createDeepSeekIntegration({
  id: 'deepseek-cn',
  label: 'DeepSeek 开放平台',
  endpoint: 'https://platform.deepseek.com',
  partition: 'persist:deepseek',
  displayName: 'DeepSeek 开放平台',
  intl: false
})
