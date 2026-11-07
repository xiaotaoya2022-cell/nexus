// 平台注册表：按序接入。新增平台 = platforms/ 下新增文件并在数组中追加。

import type { PlatformIntegration } from '../types'
import { integration as antigravity } from './antigravity'
import { integration as codex } from './codex'
import { integration as cursor } from './cursor'
import { integration as codebuddyCn } from './codebuddy-cn'
import { integration as codebuddyIntl } from './codebuddy-intl'
import { integration as deepseekCn } from './deepseek-cn'
import { integration as deepseekIntl } from './deepseek-intl'
import { integration as qoder } from './qoder'
import { integration as trae } from './trae'
import { integration as workbuddy } from './workbuddy'

export const PLATFORM_INTEGRATIONS: PlatformIntegration[] = [
  antigravity,
  codex,
  cursor,
  codebuddyCn,
  codebuddyIntl,
  deepseekCn,
  deepseekIntl,
  qoder,
  trae,
  workbuddy
]
