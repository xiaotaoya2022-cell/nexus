// 无头 Mesh 采集端运行器（纯 Node 实现，零 Electron 依赖）：
// 供 Linux VM / WSL2 / 纯终端环境直接采集本机 Agent 用量并增量推送至 Hub。

import os from 'node:os'
import { join } from 'node:path'
import { NexusStore } from '@main/modules/aggregator/infrastructure/store'
import { createAdapters } from '@main/modules/adapter/application/registry'
import { SyncService } from '@main/modules/aggregator/application/sync-service'
import { SystemCollector } from '@main/modules/system/collector'
import { logger, setLogDir } from '@main/modules/shared/logger'
import { NodeIdentityService } from './identity'
import { MeshClient } from './client'

export interface HeadlessMeshOptions {
  dataDir: string
  pairUri?: string
  alias?: string
  intervalSec: number
  once: boolean
}

export function parseHeadlessMeshArgs(argv: string[]): { help: boolean; options: HeadlessMeshOptions } {
  let dataDir = join(os.homedir() || os.tmpdir(), '.nexus-mesh')
  let pairUri: string | undefined
  let alias: string | undefined
  let intervalSec = 30
  let once = false
  let help = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      help = true
    } else if (arg === '--once') {
      once = true
    } else if (arg === '--data-dir' && argv[i + 1]) {
      dataDir = argv[++i]
    } else if (arg.startsWith('--data-dir=')) {
      dataDir = arg.slice('--data-dir='.length)
    } else if (arg === '--pair' && argv[i + 1]) {
      pairUri = argv[++i]
    } else if (arg.startsWith('--pair=')) {
      pairUri = arg.slice('--pair='.length)
    } else if (arg === '--alias' && argv[i + 1]) {
      alias = argv[++i]
    } else if (arg.startsWith('--alias=')) {
      alias = arg.slice('--alias='.length)
    } else if (arg === '--interval' && argv[i + 1]) {
      const n = Number(argv[++i])
      if (Number.isFinite(n) && n >= 5) intervalSec = Math.round(n)
    } else if (arg.startsWith('--interval=')) {
      const n = Number(arg.slice('--interval='.length))
      if (Number.isFinite(n) && n >= 5) intervalSec = Math.round(n)
    }
  }

  return {
    help,
    options: { dataDir, pairUri, alias, intervalSec, once }
  }
}

export function printHeadlessUsage(): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      'Nexus Headless Mesh Agent',
      '',
      'Usage:',
      '  node out/main/mesh-agent.js [options]',
      '  nexus --headless-mesh [options]',
      '',
      'Options:',
      '  --data-dir <path>   本地数据库与日志目录（默认 ~/.nexus-mesh）',
      '  --pair <uri>        使用 nexus-pair://... 配对串绑定并连入主 Hub',
      '  --alias <name>      设置本机节点友好别名（如 Ubuntu-WSL2）',
      '  --interval <sec>    本地扫描推送周期秒数（默认 30，最小 5）',
      '  --once              执行一次全量扫描与增量推送后立即退出',
      '  --help, -h          显示本帮助'
    ].join('\n')
  )
}

export async function runHeadlessMeshAgent(opts: HeadlessMeshOptions): Promise<void> {
  setLogDir(opts.dataDir)
  const dbPath = join(opts.dataDir, 'nexus-mesh.db')
  const store = new NexusStore(dbPath)
  const adapters = createAdapters(store)
  const system = new SystemCollector()
  const identity = new NodeIdentityService(store)
  await identity.probeKind()
  if (opts.alias) identity.setAlias(opts.alias)
  identity.setRoleOverride('spoke')

  const getActiveAgents = (): string[] => adapters.filter((a) => a.detect()).map((a) => a.id)
  const client = new MeshClient(store, identity, system, getActiveAgents)
  const sync = new SyncService(store, adapters, () => {})

  // eslint-disable-next-line no-console
  console.log(
    `[mesh-agent] nodeId=${identity.nodeId} kind=${identity.getKind()} host=${os.hostname()} db=${dbPath}`
  )

  try {
    if (opts.pairUri) {
      await client.pairWithHub({ uri: opts.pairUri })
      // eslint-disable-next-line no-console
      console.log(`[mesh-agent] paired with Hub: ${client.loadConfig()?.hubUrl ?? 'ok'}`)
    } else {
      const cfg = client.loadConfig()
      if (!cfg) {
        throw new Error('尚未配对 Hub：请通过 --pair "nexus-pair://..." 完成首次配对')
      }
      client.start()
    }

    // 先做一次本地适配器同步，再增量推流至 Hub
    await sync.syncNow()
    // 等候已有配置生效连线（非 pair 首次启动时短等握手完成）
    for (let i = 0; i < 40 && !client.status()?.connected; i++) {
      await new Promise((r) => setTimeout(r, 150))
    }
    const pushRes = await client.syncDelta()
    // eslint-disable-next-line no-console
    console.log(
      `[mesh-agent] sync done pushed=${pushRes.pushed} watermark=${JSON.stringify(pushRes.watermark)}`
    )

    if (opts.once) {
      client.stop()
      sync.dispose()
      store.close()
      return
    }

    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        void (async () => {
          try {
            await sync.syncNow()
            const delta = await client.syncDelta()
            if (delta.pushed > 0) {
              // eslint-disable-next-line no-console
              console.log(`[mesh-agent] pushed=${delta.pushed} usageId=${delta.watermark.usageId}`)
            }
          } catch (err) {
            logger.warn('mesh_agent.loop_failed', { error: err instanceof Error ? err.message : String(err) })
          }
        })()
      }, opts.intervalSec * 1000)

      const shutdown = (): void => {
        clearInterval(timer)
        client.stop()
        sync.dispose()
        store.close()
        resolve()
      }
      process.once('SIGINT', shutdown)
      process.once('SIGTERM', shutdown)
    })
  } catch (err) {
    client.stop()
    sync.dispose()
    store.close()
    throw err
  }
}
