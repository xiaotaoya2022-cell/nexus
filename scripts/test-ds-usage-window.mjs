// 模拟 fetchUsageAll 滚动逻辑（从今天往回 31 天跨度，空段连 2 停）
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const authPaths = [join(process.env.APPDATA, 'nexus', 'quotas-auth.json'), join(process.env.APPDATA, 'Nexus', 'quotas-auth.json')]
let token = null
for (const p of authPaths) {
  try {
    const auth = JSON.parse(readFileSync(p, 'utf8'))
    const sess = auth.sessions?.['deepseek-cn']?.[0] ?? auth.sessions?.['deepseek-intl']?.[0] ?? auth.sessions?.deepseek?.[0]
    if (sess?.accessToken) { token = sess.accessToken; break }
  } catch {}
}
if (!token) { console.error('no token'); process.exit(1) }
const dayStartSec = (o) => { const d = new Date(); d.setHours(0,0,0,0); return Math.floor(d.getTime()/1000) - o*86400 }
const tz = -new Date().getTimezoneOffset() * 60
const H = { accept: 'application/json', authorization: `Bearer ${token}` }
const span = 31 * 86400
let endSec = dayStartSec(0) + 86400
let emptyStreak = 0
for (let seg = 0; seg < 20 && emptyStreak < 2; seg++) {
  const startSec = endSec - span
  const r = await fetch(`https://platform.deepseek.com/api/v0/usage/by_api_key/amount?start=${startSec}&end=${endSec}&tz=${tz}`, { headers: H }).then(x => x.json())
  const series = r?.data?.biz_data?.series ?? []
  let buckets = 0, first = null, last = null
  for (const s of series) for (const b of s.buckets ?? []) {
    buckets++
    if (first == null || b.time < first) first = b.time
    if (last == null || b.time > last) last = b.time
  }
  console.log(`seg${seg}: ${new Date(startSec*1000).toISOString().slice(0,10)} → ${new Date(endSec*1000).toISOString().slice(0,10)} biz=${r?.data?.biz_code} series=${series.length} buckets=${buckets} span=${first?new Date(first*1000).toISOString().slice(0,10):'-'}→${last?new Date(last*1000).toISOString().slice(0,10):'-'}`)
  if (buckets === 0) emptyStreak++
  else emptyStreak = 0
  endSec = startSec
}
