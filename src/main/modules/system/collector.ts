// 系统状态采集（v2 Phase 1，指导书 §4.2 system-collector）。
// 零事件循环阻塞设计：CPU / 内存 / 运行时长直读 node:os（0.05ms）；Windows 网速走异步 netstat -e，
// 显卡与磁盘走异步 PowerShell EncodedCommand + 10 分钟后台刷新缓存（彻底避开 systeminformation 在 Win32 下
// 调用 execSync('ipconfig /all') 导致的周期性 ~625ms 主线程与鼠标卡顿）。
// Linux / macOS 等其他平台保留 /proc/net/dev 与 systeminformation 异步兜底。

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import si from 'systeminformation'
import { logger } from '@main/modules/shared/logger'

export interface SystemSnapshot {
  ts: number
  cpu: {
    manufacturer: string
    model: string
    loadPercent: number
    cores: number
  }
  memory: {
    totalBytes: number
    usedBytes: number
    usedPercent: number
  }
  gpus: Array<{ model: string; utilPercent: number | null; memUsedMB: number | null; memTotalMB: number | null }>
  disks: Array<{ fs: string; mount: string; sizeBytes: number; usedBytes: number; usePercent: number }>
  network: {
    rxBytesPerSec: number
    txBytesPerSec: number
  }
  uptimeSec: number
  load: { currentHourPercent: number | null }
}

const CACHE_MS = 2000
const STATIC_TTL_MS = 600_000
const VIRTUAL_GPU_RE = /virtual|gameviewer|indirect|microsoft basic|parsec|sunshine|oray|todesk|sunlogin/i

const WIN_STATIC_PS = [
  '$g=@(Get-CimInstance Win32_VideoController|Select-Object -ExpandProperty Name);',
  "$d=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'|Select-Object DeviceID,Size,FreeSpace);",
  '[PSCustomObject]@{gpus=$g;disks=$d}|ConvertTo-Json -Compress'
].join('')
const WIN_STATIC_PS_B64 = Buffer.from(WIN_STATIC_PS, 'utf16le').toString('base64')

function execFileAsync(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout ?? ''))
    })
  })
}

function inferManufacturer(model: string): string {
  if (/\bAMD\b|Ryzen|EPYC|Threadripper|Athlon/i.test(model)) return 'AMD'
  if (/\bIntel\b|Core|Xeon|Celeron|Pentium/i.test(model)) return 'Intel'
  if (/\bApple\b|\bM[1-9]\b/i.test(model)) return 'Apple'
  return ''
}

function sortGpuModels(models: string[]): Array<{ model: string }> {
  const unique = [...new Set(models.map((m) => m.trim()).filter(Boolean))]
  unique.sort((a, b) => Number(VIRTUAL_GPU_RE.test(a)) - Number(VIRTUAL_GPU_RE.test(b)))
  return unique.map((model) => ({ model }))
}

/** 解析 `netstat -e` 累计收发字节行（兼容英文 "Bytes" / 中文 "字节" / 其他本地化第一行双计数器） */
export function parseNetstatBytes(stdout: string): { rx: number; tx: number } | null {
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const m = /^[^\d\s]+\s+(\d+)\s+(\d+)$/.exec(line)
    if (!m) continue
    const rx = Number(m[1])
    const tx = Number(m[2])
    if (Number.isFinite(rx) && Number.isFinite(tx) && rx >= 0 && tx >= 0) {
      return { rx, tx }
    }
  }
  return null
}

/** 解析 Linux `/proc/net/dev` 非回环接口累计收发字节 */
export function parseProcNetDevBytes(content: string): { rx: number; tx: number } {
  let rx = 0
  let tx = 0
  for (const line of content.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const iface = line.slice(0, colon).trim()
    if (!iface || iface === 'lo') continue
    const cols = line.slice(colon + 1).trim().split(/\s+/)
    if (cols.length < 9) continue
    const rxVal = Number(cols[0])
    const txVal = Number(cols[8])
    if (Number.isFinite(rxVal) && rxVal >= 0) rx += rxVal
    if (Number.isFinite(txVal) && txVal >= 0) tx += txVal
  }
  return { rx, tx }
}

export class SystemCollector {
  private cache: SystemSnapshot | null = null
  private cacheAt = 0
  private inFlight: Promise<SystemSnapshot> | null = null
  private staticInfo: {
    cpu: { manufacturer: string; model: string; cores: number }
    gpus: Array<{ model: string }>
    disks: Array<{ fs: string; mount: string; sizeBytes: number; usedBytes: number }>
  } | null = null
  private staticAt = 0
  private staticInFlight: Promise<void> | null = null
  private prevCpuTotals: { idle: number; total: number } | null = null
  private prevNetSample: { ts: number; rx: number; tx: number } | null = null

  /** 采样一次（带 2s 缓存与并发去重；失败返回上次快照，从未成功则抛错） */
  async snapshot(): Promise<SystemSnapshot> {
    const now = Date.now()
    if (this.cache && now - this.cacheAt < CACHE_MS) return this.cache
    if (this.inFlight) return this.inFlight
    this.inFlight = this.sample()
      .then((snap) => {
        this.cache = snap
        this.cacheAt = Date.now()
        return snap
      })
      .catch((err) => {
        logger.warn('system.sample_failed', { error: err instanceof Error ? err.message : String(err) })
        if (this.cache) return this.cache
        throw err
      })
      .finally(() => {
        this.inFlight = null
      })
    return this.inFlight
  }

  private sampleCpuFast(): { manufacturer: string; model: string; cores: number; loadPercent: number } {
    const cpus = os.cpus()
    const rawModel = cpus[0]?.model?.trim() || 'CPU'
    const manufacturer = inferManufacturer(rawModel)
    const model = manufacturer
      ? `${manufacturer} ${rawModel}`.replace(/\b(AMD|Intel|Apple)\s+\1\b/i, '$1').trim()
      : rawModel
    let idle = 0
    let total = 0
    for (const c of cpus) {
      idle += c.times.idle
      total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
    }
    let loadPercent = 0
    if (this.prevCpuTotals) {
      const dIdle = idle - this.prevCpuTotals.idle
      const dTotal = total - this.prevCpuTotals.total
      if (dTotal > 0) {
        loadPercent = Math.max(0, Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 1000) / 10))
      }
    } else if (total > 0) {
      loadPercent = Math.max(0, Math.min(100, Math.round(((total - idle) / total) * 1000) / 10))
    }
    this.prevCpuTotals = { idle, total }
    return { manufacturer, model, cores: Math.max(1, cpus.length), loadPercent }
  }

  private async refreshStaticInfo(cpuMeta: { manufacturer: string; model: string; cores: number }): Promise<void> {
    if (this.staticInFlight) return this.staticInFlight
    this.staticInFlight = (async () => {
      try {
        if (process.platform === 'win32') {
          let gpus: Array<{ model: string }> = []
          let disks: Array<{ fs: string; mount: string; sizeBytes: number; usedBytes: number }> = []
          try {
            const raw = await execFileAsync(
              'powershell.exe',
              ['-NoProfile', '-NonInteractive', '-EncodedCommand', WIN_STATIC_PS_B64],
              8000
            )
            const parsed = JSON.parse(raw.trim()) as {
              gpus?: string | string[]
              disks?: Array<{ DeviceID?: string; Size?: number; FreeSpace?: number }> | { DeviceID?: string; Size?: number; FreeSpace?: number }
            }
            const gpuArr = Array.isArray(parsed.gpus)
              ? parsed.gpus
              : typeof parsed.gpus === 'string'
                ? [parsed.gpus]
                : []
            gpus = sortGpuModels(gpuArr.filter((g): g is string => typeof g === 'string'))
            const diskArr = Array.isArray(parsed.disks)
              ? parsed.disks
              : parsed.disks
                ? [parsed.disks]
                : []
            disks = diskArr
              .filter((d) => typeof d?.DeviceID === 'string' && Number(d.Size) > 0)
              .map((d) => {
                const sizeBytes = Number(d.Size) || 0
                const free = Math.max(0, Number(d.FreeSpace) || 0)
                return {
                  fs: String(d.DeviceID),
                  mount: String(d.DeviceID),
                  sizeBytes,
                  usedBytes: Math.max(0, sizeBytes - free)
                }
              })
          } catch {
            // WMI/PowerShell 不可用时保留上次结果或空列表，绝不阻塞主循环
          }
          this.staticInfo = {
            cpu: cpuMeta,
            gpus: gpus.length > 0 ? gpus : (this.staticInfo?.gpus ?? []),
            disks: disks.length > 0 ? disks : (this.staticInfo?.disks ?? [])
          }
          this.staticAt = Date.now()
          return
        }

        const [graphics, fsSize] = await Promise.all([si.graphics(), si.fsSize()])
        this.staticInfo = {
          cpu: cpuMeta,
          gpus: sortGpuModels(graphics.controllers.map((g) => g.model)),
          disks: fsSize
            .filter((d) => d.size > 0)
            .map((d) => ({ fs: d.fs, mount: d.mount, sizeBytes: d.size, usedBytes: d.used }))
        }
        this.staticAt = Date.now()
      } finally {
        this.staticInFlight = null
      }
    })()
    return this.staticInFlight
  }

  private async sampleNetworkRate(): Promise<{ rxBytesPerSec: number; txBytesPerSec: number }> {
    const computeRate = (curRx: number, curTx: number): { rxBytesPerSec: number; txBytesPerSec: number } => {
      const now = Date.now()
      const prev = this.prevNetSample
      this.prevNetSample = { ts: now, rx: curRx, tx: curTx }
      if (!prev) return { rxBytesPerSec: 0, txBytesPerSec: 0 }
      const dtSec = (now - prev.ts) / 1000
      if (dtSec <= 0.05) return { rxBytesPerSec: 0, txBytesPerSec: 0 }
      const dRx = curRx >= prev.rx ? curRx - prev.rx : 0
      const dTx = curTx >= prev.tx ? curTx - prev.tx : 0
      return {
        rxBytesPerSec: Math.max(0, Math.round(dRx / dtSec)),
        txBytesPerSec: Math.max(0, Math.round(dTx / dtSec))
      }
    }

    if (process.platform === 'win32') {
      try {
        const out = await execFileAsync('netstat', ['-e'], 2500)
        const parsed = parseNetstatBytes(out)
        if (parsed) return computeRate(parsed.rx, parsed.tx)
      } catch {
        // netstat 超时或失败返回 0 速率，避免阻塞
      }
      return { rxBytesPerSec: 0, txBytesPerSec: 0 }
    }

    if (process.platform === 'linux') {
      try {
        const raw = await readFile('/proc/net/dev', 'utf8')
        const parsed = parseProcNetDevBytes(raw)
        return computeRate(parsed.rx, parsed.tx)
      } catch {
        // fallback below
      }
    }

    const net = await si.networkStats()
    const netAgg = net.reduce(
      (acc, n) => ({ rx: acc.rx + (n.rx_sec || 0), tx: acc.tx + (n.tx_sec || 0) }),
      { rx: 0, tx: 0 }
    )
    return {
      rxBytesPerSec: Math.max(0, Math.round(netAgg.rx)),
      txBytesPerSec: Math.max(0, Math.round(netAgg.tx))
    }
  }

  private async sample(): Promise<SystemSnapshot> {
    const cpuFast = this.sampleCpuFast()
    const cpuMeta = {
      manufacturer: cpuFast.manufacturer,
      model: cpuFast.model,
      cores: cpuFast.cores
    }

    if (!this.staticInfo) {
      await this.refreshStaticInfo(cpuMeta)
    } else if (Date.now() - this.staticAt > STATIC_TTL_MS) {
      // 过期时异步后台刷新，不阻塞当前高频采样周期
      void this.refreshStaticInfo(cpuMeta)
    }

    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    const usedMem = Math.max(0, totalMem - freeMem)
    const net = await this.sampleNetworkRate()
    const st = this.staticInfo ?? { cpu: cpuMeta, gpus: [], disks: [] }

    return {
      ts: Date.now(),
      cpu: {
        manufacturer: st.cpu.manufacturer,
        model: st.cpu.model,
        loadPercent: cpuFast.loadPercent,
        cores: st.cpu.cores
      },
      memory: {
        totalBytes: totalMem,
        usedBytes: usedMem,
        usedPercent: totalMem > 0 ? Math.round((usedMem / totalMem) * 1000) / 10 : 0
      },
      gpus: st.gpus.map((g) => ({
        model: g.model,
        utilPercent: null,
        memUsedMB: null,
        memTotalMB: null
      })),
      disks: st.disks.map((d) => ({
        fs: d.fs,
        mount: d.mount,
        sizeBytes: d.sizeBytes,
        usedBytes: d.usedBytes,
        usePercent: d.sizeBytes > 0 ? Math.round((d.usedBytes / d.sizeBytes) * 1000) / 10 : 0
      })),
      network: net,
      uptimeSec: Math.floor(os.uptime()),
      load: { currentHourPercent: null }
    }
  }
}
