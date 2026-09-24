// 远程服务自测客户端：配对 → 鉴权 → 订阅 → 请求（node scripts/remote-client-test.js <info.json>）
// 由 remote-smoke.ts 的主进程配套使用：从临时 json 读取 port/pin（仅允许 tmpdir 内路径）。
const WebSocket = require('ws')
const { readFileSync } = require('node:fs')
const { resolve, sep, isAbsolute } = require('node:path')
const os = require('node:os')

const RAW = process.argv[2] || ''
const TMP = resolve(os.tmpdir())
const infoPath = isAbsolute(RAW) && !RAW.includes('..') ? resolve(RAW) : null
if (!infoPath || !(infoPath === TMP || infoPath.startsWith(TMP + sep))) {
  console.error('[client] info 路径必须在系统临时目录内')
  process.exit(1)
}
const { port, pin } = JSON.parse(readFileSync(infoPath, 'utf8'))
console.log(`[client] T0 启动 port=${port} pin=${pin}`)

let reqId = 0
const pending = new Map()
const ws = new WebSocket(`ws://127.0.0.1:${port}`)

function req(method, payload) {
  return new Promise((resolve, reject) => {
    const id = `req_${++reqId}`
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ v: 1, type: 'req', id, method, payload }))
    setTimeout(() => reject(new Error(`${method} 超时`)), 25000)
  })
}

ws.on('message', (data) => {
  const frame = JSON.parse(data.toString('utf8'))
  if (frame.type === 'res' && pending.has(frame.id)) {
    const { resolve: res, reject } = pending.get(frame.id)
    pending.delete(frame.id)
    frame.ok ? res(frame.payload) : reject(new Error(frame.error))
  } else if (frame.type === 'push') {
    console.log(`[client] push ${frame.ch} 收到（payload ${JSON.stringify(frame.payload).length}B）`)
  }
})

function fail(step, err) {
  console.error(`[client] FAIL at ${step}:`, err.message || err)
  process.exit(1)
}

async function main() {
  // open 事件已在模块级触发 main()，此处无需再等待

  // 1) 未鉴权请求应被拒
  try {
    await req('agent.overview', { range: '7d' })
    fail('unauthorized-check', new Error('未鉴权请求竟成功'))
  } catch {
    console.log('[client] 未鉴权拒绝 ✓')
  }

  // 2) 错误 PIN 应被拒
  try {
    await req('pair', { pin: '000000', deviceName: 'test-phone' })
    fail('pair-wrong-pin', new Error('错误 PIN 竟成功'))
  } catch {
    console.log('[client] 错误 PIN 拒绝 ✓')
  }

  // 3) 正确 PIN 配对
  const pair = await req('pair', { pin, deviceName: 'test-phone' })
  if (!pair.deviceId || !pair.token) fail('pair', new Error('配对返回缺字段'))
  console.log(`[client] 配对 ✓ deviceId=${pair.deviceId}`)

  // 4) 重新连接后用令牌鉴权
  ws.close()
  await new Promise((r) => setTimeout(r, 300))
  const ws2 = new WebSocket(`ws://127.0.0.1:${port}`)
  ws2.on('error', (e) => fail('reconnect', e))
  await new Promise((r) => ws2.on('open', r))
  ws2.on('message', (data) => {
    const frame = JSON.parse(data.toString('utf8'))
    if (frame.type === 'res') {
      const cb = pending.get(frame.id)
      if (cb) {
        pending.delete(frame.id)
        frame.ok ? cb.resolve(frame.payload) : cb.reject(new Error(frame.error))
      }
    } else if (frame.type === 'push') {
      console.log(`[client] push ${frame.ch} 收到（payload ${JSON.stringify(frame.payload).length}B）`)
    }
  })
  const authed = await new Promise((resolve, reject) => {
    const id = 'auth_1'
    pending.set(id, { resolve, reject })
    ws2.send(JSON.stringify({ v: 1, type: 'req', id, method: 'auth', payload: { deviceId: pair.deviceId, token: pair.token } }))
    setTimeout(() => reject(new Error('auth 超时')), 25000)
  })
  if (!authed.capabilities || !authed.capabilities.length) fail('auth', new Error('capabilities 为空'))
  console.log(`[client] 鉴权 ✓ capabilities=${authed.capabilities.length}`)

  // 5) 订阅 + 数据请求
  await req2(ws2, 'subscribe', { channels: ['agent.overview', 'system.snapshot'] })
  console.log('[client] 订阅 ✓')
  const overview = await req2(ws2, 'agent.overview', { range: 'today' })
  console.log(`[client] agent.overview ✓ total=${overview.totals.total}`)
  const snap = await req2(ws2, 'system.snapshot', {})
  console.log(`[client] system.snapshot ✓ cpu=${snap.cpu.loadPercent}% mem=${snap.memory.usedPercent}%`)
  const instances = await req2(ws2, 'zc.instances', {})
  console.log(`[client] zc.instances ✓ ${instances.length} 个实例`)
  await req2(ws2, 'unsubscribe', { channels: ['agent.overview'] })
  console.log('[client] 全部通过 PASS')
  ws2.close()
  setTimeout(() => process.exit(0), 500)

  function req2(sock, method, payload) {
    return new Promise((resolve, reject) => {
      const id = `req_${++reqId}_2`
      pending.set(id, { resolve, reject })
      sock.send(JSON.stringify({ v: 1, type: 'req', id, method, payload }))
      setTimeout(() => reject(new Error(`${method} 超时`)), 25000)
    })
  }
}

ws.on('open', () => { console.log('[client] T1 open'); main().catch((e) => fail('main', e)) })
ws.on('error', (e) => fail('connect', e))
ws.on('close', (code) => console.log(`[client] T-close code=${code}`))
