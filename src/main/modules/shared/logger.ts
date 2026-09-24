import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

type Level = 'info' | 'warn' | 'error'

function logFile(): string {
  const dir = join(app.getPath('userData'), 'logs')
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
