// 纯 Node 入口：面向无 GUI 的 WSL2 / Linux 虚拟机后台节点采集（node out/main/mesh-agent.js）。

import {
  parseHeadlessMeshArgs,
  printHeadlessUsage,
  runHeadlessMeshAgent
} from './modules/mesh/headless'

async function main(): Promise<void> {
  const { help, options } = parseHeadlessMeshArgs(process.argv.slice(2))
  if (help) {
    printHeadlessUsage()
    return
  }
  await runHeadlessMeshAgent(options)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[mesh-agent] FAIL:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
