// 数字与时间格式化：数值一律等宽 tabular-nums 呈现（规范 §2.1）。

// 中文数量级（用户口径：16.28B → 162.8亿）；同时是图表轴/标签/图例的统一单位
export function compactNumber(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}万亿`
  if (abs >= 1e8) return `${(n / 1e8).toFixed(1)}亿`
  if (abs >= 1e4) return `${(n / 1e4).toFixed(1)}万`
  return String(Math.round(n))
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
  if (ms == null || ms <= 0) return '无记录'
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

export function shortDir(dir: string | null): string {
  if (!dir) return '—'
  const parts = dir.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : dir
}

export function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id
}
