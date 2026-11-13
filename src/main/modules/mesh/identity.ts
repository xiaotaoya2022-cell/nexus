// 设备硬件指纹与虚拟化探测（Nexus Mesh）。
// 自动识别 physical / vmware / hyperv / wsl2 / vm / mac / linux，持久化全局唯一 nodeId，
// 并结合网络接口特征标注 LAN / VMware NAT / WSL vSwitch / Tailscale 链路类型。

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import si from 'systeminformation'
import type { NexusStore } from '@main/modules/aggregator/infrastructure/store'
import type { SystemSnapshot } from '@main/modules/system/collector'
import { logger } from '@main/modules/shared/logger'
import type {
  LinkTransport,
  NodeHardwareSummary,
  NodeIpHint,
  NodeKind,
  NodeProfile,
  NodeRole
} from '@shared/types'

function isTailscaleIp(ip: string, ifaceName = ''): boolean {
  if (/tailscale/i.test(ifaceName)) return true
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4) return false
  // Tailscale CGNAT 段：100.64.0.0/10
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
}

function isPrivateLanIp(ip: string): boolean {
  if (ip.startsWith('192.168.') || ip.startsWith('10.')) return true
  if (ip.startsWith('172.')) {
    const second = Number(ip.split('.')[1])
    return second >= 16 && second <= 31
  }
  return false
}

export function classifyInterfaceAddress(
  ip: string,
  ifaceName = ''
): { transport: LinkTransport; label: string } {
  if (ip === '127.0.0.1' || ip === '::1') {
    return { transport: 'local', label: '本机回环' }
  }
  if (isTailscaleIp(ip, ifaceName)) {
    return { transport: 'tailscale', label: 'Tailscale/虚拟网（跨网用）' }
  }
  if (/vmware|vmnet/i.test(ifaceName)) {
    return { transport: 'vmware_nat', label: 'VMware NAT' }
  }
  if (/wsl|vethernet.*wsl/i.test(ifaceName)) {
    return { transport: 'wsl', label: 'WSL vSwitch' }
  }
  if (isPrivateLanIp(ip)) {
    return { transport: 'lan', label: '局域网' }
  }
  return { transport: 'other', label: '其他网络' }
}

/** 结合连接对端 IP 与节点上报信息判断真实链路类型 */
export function inferPeerTransport(remoteIp: string | null | undefined, profile: NodeProfile): LinkTransport {
  const cleanIp = (remoteIp ?? '').replace(/^::ffff:/, '')
  if (cleanIp === '127.0.0.1' || cleanIp === '::1') {
    if (profile.kind === 'wsl2') return 'wsl'
    if (profile.kind === 'vmware') return 'vmware_nat'
    return 'local'
  }
  if (cleanIp && isTailscaleIp(cleanIp)) return 'tailscale'
  const matched = profile.ipHints.find((h) => h.host === cleanIp)
  if (matched) return matched.transport
  if (profile.kind === 'wsl2') return 'wsl'
  if (profile.kind === 'vmware') return 'vmware_nat'
  if (cleanIp && isPrivateLanIp(cleanIp)) return 'lan'
  return profile.ipHints[0]?.transport ?? 'lan'
}

export function listNetworkIpHints(): NodeIpHint[] {
  const out: NodeIpHint[] = []
  const seen = new Set<string>()
  const ifaces = os.networkInterfaces()
  for (const [ifaceName, list] of Object.entries(ifaces)) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue
      const ip = ni.address
      if (seen.has(ip)) continue
      seen.add(ip)
      const classified = classifyInterfaceAddress(ip, ifaceName)
      out.push({ host: ip, transport: classified.transport, label: classified.label })
    }
  }
  const priority: Record<LinkTransport, number> = {
    tailscale: 0,
    vmware_nat: 1,
    wsl: 2,
    lan: 3,
    other: 4,
    local: 5
  }
  return out.sort((a, b) => priority[a.transport] - priority[b.transport])
}

function fastKindFallback(): NodeKind {
  if (process.platform === 'linux') {
    if (process.env.WSL_DISTRO_NAME || existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) {
      return 'wsl2'
    }
    try {
      const procVer = readFileSync('/proc/version', 'utf8')
      if (/microsoft|wsl/i.test(procVer)) return 'wsl2'
    } catch {
      // 忽略 /proc 读取失败
    }
    return 'linux'
  }
  if (process.platform === 'darwin') return 'mac'
  return 'physical'
}

export function defaultRoleForKind(kind: NodeKind): NodeRole {
  return kind === 'physical' || kind === 'mac' ? 'hub' : 'spoke'
}

export class NodeIdentityService {
  readonly nodeId: string
  private detectedKind: NodeKind
  private kindProbed = false
  private kindProbePromise: Promise<NodeKind> | null = null

  constructor(private readonly store: NexusStore) {
    let id = store.getSetting('meshNodeId')
    if (!id) {
      id = `node_${randomBytes(8).toString('hex')}`
      store.setSetting('meshNodeId', id)
    }
    this.nodeId = id

    const cachedKind = store.getSetting('meshDetectedKind') as NodeKind | null
    this.detectedKind = cachedKind || fastKindFallback()
  }

  /** 异步探测虚拟化形态（VMware / Hyper-V / VirtualBox / QEMU / WSL2 / Mac / Linux） */
  async probeKind(): Promise<NodeKind> {
    if (this.kindProbed) return this.detectedKind
    if (this.kindProbePromise) return this.kindProbePromise

    this.kindProbePromise = (async () => {
      const fast = fastKindFallback()
      if (fast === 'wsl2') {
        this.detectedKind = 'wsl2'
        this.kindProbed = true
        this.store.setSetting('meshDetectedKind', 'wsl2')
        return 'wsl2'
      }
      try {
        const [sys, bios, base] = await Promise.all([
          si.system().catch(() => null),
          si.bios().catch(() => null),
          si.baseboard().catch(() => null)
        ])
        const corpus = [
          sys?.manufacturer,
          sys?.model,
          sys?.version,
          bios?.vendor,
          bios?.version,
          base?.manufacturer,
          base?.model
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()

        let resolved: NodeKind = fast
        if (/vmware/i.test(corpus)) resolved = 'vmware'
        else if (/hyper-v|microsoft corporation.*virtual/i.test(corpus)) resolved = 'hyperv'
        else if (sys?.virtual || /virtualbox|vbox|qemu|kvm|parallels|xen|bhyve|innotek|bochs/i.test(corpus)) {
          resolved = 'vm'
        }
        this.detectedKind = resolved
        this.store.setSetting('meshDetectedKind', resolved)
      } catch (err) {
        logger.warn('mesh.kind_probe_failed', { error: err instanceof Error ? err.message : String(err) })
      } finally {
        this.kindProbed = true
      }
      return this.detectedKind
    })()

    return this.kindProbePromise
  }

  getKind(): NodeKind {
    return this.detectedKind
  }

  getAlias(): string | null {
    const raw = this.store.getSetting('meshNodeAlias')
    return raw && raw.trim() ? raw.trim() : null
  }

  setAlias(alias: string | null): void {
    const clean = alias?.trim().slice(0, 48) ?? ''
    if (clean) this.store.setSetting('meshNodeAlias', clean)
    else this.store.db.prepare('DELETE FROM settings WHERE key = ?').run('meshNodeAlias')
  }

  getRoleOverride(): NodeRole | null {
    const v = this.store.getSetting('meshRoleOverride')
    return v === 'hub' || v === 'spoke' ? v : null
  }

  getEffectiveRole(): NodeRole {
    return this.getRoleOverride() ?? defaultRoleForKind(this.detectedKind)
  }

  setRoleOverride(role: NodeRole | null): void {
    if (role === 'hub' || role === 'spoke') {
      this.store.setSetting('meshRoleOverride', role)
    } else {
      this.store.db.prepare('DELETE FROM settings WHERE key = ?').run('meshRoleOverride')
    }
  }

  buildHardwareSummary(snap?: SystemSnapshot | null): NodeHardwareSummary {
    const cpus = os.cpus()
    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    const usedMem = Math.max(0, totalMem - freeMem)
    const fastCpuModel = cpus[0]?.model?.trim() || `${process.arch} CPU`

    if (!snap) {
      return {
        osPlatform: process.platform,
        osRelease: os.release(),
        arch: process.arch,
        cpuModel: fastCpuModel,
        cpuCores: cpus.length || 1,
        cpuLoadPercent: 0,
        ramTotalBytes: totalMem,
        ramUsedBytes: usedMem,
        ramUsedPercent: totalMem > 0 ? Math.round((usedMem / totalMem) * 1000) / 10 : 0,
        gpuModel: null,
        uptimeSec: Math.floor(os.uptime())
      }
    }

    return {
      osPlatform: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      cpuModel: snap.cpu.model || fastCpuModel,
      cpuCores: snap.cpu.cores || cpus.length || 1,
      cpuLoadPercent: snap.cpu.loadPercent,
      ramTotalBytes: snap.memory.totalBytes || totalMem,
      ramUsedBytes: snap.memory.usedBytes,
      ramUsedPercent: snap.memory.usedPercent,
      gpuModel: snap.gpus[0]?.model ?? null,
      uptimeSec: snap.uptimeSec
    }
  }

  buildProfile(snap?: SystemSnapshot | null, activeAgents: string[] = []): NodeProfile {
    return {
      nodeId: this.nodeId,
      hostname: os.hostname(),
      alias: this.getAlias(),
      kind: this.detectedKind,
      role: this.getEffectiveRole(),
      ipHints: listNetworkIpHints(),
      hwSummary: this.buildHardwareSummary(snap),
      activeAgents,
      updatedAt: Date.now()
    }
  }
}
