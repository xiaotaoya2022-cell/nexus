import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'app.nexus.mobile',
  appName: 'Nexus',
  webDir: 'dist',
  // 局域网 ws:// 明文直连 PC 端 Nexus 远程服务：
  // - androidScheme 用 http，避免 https 源下 ws:// 被混合内容策略拦截
  // - allowMixedContent 兜底部分 WebView 行为
  server: {
    androidScheme: 'http'
  },
  android: {
    allowMixedContent: true
  }
}

export default config
