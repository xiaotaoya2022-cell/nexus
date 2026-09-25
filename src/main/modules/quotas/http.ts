// 配额平台共享助手：容错 JSON 读取、带超时 fetch、JWT payload 解码。

import { net } from 'electron'

// 用 Electron net.fetch：走 Chromium 网络栈，自动跟随系统代理（国内访问
// chatgpt.com/cursor.com 等必需）；不可用时回退全局 fetch。
const doFetch: typeof fetch =
  typeof net?.fetch === 'function' ? (net.fetch.bind(net) as typeof fetch) : fetch

export async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<{ status: number; body: unknown; text: string }> {
  const { timeoutMs = 20_000, ...rest } = init
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await doFetch(url, { ...rest, signal: controller.signal })
    const text = await res.text()
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {
      // 非 JSON 响应保留文本
    }
    return { status: res.status, body, text }
  } finally {
    clearTimeout(timer)
  }
}

/** 读取 JSON 文件（键级容错，值不落日志）。路径由调用方保证来源。 */
export function readJsonFile<T>(path: string): T | null {
  try {
    const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs')
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

/** JWT 第二段（payload）解码，用于提取账号标识（如 ChatGPT/Cursor 的 sub）。 */
export function jwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}

export function clampPercent(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10))
}

/** 从对象里按候选键取数值 */
export function pickNumber(obj: unknown, keys: string[]): number | null {
  if (obj == null || typeof obj !== 'object') return null
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v)
  }
  return null
}

/** 从对象里按候选键取字符串 */
export function pickString(obj: unknown, keys: string[]): string | null {
  if (obj == null || typeof obj !== 'object') return null
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k]
    if (typeof v === 'string' && v.trim()) return v
    if (typeof v === 'number') return String(v)
  }
  return null
}

/** 宽容解析时间：epoch 秒/毫秒 或日期字符串 */
export function parseTimeLoose(v: unknown): number | null {
  if (v == null) return null
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v > 1e12) return Math.round(v) // ms
    if (v > 1e9) return Math.round(v * 1000) // s
    return null
  }
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}
