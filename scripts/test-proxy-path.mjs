// 对比：直连 vs 系统代理（127.0.0.1:40022）访问 DeepSeek API
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const authPaths = [join(process.env.APPDATA, 'nexus', 'quotas-auth.json'), join(process.env.APPDATA, 'Nexus', 'quotas-auth.json')]
let token = null
for (const p of authPaths) {
  try {
    const auth = JSON.parse(readFileSync(p, 'utf8'))
    const sess = auth.sessions?.['deepseek-cn']?.[0] ?? auth.sessions?.deepseek?.[0]
    if (sess?.accessToken) { token = sess.accessToken; break }
  } catch {}
}
if (!token) { console.error('no token'); process.exit(1) }
const url = 'https://platform.deepseek.com/api/v0/users/get_user_summary'
const H = { accept: 'application/json', authorization: `Bearer ${token}` }

// 直连
try {
  const t0 = Date.now()
  const r = await fetch(url, { headers: H })
  console.log('direct:', r.status, `${Date.now() - t0}ms`)
} catch (e) { console.log('direct ERR:', e.cause?.code ?? e.message) }

// 系统代理（CONNECT 隧道手写最小实现）
import net from 'node:net'
const proxy = { host: '127.0.0.1', port: 40022 }
const viaProxy = await new Promise((resolve) => {
  const sock = net.connect(proxy.port, proxy.host, () => {
    sock.write(`CONNECT platform.deepseek.com:443 HTTP/1.1\r\nHost: platform.deepseek.com:443\r\n\r\n`)
  })
  let buf = ''
  sock.on('data', (d) => {
    buf += d.toString()
    if (buf.includes('\r\n\r\n')) {
      resolve({ ok: /200/.test(buf.split('\r\n')[0]), statusLine: buf.split('\r\n')[0] })
      sock.destroy()
    }
  })
  sock.on('error', (e) => resolve({ ok: false, statusLine: 'ERR ' + e.code }))
  setTimeout(() => resolve({ ok: false, statusLine: 'timeout' }), 8000)
})
console.log('proxy CONNECT:', viaProxy)
