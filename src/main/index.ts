// Nexus 主进程入口：创建窗口、装配各模块（依赖注入）、启动同步循环。

import { app, BrowserWindow, nativeTheme, Notification } from 'electron'
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
import { QuotaEngine } from './modules/quotas/engine'
import { logger } from './modules/shared/logger'
import { PLATFORM_INTEGRATIONS } from './modules/quotas/platforms/registry'
import { RemoteServer } from './modules/remote/server'
import { registerIpc, broadcastSyncProgress, broadcastMaximizeState } from './ipc/register'

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
    // 应用图标：任务栏/Alt+Tab（安装包图标由 electron-builder 从 build/icon.ico 取）
    icon: join(app.getAppPath(), 'build/icon.ico'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161616' : '#f8f8f8',
    autoHideMenuBar: true,
    show: false,
    // 无边框窗口：自绘顶栏 + 自绘窗口控制钮。
    // 不用 titleBarOverlay——实测 Windows 上 runtime setTitleBarOverlay 更新背景
    // 不可靠（调用成功但 WCO 视觉不刷新，主题切换永远慢半拍）；自绘三钮随渲染层
    // 主题 class 即时变色，彻底同步。
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  // 导航锁定：任何导航/新窗口一律阻止（外链走 shell.openExternal）
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost:') && !url.startsWith('file://')) e.preventDefault()
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // 自绘窗口控制钮：最大化状态变化 → 渲染层切换图标
  mainWindow.on('maximize', () => broadcastMaximizeState(mainWindow, true))
  mainWindow.on('unmaximize', () => broadcastMaximizeState(mainWindow, false))
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
          await mainWindow.webContents.executeJavaScript(
            `window.scrollTo(0, 0); document.querySelector('main')?.scrollTo(0, ${process.env.NEXUS_CAPTURE_SCROLL === 'bottom' ? '999999' : '0'}); true`,
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
                const filtered = document.body.innerText.includes('已筛选')
                return {
                  filtered,
                  localStorage: JSON.stringify(localStorage),
                  sel: sel ? sel.toString().slice(0, 80) : null,
                  count: out.length,
                  items: out.slice(0, 12)
                }
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

  // WCO 窗口控制钮区域颜色跟随主题（含启动与运行中切换；updated 在 themeSource 变化时触发）
  // WCO 已移除（自绘窗口控制钮随渲染层主题即时变色），无需原生 overlay 同步

  const adapters = createAdapters(store)
  const query = new QueryService(store)

  // 看板缓存：sync 有新数据即失效；随后 3s 错峰预热常用范围（7天+全部），
  // 让用户切范围基本命中内存（0ms）。预热本身 ~0.7s，撞上用户点击的概率 <2%。
  let boardWarmer: NodeJS.Timeout | null = null
  const onSyncDone = (): void => {
    query.invalidateBoardCache()
    if (boardWarmer) clearTimeout(boardWarmer)
    boardWarmer = setTimeout(() => {
      boardWarmer = null
      try {
        const saved = store?.getSetting('range')
        const preferred = saved === 'today' || saved === '7d' || saved === '30d' || saved === 'month' || saved === 'year' || saved === 'all' ? saved : '7d'
        query.getBoard(preferred, null)
        if (preferred !== 'all') query.getBoard('all', null)
      } catch {
        // 预热失败静默，用户点击时现算
      }
    }, 3000)
  }
  sync = new SyncService(store, adapters, (p) => {
    broadcastSyncProgress(mainWindow, p)
    if (p.phase === 'done') onSyncDone()
  })

  // v2：系统采集 / 多开实例 / DSH 桥接 / 远程服务
  const system = new SystemCollector()
  const zcode = new ZcodeManager()
  const dsh = new DshBridge()
  const cockpit = new CockpitBridge()
  const quota = new QuotaEngine(app.getPath('userData'), (key) => store?.getSetting(key) ?? null, (views) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('nexus:quota-update', views)
    }
    remote.broadcastPush('quota', views)
  }, (alert) => {
    // 系统通知 + 远程告警通道
    try {
      new Notification({ title: alert.title, body: alert.body }).show()
    } catch {
      // 通知失败不影响主流程
    }
    remote.broadcastPush('alert', alert)
  })
  quota.registerIntegrations(PLATFORM_INTEGRATIONS)
  // 账号级每日真实消耗（官方账单）落 Nexus 库
  quota.setUsageSink((platform, accountId, rows) => {
    try {
      store?.upsertAccountUsage(platform, accountId, rows)
    } catch (err) {
      logger.warn('quota.usage_sink_failed', { platform, error: err instanceof Error ? err.message : String(err) })
    }
    // 官方账单合成 usage_records 行 → 进主看板"Token 消耗"总账。
    // 防重：dedupeKey = bill:<账号ID>:<日>:<模型> —— 同账号退出重登（accountId 稳定）、
    // 国内/国际双入口登录同一账号，都会命中同一条 dedupe_key，upsert 幂等不重复。
    // credits 口径（tokens=0）不落 token 行，只在账号面板展示。
    try {
      const billRows: Parameters<NexusStore['insertUsage']>[0] = []
      for (const row of rows) {
        if (row.tokens <= 0) continue
        const dayMs = Date.parse(`${row.day}T12:00:00+08:00`)
        if (!Number.isFinite(dayMs)) continue
        const models = row.models && Object.keys(row.models).length > 0 ? row.models : null
        if (models) {
          for (const [model, m] of Object.entries(models)) {
            if (m.input + m.output <= 0) continue
            billRows.push({
              agent: platform,
              model,
              provider: 'official-bill',
              ts: dayMs,
              inputTokens: m.input,
              outputTokens: m.output,
              reasoningTokens: 0,
              cacheReadTokens: m.cacheRead,
              cacheWriteTokens: 0,
              sessionId: null,
              dedupeKey: `bill:${accountId}:${row.day}:${model}`,
              isEstimated: false,
              requests: m.requests
            })
          }
        } else {
          billRows.push({
            agent: platform,
            model: 'unknown',
            provider: 'official-bill',
            ts: dayMs,
            inputTokens: row.tokens,
            outputTokens: 0,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            sessionId: null,
            dedupeKey: `bill:${accountId}:${row.day}`,
            isEstimated: false,
            requests: row.requests
          })
        }
      }
      if (billRows.length > 0) store?.insertUsage(billRows)
    } catch (err) {
      logger.warn('quota.usage_sink_failed', { platform, error: err instanceof Error ? err.message : String(err) })
    }
  })
  quota.setEarliestDayQuery(
    (platform, accountId) => store?.earliestAccountUsageDay(platform, accountId) ?? null
  )
  let remoteSecret = store.getSetting('remoteSecret')
  if (!remoteSecret) {
    remoteSecret = randomBytes(32).toString('hex')
    store.setSetting('remoteSecret', remoteSecret)
  }
  const remote = new RemoteServer(
    { store, query, system, zcode, dsh, userDataDir: app.getPath('userData') },
    remoteSecret
  )

  registerIpc({ store, query, sync, adapters, presence: PRESENCE_ONLY_AGENTS, system, zcode, dsh, cockpit, quota, remote, getMainWindow: () => mainWindow })

  quota.startPolling()

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
