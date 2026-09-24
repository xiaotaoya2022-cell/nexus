// ZCode 多开实例管理（v2 Phase 1，指导书 §3.4）。
// 依据《多开ZCode管理方案》(docs/research/v2/多开ZCode管理方案.md)：
// - agent 数据不按实例归属（全局共享 db.sqlite），聚合视图为主；实例视图只做运行期元数据
// - 本模块全程只读：文件系统枚举 + 白名单内元数据读取，绝不 kill/写任何 ZCode 数据
//
// 实现说明（v2 MVP）：不使用进程枚举/子进程派生——实例发现走 userData 目录证据：
// 运行态 = tasks-index.sqlite-wal 新鲜度（WAL 在库被打开时存在并被写入）。
// 远控对 ZCode 的"启动任务"经 zcode:// 深链唤起（Electron shell API）；
// headless stdio 会话与 WMI 进程枚举延后（理由记录于 ENHANCEMENT_REPORT.md）。

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve, sep } from 'node:path'
import { join } from 'node:path'
import { readJsonSafe } from './fsutil'

export interface ZcodeInstance {
  id: string // userData 目录标识（default 或 cockpit 实例名）
  userDataDir: string
  name: string
  running: boolean
  currentProject: string | null
  lastActiveAt: number | null
}

const RUNNING_WAL_FRESH_MS = 5 * 60_000

function zcodeUserDataRoots(): string[] {
  const appdataRoot = process.env.APPDATA
    ? resolve(process.env.APPDATA, 'ZCode')
    : resolve(homedir(), 'AppData', 'Roaming', 'ZCode')
  const cockpitRoot = resolve(homedir(), '.antigravity_cockpit', 'instances', 'zcode')
  return [appdataRoot, cockpitRoot]
}

/** 白名单内判定（使用点内联语义：绝对 + 无 .. + 根白名单） */
function underAllowedRoot(resolved: string): boolean {
  return zcodeUserDataRoots().some((root) => resolved === root || resolved.startsWith(root + sep))
}

function safeMtime(path: string): number | null {
  const resolved = resolve(path)
  if (!isAbsolute(resolved) || resolved.includes('..') || !underAllowedRoot(resolved)) return null
  try {
    if (!existsSync(resolved)) return null
    return statSync(resolved).mtimeMs
  } catch {
    return null
  }
}

function isRunning(ud: string): boolean {
  // WAL 存在且 5 分钟内有写入 → 该实例的本地库处于打开状态
  for (const marker of ['v2/tasks-index.sqlite-wal', 'tasks-index.sqlite-wal']) {
    const m = safeMtime(join(ud, marker))
    if (m != null && Date.now() - m < RUNNING_WAL_FRESH_MS) return true
  }
  return false
}

function pickRecentProject(ud: string): string | null {
  const setting = readJsonSafe(join(ud, 'setting.json'))
  const recent = setting?.recentProjects
  if (Array.isArray(recent) && recent.length > 0) {
    const first = recent[0]
    if (typeof first === 'string') return first
    if (first && typeof first === 'object') {
      const p = (first as Record<string, unknown>).path
      if (typeof p === 'string') return p
    }
  }
  return null
}

export class ZcodeManager {
  private cache: ZcodeInstance[] | null = null
  private cacheAt = 0

  /** 枚举本机 ZCode 实例（文件系统证据，5s 缓存）。
   * 目录来源（均在白名单根下）：默认 userData + cockpit 多开目录的一级子目录。 */
  instances(): ZcodeInstance[] {
    const now = Date.now()
    if (this.cache && now - this.cacheAt < 5000) return this.cache
    const roots = zcodeUserDataRoots()
    const candidates: Array<{ ud: string; name: string }> = []
    const [defaultRoot, cockpitRoot] = roots
    if (existsSync(defaultRoot)) candidates.push({ ud: defaultRoot, name: 'default' })
    try {
      if (existsSync(cockpitRoot)) {
        for (const entry of readdirSync(cockpitRoot)) {
          const ud = resolve(cockpitRoot, entry, 'electron')
          if (
            isAbsolute(ud) &&
            !ud.includes('..') &&
            underAllowedRoot(ud) &&
            existsSync(join(ud, 'setting.json'))
          ) {
            candidates.push({ ud, name: entry })
          }
        }
      }
    } catch {
      // 枚举失败按无 cockpit 实例处理
    }

    const out: ZcodeInstance[] = []
    const seen = new Set<string>()
    for (const { ud, name } of candidates) {
      const key = resolve(ud).toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        id: name,
        userDataDir: resolve(ud),
        name,
        running: isRunning(ud),
        currentProject: pickRecentProject(ud),
        lastActiveAt: safeMtime(join(ud, 'v2', 'tasks-index.sqlite')) ?? safeMtime(join(ud, 'tasks-index.sqlite'))
      })
    }
    // 活跃的排前，其次按名称
    out.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) || a.name.localeCompare(b.name))
    this.cache = out
    this.cacheAt = now
    return out
  }
}

export function defaultZcodeHome(): string {
  return join(homedir(), '.zcode')
}
