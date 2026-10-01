// 平台注册表：按序接入。新增平台 = platforms/ 下新增文件并在数组中追加。

import type { PlatformIntegration } from '../types'
import { integration as codex } from './codex'
import { integration as cursor } from './cursor'
import { integration as codebuddyCn } from './codebuddy-cn'
import { integration as deepseek } from './deepseek'
import { integration as qoder } from './qoder'
import { integration as trae } from './trae'
import { integration as workbuddy } from './workbuddy'

export const PLATFORM_INTEGRATIONS: PlatformIntegration[] = [
  codex,
  cursor,
  codebuddyCn,
  deepseek,
  qoder,
  trae,
  workbuddy
]
