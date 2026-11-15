// 托盘图标按 DPI 物理像素尺寸与 Windows 任务栏明暗主题加载，避免 Windows 高分屏模糊放大与明暗对比失效。

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, nativeImage, nativeTheme, screen, systemPreferences, type Tray } from 'electron'
import { logger } from './modules/shared/logger'

export const TRAY_ICON_SIZES = [16, 20, 24, 28, 32, 36, 40, 48] as const
const REG_PERSONALIZE_KEY = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
const THEME_RECHECK_COOLDOWN_MS = 20_000

export type TrayInkVariant = 'dark' | 'light'

/** 将 `16 * scaleFactor` 对齐到预烘焙最清晰的物理像素档位（覆盖 100%~300% DPI） */
export function pickTrayPixelSize(scaleFactor: number): number {
  const safeScale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1
  const desired = Math.max(16, Math.round(16 * safeScale))
  let best: number = TRAY_ICON_SIZES[0]
  let bestDiff = Math.abs(best - desired)
  for (const s of TRAY_ICON_SIZES) {
    const diff = Math.abs(s - desired)
    if (diff < bestDiff) {
      best = s
      bestDiff = diff
    }
  }
  return best
}

function queryWindowsSystemLightTheme(): Promise<boolean | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(
      'reg.exe',
      ['query', REG_PERSONALIZE_KEY, '/v', 'SystemUsesLightTheme'],
      { timeout: 1500, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(null)
          return
        }
        const m = /REG_DWORD\s+0x([0-9a-fA-F]+)/i.exec(stdout)
        if (!m) {
          resolve(null)
          return
        }
        resolve(parseInt(m[1], 16) !== 0)
      }
    )
  })
}

function resolveTrayAssetPath(variant: TrayInkVariant, px: number): string | null {
  const fileName = `tray-${variant}-${px}.png`
  const candidates = [
    join(app.getAppPath(), 'build', 'tray', fileName),
    join(process.resourcesPath ?? '', 'tray', fileName),
    join(process.resourcesPath ?? '', 'build', 'tray', fileName)
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

function getTrayMetrics(): { scaleFactor: number; px: number } {
  try {
    const scaleFactor = screen.getPrimaryDisplay().scaleFactor || 1
    return { scaleFactor, px: pickTrayPixelSize(scaleFactor) }
  } catch {
    return { scaleFactor: 1, px: 16 }
  }
}

export function loadTrayIconImage(
  isLightTaskbar: boolean,
  fallbackIconPath: string,
  fallbackDataUrl: string
): { image: Electron.NativeImage; px: number; variant: TrayInkVariant } {
  const { scaleFactor, px } = getTrayMetrics()
  const variant: TrayInkVariant = isLightTaskbar ? 'dark' : 'light'
  const assetPath = resolveTrayAssetPath(variant, px)

  let img: Electron.NativeImage | null = null
  if (assetPath) {
    try {
      // 从精确物理尺寸 PNG 构造 NativeImage，确保 Win32 GetHICON(SM_CXSMICON) 零缩放失真
      const buf = readFileSync(assetPath)
      const parsed = nativeImage.createFromBuffer(buf)
      if (!parsed.isEmpty()) img = parsed
    } catch {
      img = null
    }
  }

  if (!img || img.isEmpty()) {
    const raw = existsSync(fallbackIconPath)
      ? nativeImage.createFromPath(fallbackIconPath)
      : nativeImage.createEmpty()
    if (!raw.isEmpty()) {
      img = raw.resize({ width: px, height: px })
      logger.warn('icon.tray_asset_fallback', { variant, px, fallbackIconPath })
    } else {
      logger.error('icon.tray_load_failed', { assetPath, fallbackIconPath })
      img = nativeImage.createFromDataURL(fallbackDataUrl)
    }
  } else {
    logger.info('icon.tray_loaded', {
      path: assetPath,
      variant,
      px,
      scaleFactor,
      w: img.getSize().width,
      h: img.getSize().height
    })
  }

  return { image: img, px, variant }
}

export interface TrayAppearanceController {
  initialImage: Electron.NativeImage
  maybeRefresh: () => void
  dispose: () => void
}

/** 创建托盘图标并监听 DPI / Windows 任务栏明暗模式变化，自动切换最清晰高对比版本 */
export function initTrayAppearance(
  getTray: () => Tray | null,
  fallbackIconPath: string,
  fallbackDataUrl: string
): TrayAppearanceController {
  let isLightTaskbar = !nativeTheme.shouldUseDarkColors
  const first = loadTrayIconImage(isLightTaskbar, fallbackIconPath, fallbackDataUrl)
  let appliedVariant: TrayInkVariant = first.variant
  let appliedPx: number = first.px
  let lastQueryAt = 0
  let queryInFlight = false
  let disposed = false

  const applyIfChanged = (): void => {
    if (disposed) return
    const tray = getTray()
    if (!tray) return
    const { px } = getTrayMetrics()
    const nextVariant: TrayInkVariant = isLightTaskbar ? 'dark' : 'light'
    if (px === appliedPx && nextVariant === appliedVariant) return
    const loaded = loadTrayIconImage(isLightTaskbar, fallbackIconPath, fallbackDataUrl)
    appliedVariant = loaded.variant
    appliedPx = loaded.px
    tray.setImage(loaded.image)
  }

  const syncTaskbarThemeAsync = (force = false): void => {
    if (disposed || process.platform !== 'win32' || queryInFlight) return
    const now = Date.now()
    if (!force && now - lastQueryAt < THEME_RECHECK_COOLDOWN_MS) return
    lastQueryAt = now
    queryInFlight = true
    void queryWindowsSystemLightTheme()
      .then((regLight) => {
        if (disposed || regLight === null) return
        isLightTaskbar = regLight
        applyIfChanged()
      })
      .finally(() => {
        queryInFlight = false
      })
  }

  const onDisplayMetricsChanged = (): void => applyIfChanged()
  const onNativeThemeUpdated = (): void => {
    isLightTaskbar = !nativeTheme.shouldUseDarkColors
    applyIfChanged()
    syncTaskbarThemeAsync(true)
  }
  const onAccentColorChanged = (): void => syncTaskbarThemeAsync(true)

  screen.on('display-metrics-changed', onDisplayMetricsChanged)
  nativeTheme.on('updated', onNativeThemeUpdated)
  if (process.platform === 'win32') {
    systemPreferences.on('accent-color-changed', onAccentColorChanged)
  }
  // 异步校正混合主题（例如 Windows 深色任务栏 + 浅色应用模式）
  syncTaskbarThemeAsync(true)

  return {
    initialImage: first.image,
    maybeRefresh: () => syncTaskbarThemeAsync(false),
    dispose: () => {
      disposed = true
      screen.off('display-metrics-changed', onDisplayMetricsChanged)
      nativeTheme.off('updated', onNativeThemeUpdated)
      if (process.platform === 'win32') {
        systemPreferences.off('accent-color-changed', onAccentColorChanged)
      }
    }
  }
}
