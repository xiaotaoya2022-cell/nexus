// 设置：服务器地址 + 配对（粘贴配对码/手输 PIN+密钥+nonce）+ 已配对凭据管理 + 连接状态指示。

import { useState } from 'react'
import { pairOnce, parsePairingUri } from '../lib/conn'
import { useStore } from '../lib/store'

const STATUS_TEXT: Record<string, string> = {
  online: '在线',
  connecting: '连接中…',
  authing: '鉴权中…',
  disconnected: '已断开',
  error: '错误'
}

export function SettingsPage() {
  const settings = useStore((s) => s.settings)
  const status = useStore((s) => s.status)
  const saveSettings = useStore((s) => s.saveSettings)
  const clearPairing = useStore((s) => s.clearPairing)
  const applyConnect = useStore((s) => s.applyConnect)
  const applyDisconnect = useStore((s) => s.applyDisconnect)

  const [pin, setPin] = useState('')
  const [pairNonce, setPairNonce] = useState('')
  const [pairSecret, setPairSecret] = useState('')
  const [pairing, setPairing] = useState(false)
  const [pairMsg, setPairMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const paired = settings.deviceId !== '' && settings.token !== ''
  const addressReady = settings.host.trim() !== '' && settings.port.trim() !== ''
  const pairReady = pin.length === 6 && pairNonce !== '' && pairSecret !== ''

  /** 粘贴 PC 端二维码内容：解析出 host/port/nonce/密钥/PIN 并填入表单 */
  const applyPairingText = (raw: string) => {
    const parsed = parsePairingUri(raw)
    if (parsed == null) {
      if (raw.trim() !== '') setPairMsg({ ok: false, text: '无法识别配对码，应为 nexus-pair://host:port?n=…&s=…#123456' })
      return
    }
    saveSettings({ host: parsed.host, port: parsed.port })
    setPairNonce(parsed.nonce)
    setPairSecret(parsed.pairingSecret)
    setPin(parsed.pin)
    setPairMsg({ ok: true, text: '已解析配对码，请点击「配对」完成 pairing' })
  }

  const doPair = async () => {
    if (!pairReady || !addressReady || pairing) return
    setPairing(true)
    setPairMsg(null)
    try {
      const res = await pairOnce(settings.host.trim(), settings.port.trim(), {
        nonce: pairNonce,
        pairingSecret: pairSecret,
        pin,
        deviceName: settings.deviceName || 'Android 手机'
      })
      saveSettings({ deviceId: res.deviceId, token: res.token })
      setPairMsg({ ok: true, text: `配对成功：${res.deviceId}（token 已本地推导，未上线）` })
      setPin('')
      setPairNonce('')
      setPairSecret('')
      applyConnect()
    } catch (e) {
      setPairMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setPairing(false)
    }
  }

  const dotClass =
    status.status === 'online' ? 'ok' : status.status === 'error' ? 'err' : status.status === 'disconnected' ? 'idle' : 'wait'

  return (
    <div className="page-scroll">
      <div className="card">
        <div className="card-head">
          <span className="card-title">连接状态</span>
          <span className="status-line">
            <span className={`status-dot ${dotClass}`} />
            <span>{STATUS_TEXT[status.status] ?? status.status}</span>
          </span>
        </div>
        {status.detail != null && <div className="hint">{status.detail}</div>}
        {status.retryInMs != null && <div className="hint">约 {status.retryInMs / 1000}s 后自动重连</div>}
        <div className="btn-row">
          <button className="btn primary" disabled={!paired || !addressReady || status.status === 'online'} onClick={applyConnect}>
            连接
          </button>
          <button className="btn" disabled={status.status === 'disconnected'} onClick={applyDisconnect}>
            断开
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-title">服务器</div>
        <div className="field-grid">
          <label className="field">
            <span>地址</span>
            <input
              className="input mono"
              placeholder="PC 局域网 IP，如 192.168.1.20"
              value={settings.host}
              inputMode="decimal"
              autoComplete="off"
              onChange={(e) => saveSettings({ host: e.target.value.trim() })}
            />
          </label>
          <label className="field">
            <span>端口</span>
            <input
              className="input mono"
              placeholder="随机端口"
              value={settings.port}
              inputMode="numeric"
              autoComplete="off"
              onChange={(e) => saveSettings({ port: e.target.value.replace(/\D/g, '').slice(0, 5) })}
            />
          </label>
          <label className="field">
            <span>设备名</span>
            <input
              className="input"
              placeholder="显示在 PC 端设备列表"
              value={settings.deviceName}
              maxLength={40}
              onChange={(e) => saveSettings({ deviceName: e.target.value })}
            />
          </label>
        </div>
        <div className="hint">手机与 PC 需在同一局域网；地址与端口见 PC 端「设置 → 远程服务」的配对二维码。</div>
      </div>

      <div className="card">
        <div className="card-head">
          <span className="card-title">配对</span>
          {paired && <span className="card-side badge ok">已配对</span>}
        </div>
        {!paired ? (
          <>
            <div className="field-grid">
              <label className="field">
                <span>粘贴配对码（PC 端二维码内容）</span>
                <input
                  className="input mono"
                  placeholder="nexus-pair://192.168.x.x:port?n=…&s=…#123456"
                  autoComplete="off"
                  onChange={(e) => applyPairingText(e.target.value)}
                />
              </label>
              <label className="field">
                <span>PIN（60s 有效，一次性）</span>
                <input
                  className="input mono pin"
                  placeholder="6 位数字"
                  value={pin}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                />
              </label>
              <label className="field">
                <span>配对密钥 s</span>
                <input
                  className="input mono"
                  placeholder="二维码内 s= 参数"
                  value={pairSecret}
                  autoComplete="off"
                  onChange={(e) => setPairSecret(e.target.value.trim())}
                />
              </label>
              <label className="field">
                <span>配对会话 n（nonce）</span>
                <input
                  className="input mono"
                  placeholder="二维码内 n= 参数"
                  value={pairNonce}
                  autoComplete="off"
                  onChange={(e) => setPairNonce(e.target.value.trim())}
                />
              </label>
            </div>
            <div className="btn-row">
              <button className="btn primary" disabled={!pairReady || !addressReady || pairing} onClick={() => void doPair()}>
                {pairing ? '配对中…' : '配对'}
              </button>
            </div>
            {pairMsg != null && <div className={`hint ${pairMsg.ok ? 'ok-text' : 'err-text'}`}>{pairMsg.text}</div>}
            <div className="hint">
              在 PC 端「设置 → 生成配对二维码 / PIN」后，用手机相机扫码或复制二维码内容粘贴到上方；
              也可对照二维码手工填 PIN / s / n 三项。
            </div>
          </>
        ) : (
          <>
            <div className="kv-row">
              <span className="kv-key">deviceId</span>
              <span className="kv-val mono">{settings.deviceId}</span>
            </div>
            <div className="kv-row">
              <span className="kv-key">token</span>
              <span className="kv-val mono">
                {settings.token.slice(0, 10)}…{settings.token.slice(-6)}
              </span>
            </div>
            <div className="hint">
              token 由二维码密钥本地推导（sha256），鉴权走挑战-应答、令牌永不上线；
              凭据仅存本机 localStorage，已关闭系统备份。
            </div>
            <div className="btn-row">
              <button
                className="btn danger"
                onClick={() => {
                  clearPairing()
                  setPairMsg(null)
                }}
              >
                清除配对
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
