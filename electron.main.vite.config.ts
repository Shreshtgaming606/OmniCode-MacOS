import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { loadEnv } from 'vite'

import { readGoogleOAuthBuildConfig } from './src/build/google-oauth-build-config'

// Fast, production-equivalent main-process rebuilds for changes that do not
// touch the preloads or renderer. The regular `npm run build` remains the full
// release gate and is always run at least once before packaging.
export default defineConfig(({ mode }) => {
  const environment = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  const googleOAuth = readGoogleOAuthBuildConfig(environment)
  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      define: {
        __OMNICODE_GOOGLE_OAUTH_CLIENT_ID__: JSON.stringify(googleOAuth?.clientId ?? ''),
        __OMNICODE_GOOGLE_OAUTH_CLIENT_SECRET__: JSON.stringify(googleOAuth?.clientSecret ?? ''),
        __OMNICODE_GOOGLE_OAUTH_TESTING__: JSON.stringify(googleOAuth?.testing ?? false)
      }
    }
  }
})

