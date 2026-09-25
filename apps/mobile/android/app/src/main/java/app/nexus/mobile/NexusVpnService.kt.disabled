// NexusVpnService：Nexus 自带 WireGuard 隧道服务（GoBackend，用户态，无 root）。
// 职责：捕获手机发往 PC 虚拟网段(10.66.66.0/24)的流量，经 WireGuard 隧道送达 PC 端
// sidecar 的 WireGuard 服务端。密钥与 PC 地址由 App 在启动隧道前写入 SharedPreferences。
// 依赖：com.wireguard.android:tunnel（官方 GoBackend，MPL-2.0）。

package app.nexus.mobile

import android.content.Intent
import android.os.ParcelFileDescriptor
import com.wireguard.android.backend.GoBackend
import com.wireguard.config.Config
import com.wireguard.config.InetNetwork
import com.wireguard.config.Interface
import com.wireguard.config.Peer
import com.wireguard.crypto.KeyPair
import java.net.InetSocketAddress

class NexusVpnService : android.net.VpnService() {

    companion object {
        const val ACTION_CONNECT = "app.nexus.mobile.VPN_CONNECT"
        const val ACTION_DISCONNECT = "app.nexus.mobile.VPN_DISCONNECT"
        private const val VPN_ADDRESS = "10.66.66.2/24" // 手机端隧道内地址
        private const val PC_TUNNEL_ADDRESS = "10.66.66.1"
        private const val PREFS = "nexus_vpn"
    }

    private var tunnel: ParcelFileDescriptor? = null
    private var running = false

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_DISCONNECT -> {
                stopTunnel()
                return START_NOT_STICKY
            }
            else -> connect()
        }
        return START_STICKY
    }

    private fun connect() {
        if (running) return
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val privateKey = prefs.getString("privateKey", null)
        val peerPublicKey = prefs.getString("peerPublicKey", null)
        val endpoint = prefs.getString("endpoint", null)
        if (privateKey == null || peerPublicKey == null || endpoint == null) return

        // GoBackend 需要在 Application/首次使用时 loadLibrary；此处懒加载
        val backend = GoBackend(this)

        val config = Config.Builder()
            .setInterface(
                Interface.Builder()
                    .addAddress(InetNetwork.parse(VPN_ADDRESS))
                    .parsePrivateKey(privateKey)
                    .build()
            )
            .addPeer(
                Peer.Builder()
                    .setPublicKey(com.wireguard.crypto.Key.fromBase64(peerPublicKey))
                    .setEndpoint(InetSocketAddress(endpoint, 51820))
                    .addAllowedIp(InetNetwork.parse("10.66.66.0/24"))
                    .setPersistentKeepalive(25)
                    .build()
            )
            .build()

        // addAddress/addRoute：把 PC 隧道地址路由进 VPN
        val builder = Builder()
            .setMtu(1420)
            .addAddress("10.66.66.2", 24)
            .addRoute("10.66.66.0", 24)
            .addDnsServer("10.66.66.1")
        tunnel = builder.establish()
        running = tunnel != null

        // GoBackend 隧道状态切换（backend.setState 由调用线程处理）
        Thread {
            try {
                backend.setState(backend.getState(), config)
            } catch (_: Exception) {
            }
        }.start()
    }

    private fun stopTunnel() {
        tunnel?.close()
        tunnel = null
        running = false
    }

    override fun onDestroy() {
        stopTunnel()
        super.onDestroy()
    }
}
