import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import {
  Eraser,
  Columns2,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  SquareTerminal,
  Trash2,
  X
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'

import type {
  TerminalExitEvent,
  TerminalSessionInfo
} from '../../../shared/contracts'
import { buildShellCommand } from '../lib/terminal-command'
import './TerminalPanel.css'

export interface TerminalPanelProps {
  workspacePath: string | null
  visible: boolean
  onRequestClose: () => void
  onOutput?: (data: string) => void
  onRequestText: (options: { title: string; label: string; value?: string; confirmLabel: string }) => Promise<string | null>
  runRequest?: TerminalRunRequest
}

export interface TerminalRunRequest {
  token: number
  name: string
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
}

type SessionState = 'running' | 'exited'

interface PanelSession extends TerminalSessionInfo {
  state: SessionState
  exitCode?: number
  signal?: number
}

interface BusyAction {
  kind: 'create' | 'restart' | 'kill'
  id?: string
}

type SessionTemplate = Pick<TerminalSessionInfo, 'cwd'> &
  Partial<Pick<TerminalSessionInfo, 'shell' | 'name'>>

interface TerminalViewportProps {
  session: PanelSession
  active: boolean
  secondary: boolean
  panelVisible: boolean
  onActivate: (id: string) => void
  onReady: (id: string, terminal: XTerm, search: SearchAddon) => void
  onUnready: (id: string, terminal: XTerm) => void
  onError: (message: string) => void
}

const MAX_PENDING_OUTPUT = 512 * 1024

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return fallback
}

function cssColor(element: HTMLElement, property: string, fallback: string): string {
  const value = window.getComputedStyle(element).getPropertyValue(property).trim()
  return value || fallback
}

function readTerminalTheme(element: HTMLElement): ITheme {
  return {
    background: cssColor(element, '--tp-terminal-background', '#111318'),
    foreground: cssColor(element, '--tp-terminal-foreground', '#d7dbe2'),
    cursor: cssColor(element, '--tp-terminal-cursor', '#d7dbe2'),
    cursorAccent: cssColor(element, '--tp-terminal-background', '#111318'),
    selectionBackground: cssColor(element, '--tp-terminal-selection', '#355785'),
    black: '#20242a',
    red: '#ef7b7b',
    green: '#72c991',
    yellow: '#e2b86b',
    blue: '#76a7f7',
    magenta: '#c79bf0',
    cyan: '#63c3cf',
    white: '#d7dbe2',
    brightBlack: '#717986',
    brightRed: '#ff9494',
    brightGreen: '#8bddaa',
    brightYellow: '#f2ce86',
    brightBlue: '#99beff',
    brightMagenta: '#dab5ff',
    brightCyan: '#85dbe4',
    brightWhite: '#f4f6f8'
  }
}

function exitDescription(event: TerminalExitEvent): string {
  if (event.signal !== undefined && event.signal !== 0) {
    return `Terminal process exited after signal ${event.signal}.`
  }
  return `Terminal process exited with code ${event.exitCode}.`
}

function terminalDomId(id: string): string {
  return `omnicode-terminal-${id.replaceAll(/[^a-zA-Z0-9_-]/g, '-')}`
}

function TerminalViewport({
  session,
  active,
  secondary,
  panelVisible,
  onActivate,
  onReady,
  onUnready,
  onError
}: TerminalViewportProps): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const activeRef = useRef(active)
  const visibleRef = useRef(panelVisible)

  activeRef.current = active
  visibleRef.current = panelVisible

  const fit = useCallback((focus = false): void => {
    if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current)

    animationFrameRef.current = window.requestAnimationFrame(() => {
      animationFrameRef.current = null
      const container = containerRef.current
      const terminal = terminalRef.current
      const fitAddon = fitAddonRef.current
      if (
        !container ||
        !terminal ||
        !fitAddon ||
        !activeRef.current ||
        !visibleRef.current ||
        container.clientWidth < 2 ||
        container.clientHeight < 2
      ) {
        return
      }

      try {
        fitAddon.fit()
        if (focus) terminal.focus()
      } catch (error) {
        onError(errorMessage(error, 'The terminal could not be resized.'))
      }
    })
  }, [onError])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    const terminal = new XTerm({
      allowProposedApi: false,
      convertEol: false,
      // A blinking xterm cursor continuously repaints both the renderer and GPU
      // process even when the terminal is idle. A solid cursor preserves the
      // input location without keeping an otherwise idle workbench busy.
      cursorBlink: false,
      cursorStyle: 'block',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      fontWeight: '400',
      fontWeightBold: '600',
      letterSpacing: 0,
      lineHeight: 1.25,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: true,
      screenReaderMode: true,
      scrollback: 10_000,
      theme: readTerminalTheme(container)
    })
    const fitAddon = new FitAddon()
    const searchAddon = new SearchAddon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(searchAddon)
    terminal.open(container)
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    const inputDisposable = terminal.onData((data) => {
      try {
        window.omnicode.terminal.write(session.id, data)
      } catch (error) {
        onError(errorMessage(error, 'Input could not be sent to the terminal.'))
      }
    })
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      try {
        window.omnicode.terminal.resize(session.id, cols, rows)
      } catch (error) {
        onError(errorMessage(error, 'The terminal process could not be resized.'))
      }
    })
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !event.metaKey) return true

      const key = event.key.toLowerCase()
      if (key === 'c') {
        if (terminal.hasSelection()) {
          void navigator.clipboard.writeText(terminal.getSelection()).catch((error: unknown) => {
            onError(errorMessage(error, 'The selected terminal text could not be copied.'))
          })
        }
        return false
      }

      if (key === 'v') {
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (text) window.omnicode.terminal.write(session.id, text)
          })
          .catch((error: unknown) => {
            onError(errorMessage(error, 'Clipboard text could not be pasted into the terminal.'))
          })
        return false
      }

      if (key === 'k') {
        terminal.clear()
        return false
      }

      return true
    })

    const applyTheme = (): void => {
      terminal.options.theme = readTerminalTheme(container)
    }
    const themeObserver = new MutationObserver(applyTheme)
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style']
    })
    if (document.body) {
      themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'data-theme', 'style']
      })
    }

    const colorScheme = window.matchMedia('(prefers-color-scheme: dark)')
    colorScheme.addEventListener('change', applyTheme)

    let resizeObserver: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => fit())
      resizeObserver.observe(container)
    }

    const helperTextarea = container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
    helperTextarea?.setAttribute('aria-label', `${session.name} terminal input`)

    onReady(session.id, terminal, searchAddon)
    fit(activeRef.current && visibleRef.current)

    return () => {
      onUnready(session.id, terminal)
      if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current)
      resizeObserver?.disconnect()
      themeObserver.disconnect()
      colorScheme.removeEventListener('change', applyTheme)
      inputDisposable.dispose()
      resizeDisposable.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [fit, onError, onReady, onUnready, session.id, session.name])

  useLayoutEffect(() => {
    if (active && panelVisible) fit(true)
  }, [active, fit, panelVisible])

  return (
    <div
      aria-labelledby={`${terminalDomId(session.id)}-tab`}
      className={`terminal-panel__screen${active ? ' is-active' : ''}${secondary ? ' is-secondary' : ''}`}
      id={`${terminalDomId(session.id)}-panel`}
      onMouseDown={() => onActivate(session.id)}
      ref={containerRef}
      role="tabpanel"
    />
  )
}

export function TerminalPanel({
  workspacePath,
  visible,
  onRequestClose,
  onOutput,
  onRequestText,
  runRequest
}: TerminalPanelProps): ReactNode {
  const [sessions, setSessions] = useState<PanelSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [splitId, setSplitId] = useState<string | null>(null)
  const [availableShells, setAvailableShells] = useState<string[]>([])
  const [selectedShell, setSelectedShell] = useState('')
  const [searchVisible, setSearchVisible] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [, setTerminalRevision] = useState(0)

  const sessionsRef = useRef<PanelSession[]>([])
  const terminalRefs = useRef(new Map<string, XTerm>())
  const searchRefs = useRef(new Map<string, SearchAddon>())
  const pendingOutput = useRef(new Map<string, string>())
  const earlyExits = useRef(new Map<string, TerminalExitEvent>())
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const restartingIds = useRef(new Set<string>())
  const killingIds = useRef(new Set<string>())
  const ignoredExitIds = useRef(new Set<string>())
  const creatingRef = useRef(false)
  const mountedRef = useRef(false)
  const deferredUnmountCleanup = useRef<number | null>(null)
  const generationRef = useRef(0)
  const workspaceRef = useRef(workspacePath)
  const previousWorkspaceRef = useRef(workspacePath)
  const automaticallyOpenedWorkspace = useRef<string | null>(null)
  const sessionSequence = useRef(1)
  const lastRunToken = useRef<number | undefined>(undefined)
  const runQueue = useRef<TerminalRunRequest[]>([])
  const runQueueProcessing = useRef(false)
  const [runQueueRevision, setRunQueueRevision] = useState(0)

  sessionsRef.current = sessions
  workspaceRef.current = workspacePath

  useEffect(() => {
    void window.omnicode.terminal.listShells().then((shells) => {
      setAvailableShells(shells)
      setSelectedShell((current) => current || shells[0] || '')
    }).catch(() => undefined)
  }, [])

  const reportError = useCallback((message: string): void => {
    setError(message)
  }, [])

  const registerTerminal = useCallback((id: string, terminal: XTerm, search: SearchAddon): void => {
    terminalRefs.current.set(id, terminal)
    searchRefs.current.set(id, search)
    const buffered = pendingOutput.current.get(id)
    if (buffered) {
      terminal.write(buffered)
      pendingOutput.current.delete(id)
    }
    setTerminalRevision((revision) => revision + 1)
  }, [])

  const unregisterTerminal = useCallback((id: string, terminal: XTerm): void => {
    if (terminalRefs.current.get(id) === terminal) {
      terminalRefs.current.delete(id)
      searchRefs.current.delete(id)
      setTerminalRevision((revision) => revision + 1)
    }
  }, [])

  const createSession = useCallback(async (
    template?: SessionTemplate
  ): Promise<TerminalSessionInfo | null> => {
    const cwd = template?.cwd || workspaceRef.current
    if (!cwd) {
      setError('Open a folder before starting a terminal.')
      return null
    }
    if (creatingRef.current) return null

    const generation = generationRef.current
    const sequence = sessionSequence.current
    sessionSequence.current += 1
    creatingRef.current = true
    setBusyAction({ kind: 'create' })
    setError(null)

    try {
      const session = await window.omnicode.terminal.create({
        cwd,
        shell: template?.shell || selectedShell || undefined,
        name: template?.name || `Terminal ${sequence}`
      })

      if (!mountedRef.current || generation !== generationRef.current) {
        killingIds.current.add(session.id)
        ignoredExitIds.current.add(session.id)
        await window.omnicode.terminal.kill(session.id).catch(() => undefined)
        killingIds.current.delete(session.id)
        window.setTimeout(() => ignoredExitIds.current.delete(session.id), 5_000)
        return null
      }

      const earlyExit = earlyExits.current.get(session.id)
      earlyExits.current.delete(session.id)
      const panelSession: PanelSession = {
        ...session,
        state: earlyExit ? 'exited' : 'running',
        exitCode: earlyExit?.exitCode,
        signal: earlyExit?.signal
      }
      setSessions((current) => [...current, panelSession])
      setActiveId(session.id)

      if (earlyExit) {
        const notice = `\r\n\u001b[90m[${exitDescription(earlyExit)}]\u001b[0m\r\n`
        const buffered = pendingOutput.current.get(session.id) ?? ''
        pendingOutput.current.set(session.id, `${buffered}${notice}`.slice(-MAX_PENDING_OUTPUT))
      }

      return session
    } catch (cause) {
      setError(errorMessage(cause, 'A terminal session could not be created.'))
      return null
    } finally {
      creatingRef.current = false
      if (mountedRef.current && generation === generationRef.current) setBusyAction(null)
    }
  }, [selectedShell])

  useEffect(() => {
    const stopData = window.omnicode.terminal.onData(({ id, data }) => {
      onOutput?.(data)
      const terminal = terminalRefs.current.get(id)
      if (terminal) {
        terminal.write(data)
        return
      }

      const buffered = `${pendingOutput.current.get(id) ?? ''}${data}`
      pendingOutput.current.set(id, buffered.slice(-MAX_PENDING_OUTPUT))
    })

    const stopExit = window.omnicode.terminal.onExit((event) => {
      if (ignoredExitIds.current.delete(event.id)) return
      if (killingIds.current.has(event.id) || restartingIds.current.has(event.id)) return

      const knownSession = sessionsRef.current.some((session) => session.id === event.id)
      if (!knownSession) {
        earlyExits.current.set(event.id, event)
        return
      }

      setSessions((current) => current.map((session) => (
        session.id === event.id
          ? { ...session, state: 'exited', exitCode: event.exitCode, signal: event.signal }
          : session
      )))
      const notice = `\r\n\u001b[90m[${exitDescription(event)}]\u001b[0m\r\n`
      const terminal = terminalRefs.current.get(event.id)
      if (terminal) terminal.write(notice)
      else {
        const buffered = pendingOutput.current.get(event.id) ?? ''
        pendingOutput.current.set(event.id, `${buffered}${notice}`.slice(-MAX_PENDING_OUTPUT))
      }
    })

    return () => {
      stopData()
      stopExit()
    }
  }, [onOutput])

  useEffect(() => {
    if (deferredUnmountCleanup.current !== null) {
      window.clearTimeout(deferredUnmountCleanup.current)
      deferredUnmountCleanup.current = null
    }
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      deferredUnmountCleanup.current = window.setTimeout(() => {
        deferredUnmountCleanup.current = null
        if (mountedRef.current) return

        generationRef.current += 1
        for (const session of sessionsRef.current) {
          killingIds.current.add(session.id)
          ignoredExitIds.current.add(session.id)
          void window.omnicode.terminal.kill(session.id).finally(() => {
            killingIds.current.delete(session.id)
            window.setTimeout(() => ignoredExitIds.current.delete(session.id), 5_000)
          })
        }
      }, 0)
    }
  }, [])

  useEffect(() => {
    if (previousWorkspaceRef.current === workspacePath) return

    previousWorkspaceRef.current = workspacePath
    generationRef.current += 1
    automaticallyOpenedWorkspace.current = null
    sessionSequence.current = 1
    setBusyAction(null)
    setError(null)
    setSessions([])
    setActiveId(null)
    setSplitId(null)
    pendingOutput.current.clear()
    earlyExits.current.clear()
    runQueue.current = []

    for (const session of sessionsRef.current) {
      killingIds.current.add(session.id)
      ignoredExitIds.current.add(session.id)
      void window.omnicode.terminal.kill(session.id).finally(() => {
        killingIds.current.delete(session.id)
        pendingOutput.current.delete(session.id)
        window.setTimeout(() => ignoredExitIds.current.delete(session.id), 5_000)
      })
    }
  }, [workspacePath])

  useEffect(() => {
    if (
      !visible ||
      !workspacePath ||
      sessions.length !== 0 ||
      creatingRef.current ||
      automaticallyOpenedWorkspace.current === workspacePath
    ) {
      return
    }

    const timer = window.setTimeout(() => {
      if (
        mountedRef.current &&
        visible &&
        workspaceRef.current === workspacePath &&
        sessionsRef.current.length === 0 &&
        !creatingRef.current
      ) {
        automaticallyOpenedWorkspace.current = workspacePath
        void createSession()
      }
    }, 0)

    return () => window.clearTimeout(timer)
  }, [createSession, sessions.length, visible, workspacePath])

  useEffect(() => {
    if (!runRequest || lastRunToken.current === runRequest.token) return
    lastRunToken.current = runRequest.token
    runQueue.current.push({
      ...runRequest,
      args: [...runRequest.args],
      env: runRequest.env ? { ...runRequest.env } : undefined
    })
    setRunQueueRevision((revision) => revision + 1)
  }, [runRequest])

  useEffect(() => {
    if (runQueueProcessing.current || busyAction || runQueue.current.length === 0) return

    const request = runQueue.current[0]
    if (!request) return
    runQueueProcessing.current = true

    const dequeueRequest = (): void => {
      const index = runQueue.current.indexOf(request)
      if (index !== -1) runQueue.current.splice(index, 1)
    }

    void (async () => {
      let created: TerminalSessionInfo | null = null
      try {
        const commandLine = buildShellCommand(request)
        created = await createSession({
          cwd: request.cwd,
          name: request.name.trim() || 'Run'
        })
        if (!created) {
          if (!creatingRef.current) dequeueRequest()
          return
        }

        setActiveId(created.id)
        if (commandLine !== null) window.omnicode.terminal.write(created.id, `${commandLine}\r`)
        dequeueRequest()
      } catch (cause) {
        dequeueRequest()
        setError(errorMessage(cause, 'The run command could not be started.'))
        if (created) {
          const createdId = created.id
          killingIds.current.add(createdId)
          ignoredExitIds.current.add(createdId)
          await window.omnicode.terminal.kill(createdId).catch(() => undefined)
          killingIds.current.delete(createdId)
          window.setTimeout(() => ignoredExitIds.current.delete(createdId), 5_000)
          setSessions((current) => current.filter((session) => session.id !== createdId))
        }
      } finally {
        runQueueProcessing.current = false
        if (mountedRef.current) setRunQueueRevision((revision) => revision + 1)
      }
    })()
  }, [busyAction, createSession, runQueueRevision])

  useEffect(() => {
    if (activeId && sessions.some((session) => session.id === activeId)) return
    setActiveId(sessions.at(-1)?.id ?? null)
  }, [activeId, sessions])

  useEffect(() => {
    if (splitId && !sessions.some((session) => session.id === splitId)) setSplitId(null)
    if (splitId === activeId) setSplitId(null)
  }, [activeId, sessions, splitId])

  const activeSession = sessions.find((session) => session.id === activeId) ?? null
  const activeTerminal = activeId ? terminalRefs.current.get(activeId) : undefined
  const activeBusy = Boolean(
    busyAction && (busyAction.kind === 'create' || busyAction.id === activeId)
  )

  const restartSession = useCallback(async (session: PanelSession): Promise<void> => {
    if (busyAction) return

    setBusyAction({ kind: 'restart', id: session.id })
    setError(null)
    restartingIds.current.add(session.id)
    ignoredExitIds.current.add(session.id)
    const generation = generationRef.current

    try {
      const replacement = session.state === 'running'
        ? await window.omnicode.terminal.restart(session.id)
        : await window.omnicode.terminal.create({
            cwd: session.cwd,
            shell: session.shell,
            name: session.name
          })

      if (!mountedRef.current || generation !== generationRef.current) {
        killingIds.current.add(replacement.id)
        ignoredExitIds.current.add(replacement.id)
        await window.omnicode.terminal.kill(replacement.id).catch(() => undefined)
        killingIds.current.delete(replacement.id)
        window.setTimeout(() => ignoredExitIds.current.delete(replacement.id), 5_000)
        return
      }

      pendingOutput.current.delete(session.id)
      earlyExits.current.delete(session.id)
      const earlyExit = earlyExits.current.get(replacement.id)
      earlyExits.current.delete(replacement.id)
      setSessions((current) => {
        const index = current.findIndex((item) => item.id === session.id)
        const next = [...current]
        const replacementSession: PanelSession = {
          ...replacement,
          state: earlyExit ? 'exited' : 'running',
          exitCode: earlyExit?.exitCode,
          signal: earlyExit?.signal
        }
        if (index === -1) next.push(replacementSession)
        else next.splice(index, 1, replacementSession)
        return next
      })
      setActiveId(replacement.id)
      if (splitId === session.id) setSplitId(replacement.id)

      if (earlyExit) {
        const notice = `\r\n\u001b[90m[${exitDescription(earlyExit)}]\u001b[0m\r\n`
        const buffered = pendingOutput.current.get(replacement.id) ?? ''
        pendingOutput.current.set(replacement.id, `${buffered}${notice}`.slice(-MAX_PENDING_OUTPUT))
      }
    } catch (cause) {
      setError(errorMessage(cause, 'The terminal session could not be restarted.'))
      setSessions((current) => current.map((item) => (
        item.id === session.id ? { ...item, state: 'exited' } : item
      )))
    } finally {
      restartingIds.current.delete(session.id)
      window.setTimeout(() => ignoredExitIds.current.delete(session.id), 5_000)
      if (mountedRef.current && generation === generationRef.current) setBusyAction(null)
    }
  }, [busyAction, splitId])

  const killSession = useCallback(async (session: PanelSession): Promise<void> => {
    if (busyAction) return

    setBusyAction({ kind: 'kill', id: session.id })
    setError(null)
    killingIds.current.add(session.id)
    ignoredExitIds.current.add(session.id)

    try {
      await window.omnicode.terminal.kill(session.id)
      pendingOutput.current.delete(session.id)
      earlyExits.current.delete(session.id)
      setSessions((current) => current.filter((item) => item.id !== session.id))
      if (splitId === session.id) setSplitId(null)
    } catch (cause) {
      setError(errorMessage(cause, 'The terminal session could not be stopped.'))
    } finally {
      killingIds.current.delete(session.id)
      window.setTimeout(() => ignoredExitIds.current.delete(session.id), 5_000)
      if (mountedRef.current) setBusyAction(null)
    }
  }, [busyAction, splitId])

  useEffect(() => {
    const handleNew = (): void => {
      void createSession()
    }
    const handleClear = (): void => {
      if (!activeId) return
      terminalRefs.current.get(activeId)?.clear()
    }
    const handleKill = (): void => {
      if (!activeId) return
      const session = sessionsRef.current.find((item) => item.id === activeId)
      if (session) void killSession(session)
    }

    window.addEventListener('omnicode:terminal-new', handleNew)
    window.addEventListener('omnicode:terminal-clear', handleClear)
    window.addEventListener('omnicode:terminal-kill', handleKill)
    return () => {
      window.removeEventListener('omnicode:terminal-new', handleNew)
      window.removeEventListener('omnicode:terminal-clear', handleClear)
      window.removeEventListener('omnicode:terminal-kill', handleKill)
    }
  }, [activeId, createSession, killSession])

  const selectAndFocusTab = useCallback((session: PanelSession): void => {
    setActiveId(session.id)
    window.requestAnimationFrame(() => tabRefs.current.get(session.id)?.focus())
  }, [])

  const handleTabKeyDown = useCallback((
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number
  ): void => {
    if (sessions.length === 0) return

    let targetIndex: number | null = null
    if (event.key === 'ArrowLeft') targetIndex = (index - 1 + sessions.length) % sessions.length
    if (event.key === 'ArrowRight') targetIndex = (index + 1) % sessions.length
    if (event.key === 'Home') targetIndex = 0
    if (event.key === 'End') targetIndex = sessions.length - 1
    if (targetIndex === null) return

    event.preventDefault()
    const target = sessions[targetIndex]
    if (target) selectAndFocusTab(target)
  }, [selectAndFocusTab, sessions])

  return (
    <section
      aria-label="Integrated terminal"
      className="terminal-panel"
      hidden={!visible}
    >
      <header className="terminal-panel__header">
        <div className="terminal-panel__heading">
          <SquareTerminal aria-hidden="true" />
          <span>Terminal</span>
        </div>

        <div className="terminal-panel__tabs" role="tablist" aria-label="Terminal sessions">
          {sessions.map((session, index) => {
            const selected = session.id === activeId
            return (
              <button
                aria-controls={`${terminalDomId(session.id)}-panel`}
                aria-label={`${session.name}${session.state === 'exited' ? ', exited' : ''}`}
                aria-selected={selected}
                className={`terminal-panel__tab${selected ? ' is-active' : ''}`}
                id={`${terminalDomId(session.id)}-tab`}
                key={session.id}
                onClick={() => setActiveId(session.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
                ref={(element) => {
                  if (element) tabRefs.current.set(session.id, element)
                  else tabRefs.current.delete(session.id)
                }}
                role="tab"
                tabIndex={selected ? 0 : -1}
                title={`${session.shell} — ${session.cwd}`}
                type="button"
              >
                <span
                  aria-hidden="true"
                  className={`terminal-panel__status-dot terminal-panel__status-dot--${session.state}`}
                />
                <span className="terminal-panel__tab-label">{session.name}</span>
              </button>
            )
          })}
        </div>

        <div className="terminal-panel__actions" role="toolbar" aria-label="Terminal actions">
          <select
            aria-label="Shell for new terminals"
            disabled={busyAction !== null}
            onChange={(event) => setSelectedShell(event.target.value)}
            title="Shell for new terminals"
            value={selectedShell}
          >
            {availableShells.map((shell) => <option key={shell} value={shell}>{shell.split('/').pop()}</option>)}
          </select>
          <button
            aria-label="New terminal"
            disabled={!workspacePath || busyAction !== null}
            onClick={() => void createSession()}
            title={workspacePath ? 'New terminal' : 'Open a folder to start a terminal'}
            type="button"
          >
            {busyAction?.kind === 'create' ? (
              <LoaderCircle className="terminal-panel__spin" aria-hidden="true" />
            ) : (
              <Plus aria-hidden="true" />
            )}
          </button>
          <button
            aria-label="Split terminal"
            disabled={!workspacePath || busyAction !== null || Boolean(splitId)}
            onClick={() => {
              const primary = activeId
              void createSession({ cwd: workspacePath ?? '', shell: selectedShell || undefined }).then((created) => {
                if (created && primary) { setActiveId(primary); setSplitId(created.id) }
              })
            }}
            title="Split terminal"
            type="button"
          >
            <Columns2 aria-hidden="true" />
          </button>
          <button
            aria-label="Rename active terminal"
            disabled={!activeSession}
            onClick={() => void (async () => {
              if (!activeSession) return
              const name = await onRequestText({ title: 'Rename Terminal', label: 'Terminal name', value: activeSession.name, confirmLabel: 'Rename' })
              if (name) setSessions((current) => current.map((session) => session.id === activeSession.id ? { ...session, name } : session))
            })()}
            title="Rename terminal"
            type="button"
          >
            <Pencil aria-hidden="true" />
          </button>
          <button
            aria-label="Search terminal output"
            disabled={!activeSession}
            onClick={() => setSearchVisible((value) => !value)}
            title="Search terminal output"
            type="button"
          >
            <Search aria-hidden="true" />
          </button>
          <button
            aria-label="Restart active terminal"
            disabled={!activeSession || activeBusy}
            onClick={() => activeSession && void restartSession(activeSession)}
            title="Restart terminal"
            type="button"
          >
            {busyAction?.kind === 'restart' && busyAction.id === activeId ? (
              <LoaderCircle className="terminal-panel__spin" aria-hidden="true" />
            ) : (
              <RotateCcw aria-hidden="true" />
            )}
          </button>
          <button
            aria-label="Clear active terminal"
            disabled={!activeTerminal || activeBusy}
            onClick={() => activeTerminal?.clear()}
            title="Clear terminal (⌘K)"
            type="button"
          >
            <Eraser aria-hidden="true" />
          </button>
          <button
            aria-label="Kill active terminal"
            disabled={!activeSession || activeBusy}
            onClick={() => activeSession && void killSession(activeSession)}
            title="Kill terminal"
            type="button"
          >
            {busyAction?.kind === 'kill' && busyAction.id === activeId ? (
              <LoaderCircle className="terminal-panel__spin" aria-hidden="true" />
            ) : (
              <Trash2 aria-hidden="true" />
            )}
          </button>
          <span className="terminal-panel__action-separator" aria-hidden="true" />
          <button
            aria-label="Close terminal panel"
            onClick={onRequestClose}
            title="Close terminal panel"
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </div>
      </header>

      {searchVisible ? (
        <form className="terminal-panel__search" onSubmit={(event) => { event.preventDefault(); if (activeId && searchQuery) searchRefs.current.get(activeId)?.findNext(searchQuery) }}>
          <Search aria-hidden="true" />
          <input autoFocus aria-label="Search terminal output" onChange={(event) => setSearchQuery(event.target.value)} placeholder="Find in terminal" value={searchQuery} />
          <button type="button" disabled={!searchQuery} onClick={() => activeId && searchRefs.current.get(activeId)?.findPrevious(searchQuery)}>Previous</button>
          <button type="submit" disabled={!searchQuery}>Next</button>
          <button type="button" aria-label="Close terminal search" onClick={() => setSearchVisible(false)}><X /></button>
        </form>
      ) : null}

      {error ? (
        <div className="terminal-panel__error" role="alert">
          <span>{error}</span>
          <button aria-label="Dismiss terminal error" onClick={() => setError(null)} type="button">
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <div className={`terminal-panel__viewport${splitId ? ' is-split' : ''}`}>
        {sessions.length === 0 ? (
          <div className="terminal-panel__empty" role="status">
            {busyAction?.kind === 'create' ? (
              <>
                <LoaderCircle className="terminal-panel__spin" aria-hidden="true" />
                <span>Starting terminal…</span>
              </>
            ) : (
              <>
                <SquareTerminal aria-hidden="true" />
                <span>{workspacePath ? 'No terminal sessions' : 'Open a folder to start a terminal'}</span>
                {workspacePath ? (
                  <button disabled={busyAction !== null} onClick={() => void createSession()} type="button">
                    <Plus aria-hidden="true" />
                    New Terminal
                  </button>
                ) : null}
              </>
            )}
          </div>
        ) : (
          sessions.map((session) => (
            <TerminalViewport
              active={session.id === activeId || session.id === splitId}
              key={session.id}
              onActivate={(id) => {
                if (id === splitId && activeId) {
                  setSplitId(activeId)
                  setActiveId(id)
                  return
                }
                setActiveId(id)
              }}
              onError={reportError}
              onReady={registerTerminal}
              onUnready={unregisterTerminal}
              panelVisible={visible}
              secondary={session.id === splitId}
              session={session}
            />
          ))
        )}
      </div>
    </section>
  )
}

export default TerminalPanel
