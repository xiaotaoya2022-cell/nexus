// SurePoint 自适应表现引擎：热点背景亮度采样（Alpha 合成穿透）+ 滞回防抖。
// 零运行时依赖，框架无关，供全局光标与局部预览光标共用。

export type CursorInkTone = 'dark' | 'light'

/** 滞回阈值：浅底深墨切瓷白 (< 0.36) / 深底瓷白切深墨 (> 0.44)，中间区间维持上一态防抖 */
export const LUMA_TO_LIGHT_THRESHOLD = 0.36
export const LUMA_TO_DARK_THRESHOLD = 0.44

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

/** 解析 Chromium/Electron getComputedStyle().backgroundColor 输出（rgb / rgba / color(srgb ...)） */
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

/** 采样指针热点下方的有效视觉亮度（支持半透明叠加与 data-cursor-tone 显式覆盖） */
export function sampleBackdropLuminance(x: number, y: number): {
  toneHint?: CursorInkTone
  luminance: number
} {
  if (typeof document === 'undefined' || typeof document.elementsFromPoint !== 'function') {
    return { luminance: 1 }
  }

  const stack = document.elementsFromPoint(x, y)
  let accumR = 0
  let accumG = 0
  let accumB = 0
  let remainingAlpha = 1

  for (const el of stack) {
    if (el.classList.contains('nx-cursor') || el.getAttribute('data-slot') === 'smooth-global-cursor') {
      continue
    }

    const explicitTone = el.getAttribute('data-cursor-tone')
    if (explicitTone === 'dark' || explicitTone === 'light') {
      // data-cursor-tone 语义表示“背景是深/浅”，对应光标墨色取反
      const inkForZone: CursorInkTone = explicitTone === 'dark' ? 'light' : 'dark'
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
    const isDarkDoc = document.documentElement.classList.contains('theme-dark')
    const base = isDarkDoc ? 11 : 248
    accumR += base * remainingAlpha
    accumG += base * remainingAlpha
    accumB += base * remainingAlpha
  }

  return { luminance: relativeLuminance(accumR, accumG, accumB) }
}

/** 基于滞回阈值计算下一帧应采用的光标墨色极性 */
export function resolveAdaptiveTone(
  x: number,
  y: number,
  currentTone: CursorInkTone
): CursorInkTone {
  const { toneHint, luminance } = sampleBackdropLuminance(x, y)
  if (toneHint) return toneHint
  if (currentTone === 'dark' && luminance < LUMA_TO_LIGHT_THRESHOLD) return 'light'
  if (currentTone === 'light' && luminance > LUMA_TO_DARK_THRESHOLD) return 'dark'
  return currentTone
}
