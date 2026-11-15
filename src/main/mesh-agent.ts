// 纯 Node 入口：面向无 GUI 的 WSL2 / Linux 虚拟机后台节点采集（node out/main/mesh-agent.js）。
// --pair 只在校验后落盘（persistPairRequest），网络连接由运行器从盘上配置发起。

import {
  parseHeadlessMeshArgs,
  persistPairRequest,
  printHeadlessUsage,
  runHeadlessMeshAgent
} from './modules/mesh/headless'

async function main(): Promise<void> {
  const { help, options } = parseHeadlessMeshArgs(process.argv.slice(2))
  if (help) {
    printHeadlessUsage()
    return
  }
  if (options.pairUri) {
    persistPairRequest(options.pairUri, options.alias)
    options.pairUri = undefined // 命令行污点终结于落盘
  }
  await runHeadlessMeshAgent(options)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[mesh-agent] FAIL:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
