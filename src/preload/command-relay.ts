export type AppCommandListener = (command: string, payload?: unknown) => void

export interface AppCommandRelay {
  dispatch(command: string, payload?: unknown): void
  subscribe(listener: AppCommandListener): () => void
}

/**
 * Renderer subscriptions are registered from a React effect, after the first
 * paint. Keep a small bounded queue so native menu/Finder commands arriving in
 * that startup window are delivered instead of silently disappearing.
 */
export function createAppCommandRelay(queueLimit = 50): AppCommandRelay {
  const listeners = new Set<AppCommandListener>()
  let pending: Array<{ command: string; payload?: unknown }> = []

  return {
    dispatch(command, payload) {
      if (listeners.size === 0) {
        pending.push({ command, payload })
        if (pending.length > queueLimit) pending = pending.slice(-queueLimit)
        return
      }
      for (const listener of listeners) listener(command, payload)
    },
    subscribe(listener) {
      listeners.add(listener)
      if (pending.length > 0) {
        const queued = pending
        pending = []
        for (const item of queued) listener(item.command, item.payload)
      }
      return () => listeners.delete(listener)
    }
  }
}
