// Tailscale 内嵌引擎（PC 端）。
// 架构（第五批）：tsnet sidecar 二进制（sidecars/tailscale-sidecar/，go build 产出）以
// 独立进程运行：nexus-tailscale.exe --target=<Nexus WS端口> --port=<控制端口> --state=<目录>
// 本模块只做：探测控制端口状态 + 触发登录（HTTP /auth，127.0.0.1）。
// 不派生进程（进程管理集成留待下一批，见 ENHANCEMENT_REPORT）。

const CTRL_BASE_CANDIDATES = [41000, 41001, 41002, 41003, 41004]

export interface TailscaleStatus {
  available: boolean
  running: boolean
  ip: string
  up: boolean
  port: number | null
  error: string
}

async function probe(port: number): Promise<{ ip: string; up: boolean } | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1200)
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: controller.signal })
    clearTimeout(timer)
    if (res.status !== 200) return null
    const data = (await res.json()) as { ip?: string; up?: boolean }
    return { ip: data.ip ?? '', up: data.up ?? false }
  } catch {
    return null
  }
}

export class TailscaleManager {
  private ctrlPort: number | null = null
  private targetPort = 0

  start(targetPort: number): void {
    this.targetPort = targetPort
  }

  get target(): number {
    return this.targetPort
  }

  status(): TailscaleStatus {
    return {
      available: true, // sidecar 二进制随包分发（extraResources），本地构建亦可
      running: this.ctrlPort != null,
      ip: '',
      up: false,
      port: this.ctrlPort,
      error: ''
    }
  }

  /** 探测已运行 sidecar 的控制端口并触发登录（返回 authURL 或 null）。 */
  async startLogin(): Promise<string | null> {
    for (const port of CTRL_BASE_CANDIDATES) {
      const st = await probe(port)
      if (st != null) {
        this.ctrlPort = port
        this.targetPort = this.targetPort || 0
        const res = await fetch(`http://127.0.0.1:${port}/auth`)
        const data = (await res.json()) as { authURL?: string }
        return data.authURL ?? null
      }
    }
    return null
  }

  async statusLive(): Promise<{ ip: string; up: boolean; port: number | null }> {
    for (const port of CTRL_BASE_CANDIDATES) {
      const st = await probe(port)
      if (st != null) {
        this.ctrlPort = port
        return { ip: st.ip, up: st.up, port }
      }
    }
    return { ip: '', up: false, port: null }
  }
}
