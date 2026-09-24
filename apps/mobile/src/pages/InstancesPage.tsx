// 实例：ZCode 实例列表（只读发现）+ DSH 会话列表，支持下拉刷新。

import { useCallback, useEffect, useState } from 'react'
import { PullRefresh } from '../components/PullRefresh'
import type { DshSessionInfo, DshStatus, ZcodeInstance } from '../lib/api-types'
import { conn } from '../lib/conn'
import { fmtDateTime } from '../lib/format'
import { useStore } from '../lib/store'

export function InstancesPage() {
  const online = useStore((s) => s.status.status === 'online')
  const [zc, setZc] = useState<ZcodeInstance[] | null>(null)
  const [dshStatus, setDshStatus] = useState<DshStatus | null>(null)
  const [dshSessions, setDshSessions] = useState<DshSessionInfo[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [instances, status, sessions] = await Promise.all([
        conn.request<ZcodeInstance[]>('zc.instances'),
        conn.request<DshStatus>('dsh.status'),
        conn.request<DshSessionInfo[]>('dsh.sessions')
      ])
      setZc(instances)
      setDshStatus(status)
      setDshSessions(sessions)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    if (online) void load()
  }, [online, load])

  return (
    <PullRefresh onRefresh={load}>
      {!online && <div className="banner warn">未连接 PC 端</div>}
      {err != null && <div className="banner error">加载失败：{err}</div>}

      <div className="card">
        <div className="card-head">
          <span className="card-title">ZCode 实例</span>
          <span className="card-side mono">{zc?.length ?? '—'}</span>
        </div>
        {zc == null ? (
          <div className="empty">{online ? '加载中…' : '等待连接…'}</div>
        ) : zc.length === 0 ? (
          <div className="empty">未发现实例</div>
        ) : (
          <div className="list">
            {zc.map((inst) => (
              <div className="list-row" key={inst.id}>
                <div className="list-main">
                  <div className="list-title">
                    {inst.name}
                    <span className={`badge ${inst.running ? 'ok' : 'idle'}`}>{inst.running ? '运行中' : '离线'}</span>
                  </div>
                  <div className="list-sub">
                    {inst.currentProject ?? '无项目'}
                    {inst.lastActiveAt != null ? ` · 活跃 ${fmtDateTime(inst.lastActiveAt)}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <span className="card-title">DSH 会话</span>
          <span className="card-side">
            {dshStatus != null ? (
              <span className={`badge ${dshStatus.available && !dshStatus.degraded ? 'ok' : 'idle'}`}>
                {dshStatus.available ? (dshStatus.degraded ? `降级 :${dshStatus.port}` : `可用 :${dshStatus.port}`) : '不可用'}
              </span>
            ) : null}
          </span>
        </div>
        {dshStatus != null && !dshStatus.available && (
          <div className="banner">DSH 未运行（{dshStatus.detail ?? `端口 ${dshStatus.port}`}）</div>
        )}
        {dshSessions == null ? (
          <div className="empty">{online ? '加载中…' : '等待连接…'}</div>
        ) : dshSessions.length === 0 ? (
          <div className="empty">暂无 DSH 会话</div>
        ) : (
          <div className="list">
            {dshSessions.map((s) => (
              <div className="list-row" key={s.sessionId}>
                <div className="list-main">
                  <div className="list-title">
                    <span className="mono">{s.sessionId.slice(0, 12)}</span>
                    {s.running != null && (
                      <span className={`badge ${s.running ? 'ok' : 'idle'}`}>{s.running ? '运行中' : '空闲'}</span>
                    )}
                  </div>
                  <div className="list-sub">
                    {s.workspace ?? '未知工作区'}
                    {s.updatedAt != null ? ` · ${fmtDateTime(s.updatedAt)}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="hint">下拉刷新 · 数据来自 PC 端只读发现</div>
    </PullRefresh>
  )
}
