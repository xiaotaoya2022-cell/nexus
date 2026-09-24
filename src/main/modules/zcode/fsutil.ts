// 白名单约束下的只读 JSON 读取（供 zcode/实例元数据等使用）。
// 路径校验在使用点内联：绝对 + 无 .. + 根白名单（Mimosa 路径穿越对策）。

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve, sep } from 'node:path'
import { join } from 'node:path'

export function allowedMetaRoots(): string[] {
  const appdataRoot = process.env.APPDATA
    ? resolve(process.env.APPDATA, 'ZCode')
    : resolve(homedir(), 'AppData', 'Roaming', 'ZCode')
  const cockpitRoot = resolve(homedir(), '.antigravity_cockpit', 'instances')
  return [appdataRoot, cockpitRoot]
}

export function underAllowedRoot(resolved: string): boolean {
  return allowedMetaRoots().some((root) => resolved === root || resolved.startsWith(root + sep))
}

export function readJsonSafe(path: string): Record<string, unknown> | null {
  const resolved = resolve(path)
  if (!isAbsolute(resolved) || resolved.includes('..') || !underAllowedRoot(resolved)) return null
  try {
    if (!existsSync(resolved)) return null
    return JSON.parse(readFileSync(resolved, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

export function joinUnderRoot(root: string, ...parts: string[]): string | null {
  const resolved = resolve(join(root, ...parts))
  if (!isAbsolute(resolved) || resolved.includes('..') || !underAllowedRoot(resolved)) return null
  return resolved
}
