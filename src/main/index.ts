// Nexus 主进程入口：创建窗口、装配各模块（依赖注入）、启动同步循环。

import { app, BrowserWindow, nativeTheme } from 'electron'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { NexusStore } from './modules/aggregator/infrastructure/store'
import { createAdapters, PRESENCE_ONLY_AGENTS } from './modules/adapter/application/registry'
import { SyncService } from './modules/aggregator/application/sync-service'
import { QueryService } from './modules/aggregator/application/query-service'
import { SystemCollector } from './modules/system/collector'
import { ZcodeManager } from './modules/zcode/manager'
import { DshBridge } from './modules/dsh/bridge'
import { CockpitBridge } from './modules/cockpit/bridge'
import { RemoteServer } from './modules/remote/server'
import { registerIpc, broadcastSyncProgress } from './ipc/register'
import { logger } from './modules/shared/logger'

let mainWindow: BrowserWindow | null = null
let store: NexusStore | null = null
let sync: SyncService | null = null

/**
 * 一次性迁移（蓝队 F4）：旧版 codex 适配器用畸形文件名回退 id 落库，
 * 存量 session_id 与新正则/缓存口径不连续。清空 codex 数据与游标，
 * 下一次同步自动全量重读（session_meta 给出真实 id）。settings 标记保证只执行一次。
 */
function remigrateCodexIfFlagged(store: NexusStore): void {
  if (store.getSetting('codexRemigratedV2') === '1') return
  store.db.prepare("DELETE FROM usage_records WHERE agent = 'codex'").run()
  store.db.prepare("DELETE FROM sessions WHERE agent = 'codex'").run()
  store.db.prepare("DELETE FROM sync_state WHERE agent = 'codex'").run()
  store.setSetting('codexRemigratedV2', '1')
  logger.info('migration.codex_remigrated')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1080,
    minHeight: 680,
    title: 'Nexus',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161616' : '#f8f8f8',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  // 诊断辅助：NEXUS_DEBUG=1 时转发渲染进程控制台与加载错误到主进程 stdout
  if (process.env.NEXUS_DEBUG) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`)
    })
    mainWindow.webContents.on('preload-error', (_e, path, error) => {
      console.error(`[preload-error] ${path}: ${String(error)}`)
    })
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error(`[did-fail-load] ${code} ${desc} ${url}`)
    })
  }
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // 视觉验收辅助：NEXUS_CAPTURE=<png路径> 启动后自动截图并退出
  const capturePath = process.env.NEXUS_CAPTURE
  if (capturePath) {
    mainWindow.once('ready-to-show', () => {
      setTimeout(() => {
        void (async () => {
          if (!mainWindow) return
          const scroll =
            process.env.NEXUS_CAPTURE_SCROLL === 'bottom'
              ? 'document.body.scrollHeight'
              : '0'
          await mainWindow.webContents.executeJavaScript(
            `window.scrollTo(0, 0); document.querySelector('main')?.scrollTo(0, ${scroll === '0' ? '0' : '999999'}); true`,
            true
          )
          await new Promise((r) => setTimeout(r, 300))
          const image = await mainWindow.webContents.capturePage()
          if (process.env.NEXUS_PROBE) {
            const probe = await mainWindow.webContents.executeJavaScript(
              `(() => {
                const out = []
                const sel = window.getSelection()
                document.querySelectorAll('h2, header span, h2 ~ *').forEach((el) => {
                  const cs = getComputedStyle(el)
                  if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || (sel && sel.containsNode(el, true))) {
                    out.push({ tag: el.tagName, text: (el.textContent || '').slice(0, 24), bg: cs.backgroundColor, class: el.className.slice(0, 60), selected: sel ? sel.containsNode(el, true) : false })
                  }
                })
                return { sel: sel ? sel.toString().slice(0, 80) : null, count: out.length, items: out.slice(0, 12) }
              })()`,
              true
            )
            console.log(`[probe] ${JSON.stringify(probe, null, 1)}`)
          }
          const { promises } = await import('node:fs')
          await promises.writeFile(capturePath, image.toPNG())
          console.log(`[capture] saved: ${capturePath}`)
          app.exit(0)
        })()
      }, Number(process.env.NEXUS_CAPTURE_DELAY_MS) || 8000)
    })
  }
}

// 单实例锁（红队 N-14）：双开会导致双份同步循环互踩 sync_state
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

if (process.env.NEXUS_CAPTURE) {
  // 截图验证场景禁用 GPU 合成，避免 capturePage 出现图层伪影
  app.disableHardwareAcceleration()
}

app.whenReady()
  .then(() => {
  const dbPath = join(app.getPath('userData'), 'nexus.db')
  store = new NexusStore(dbPath)
  logger.info('store.ready', { dbPath })
  remigrateCodexIfFlagged(store)

  const theme = store.getSetting('theme')
  nativeTheme.themeSource = theme === 'light' ? 'light' : 'dark'

  const adapters = createAdapters(store)
  const query = new QueryService(store)
  sync = new SyncService(store, adapters, (p) => broadcastSyncProgress(mainWindow, p))

  // v2：系统采集 / 多开实例 / DSH 桥接 / 远程服务
  const system = new SystemCollector()
  const zcode = new ZcodeManager()
  const dsh = new DshBridge()
  const cockpit = new CockpitBridge()
  let remoteSecret = store.getSetting('remoteSecret')
  if (!remoteSecret) {
    remoteSecret = randomBytes(32).toString('hex')
    store.setSetting('remoteSecret', remoteSecret)
  }
  const remote = new RemoteServer(
    { store, query, system, zcode, dsh, userDataDir: app.getPath('userData') },
    remoteSecret
  )

  registerIpc({ store, query, sync, adapters, presence: PRESENCE_ONLY_AGENTS, system, zcode, dsh, cockpit, remote, getMainWindow: () => mainWindow })

  if (store.getSetting('remoteEnabled') === '1') {
    remote.start()
  }

  createWindow()
  sync.startBackgroundLoop()
  mainWindow?.webContents.on('did-finish-load', () => {
    broadcastSyncProgress(mainWindow, sync?.getStatus() ?? { phase: 'idle', agent: null, message: '', startedAt: 0, finishedAt: null, results: [] })
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  })
  .catch((err) => {
    // 启动失败（如 nexus.db 损坏/被占用）必须可见，不能无声无息（红队 N-08）
    const message = err instanceof Error ? err.message : String(err)
    logger.error('app.startup_failed', { error: message })
    // dialog 需要延迟到 app 就绪后；此处已处于 whenReady 链内
    void import('electron').then(({ dialog }) => {
      dialog.showErrorBox('Nexus 启动失败', message)
      app.exit(1)
    })
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  sync?.dispose()
  store?.close()
})
