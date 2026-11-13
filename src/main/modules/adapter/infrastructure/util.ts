// 适配器基础设施：文件扫描、JSONL 增量读取、时间戳解析、只读 SQLite 打开。

import { DatabaseSync } from 'node:sqlite'
import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** 打开只读 SQLite（readOnly 语义等价 mode=ro，绝不写用户数据）。
 * busy_timeout=5s：外部库（如 ZCode）处于活动 WAL 写入中，避免偶发 SQLITE_BUSY。 */
export function openReadonlyDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true })
  db.prepare('PRAGMA busy_timeout = 5000').get()
  return db
}

/** 列出 SQLite 表的列名（只读连接上执行 PRAGMA 安全） */
export function tableColumns(db: DatabaseSync, table: string): string[] {
  try {
    const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{
      name: string
    }>
    return rows.map((r) => r.name)
  } catch {
    return []
  }
}

/** 表是否存在 */
export function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { name: string } | undefined
  return row != null
}

/** 容错解析时间戳为 epoch ms：支持 epoch 秒/毫秒/微秒与 ISO 字符串 */
export function parseTimestampMs(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1e15) return Math.round(value / 1000) // 微秒
    if (value > 1e11) return Math.round(value) // 毫秒
    if (value > 1e8) return Math.round(value * 1000) // 秒
    return null
  }
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) return parseTimestampMs(Number(value))
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

/** 递归收集匹配后缀的文件（限制深度，避免扫爆大目录） */
export function collectFiles(root: string, suffix: string, maxDepth = 4): string[] {
  return collectFilesMulti(root, [suffix], maxDepth)
}

/** 递归收集匹配任一后缀的文件 */
export function collectFilesMulti(root: string, suffixes: string[], maxDepth = 4): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full, depth + 1)
      else if (suffixes.some((s) => name.endsWith(s))) out.push(full)
    }
  }
  walk(root, 0)
  return out
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 解压单帧或多帧拼接（multi-frame append log）Zstandard 缓冲区。
 * DSH v4（.jsonl.zstd）与新版 Codex（.jsonl.zst）均采用 Zstd 帧格式。
 */
export function decompressZstdBuffer(buf: Buffer): string {
  if (typeof zstdDecompressSync !== 'function' || buf.length === 0) return ''
  const offsets: number[] = []
  let idx = 0
  while ((idx = buf.indexOf(ZSTD_MAGIC, idx)) !== -1) {
    offsets.push(idx)
    idx += 4
  }
  if (offsets.length === 0) {
    try {
      return zstdDecompressSync(buf).toString('utf8')
    } catch {
      return ''
    }
  }
  if (offsets.length === 1) {
    try {
      return zstdDecompressSync(buf.subarray(offsets[0])).toString('utf8')
    } catch {
      return ''
    }
  }
  const chunks: string[] = []
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i]
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    try {
      chunks.push(zstdDecompressSync(buf.subarray(start, end)).toString('utf8'))
    } catch {
      // 若压缩载荷内巧合出现魔数字节，尝试向后合并帧边界
      for (let j = i + 1; j < offsets.length; j++) {
        const nextEnd = j + 1 < offsets.length ? offsets[j + 1] : buf.length
        try {
          chunks.push(zstdDecompressSync(buf.subarray(start, nextEnd)).toString('utf8'))
          i = j
          break
        } catch {
          // continue searching
        }
      }
    }
  }
  return chunks.join('\n')
}

/** 读取 .jsonl 或 .jsonl.zst / .jsonl.zstd 文件的全部非空行 */
export function readJsonlOrZstdLines(filePath: string): string[] {
  try {
    if (filePath.endsWith('.zst') || filePath.endsWith('.zstd')) {
      const raw = decompressZstdBuffer(readFileSync(filePath))
      return raw.split('\n').filter((l) => l.trim().length > 0)
    }
    return readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
  } catch {
    return []
  }
}

/**
 * 增量读取 JSONL：从 byteOffset 起按 Buffer 精确切分 \n。
 * offset 只推进到最后一个完整行（含换行符）；残留的不完整尾行下次自动重读。
 * onLine 收到 (行文本, 该行结束后的字节 offset)。返回新的 offset。
 */
export function readJsonlIncremental(
  filePath: string,
  byteOffset: number,
  onLine: (line: string, offsetAfter: number) => void,
  maxLineBytes = 32 * 1024 * 1024
): Promise<number> {
  return new Promise((resolve, reject) => {
    let st
    try {
      st = statSync(filePath)
    } catch (err) {
      reject(err)
      return
    }
    if (byteOffset >= st.size) {
      resolve(byteOffset)
      return
    }
    const stream = createReadStream(filePath, { start: byteOffset })
    let remainder: Buffer = Buffer.alloc(0)
    let rawConsumed = byteOffset
    let skippingOversize = false
    stream.on('data', (chunk: string | Buffer) => {
      const buf0 = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const buf = remainder.length ? Buffer.concat([remainder, buf0]) : buf0
      let searchFrom = 0
      for (;;) {
        const idx = buf.indexOf(0x0a, searchFrom)
        if (idx === -1) break
        if (!skippingOversize) {
          const line = buf.subarray(searchFrom, idx)
          if (line.length <= maxLineBytes) {
            onLine(line.toString('utf8'), rawConsumed + idx + 1)
          }
        }
        skippingOversize = false
        searchFrom = idx + 1
      }
      remainder = buf.subarray(searchFrom)
      if (remainder.length > maxLineBytes) skippingOversize = true // 巨型无换行块：跳过
      rawConsumed += buf0.length
    })
    stream.on('end', () => {
      resolve(rawConsumed - remainder.length)
    })
    stream.on('error', (err) => {
      stream.close()
      reject(err)
    })
  })
}
