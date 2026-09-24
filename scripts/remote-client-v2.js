// 远程服务自测客户端（与 PC 端配对/鉴权协议 v2 配套）：
// 模拟手机端——从环境变量 NEXUS_TEST_INFO（JSON: port/pin/nonce/pairingSecret）出发：
// pair（证明持有二维码内容）→ 得 deviceId，本地推导 token（永不上线）
// → auth.hello 取挑战 → auth.verify(sha256(token:nonce)) → 订阅/取数/实例发现。
// 用法：NEXUS_TEST_INFO="$(cat info.json)" node scripts/remote-client-v2.js
const WebSocket = require('ws')
const { createHash } = require('node:crypto')

const sha256 = (s) => createHash('sha256').update(s).digest('hex')

const RAW = process.env.NEXUS_TEST_INFO || ''
let info
try {
  info = JSON.parse(RAW)
} catch {
  console.error('[client] NEXUS_TEST_INFO 缺失或非法')
  process.exit(1)
}
const { port, pin, nonce, pairingSecret } = info
if (!(Number.isInteger(port) && typeof pin === 'string' && typeof nonce === 'string' && typeof pairingSecret === 'string')) {
  console.error('[client] info 字段不完整')
  process.exit(1)
}
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
    const { resolve, reject } = pending.get(frame.id)
    pending.delete(frame.id)
    frame.ok ? resolve(frame.payload) : reject(new Error(frame.error))
  } else if (frame.type === 'push') {
    console.log(`[client] push ${frame.ch} 收到（payload ${JSON.stringify(frame.payload).length}B）`)
  }
})

function fail(step, err) {
  console.error(`[client] FAIL at ${step}:`, err.message || err)
  process.exit(1)
}

async function main() {
  // 1) 未鉴权请求应被拒
  try {
    await req('agent.overview', { range: '7d' })
    fail('unauthorized-check', new Error('未鉴权请求竟成功'))
  } catch {
    console.log('[client] 未鉴权拒绝 ✓')
  }

  // 2) 错误 PIN（证明不匹配）应被拒
  try {
    await req('pair', { nonce, proof: sha256(`${pairingSecret}:${nonce}:000000`), pin: '000000', deviceName: 'test-phone' })
    fail('pair-wrong-pin', new Error('错误 PIN 竟成功'))
  } catch {
    console.log('[client] 错误 PIN 拒绝 ✓')
  }

  // 3) 正确二维码内容配对（证明 = sha256(pairingSecret:nonce:pin)；响应不含 token）
  const pair = await req('pair', {
    nonce,
    proof: sha256(`${pairingSecret}:${nonce}:${pin}`),
    pin,
    deviceName: 'test-phone'
  })
  if (!pair.deviceId) fail('pair', new Error('配对返回缺 deviceId'))
  if (pair.token) fail('pair-security', new Error('配对响应竟携带 token（应永不上线）'))
  console.log(`[client] 配对 ✓ deviceId=${pair.deviceId}（响应无 token ✓）`)
  // 双方独立推导 token（模拟手机端逻辑）
  const token = sha256(`${pairingSecret}:${pair.deviceId}:${nonce}`)

  // 4) 重连后挑战式鉴权（token 不上线）
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
  const challenge = await req2(ws2, 'auth.hello', { deviceId: pair.deviceId })
  if (!challenge.nonce) fail('auth.hello', new Error('挑战缺 nonce'))
  const authed = await req2(ws2, 'auth.verify', {
    deviceId: pair.deviceId,
    proof: sha256(`${token}:${challenge.nonce}`)
  })
  if (!authed.capabilities || !authed.capabilities.length) fail('auth.verify', new Error('capabilities 为空'))
  console.log(`[client] 挑战式鉴权 ✓ capabilities=${authed.capabilities.length}`)

  // 5) 重放旧挑战应被拒（挑战单次有效）
  try {
    await req2(ws2, 'auth.verify', { deviceId: pair.deviceId, proof: sha256(`${token}:${challenge.nonce}`) })
    fail('replay-check', new Error('重放竟成功'))
  } catch {
    console.log('[client] 挑战重放拒绝 ✓')
  }

  // 6) 订阅 + 数据请求
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

ws.on('open', () => main().catch((e) => fail('main', e)))
ws.on('error', (e) => fail('connect', e))
