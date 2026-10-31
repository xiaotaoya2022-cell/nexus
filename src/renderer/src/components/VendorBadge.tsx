// 品牌徽章：官方 logo（Simple Icons 官方 mark，CSS mask + 品牌色）；
// 无官方收录的（Z.ai/Reasonix/开源）回退品牌色字标。
// Agent 行 / 厂商分组行共用。

import type { JSX } from 'react'
import type { VendorMeta } from '@shared/vendors'
import { VENDOR_LOGOS } from '@renderer/lib/vendorLogos'

export function VendorBadge({ vendor, size = 18 }: { vendor: VendorMeta; size?: number }): JSX.Element {
  const logo = VENDOR_LOGOS[vendor.id]
  if (logo) {
    return (
      <span
        aria-hidden
        role="img"
        title={vendor.label}
        className="inline-block shrink-0"
        style={{
          width: size,
          height: size,
          backgroundColor: vendor.color,
          maskImage: `url("${logo}")`,
          maskSize: 'contain',
          maskRepeat: 'no-repeat',
          maskPosition: 'center',
          WebkitMaskImage: `url("${logo}")`,
          WebkitMaskSize: 'contain',
          WebkitMaskRepeat: 'no-repeat',
          WebkitMaskPosition: 'center'
        }}
      />
    )
  }
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 select-none items-center justify-center rounded-md font-medium leading-none text-white"
      style={{
        width: size,
        height: size,
        backgroundColor: vendor.color,
        fontSize: Math.round(size * (vendor.initial.length > 1 ? 0.38 : 0.56))
      }}
      title={vendor.label}
    >
      {vendor.initial}
    </span>
  )
}
