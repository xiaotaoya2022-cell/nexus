// Agent 官方 logo 徽章：圆角 PNG 原图（自带底色）；未收录回退厂商徽章。

import type { JSX } from 'react'
import type { VendorMeta } from '@shared/vendors'
import { AGENT_LOGOS } from '@renderer/lib/agentLogos'
import { VendorBadge } from './VendorBadge'

export function AgentLogo({
  agentId,
  vendor,
  size = 18
}: {
  agentId: string
  vendor: VendorMeta
  size?: number
}): JSX.Element {
  const logo = AGENT_LOGOS[agentId]
  if (logo) {
    return (
      <img
        src={logo}
        alt=""
        aria-hidden
        className="inline-block shrink-0 rounded-md object-cover"
        style={{ width: size, height: size }}
      />
    )
  }
  return <VendorBadge vendor={vendor} size={size} />
}
