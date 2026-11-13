// 系统状态采集（v2 Phase 1，指导书 §4.2 system-collector）。
// systeminformation 采样 + 节流缓存；只读系统信息，不做任何系统更改。
// 帧率（FPS）说明：Windows 下无系统级 FPS 的公开只读接口，交付 GPU 利用率/显存替代并记录于报告。

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

  private async sample(): Promise<SystemSnapshot> {
    // 静态/慢变信息（CPU 型号、GPU、磁盘容量）缓存 5 分钟：si.graphics/fsSize 走 WMI，
    // 在无窗口 Electron 的节流环境下单次可达 30s+，绝不能进每次采样
    if (!this.staticInfo || Date.now() - this.staticAt > 300_000) {
      const [cpu, graphics, fsSize] = await Promise.all([si.cpu(), si.graphics(), si.fsSize()])
      // systeminformation 的 cpu.model 常为步进数字代号（如 "116"），优先拼装完整 brand 或退回 os.cpus()
      const brandModel = cpu.brand
        ? `${cpu.manufacturer} ${cpu.brand}`.replace(/\b(AMD|Intel)\s+\1\b/i, '$1').trim()
        : ''
      const resolvedModel = brandModel || os.cpus()[0]?.model?.trim() || cpu.model
      const virtualGpuRe = /virtual|gameviewer|indirect|microsoft basic|parsec|sunshine|oray|todesk|sunlogin/i
      const sortedGpus = [...graphics.controllers].sort(
        (a, b) => Number(virtualGpuRe.test(a.model)) - Number(virtualGpuRe.test(b.model))
      )
      this.staticInfo = {
        cpu: { manufacturer: cpu.manufacturer, model: resolvedModel, cores: cpu.cores },
        gpus: sortedGpus.map((g) => ({ model: g.model })),
        disks: fsSize
          .filter((d) => d.size > 0)
          .map((d) => ({ fs: d.fs, mount: d.mount, sizeBytes: d.size, usedBytes: d.used }))
      }
      this.staticAt = Date.now()
    }
    const [currentLoad, mem, net, osInfo] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.networkStats(),
      si.time()
    ])

    const netAgg = net.reduce(
      (acc, n) => ({ rx: acc.rx + (n.rx_sec || 0), tx: acc.tx + (n.tx_sec || 0) }),
      { rx: 0, tx: 0 }
    )

    return {
      ts: Date.now(),
      cpu: {
        manufacturer: this.staticInfo.cpu.manufacturer,
        model: this.staticInfo.cpu.model,
        loadPercent: Math.round((currentLoad.currentLoad ?? 0) * 10) / 10,
        cores: this.staticInfo.cpu.cores
      },
      memory: {
        totalBytes: mem.total,
        usedBytes: mem.used,
        usedPercent: Math.round((mem.used / mem.total) * 1000) / 10
      },
      gpus: this.staticInfo.gpus.map((g) => ({
        model: g.model,
        utilPercent: null,
        memUsedMB: null,
        memTotalMB: null
      })),
      disks: this.staticInfo.disks.map((d) => ({
        fs: d.fs,
        mount: d.mount,
        sizeBytes: d.sizeBytes,
        usedBytes: d.usedBytes,
        usePercent: Math.round((d.usedBytes / d.sizeBytes) * 1000) / 10
      })),
      network: {
        rxBytesPerSec: Math.max(0, Math.round(netAgg.rx)),
        txBytesPerSec: Math.max(0, Math.round(netAgg.tx))
      },
      uptimeSec: Math.floor(osInfo.uptime || 0),
      load: { currentHourPercent: null }
    }
  }
}
