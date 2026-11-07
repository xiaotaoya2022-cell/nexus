// Antigravity 配额集成：读 Antigravity Cockpit 的官方 quota API 缓存。
//
// 数据链路：Antigravity 客户端 → 官方 quota 接口 → Cockpit 落缓存
//   ~/.antigravity_cockpit/cache/quota_api_v1_desktop/authorized/<sha256>.json
//   （每账号一文件：email + payload.quota_summary.groups[].buckets[]，
//     bucket = Weekly/5h 窗口的 remainingFraction + resetTime，与官方 View Usage 面板同构）
//
// 设计决定（证据）：
// - 不直连官方 API：Cockpit 的账号凭据为 AES-256-GCM 私有加密体系
//   （accounts/<id>.json algorithm=AES-256-GCM + secure-account-storage.key），
//   解密第三方工具凭据越界且脆弱；Cockpit 常驻托盘自动刷新缓存，Nexus 轮询即得最新。
// - 本地无 token 级用量：~/.gemini/antigravity/{conversations,brain} 均不含 usage 字段
//   （2026-11-07 实测），Pro 额度制只下发 remainingFraction，故不实现 fetchUsage。
// - 本文件不打印/记录任何凭据值（与模块红线一致，此处只有缓存文件路径）。

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PlatformQuota, QuotaWindow } from '@shared/quotas'
import type {
  DiscoveredCredential,
  PlatformIntegration
} from '../types'
import { QuotaAuthError } from '../types'

const CACHE_DIR = join(
  homedir(),
  '.antigravity_cockpit',
  'cache',
  'quota_api_v1_desktop',
  'authorized'
)

interface QuotaBucket {
  bucketId?: string
  displayName?: string
  remainingFraction?: number
  resetTime?: string
  window?: string
}

interface QuotaGroup {
  displayName?: string
  buckets?: QuotaBucket[]
}

interface QuotaCacheFile {
  email?: string
  updatedAt?: number
  payload?: { quota_summary?: { groups?: QuotaGroup[] } }
}

function readCache(path: string): QuotaCacheFile | null {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as QuotaCacheFile
    return j && typeof j === 'object' ? j : null
  } catch {
    return null
  }
}

export const integration: PlatformIntegration = {
  id: 'antigravity',
  label: 'Antigravity',

  async discoverLocalCredentials(): Promise<DiscoveredCredential[]> {
    if (!existsSync(CACHE_DIR)) return []
    let files: string[] = []
    try {
      files = readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json') && !f.endsWith('.bak'))
    } catch {
      return []
    }
    const out: DiscoveredCredential[] = []
    for (const f of files) {
      const p = join(CACHE_DIR, f)
      const cache = readCache(p)
      const email = typeof cache?.email === 'string' ? cache.email : null
      if (!email) continue
      out.push({
        kind: 'oauth',
        accountId: email,
        label: email,
        source: p,
        expiresAt: null
      })
    }
    return out
  },

  async fetchQuota(cred: DiscoveredCredential): Promise<PlatformQuota> {
    if (!existsSync(cred.source)) {
      throw new QuotaAuthError('Antigravity Cockpit 配额缓存不存在（Cockpit 未安装或缓存已清）')
    }
    const cache = readCache(cred.source)
    const summary = cache?.payload?.quota_summary
    if (!cache || !summary || !Array.isArray(summary.groups)) {
      // 免费账号官方不下发 quota_summary（实测 2026-11-07），与缓存损坏区分开
      throw new QuotaAuthError('官方未下发额度数据（该账号可能无 Pro 订阅）')
    }
    const groups = summary.groups
    const windows: QuotaWindow[] = []
    for (const g of groups) {
      for (const b of g.buckets ?? []) {
        if (typeof b.remainingFraction !== 'number') continue
        const groupLabel = typeof g.displayName === 'string' ? g.displayName : 'Models'
        const bucketLabel =
          typeof b.displayName === 'string' && b.displayName.length > 0
            ? b.displayName
            : typeof b.window === 'string'
              ? b.window
              : 'Quota'
        windows.push({
          label: `${groupLabel} · ${bucketLabel}`,
          usedPercent: Math.round((1 - b.remainingFraction) * 1000) / 10,
          remainingPercent: Math.round(b.remainingFraction * 1000) / 10,
          resetAt: typeof b.resetTime === 'string' ? Date.parse(b.resetTime) || null : null
        })
      }
    }
    if (!windows.length) {
      throw new QuotaAuthError('Antigravity 配额缓存为空（等待 Cockpit 下次刷新）')
    }
    const cacheUpdatedAt =
      typeof cache.updatedAt === 'number' && cache.updatedAt > 0
        ? new Date(cache.updatedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
        : null
    return {
      planLabel: 'Pro 订阅额度',
      windows,
      extra: {
        数据源: 'Antigravity Cockpit 官方配额缓存',
        ...(cacheUpdatedAt ? { 缓存时间: cacheUpdatedAt } : {})
      }
    }
  }
}
