import { useEffect } from 'react'
import { createSurePoint, type SurePointOptions } from '../core/pointerEngine'

export interface SurePointCursorProps extends SurePointOptions {
  /** Toggle adaptive pointer on/off without unmounting parent */
  enabled?: boolean
  /** External busy/loading lift state to temporarily yield OS pointer */
  lifted?: boolean
}

export function SurePointCursor({
  enabled = true,
  lifted = false,
  ...options
}: SurePointCursorProps): null {
  useEffect(() => {
    if (!enabled) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const coarse = window.matchMedia('(pointer: coarse)')
    if (reduced.matches || coarse.matches) return

    const instance = createSurePoint(options)
    if (lifted) instance.setExternalLift(true)
    return () => instance.destroy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, options.size, options.jumpThresholdPx])

  return null
}
