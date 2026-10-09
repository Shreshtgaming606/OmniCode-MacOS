export type OmniCodeRoute =
  | { kind: 'workspace'; id: string }
  | { kind: 'conversation'; mode: 'work'; id: string }
  | { kind: 'mode'; mode: 'code' | 'work' | 'omni' }
  | { kind: 'action'; action: 'start-voice' | 'ask-omni' | 'open-workspace' | 'open-recent-workspace' | 'translate-clipboard' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u

/** Navigation only. No URL route can execute a tool, shell command, or model request. */
export function parseOmniCodeDeepLink(value: unknown): OmniCodeRoute | null {
  if (typeof value !== 'string' || value.length > 512 || !value.startsWith('omnicode://') || /[%?#\\\u0000-\u001f]|\.\./u.test(value)) return null
  let url: URL
  try { url = new URL(value) } catch { return null }
  if (url.protocol !== 'omnicode:' || url.username || url.password || url.port || url.search || url.hash) return null
  const parts = url.pathname.split('/').filter(Boolean)
  if (url.hostname === 'workspace' && parts.length === 1 && UUID.test(parts[0])) return { kind: 'workspace', id: parts[0] }
  if (url.hostname === 'conversation' && parts.length === 2 && parts[0] === 'work' && ID.test(parts[1])) return { kind: 'conversation', mode: 'work', id: parts[1] }
  if (url.hostname === 'mode' && parts.length === 1 && ['code', 'work', 'omni'].includes(parts[0])) {
    return { kind: 'mode', mode: parts[0] as 'code' | 'work' | 'omni' }
  }
  if (url.hostname === 'action' && parts.length === 1 && ['start-voice', 'ask-omni', 'open-workspace', 'open-recent-workspace', 'translate-clipboard'].includes(parts[0])) {
    return { kind: 'action', action: parts[0] as 'start-voice' | 'ask-omni' | 'open-workspace' | 'open-recent-workspace' | 'translate-clipboard' }
  }
  return null
}

export function routeForSpotlightIdentifier(value: unknown): OmniCodeRoute | null {
  if (typeof value !== 'string') return null
  if (value.startsWith('workspace:')) return parseOmniCodeDeepLink(`omnicode://workspace/${value.slice(10)}`)
  if (value.startsWith('conversation:work:')) return parseOmniCodeDeepLink(`omnicode://conversation/work/${value.slice(18)}`)
  switch (value) {
    case 'action:open-code': return { kind: 'mode', mode: 'code' }
    case 'action:open-work': return { kind: 'mode', mode: 'work' }
    case 'action:open-omni': return { kind: 'mode', mode: 'omni' }
    case 'action:start-voice': return { kind: 'action', action: 'start-voice' }
    default: return null
  }
}
