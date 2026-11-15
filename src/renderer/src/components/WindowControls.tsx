// 自绘窗口控制钮：最小化/最大化/关闭（frame:false）。
// 随渲染层主题 class 即时变色（原生 WCO 的 runtime 更新不可靠，已弃用）。

import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { nexus } from '../lib/api'
import { t, useLang } from '../i18n'

const BTN = 'flex h-12 w-8 xl:w-9 2xl:w-11 shrink-0 items-center justify-center text-foreground-subtle transition-colors duration-150'

function MinIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path d="M2 6h8" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function MaxIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <rect x="2.5" y="2.5" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function RestoreIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <rect x="2" y="4" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.2 2.5h4.3a1 1 0 0 1 1 1v4.3" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function CloseIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path d="m2.5 2.5 7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

export function WindowControls(): JSX.Element {
  useLang() // 语言切换时重渲染
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void nexus.isMaximized().then(setMaximized)
    return nexus.onMaximizeChange(setMaximized)
  }, [])

  return (
    <div className="flex shrink-0 items-stretch" data-no-drag="">
      <button
        type="button"
        title={t('win.minimize')}
        aria-label={t('win.minimize')}
        onClick={() => void nexus.minimizeWindow()}
        className={`${BTN} hover:bg-hover hover:text-foreground`}
      >
        <MinIcon />
      </button>
      <button
        type="button"
        title={maximized ? t('win.restore') : t('win.maximize')}
        aria-label={maximized ? t('win.restore') : t('win.maximize')}
        onClick={() => void nexus.toggleMaximizeWindow()}
        className={`${BTN} hover:bg-hover hover:text-foreground`}
      >
        {maximized ? <RestoreIcon /> : <MaxIcon />}
      </button>
      <button
        type="button"
        title={t('win.close')}
        aria-label={t('win.close')}
        onClick={() => void nexus.closeWindow()}
        className={`${BTN} hover:bg-destructive hover:text-white`}
      >
        <CloseIcon />
      </button>
    </div>
  )
}
