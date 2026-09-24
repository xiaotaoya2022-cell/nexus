// zc.instances / dsh.* 的 payload 形状。
// 这些结构目前只在 PC 端主进程实现中定义（src/main/modules/{zcode,dsh}，依赖 node 模块，不宜进 shared），
// 此处按其导出接口逐字段镜像；协议信封本身仍从 @shared/protocol 单一来源引用。
// 若 PC 端结构变化，以 manager.ts / bridge.ts 为准同步本文件。

export interface ZcodeInstance {
  id: string
  userDataDir: string
  name: string
  running: boolean
  currentProject: string | null
  lastActiveAt: number | null
}

export interface DshSessionInfo {
  sessionId: string
  workspace?: string
  updatedAt?: number | string
  running?: boolean
}

export interface DshStatus {
  available: boolean
  degraded: boolean
  port: number
  detail?: string
}

/** dsh.prompt 响应 payload */
export interface DshPromptResult {
  sessionId: string
  res: unknown
}
