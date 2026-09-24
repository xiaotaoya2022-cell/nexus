// 展示格式化（数值一律等宽 + tabular-nums，见 theme.css 的 .mono）

export function fmtCompact(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  const abs = Math.abs(n)
  const f = (v: number, digits: 0 | 1) => v.toFixed(digits)
  if (abs >= 1e9) return `${f(n / 1e9, abs >= 1e10 ? 0 : 1)}B`
  if (abs >= 1e6) return `${f(n / 1e6, abs >= 1e7 ? 0 : 1)}M`
  if (abs >= 1e3) return `${f(n / 1e3, abs >= 1e4 ? 0 : 1)}k`
  return String(Math.round(n))
}

export function fmtBytes(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n.toFixed(0)} B`
}

export function fmtBytesRate(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return `${fmtBytes(n)}/s`
}

export function fmtPct(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return `${n.toFixed(0)}%`
}

function pad2(x: number): string {
  return String(x).padStart(2, '0')
}

/** HH:mm:ss（网络热力图列标用） */
export function fmtHms(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** HH:mm */
export function fmtTime(ts: number | string | null | undefined): string {
  if (ts == null) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** MM-DD HH:mm */
export function fmtDateTime(ts: number | string | null | undefined): string {
  if (ts == null) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export function fmtUptime(sec: number | null | undefined): string {
  if (sec == null || Number.isNaN(sec)) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}天${h}时`
  if (h > 0) return `${h}时${m}分`
  return `${m}分`
}

/** 成本展示：$x.xx */
export function fmtUsd(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return `$${n.toFixed(2)}`
}
