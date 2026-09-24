import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Nexus Android 端（Capacitor + React）。
// @shared 直接指向 PC 端共享契约目录：协议信封与数据类型单一事实源。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../../src/shared', import.meta.url))
    }
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1600
  }
})
