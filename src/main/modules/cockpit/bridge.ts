// Antigravity Cockpit 感知桥（v2 补强③）。
// 依据《其他 Agent 采集源调研报告》(docs/research/v2/other-agent-collection.md)：
// cockpit-tools（github.com/jlcodes99/cockpit-tools）的「API 服务」= Codex 本地网关，
// 启用后 Codex 流量经网关中继并把每请求 token/成本写入
// ~/.antigravity_cockpit/codex_local_access_logs.sqlite 的 request_logs ——
// Nexus 的 antigravity 适配器已在读该表，启用即自动接入。
// 本桥只读两样东西：
// 1. codex_local_access.json 的白名单字段（enabled/port/gatewayMode，绝不读 apiKey 等凭据字段）
// 2. request_logs 行数（只读 SQLite COUNT）
// 结果缓存 5s，避免每次 getAgents 都触碰磁盘。

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { join } from 'node:path'
import { openReadonlyDb, tableExists } from '@main/modules/adapter/infrastructure/util'

export interface CockpitStatus {
  installed: boolean
  gatewayEnabled: boolean
  gatewayPort: number | null
  requestLogRows: number
}

const CACHE_MS = 5000

export class CockpitBridge {
  private readonly home = homedir()
  private readonly configPath = join(this.home, '.antigravity_cockpit', 'codex_local_access.json')
  private readonly logsDb = join(this.home, '.antigravity_cockpit', 'codex_local_access_logs.sqlite')
  private cache: CockpitStatus | null = null
  private cacheAt = 0

  status(): CockpitStatus {
    const now = Date.now()
    if (this.cache && now - this.cacheAt < CACHE_MS) return this.cache
    const installed = existsSync(this.configPath) || existsSync(this.logsDb)
    let gatewayEnabled = false
    let gatewayPort: number | null = null
    if (existsSync(this.configPath)) {
      // 使用点内联路径校验：绝对 + 已归一化 + 固定文件名（防穿越）
      const resolved = resolve(this.configPath)
      if (
        isAbsolute(resolved) &&
        resolved === join(this.home, '.antigravity_cockpit', 'codex_local_access.json')
      ) {
        try {
          const raw = JSON.parse(readFileSync(resolved, 'utf8')) as Record<string, unknown>
          // 白名单字段：仅取布尔/端口，凭据字段（apiKey/apiKeys）一律不触碰
          gatewayEnabled = raw.enabled === true
          const port = typeof raw.port === 'number' && raw.port > 0 ? raw.port : null
          gatewayPort = port
        } catch {
          // 配置不可解析按未启用处理
        }
      }
    }
    let requestLogRows = 0
    if (existsSync(this.logsDb)) {
      try {
        const db = openReadonlyDb(this.logsDb)
        try {
          if (tableExists(db, 'request_logs')) {
            const row = db.prepare('SELECT COUNT(*) c FROM request_logs').get() as { c: number }
            requestLogRows = Number(row?.c) || 0
          }
        } finally {
          db.close()
        }
      } catch {
        requestLogRows = 0
      }
    }
    this.cache = { installed, gatewayEnabled, gatewayPort, requestLogRows }
    this.cacheAt = now
    return this.cache
  }

  /** 侧栏 note：把"该做什么"直接告诉用户 */
  noteFor(): string | null {
    const st = this.status()
    if (!st.installed) return null
    if (st.requestLogRows > 0) return null // 已有数据：显示最近活动时间
    if (st.gatewayEnabled) return 'Cockpit API 服务已启用 · 产生流量后自动接入'
    return 'Cockpit 已装 · 在其「API 服务」页启用服务后自动接入'
  }
}
