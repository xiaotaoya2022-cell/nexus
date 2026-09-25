// Windows DPAPI + os_crypt AES-256-GCM 解密助手（VS Code 系 IDE secret storage 通用）。
// 链路（cockpit vscode_inject.rs:153-179, 567-580）：
// 1) <dataRoot>/Local State → os_crypt.encrypted_key（base64，剥 'DPAPI' 5 字节前缀）
// 2) DPAPI CurrentUser 解密该 key（execFile powershell 常量命令，参数化 base64 输入）
// 3) v10 payload：nonce(12) + ciphertext + tag(16)，AES-256-GCM
// 安全：execFile 参数列表不经 shell；仅处理本机当前用户的加密数据；明文不落日志。

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDecipheriv } from 'node:crypto'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const PS_DPAPI_UNPROTECT =
  'param([string]$b64) $b = [Convert]::FromBase64String($b64); ' +
  '$p = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ' +
  '[Convert]::ToBase64String($p)'

let cachedKey: Buffer | null = null
let cachedKeyRoot = ''

/** DPAPI 解 base64 密文（无附加熵） */
export async function dpapiUnprotectBase64(b64: string): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', PS_DPAPI_UNPROTECT, b64],
    { timeout: 15000, windowsHide: true }
  )
  const out = stdout.trim()
  if (!out) throw new Error('DPAPI 解密失败（PowerShell 无输出）')
  return Buffer.from(out, 'base64')
}

/** 取 VS Code 系应用（Qoder/Trae 等）的 os_crypt AES key（按 dataRoot 缓存）。 */
export async function osCryptKey(dataRoot: string): Promise<Buffer | null> {
  if (cachedKey && cachedKeyRoot === dataRoot) return cachedKey
  const localState = join(dataRoot, 'Local State')
  if (!existsSync(localState)) return null
  try {
    const json = JSON.parse(readFileSync(localState, 'utf8')) as {
      os_crypt?: { encrypted_key?: string }
    }
    const encKeyB64 = json.os_crypt?.encrypted_key
    if (!encKeyB64) return null
    const blob = Buffer.from(encKeyB64, 'base64')
    if (blob.subarray(0, 5).toString('ascii') !== 'DPAPI') return null
    const key = await dpapiUnprotectBase64(blob.subarray(5).toString('base64'))
    if (key.length !== 32) return null
    cachedKey = key
    cachedKeyRoot = dataRoot
    return key
  } catch {
    return null
  }
}

/** 解 VS Code v10 payload（nonce12 + ciphertext + tag16）。 */
export function decryptV10(key: Buffer, payload: Buffer): string | null {
  if (payload.length < 12 + 16 || payload.subarray(0, 3).toString('ascii') !== 'v10') return null
  try {
    const nonce = payload.subarray(3, 15)
    const tag = payload.subarray(payload.length - 16)
    const cipher = payload.subarray(15, payload.length - 16)
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(cipher), decipher.final()])
    return plain.toString('utf8')
  } catch {
    return null
  }
}

/**
 * 读 VS Code 系 secret storage 值并解密。
 * value 兼容两种形态：纯 base64/JSON{base64|data|encrypted}（cockpit decode_buffer_data 同款宽容度）。
 */
export async function decryptSecretValue(dataRoot: string, rawValue: string): Promise<string | null> {
  const key = await osCryptKey(dataRoot)
  if (!key) return null
  let b64 = rawValue
  try {
    const parsed = JSON.parse(rawValue) as Record<string, unknown>
    const inner =
      (typeof parsed.base64 === 'string' && parsed.base64) ||
      (typeof parsed.data === 'string' && parsed.data) ||
      (typeof parsed.encrypted === 'string' && parsed.encrypted) ||
      null
    if (inner) b64 = inner
  } catch {
    // 非 JSON：按纯 base64 处理
  }
  try {
    const payload = Buffer.from(b64, 'base64')
    return decryptV10(key, payload)
  } catch {
    return null
  }
}
