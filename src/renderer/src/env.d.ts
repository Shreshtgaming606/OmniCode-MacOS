/// <reference types="vite/client" />

import type { OmniCodeAPI } from '../../shared/contracts'

declare global {
  interface Window {
    omnicode: OmniCodeAPI
  }
}

export {}
