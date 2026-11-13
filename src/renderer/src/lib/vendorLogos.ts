// 厂商官方 logo（Simple Icons 收录的官方 mark，构建期打包、离线可用）。
// 渲染用 CSS mask + 品牌色背景（monochrome mark 通用方案）。
// Z.ai / Reasonix / 开源 无官方收录 → VendorBadge 回退字标。

import alibabacloud from '@renderer/assets/logos/alibabacloud.svg'
import anthropic from '@renderer/assets/logos/anthropic.svg'
import bytedance from '@renderer/assets/logos/bytedance.svg'
import claude from '@renderer/assets/logos/claude.svg'
import cursor from '@renderer/assets/logos/cursor.svg'
import deepseek from '@renderer/assets/logos/deepseek.svg'
import google from '@renderer/assets/logos/google.svg'
import openai from '@renderer/assets/logos/openai.svg'
import tencentqq from '@renderer/assets/logos/tencentqq.svg'
import metaSvg from '@renderer/assets/logos/meta.svg'
import xiaomiSvg from '@renderer/assets/logos/xiaomi.svg'
import clineSvg from '@renderer/assets/logos/cline.svg'
import zaiSvg from '@renderer/assets/logos/zai.svg'
import reasonixSvg from '@renderer/assets/logos/reasonix.svg'
import rooSvg from '@renderer/assets/logos/roo.svg'
import kiloSvg from '@renderer/assets/logos/kilo.svg'
import opensourceSvg from '@renderer/assets/logos/opensource.svg'

export const VENDOR_LOGOS: Record<string, string> = {
  deepseek,
  openai,
  anthropic,
  google,
  tencent: tencentqq,
  alibaba: alibabacloud,
  bytedance,
  cursor,
  zai: zaiSvg,
  reasonix: reasonixSvg,
  xiaomi: xiaomiSvg,
  meta: metaSvg,
  cline: clineSvg,
  roo: rooSvg,
  kilo: kiloSvg,
  oss: opensourceSvg,
  // claude mark 给 anthropic 厂商组里 claude-code 行更贴切（同色系）
  'claude-code': claude
}
