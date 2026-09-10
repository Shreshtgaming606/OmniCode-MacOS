import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __OMNICODE_GOOGLE_OAUTH_CLIENT_ID__: JSON.stringify(process.env.OMNICODE_GOOGLE_OAUTH_CLIENT_ID?.trim() ?? ''),
      __OMNICODE_GOOGLE_OAUTH_CLIENT_SECRET__: JSON.stringify(process.env.OMNICODE_GOOGLE_OAUTH_CLIENT_SECRET?.trim() ?? '')
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          // Electron's sandboxed preload loader executes CommonJS. Keeping the
          // renderer sandboxed is more important than emitting preload ESM.
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()]
  }
})
