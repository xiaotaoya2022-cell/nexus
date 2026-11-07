// 数字/时间格式化。语言相关的量级与相对时间走 i18n（t() 纯函数，非组件可用）。

import { getLang, t } from '../i18n'

export function compactNumber(n: number): string {
  const abs = Math.abs(n)
  if (getLangSafe() === 'en') {
    if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`
    if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`
    if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`
    if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`
    return String(Math.round(n))
  }
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}万亿`
  if (abs >= 1e8) return `${(n / 1e8).toFixed(1)}亿`
  if (abs >= 1e4) return `${(n / 1e4).toFixed(1)}万`
  return String(Math.round(n))
}

function getLangSafe(): string {
  try {
    return getLang()
  } catch {
    return 'zh-CN'
  }
}

export function fullNumber(n: number): string {
  return n.toLocaleString('en-US')
}

export function formatCost(usd: number): string {
  if (usd <= 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1000) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd).toLocaleString('en-US')}`
}

export function formatTime(ms: number | null, todayLabel = true): string {
  if (ms == null || ms <= 0) return '—'
  const d = new Date(ms)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (sameDay && todayLabel) return hhmm
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hhmm}`
}

export function formatDayLabel(day: string): string {
  // YYYY-MM-DD → MM-DD（本年）或 YYYY-MM-DD
  const now = new Date()
  if (day.startsWith(String(now.getFullYear()))) return day.slice(5)
  return day
}

export function relativeTime(ms: number | null): string {
  if (ms == null || ms <= 0) return t('time.noRecord')
  const diff = Date.now() - ms
  if (diff < 60_000) return t('time.justNow')
  if (diff < 3_600_000) return t('time.minutesAgo', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('time.hoursAgo', { n: Math.floor(diff / 3_600_000) })
  return t('time.daysAgo', { n: Math.floor(diff / 86_400_000) })
}

export function shortDir(dir: string | null): string {
  if (!dir) return '—'
  const parts = dir.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : dir
}

export function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id
}
