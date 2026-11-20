// SurePoint Luminance & Hysteresis Sampler (Zero-Dependency)

export type SurePointTone = 'dark' | 'light'

export interface LuminanceOptions {
  toLightThreshold?: number
  toDarkThreshold?: number
  fallbackDarkBase?: number
  fallbackLightBase?: number
}

export const DEFAULT_TO_LIGHT_THRESHOLD = 0.36
export const DEFAULT_TO_DARK_THRESHOLD = 0.44

interface RgbaColor {
  r: number
  g: number
  b: number
  a: number
}

const srgbToLinear = (c255: number): number => {
  const s = Math.max(0, Math.min(1, c255 / 255))
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

export const relativeLuminance = (r: number, g: number, b: number): number =>
  0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)

export function parseCssColor(raw: string): RgbaColor | null {
  if (!raw || raw === 'transparent') return null

  const rgbMatch = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+%?))?\s*\)$/i.exec(raw)
  if (rgbMatch) {
    const r = Number(rgbMatch[1])
    const g = Number(rgbMatch[2])
    const b = Number(rgbMatch[3])
    let a = 1
    if (rgbMatch[4] !== undefined) {
      a = rgbMatch[4].endsWith('%') ? parseFloat(rgbMatch[4]) / 100 : Number(rgbMatch[4])
    }
    return Number.isFinite(a) ? { r, g, b, a: Math.max(0, Math.min(1, a)) } : null
  }

  const srgbMatch = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/i.exec(raw)
  if (srgbMatch) {
    const r = Number(srgbMatch[1]) * 255
    const g = Number(srgbMatch[2]) * 255
    const b = Number(srgbMatch[3]) * 255
    let a = 1
    if (srgbMatch[4] !== undefined) {
      a = srgbMatch[4].endsWith('%') ? parseFloat(srgbMatch[4]) / 100 : Number(srgbMatch[4])
    }
    return Number.isFinite(a) ? { r, g, b, a: Math.max(0, Math.min(1, a)) } : null
  }

  return null
}

export function sampleBackdropLuminance(
  x: number,
  y: number,
  options: LuminanceOptions = {}
): { toneHint?: SurePointTone; luminance: number } {
  if (typeof document === 'undefined' || typeof document.elementsFromPoint !== 'function') {
    return { luminance: 1 }
  }

  const stack = document.elementsFromPoint(x, y)
  let accumR = 0
  let accumG = 0
  let accumB = 0
  let remainingAlpha = 1

  for (const el of stack) {
    if (el.hasAttribute('data-surepoint-cursor') || el.classList.contains('sp-cursor')) {
      continue
    }

    const explicitTone = el.getAttribute('data-cursor-tone')
    if (explicitTone === 'dark' || explicitTone === 'light') {
      const inkForZone: SurePointTone = explicitTone === 'dark' ? 'light' : 'dark'
      return { toneHint: inkForZone, luminance: explicitTone === 'dark' ? 0.05 : 0.95 }
    }

    const style = window.getComputedStyle(el)
    const parsed = parseCssColor(style.backgroundColor)
    if (!parsed || parsed.a <= 0.01) continue

    const elOpacity = Number(style.opacity)
    const effA = parsed.a * (Number.isFinite(elOpacity) ? Math.max(0, Math.min(1, elOpacity)) : 1)
    if (effA <= 0.01) continue

    accumR += parsed.r * effA * remainingAlpha
    accumG += parsed.g * effA * remainingAlpha
    accumB += parsed.b * effA * remainingAlpha
    remainingAlpha *= 1 - effA

    if (remainingAlpha <= 0.02) break
  }

  if (remainingAlpha > 0) {
    const isDarkDoc = document.documentElement.classList.contains('theme-dark') ||
      document.documentElement.classList.contains('dark')
    const base = isDarkDoc
      ? (options.fallbackDarkBase ?? 11)
      : (options.fallbackLightBase ?? 248)
    accumR += base * remainingAlpha
    accumG += base * remainingAlpha
    accumB += base * remainingAlpha
  }

  return { luminance: relativeLuminance(accumR, accumG, accumB) }
}

export function resolveAdaptiveTone(
  x: number,
  y: number,
  currentTone: SurePointTone,
  options: LuminanceOptions = {}
): SurePointTone {
  const { toneHint, luminance } = sampleBackdropLuminance(x, y, options)
  if (toneHint) return toneHint

  const toLight = options.toLightThreshold ?? DEFAULT_TO_LIGHT_THRESHOLD
  const toDark = options.toDarkThreshold ?? DEFAULT_TO_DARK_THRESHOLD
  if (currentTone === 'dark' && luminance < toLight) return 'light'
  if (currentTone === 'light' && luminance > toDark) return 'dark'
  return currentTone
}
