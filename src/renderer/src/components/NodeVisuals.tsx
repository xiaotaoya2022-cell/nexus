// 多机节点共享视觉基元（Nexus Mesh Phase 3）：
// 统一设备形态矢量图、虚拟化/链路文案以及主机名/硬件简述格式化，供切换条、会话徽章与 Mesh 视图复用。

import type { JSX } from 'react'
import type { LinkTransport, MeshNodeInfo, NodeHardwareSummary, NodeKind } from '@shared/types'
import { t } from '../i18n'

export function formatRamGb(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0'
  const gb = bytes / 1024 ** 3
  return decimals === 0 ? `${Math.round(gb)}` : gb.toFixed(decimals)
}

export function osSummary(hw: NodeHardwareSummary): string {
  return `${hw.osPlatform} ${hw.osRelease} · ${hw.arch}`
}

export function nodeKindLabel(kind: NodeKind): string {
  return t(`mesh.kind.${kind}`)
}

export function transportLabel(transport: LinkTransport): string {
  return t(`mesh.transport.${transport}`)
}

export function nodeDisplayName(node: Pick<MeshNodeInfo, 'alias' | 'hostname'>): string {
  const alias = node.alias?.trim()
  return alias || node.hostname
}

export function nodeShortMeta(node: MeshNodeInfo): string {
  const parts: string[] = []
  if (node.role === 'hub') parts.push('HUB')
  else parts.push(nodeKindLabel(node.kind))

  if (node.isLocal) {
    if (node.hwSummary.cpuCores > 0) parts.push(`${node.hwSummary.cpuCores}C`)
    if (node.hwSummary.ramTotalBytes > 0) {
      parts.push(`${formatRamGb(node.hwSummary.ramTotalBytes, 0)}G`)
    }
  } else if (node.status !== 'offline' && node.rttMs != null) {
    parts.push(`${node.rttMs}ms`)
  } else if (node.status === 'offline') {
    parts.push(t('mesh.status.offline'))
  }
  return parts.join(' · ')
}

/** 自定义矢量设备轮廓图标（按 physical / vmware / hyperv / wsl2 / vm / mac / linux 区分） */
export function NodeKindIcon({
  kind,
  className = 'size-4'
}: {
  kind: NodeKind
  className?: string
}): JSX.Element {
  if (kind === 'vmware' || kind === 'hyperv' || kind === 'vm') {
    return (
      <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
        <rect x="2.5" y="4" width="10.5" height="9" rx="1.8" stroke="currentColor" strokeWidth="1.4" />
        <rect
          x="7"
          y="7"
          width="10.5"
          height="9"
          rx="1.8"
          fill="var(--nx-card)"
          stroke="currentColor"
          strokeWidth="1.4"
        />
        <circle cx="10.2" cy="11.5" r="1.2" fill="currentColor" />
      </svg>
    )
  }

  if (kind === 'wsl2') {
    return (
      <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
        <rect x="2.5" y="3.5" width="15" height="13" rx="2.4" stroke="currentColor" strokeWidth="1.4" />
        <path
          d="M6.2 8.2 9 10.2l-2.8 2M10.5 12.2h3.3"
          stroke="currentColor"
          strokeWidth="1.45"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }

  if (kind === 'mac') {
    return (
      <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
        <rect x="3" y="4" width="14" height="9.5" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
        <path d="M1.8 15.8h16.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    )
  }

  if (kind === 'linux') {
    return (
      <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
        <rect x="3" y="3.5" width="14" height="5.2" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
        <rect x="3" y="11.3" width="14" height="5.2" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="6" cy="6.1" r="0.9" fill="currentColor" />
        <circle cx="6" cy="13.9" r="0.9" fill="currentColor" />
      </svg>
    )
  }

  // physical 主力工作站 / 桌面塔式主机
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
      <rect x="2.8" y="3.2" width="9.8" height="13.6" rx="1.8" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.4 6.5h4.6M5.4 9.2h4.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="7.7" cy="13.4" r="1.1" fill="currentColor" />
      <path d="M15 5.5v9M17.2 7.5v5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" opacity="0.65" />
    </svg>
  )
}

export function MeshGlyph({ className = 'size-4' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
      <circle cx="10" cy="4.2" r="2.1" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4.4" cy="14.6" r="2.1" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="15.6" cy="14.6" r="2.1" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8.8 6 5.5 12.6M11.2 6l3.3 6.6M6.5 14.6h7"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </svg>
  )
}
