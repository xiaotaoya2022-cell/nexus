// DSH 本地会话读取器：解压 ~/.dsh/sessions/ 下的 zstd 会话文件，
// 不依赖 DSH 进程运行（用户要求：数据在本机即可见）。
// 结构：~/.dsh/sessions/<workspace-dir>/session-<uuid>/session.jsonl.zstd

import { createZstdDecompress } from 'node:zlib'
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface DshLocalSession {
  sessionId: string
  workspaceDir: string
  workspaceLabel: string
  startedAt: number | null
  updatedAt: number | null
  messageCount: number
  title: string | null
}

const SESSIONS_DIR = join(homedir(), '.dsh', 'sessions')

/** 解码 workspace 目录名（~0020 = 空格等 URL 编码片段） */
function decodeWorkspaceDir(name: string): string {
  return name
    .replace(/~0020/g, ' ')
    .replace(/~002D/gi, '-')
    .replace(/~005F/gi, '_')
    .replace(/~2D/gi, '-')
    .replace(/~5F/gi, '_')
}

/** 异步流式解压 zstd 文件为 UTF-8 文本。 */
function decompressZstdFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const input = createReadStream(filePath)
    const decoder = createZstdDecompress()
    input.on('error', reject)
    decoder.on('error', reject)
    decoder.on('data', (c: Buffer) => chunks.push(c))
    decoder.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    input.pipe(decoder)
  })
}

/** 从 jsonl 内容提取会话元数据。 */
function extractMeta(
  jsonl: string
): { title: string | null; startedAt: number | null; updatedAt: number | null; messageCount: number } {
  let title: string | null = null
  let startedAt: number | null = null
  let updatedAt: number | null = null
  let count = 0
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    count++
    try {
      const obj = JSON.parse(line) as Record<string, unknown>
      const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : null
      if (ts != null && !Number.isNaN(ts)) {
        if (startedAt == null) startedAt = ts
        updatedAt = ts
      }
      if (title == null && typeof obj.role === 'string' && obj.role === 'user') {
        const content = obj.content
        const text =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? (content as Array<{ type?: string; text?: string }>)
                  .filter((c) => c?.type === 'text' && typeof c.text === 'string')
                  .map((c) => c.text)
                  .join(' ')
              : ''
        if (text) title = text.slice(0, 80)
      }
    } catch {
      // 坏行跳过
    }
  }
  return { title, startedAt, updatedAt, messageCount: count }
}

function byRecency(a: DshLocalSession, b: DshLocalSession): number {
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
}

export class DshLocalSessionReader {
  private readonly base = SESSIONS_DIR

  /** 轻量枚举：仅目录/mtime，不解压 zstd（侧栏/状态用，毫秒级）。 */
  listSummaries(): DshLocalSession[] {
    if (!existsSync(this.base)) return []
    const out: DshLocalSession[] = []
    for (const ws of readdirSync(this.base)) {
      const wsdir = join(this.base, ws)
      let sessDirs: string[] = []
      try {
        sessDirs = readdirSync(wsdir).filter((d) => d.startsWith('session-'))
      } catch {
        continue
      }
      let latest = 0
      for (const sess of sessDirs) {
        try {
          const mt = statSync(join(wsdir, sess, 'session.jsonl.zstd')).mtimeMs
          if (mt > latest) latest = mt
        } catch {
          continue
        }
      }
      out.push({
        sessionId: ws,
        workspaceDir: decodeWorkspaceDir(ws),
        workspaceLabel: decodeWorkspaceDir(ws),
        startedAt: null,
        updatedAt: latest || null,
        messageCount: sessDirs.length,
        title: null
      })
    }
    return out.sort(byRecency)
  }

  available(): boolean {
    return existsSync(this.base)
  }

  /** 枚举全部本地会话（zstd 异步解压；上限 limit，按最近活动排序）。 */
  async listAll(limit = 500): Promise<DshLocalSession[]> {
    if (!existsSync(this.base)) return []
    const out: DshLocalSession[] = []
    const seen = new Set<string>()
    for (const ws of readdirSync(this.base)) {
      const wsdir = join(this.base, ws)
      let sessDirs: string[] = []
      try {
        sessDirs = readdirSync(wsdir).filter((d) => d.startsWith('session-'))
      } catch {
        continue
      }
      for (const sess of sessDirs) {
        const sessDir = join(wsdir, sess)
        const zstdPath = join(sessDir, 'session.jsonl.zstd')
        let mtime = 0
        try {
          mtime = statSync(zstdPath).mtimeMs
        } catch {
          continue
        }
        if (seen.has(sessDir)) continue
        seen.add(sessDir)
        let title: string | null = null
        let startedAt: number | null = null
        let updatedAt: number | null = mtime || null
        let messageCount = 0
        try {
          const jsonl = await decompressZstdFile(zstdPath)
          const meta = extractMeta(jsonl)
          title = meta.title
          startedAt = meta.startedAt
          updatedAt = meta.updatedAt ?? updatedAt
          messageCount = meta.messageCount
        } catch {
          // 解压失败仅保留文件级时间，条目不丢
        }
        out.push({
          sessionId: sess.replace('session-', ''),
          workspaceDir: decodeWorkspaceDir(ws),
          workspaceLabel: decodeWorkspaceDir(ws),
          startedAt,
          updatedAt,
          messageCount,
          title
        })
        if (out.length >= limit) break
      }
    }
    return out.sort(byRecency)
  }
}

export { extractMeta }
