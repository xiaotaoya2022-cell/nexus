// 远程服务端到端自测入口：起 store/system/zcode/dsh/remote，开启服务，
// 把端口与 PIN 写到临时文件，供 ws 客户端脚本完成配对→鉴权→订阅→取数闭环。

import { app, powerSaveBlocker } from 'electron'
import { join } from 'node:path'
import { writeFileSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { NexusStore } from './modules/aggregator/infrastructure/store'
import { QueryService } from './modules/aggregator/application/query-service'
import { SystemCollector } from './modules/system/collector'
import { ZcodeManager } from './modules/zcode/manager'
import { DshBridge } from './modules/dsh/bridge'
import { RemoteServer } from './modules/remote/server'

async function main(): Promise<void> {
  // 无窗口 Electron 会被 Chromium 后台节流定时器：测试期间阻止挂起
  const blocker = powerSaveBlocker.start('prevent-app-suspension')
  const dir = app.getPath('temp')
  const dbPath = join(dir, `nexus-remote-smoke-${process.pid}.db`)
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true })

  const store = new NexusStore(dbPath)
  const query = new QueryService(store)
  const system = new SystemCollector()
  const zcode = new ZcodeManager()
  const dsh = new DshBridge()
  const secret = randomBytes(32).toString('hex')
  const paired = new Promise<string>((resolve) => {
    const remote = new RemoteServer(
      {
        store,
        query,
        system,
        zcode,
        dsh,
        userDataDir: dir,
        onPaired: (deviceId) => resolve(deviceId)
      },
      secret
    )
    remote.start()
    ;(globalThis as { __remote?: RemoteServer }).__remote = remote
  })

  // 等端口就绪
  const remote = (globalThis as { __remote?: RemoteServer }).__remote as RemoteServer
  for (let i = 0; i < 50 && remote.status().port == null; i++) {
    await new Promise((r) => setTimeout(r, 100))
  }
  const port = remote.status().port
  if (port == null) throw new Error('端口未就绪')
  const pairing = await remote.regeneratePairing()
  const infoPath = join(dir, `nexus-remote-smoke-${process.pid}.json`)
  writeFileSync(
    infoPath,
    JSON.stringify({ port, pin: pairing.pin, nonce: pairing.nonce, pairingSecret: pairing.pairingSecret })
  )
  console.log(`[remote-smoke] ready port=${port} info=${infoPath}`)

  // 事件驱动等待配对（避免后台定时器节流误判）
  const deviceId = await Promise.race([
    paired,
    new Promise<string>((_, reject) => setTimeout(() => reject(new Error('客户端未在时限内完成配对')), 60_000))
  ])
  console.log(`[remote-smoke] PAIRED_AND_AUTHED deviceId=${deviceId}`)
  // 等客户端完成重连鉴权 + 订阅 + 取数并主动断开（无窗口 Electron 定时器被节流，按条件等待）
  await remote.waitForIdle(60_000)
  console.log('[remote-smoke] client disconnected')
  remote.stop()
  powerSaveBlocker.stop(blocker)
  store.close()
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true })
  rmSync(infoPath, { force: true })
  console.log('[remote-smoke] PASS')
  app.exit(0)
}

void app.whenReady().then(() => {
  main().catch((err) => {
    console.error('[remote-smoke] FAIL', err)
    app.exit(1)
  })
})
