import { useEffect, useState } from 'react'
import { InstancesPage } from './pages/InstancesPage'
import { ControlPage } from './pages/ControlPage'
import { OverviewPage } from './pages/OverviewPage'
import { SettingsPage } from './pages/SettingsPage'
import { SystemPage } from './pages/SystemPage'
import { useStore } from './lib/store'

const TABS = [
  { key: 'overview', label: '总览' },
  { key: 'system', label: '系统' },
  { key: 'instances', label: '实例' },
  { key: 'control', label: '控制' },
  { key: 'settings', label: '设置' }
] as const

type TabKey = (typeof TABS)[number]['key']

export default function App() {
  const [tab, setTab] = useState<TabKey>('overview')
  const applyConnect = useStore((s) => s.applyConnect)

  // 启动时若已有完整凭据则自动连接
  useEffect(() => {
    const s = useStore.getState().settings
    if (s.host !== '' && s.port !== '' && s.deviceId !== '' && s.token !== '') applyConnect()
  }, [applyConnect])

  return (
    <div className="app">
      <main className="app-body">
        {tab === 'overview' && <OverviewPage />}
        {tab === 'system' && <SystemPage />}
        {tab === 'instances' && <InstancesPage />}
        {tab === 'control' && <ControlPage />}
        {tab === 'settings' && <SettingsPage />}
      </main>
      <nav className="tabbar">
        {TABS.map((t) => (
          <button key={t.key} className={`tab${tab === t.key ? ' active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  )
}
