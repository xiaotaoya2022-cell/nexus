// 通用回环 OAuth 助手：起 127.0.0.1 随机端口回调服务器 + 打开系统浏览器 + 等授权码。
// 证据：cockpit codex_oauth.rs（start_callback_server/build_auth_url：动态端口 + S256 PKCE + state 校验）。
// 用法：调用方提供 buildAuthUrl(redirectUri)（redirectUri 里端口为 0 占位），
// 本助手起服后用真实端口构造最终 URL 再打开浏览器，避免编码串替换的脆弱性。

import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { shell } from 'electron'

export function base64urlToken(): string {
  return randomBytes(32).toString('base64url')
}

export function s256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export interface LoopbackOptions {
  /** (redirectUri) => 完整授权 URL；redirectUri 端口为 0 占位，如 http://localhost:0/auth/callback */
  buildAuthUrl: (redirectUri: string) => string
  /** 回调基址（端口 0 占位） */
  redirectUriBase: string
  expectedState: string
  timeoutMs?: number
}

export interface LoopbackResult {
  code: string
  /** 实际使用的回调地址（令牌交换必须与授权时一致） */
  redirectUri: string
}

/** 打开浏览器等待回环回调，返回授权码与真实回调地址（校验 state）。超时/用户取消抛错。 */
export async function runLoopbackOAuth(opts: LoopbackOptions): Promise<LoopbackResult> {
  const { buildAuthUrl, redirectUriBase, expectedState, timeoutMs = 300_000 } = opts
  const callbackPath = new URL(redirectUriBase).pathname

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const page = (color: string, msg: string): string =>
      `<html><body style="font-family:sans-serif;background:#161616;color:${color};text-align:center;padding-top:20%"><h2>${msg}</h2></body></html>`
    if (!url.pathname.startsWith(callbackPath)) {
      res.writeHead(404).end()
      return
    }
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const err = url.searchParams.get('error')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (code && state === expectedState) {
      res.end(page('#d4d4d4', '登录成功，可关闭此页面回到 Nexus'))
    } else {
      res.end(page('#ff8a30', err ? `登录失败：${err}` : '登录失败：授权码缺失'))
    }
    server.emit('nexus:code', code && state === expectedState ? code : null)
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port)
    })
  })

  const redirectUri = redirectUriBase.replace(':0', String(port))
  const codePromise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('OAuth 登录超时（5 分钟）')), timeoutMs)
    server.once('nexus:code', (code: string | null) => {
      clearTimeout(timer)
      if (code) resolve(code)
      else reject(new Error('授权被取消或校验失败'))
    })
  })

  try {
    await shell.openExternal(buildAuthUrl(redirectUri))
    const code = await codePromise
    return { code, redirectUri }
  } finally {
    server.close()
  }
}
