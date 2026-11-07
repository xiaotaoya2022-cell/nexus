// 轻量 i18n：零依赖 t() + useSyncExternalStore 语言订阅。
// 语言持久化到 localStorage（纯渲染层关注点，不进主进程 settings）。
// key 约定：模块前缀.语义名（header.range.today / settings.retention.hint …）。
// 缺 key 回退链：当前语言 → zh-CN → key 本身；{var} 占位符插值。

import { useSyncExternalStore } from 'react'
import { zhCN } from './zh-CN'
import { en } from './en'

export type Lang = 'zh-CN' | 'en'

const LS_KEY = 'nexus.language'
const DICTS: Record<Lang, Record<string, string>> = { 'zh-CN': zhCN, en }

let current: Lang = 'zh-CN'
try {
  const saved = localStorage.getItem(LS_KEY)
  if (saved === 'zh-CN' || saved === 'en') current = saved
} catch {
  // localStorage 不可用时保持默认
}

const listeners = new Set<() => void>()

export function getLang(): Lang {
  return current
}

export function setLang(l: Lang): void {
  if (l === current) return
  current = l
  try {
    localStorage.setItem(LS_KEY, l)
  } catch {
    // 忽略持久化失败
  }
  listeners.forEach((fn) => fn())
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** 组件内订阅当前语言（切换时触发重渲染）；配合 t() 使用。 */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang)
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const dict = DICTS[current] ?? zhCN
  let s = dict[key] ?? zhCN[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
  }
  return s
}
