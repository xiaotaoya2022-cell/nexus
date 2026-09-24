// 冒烟验证入口（不进 UI）：同步全部适配器 → 跑一遍查询服务 → 打印结果后退出。
// 运行：npx electron out/main/smoke.js
// 使用临时库文件，不触碰正式 userData 数据库。

import { app } from 'electron'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { NexusStore } from './modules/aggregator/infrastructure/store'
import { createAdapters, PRESENCE_ONLY_AGENTS } from './modules/adapter/application/registry'
import { SyncService } from './modules/aggregator/application/sync-service'
import { QueryService } from './modules/aggregator/application/query-service'

async function main(): Promise<void> {
  const dbPath = join(app.getPath('temp'), `nexus-smoke-${process.pid}.db`)
  rmSync(dbPath, { force: true })
  rmSync(`${dbPath}-wal`, { force: true })
  rmSync(`${dbPath}-shm`, { force: true })
  console.log('[smoke] db:', dbPath)

  const store = new NexusStore(dbPath)
  const adapters = createAdapters(store)
  const sync = new SyncService(store, adapters, () => {})
  const t0 = Date.now()
  const status = await sync.syncNow()
  console.log(`[smoke] sync done in ${Date.now() - t0}ms`)
  for (const r of status.results) {
    console.log(
      `[smoke]   ${r.agent}: records=${r.records} sessions=${r.sessions} tools=${r.tools}${r.error ? ` ERROR=${r.error}` : ''}`
    )
  }

  const q = new QueryService(store)
  const overview = q.getOverview('7d', null)
  console.log('[smoke] overview 7d:', JSON.stringify(overview))
  const trend = q.getTrend('7d', null, 'model')
  console.log('[smoke] trend 7d buckets:', trend.length, 'first:', JSON.stringify(trend[0]))
  console.log('[smoke] byAgent 30d:', JSON.stringify(q.getByAgent('30d').slice(0, 5)))
  console.log('[smoke] byModel 30d top3:', JSON.stringify(q.getByModel('30d', null).slice(0, 3)))
  console.log('[smoke] breakdown:', JSON.stringify(q.getTokenTypeBreakdown('30d', null)))
  const heat = q.getHeatmap('30d', null)
  console.log('[smoke] heatmap cells:', heat.cells.length, 'max:', heat.max)
  console.log('[smoke] calendar days:', q.getCalendar('30d', null).length)
  console.log('[smoke] tools:', JSON.stringify(q.getToolStats('30d', null).slice(0, 5)))
  console.log('[smoke] sessions top5:', JSON.stringify(q.getSessions('30d', null, 5).map((s) => ({ a: s.agent, t: s.tokens }))))
  console.log('[smoke] all-time overview:', JSON.stringify(q.getOverview('all', null)))

  store.close()
  rmSync(dbPath, { force: true })
  rmSync(`${dbPath}-wal`, { force: true })
  rmSync(`${dbPath}-shm`, { force: true })
  console.log(`[smoke] presence: ${PRESENCE_ONLY_AGENTS.map((p) => p.id).join(',')}`)
  console.log('[smoke] PASS')
  app.exit(0)
}

void app.whenReady().then(() => {
  main().catch((err) => {
    console.error('[smoke] FAIL', err)
    app.exit(1)
  })
})
