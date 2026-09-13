import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { loadEnv } from 'vite'
import { readGoogleOAuthBuildConfig } from './src/build/google-oauth-build-config'

export default defineConfig(({ mode }) => {
  const environment = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  const googleOAuth = readGoogleOAuthBuildConfig(environment)
  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      define: {
        // Only native public-client metadata and the developer Testing marker
        // enter the trusted main bundle. The credentials file and its path never
        // enter application files; PKCE, not the distributed Desktop secret,
        // provides the code-exchange security boundary.
        __OMNICODE_GOOGLE_OAUTH_CLIENT_ID__: JSON.stringify(googleOAuth?.clientId ?? ''),
        __OMNICODE_GOOGLE_OAUTH_CLIENT_SECRET__: JSON.stringify(googleOAuth?.clientSecret ?? ''),
        __OMNICODE_GOOGLE_OAUTH_TESTING__: JSON.stringify(googleOAuth?.testing ?? false)
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
  }
})
