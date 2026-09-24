// 控制：有限反控。选目标 DSH 会话 → 下发 prompt / cancel，操作后显示结果行。

import { useCallback, useEffect, useState } from 'react'
import type { DshPromptResult, DshSessionInfo, DshStatus } from '../lib/api-types'
import { conn } from '../lib/conn'
import { fmtTime } from '../lib/format'
import { useStore } from '../lib/store'

interface OpResult {
  ts: number
  op: string
  ok: boolean
  detail: string
}

export function ControlPage() {
  const online = useStore((s) => s.status.status === 'online')
  const [sessions, setSessions] = useState<DshSessionInfo[]>([])
  const [status, setStatus] = useState<DshStatus | null>(null)
  const [sessionId, setSessionId] = useState<string>('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<'prompt' | 'cancel' | null>(null)
  const [log, setLog] = useState<OpResult[]>([])

  const load = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([
        conn.request<DshSessionInfo[]>('dsh.sessions'),
        conn.request<DshStatus>('dsh.status')
      ])
      setSessions(s)
      setStatus(st)
    } catch (e) {
      setStatus({ available: false, degraded: false, port: 0, detail: e instanceof Error ? e.message : String(e) })
    }
  }, [])

  useEffect(() => {
    if (online) void load()
  }, [online, load])

  const appendLog = (op: string, ok: boolean, detail: string) =>
    setLog((prev) => [{ ts: Date.now(), op, ok, detail }, ...prev].slice(0, 30))

  const sendPrompt = async () => {
    const trimmed = text.trim()
    if (trimmed === '' || busy != null) return
    setBusy('prompt')
    try {
      const res = await conn.request<DshPromptResult>(
        'dsh.prompt',
        { sessionId: sessionId === '' ? undefined : sessionId, text: trimmed },
        60_000
      )
      appendLog('prompt', true, `已送达会话 ${res.sessionId.slice(0, 12)}`)
      setText('')
      void load()
    } catch (e) {
      appendLog('prompt', false, e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const sendCancel = async () => {
    if (sessionId === '' || busy != null) return
    setBusy('cancel')
    try {
      await conn.request('dsh.cancel', { sessionId }, 30_000)
      appendLog('cancel', true, `已发送取消：${sessionId.slice(0, 12)}`)
      void load()
    } catch (e) {
      appendLog('cancel', false, e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const dshReady = status == null || status.available

  return (
    <div className="page-scroll">
      {!online && <div className="banner warn">未连接 PC 端</div>}
      {online && status != null && !status.available && (
        <div className="banner error">DSH 不可用：{status.detail ?? `端口 ${status.port}`}</div>
      )}

      <div className="card">
        <div className="card-title">目标会话</div>
        <select className="select" value={sessionId} onChange={(e) => setSessionId(e.target.value)} disabled={!online}>
          <option value="">新建会话（发送时自动创建）</option>
          {sessions.map((s) => (
            <option key={s.sessionId} value={s.sessionId}>
              {`${s.sessionId.slice(0, 10)} ${s.running ? '· 运行中' : ''} ${s.workspace ? `· ${s.workspace}` : ''}`}
            </option>
          ))}
        </select>
        <div className="hint">
          {dshReady ? '通过 PC 端回环桥接下发到 DeepSeek Harness' : 'DSH 未运行，无法下发'}
        </div>
      </div>

      <div className="card">
        <div className="card-title">下发 Prompt</div>
        <textarea
          className="textarea"
          rows={4}
          placeholder={dshReady ? '输入要下发的任务文本…' : 'DSH 不可用'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={!online || !dshReady}
        />
        <div className="btn-row">
          <button
            className="btn primary"
            disabled={!online || !dshReady || busy != null || text.trim() === ''}
            onClick={() => void sendPrompt()}
          >
            {busy === 'prompt' ? '发送中…' : '下发'}
          </button>
          <button
            className="btn danger"
            disabled={!online || !dshReady || busy != null || sessionId === ''}
            onClick={() => void sendCancel()}
          >
            {busy === 'cancel' ? '取消中…' : 'Cancel 会话'}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-title">操作结果</div>
        {log.length === 0 ? (
          <div className="empty">暂无操作记录</div>
        ) : (
          <div className="list">
            {log.map((r) => (
              <div className="list-row" key={r.ts}>
                <div className="list-main">
                  <div className="list-title">
                    <span className={`badge ${r.ok ? 'ok' : 'err'}`}>{r.op}</span>
                    <span className="result-detail">{r.detail}</span>
                  </div>
                </div>
                <div className="list-side mono dim">{fmtTime(r.ts)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
