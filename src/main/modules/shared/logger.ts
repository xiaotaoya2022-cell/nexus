import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

type Level = 'info' | 'warn' | 'error'

let customLogDir: string | null = null

export function setLogDir(dir: string): void {
  customLogDir = dir
}

function resolveBaseDir(): string {
  if (customLogDir) return customLogDir
  if (process.env.NEXUS_LOG_DIR) return process.env.NEXUS_LOG_DIR
  if (process.versions.electron) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('electron') as { app?: { getPath?: (name: string) => string } }
      const p = mod.app?.getPath?.('userData')
      if (p) return p
    } catch {
      // 未进入 Electron 主上下文时走默认目录
    }
  }
  return join(homedir() || tmpdir(), '.nexus-mesh')
}

function logFile(): string {
  const dir = join(resolveBaseDir(), 'logs')
  mkdirSync(dir, { recursive: true })
  return join(dir, `nexus-${new Date().toISOString().slice(0, 10)}.jsonl`)
}

function write(level: Level, event: string, context?: Record<string, unknown>): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    module: 'nexus',
    context: context ?? {}
  })
  try {
    appendFileSync(logFile(), line + '\n')
  } catch {
    // 日志写入失败不应影响主流程
  }
  // eslint-disable-next-line no-console
  if (process.env.NEXUS_DEV_LOG) console[level](line)
}

export const logger = {
  info: (event: string, context?: Record<string, unknown>) => write('info', event, context),
  warn: (event: string, context?: Record<string, unknown>) => write('warn', event, context),
  error: (event: string, context?: Record<string, unknown>) => write('error', event, context)
}
