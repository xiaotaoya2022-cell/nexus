// 自定义弹簧光标配置与持久化工具（移植并适配自 ApiSpace）。
// 通过 localStorage/sessionStorage + CustomEvent 实现设置弹窗与全局挂载点的实时联动。

export const CURSOR_ENABLED_STORAGE_KEY = 'nx.cursor.enabled'
export const CURSOR_SIZE_STORAGE_KEY = 'nx.cursor.size'
export const CURSOR_DEGRADED_STORAGE_KEY = 'nx.cursor.degraded'

export const CURSOR_CONFIG_CHANGED_EVENT = 'nx-cursor-config-changed'
export const CURSOR_DEGRADED_EVENT = 'nx-cursor-degraded-changed'
export const CURSOR_TOAST_EVENT = 'nx-cursor-toast'

export const CURSOR_SIZE_OPTIONS = [12, 16, 20] as const
export type CursorSizeOption = (typeof CURSOR_SIZE_OPTIONS)[number]
export const DEFAULT_CURSOR_SIZE: CursorSizeOption = 12

/** 通知设置 UI 刷新远控降级横幅，而不触发全局挂载点销毁重建 */
export function dispatchCursorDegradedChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(CURSOR_DEGRADED_EVENT))
}

function dispatchCursorConfigChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(CURSOR_CONFIG_CHANGED_EVENT))
}

/** 触发应用内底部 Toast（用于远控自动降级 / 自动恢复提示） */
export function emitCursorToast(message: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<string>(CURSOR_TOAST_EVENT, { detail: message }))
}

/** 总开关读取：缺省视为开启（与 ApiSpace 一致） */
export function readCursorEnabled(): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(CURSOR_ENABLED_STORAGE_KEY) !== '0'
  } catch {
    return true
  }
}

export function writeCursorEnabled(enabled: boolean): void {
  try {
    if (enabled) {
      window.localStorage.removeItem(CURSOR_ENABLED_STORAGE_KEY)
    } else {
      window.localStorage.setItem(CURSOR_ENABLED_STORAGE_KEY, '0')
    }
  } catch {
    // 忽略存储限制，仍通过事件即时生效
  }
  dispatchCursorConfigChanged()
}

export function readCursorSize(): CursorSizeOption {
  if (typeof window === 'undefined') return DEFAULT_CURSOR_SIZE
  try {
    const raw = Number(window.localStorage.getItem(CURSOR_SIZE_STORAGE_KEY))
    return (CURSOR_SIZE_OPTIONS as readonly number[]).includes(raw)
      ? (raw as CursorSizeOption)
      : DEFAULT_CURSOR_SIZE
  } catch {
    return DEFAULT_CURSOR_SIZE
  }
}

export function writeCursorSize(size: number): void {
  if (!(CURSOR_SIZE_OPTIONS as readonly number[]).includes(size)) return
  try {
    if (size === DEFAULT_CURSOR_SIZE) {
      window.localStorage.removeItem(CURSOR_SIZE_STORAGE_KEY)
    } else {
      window.localStorage.setItem(CURSOR_SIZE_STORAGE_KEY, String(size))
    }
  } catch {
    // 忽略存储限制
  }
  dispatchCursorConfigChanged()
}

export function readCursorDegraded(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.sessionStorage.getItem(CURSOR_DEGRADED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function clearCursorDegraded(): void {
  try {
    window.sessionStorage.removeItem(CURSOR_DEGRADED_STORAGE_KEY)
  } catch {
    // 忽略
  }
}
