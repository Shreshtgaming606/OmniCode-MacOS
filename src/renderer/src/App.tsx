import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Editor, { DiffEditor, type OnMount } from '@monaco-editor/react'
import type { CancellationToken, Position, editor, languages } from 'monaco-editor'
import {
  AudioWaveform, Bot, Bug, ChevronDown, CircleAlert, CircleDot, Code2, Command, Cpu, FileCode2, Files,
  GitBranch, Menu, PanelBottom, Play, Plus, Save, Search, Settings, Sparkles, TerminalSquare,
  X, Boxes, FolderOpen, GitFork, Server, CheckCircle2, LoaderCircle, Info, TriangleAlert
} from 'lucide-react'
import type {
  AIModel, AIProviderId, DevServerOption, DiffProposal, FileNode, GitCloneProgress, GitStatus, OllamaPullProgress, PackageScript, ServerState, ThemePreference, ToolInfo, ToolInstallationProgress, WorkspaceSettings
} from '../../shared/contracts'
import { AIChat } from './components/AIChat'
import { DiffReview } from './components/DiffReview'
import { Explorer } from './components/Explorer'
import { ModelsView } from './components/ModelsView'
import { Onboarding, type DetectedTool, type OllamaState } from './components/Onboarding'
import { RunView } from './components/RunView'
import { SearchView } from './components/SearchView'
import { SettingsPanel } from './components/SettingsPanel'
import { SourceControlView } from './components/SourceControlView'
import { TerminalPanel, type TerminalRunRequest } from './components/TerminalPanel'
import { ToolsView } from './components/ToolsView'
import { ModeSwitcher } from './components/modes/ModeSwitcher'
import { OmniMode } from './components/omni/OmniMode'
import { WorkMode } from './components/work/WorkMode'
import { fileName, flattenFiles, languageDefinitionForPath, languageForPath } from './lib/languages'
import { storedAgentPermission, storedAIProvider, storedAppMode, storedModelName, storedTheme } from './lib/preferences'
import type { AppMode } from '../../shared/work-contracts'

type Activity = 'explorer' | 'search' | 'source' | 'run' | 'models' | 'tools'
type PanelTab = 'terminal' | 'output' | 'problems' | 'runlog'

interface OpenDocument {
  path: string
  content: string
  savedContent: string
  modifiedAt: number
}

interface CursorPosition { line: number; column: number }
type ToastKind = 'success' | 'error' | 'warning' | 'info'
interface ToastState { message: string; kind: ToastKind }
interface ModalInput { title: string; label: string; value: string; confirmLabel: string; onConfirm(value: string): void; onCancel?(): void }
interface InlineEditState {
  phase: 'prompt' | 'loading' | 'review'
  instruction: string
  original: string
  proposal: string
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
  error?: string
}

function applyTheme(theme: ThemePreference): void {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme === 'system' ? 'light dark' : theme
}

function cleanInlineCompletion(value: string): string {
  return value
    .replace(/^```[\w+-]*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .replace(/^Here(?:'s| is) (?:the )?(?:completion|code):?\s*/i, '')
    .slice(0, 4_000)
}

function isPathAtOrBelow(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`)
}

function remapPath(candidate: string, previousRoot: string, nextRoot: string): string {
  return isPathAtOrBelow(candidate, previousRoot) ? `${nextRoot}${candidate.slice(previousRoot.length)}` : candidate
}

const LANGUAGE_RUNTIME: Record<string, string> = {
  python: 'python3', javascript: 'node', typescript: 'node', jsx: 'node', tsx: 'node', vue: 'node', svelte: 'node',
  java: 'javac', c: 'clang', cpp: 'clang++', 'objective-c': 'clang', 'objective-cpp': 'clang++', swift: 'swift',
  csharp: 'dotnet', rust: 'cargo', go: 'go', php: 'php', ruby: 'ruby', kotlin: 'kotlinc', lua: 'lua',
  shell: 'zsh', bash: 'bash', zsh: 'zsh', fish: 'fish', dockerfile: 'docker', makefile: 'make', gradle: 'gradle'
}

function ActivityButton({ id, current, label, badge, onClick, children }: {
  id: Activity | 'ai' | 'settings'
  current?: string
  label: string
  badge?: number
  onClick(): void
  children: React.ReactNode
}) {
  return <button className={`activity-button ${current === id ? 'active' : ''}`} title={label} aria-label={label} aria-pressed={current === id} onClick={onClick}>{children}{badge ? <span className="activity-badge">{badge}</span> : null}</button>
}

function ToastNotice({ toast, onClose }: { toast: ToastState; onClose(): void }) {
  const Icon = toast.kind === 'success' ? CheckCircle2 : toast.kind === 'warning' ? TriangleAlert : toast.kind === 'info' ? Info : CircleAlert
  const label = toast.kind === 'success' ? 'Success' : toast.kind === 'warning' ? 'Warning' : toast.kind === 'info' ? 'Information' : 'Error'
  return <div className={`toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'} aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}>
    <Icon aria-hidden="true" />
    <span><strong>{label}</strong><small>{toast.message}</small></span>
    <button type="button" title="Dismiss notification" aria-label="Dismiss notification" onClick={onClose}><X /></button>
  </div>
}

const MODE_TITLEBAR: Record<Exclude<AppMode, 'code'>, {
  description: string
  icon: typeof Sparkles
}> = {
  work: { description: 'Conversations, cloud models, and connected apps', icon: Sparkles },
  omni: { description: 'Voice-first tasks and system assistance', icon: AudioWaveform }
}

function ModeTitlebarLabel({ mode }: { mode: Exclude<AppMode, 'code'> }) {
  const { description, icon: Icon } = MODE_TITLEBAR[mode]
  return <div className={`mode-titlebar-label ${mode}`}><Icon /><span>{description}</span></div>
}

export function App() {
  const [appMode, setAppMode] = useState<AppMode>(() => storedAppMode(localStorage))
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [recentFolders, setRecentFolders] = useState<string[]>([])
  const [tree, setTree] = useState<FileNode[]>([])
  const [documents, setDocuments] = useState<OpenDocument[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [activity, setActivity] = useState<Activity>('explorer')
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [aiVisible, setAiVisible] = useState(true)
  const [panelVisible, setPanelVisible] = useState(true)
  const [panelTab, setPanelTab] = useState<PanelTab>('terminal')
  const [theme, setTheme] = useState<ThemePreference>(() => storedTheme(localStorage))
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const [autosave, setAutosave] = useState(() => localStorage.getItem('omnicode.autosave') === 'true')
  const [aiAutocomplete, setAiAutocomplete] = useState(() => localStorage.getItem('omnicode.aiAutocomplete') === 'true')
  const [autocompleteProvider, setAutocompleteProvider] = useState<AIProviderId>(() => storedAIProvider(localStorage, 'omnicode.autocompleteProvider', 'ollama'))
  const [autocompleteModel, setAutocompleteModel] = useState(() => storedModelName(localStorage))
  const [workspaceSettings, setWorkspaceSettings] = useState<WorkspaceSettings>({})
  const [workspaceChatProvider, setWorkspaceChatProvider] = useState<AIProviderId>('ollama')
  const [workspaceChatModel, setWorkspaceChatModel] = useState('')
  const [editorTabSize, setEditorTabSize] = useState(2)
  const [permission, setPermission] = useState<'ask' | 'workspace' | 'agent'>(() => storedAgentPermission(localStorage))
  const [showSettings, setShowSettings] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(() => localStorage.getItem('omnicode.onboardingComplete') !== 'true')
  const [detectedTools, setDetectedTools] = useState<ToolInfo[]>([])
  const [ollamaState, setOllamaState] = useState<OllamaState>({ status: 'checking' })
  const [setupModelCatalog, setSetupModelCatalog] = useState<AIModel[]>([])
  const [toolInstallations, setToolInstallations] = useState<Record<string, ToolInstallationProgress>>({})
  const [setupModelPulls, setSetupModelPulls] = useState<Record<string, OllamaPullProgress>>({})
  const setupRefreshRef = useRef<Promise<void> | null>(null)
  const [serverState, setServerState] = useState<ServerState>({ running: false })
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [cursor, setCursor] = useState<CursorPosition>({ line: 1, column: 1 })
  const [problems, setProblems] = useState<editor.IMarker[]>([])
  const [outputs, setOutputs] = useState<string[]>(['OmniCode output channels are ready.'])
  const [terminalOutput, setTerminalOutput] = useState('')
  const [toast, setToast] = useState<ToastState | null>(null)
  const [cloneProgress, setCloneProgress] = useState<GitCloneProgress | null>(null)
  const [modalInput, setModalInput] = useState<ModalInput | null>(null)
  const [palette, setPalette] = useState<'commands' | 'files' | null>(null)
  const [paletteQuery, setPaletteQuery] = useState('')
  const [inlineEdit, setInlineEdit] = useState<InlineEditState | null>(null)
  const [diffProposalId, setDiffProposalId] = useState<string | null>(null)
  const [runRequest, setRunRequest] = useState<TerminalRunRequest | undefined>()
  const [sidebarWidth, setSidebarWidth] = useState(260)
  const [aiWidth, setAiWidth] = useState(380)
  const [panelHeight, setPanelHeight] = useState(250)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const documentsRef = useRef<OpenDocument[]>(documents)
  const autocompleteSettingsRef = useRef({ enabled: aiAutocomplete, provider: autocompleteProvider, model: autocompleteModel })
  const autocompleteRegistration = useRef<{ dispose(): void } | null>(null)
  const autocompleteCache = useRef<{ key: string; value: string; at: number } | null>(null)
  const autocompleteInFlight = useRef<{ key: string; promise: Promise<string> } | null>(null)
  const pendingLocation = useRef<{ line: number; column: number } | null>(null)
  const refreshTimer = useRef<number | null>(null)
  const indexRefreshTimer = useRef<number | null>(null)
  const allowUnloadRef = useRef(false)
  const startupInitializedRef = useRef(false)
  const externalOpenReceivedRef = useRef(false)

  const activeDocument = documents.find((document) => document.path === activePath)
  const activeLanguage = activeDocument ? languageDefinitionForPath(activeDocument.path) : null
  const activeLanguageSettings = activeLanguage ? workspaceSettings.languages?.[activeLanguage.id] : undefined
  const activeRuntime = activeLanguage ? detectedTools.find((tool) => tool.id === LANGUAGE_RUNTIME[activeLanguage.id]) : undefined
  const dirtyCount = documents.filter((document) => document.content !== document.savedContent).length
  const allFiles = useMemo(() => flattenFiles(tree), [tree])
  const dark = theme === 'dark' || (theme === 'system' && systemDark)

  const changeAppMode = useCallback((mode: AppMode): void => {
    if (mode === appMode) return
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    localStorage.setItem('omnicode.appMode', mode)
    setAppMode(mode)
  }, [appMode])

  const reportError = useCallback((cause: unknown): void => {
    const message = cause instanceof Error ? cause.message : String(cause)
    setToast({ message, kind: 'error' })
    setOutputs((current) => [...current, `[Error] ${message}`])
  }, [])
  const requestTextInput = useCallback((options: { title: string; label: string; value?: string; confirmLabel: string }): Promise<string | null> => {
    return new Promise((resolve) => {
      setModalInput({
        ...options,
        value: options.value ?? '',
        onConfirm: (value) => {
          setModalInput(null)
          resolve(value.trim())
        },
        onCancel: () => resolve(null)
      })
    })
  }, [])
  const captureTerminalOutput = useCallback((data: string): void => {
    const plain = data.replace(/\u001B\[[0-?]*[ -\/]*[@-~]/g, '').replace(/\r(?!\n)/g, '\n')
    setTerminalOutput((current) => `${current}${plain}`.slice(-24_000))
  }, [])

  const applyWorkspaceSettings = useCallback((settings: WorkspaceSettings): void => {
    setWorkspaceSettings(settings)
    if (typeof settings.editor?.autosave === 'boolean') setAutosave(settings.editor.autosave)
    if (typeof settings.editor?.tabSize === 'number') setEditorTabSize(settings.editor.tabSize)
    if (settings.agentPermissions) setPermission(settings.agentPermissions)
    const provider = settings.ai?.provider ?? 'ollama'
    setWorkspaceChatProvider(provider)
    setWorkspaceChatModel(settings.ai?.chatModel ?? '')
    if (settings.ai?.autocompleteModel) {
      setAutocompleteProvider(provider)
      setAutocompleteModel(settings.ai.autocompleteModel)
    }
  }, [])

  const refreshTree = useCallback(async (): Promise<void> => {
    if (!workspacePath) return
    try { setTree(await window.omnicode.workspace.readTree(workspacePath)) }
    catch (cause) { reportError(cause) }
  }, [workspacePath, reportError])

  const addRecent = (folder: string): void => {
    setRecentFolders((previous) => [folder, ...previous.filter((item) => item !== folder)].slice(0, 12))
  }

  const confirmWorkspaceSwitch = useCallback((): boolean => {
    const dirtyDocuments = documentsRef.current.filter((document) => document.content !== document.savedContent)
    return !dirtyDocuments.length || window.confirm(`Open another workspace and discard unsaved changes in ${dirtyDocuments.length} file${dirtyDocuments.length === 1 ? '' : 's'}?`)
  }, [])

  const openWorkspace = useCallback(async (providedPath?: string, switchAlreadyConfirmed = false): Promise<string | null> => {
    if (!switchAlreadyConfirmed && !confirmWorkspaceSwitch()) return null
    let selected: string
    try {
      const candidate = providedPath ?? await window.omnicode.workspace.selectFolder()
      if (!candidate) return null
      selected = await window.omnicode.workspace.reopenWorkspace(candidate)
      setWorkspacePath(selected)
      setTree([])
      setDocuments([])
      setActivePath(null)
      setActivity('explorer')
      setSidebarVisible(true)
      setDiffProposalId(null)
      setTerminalOutput('')
      setProblems([])
      setGitStatus(null)
      addRecent(selected)
    } catch (cause) {
      reportError(cause)
      return null
    }
    try {
      await window.omnicode.server.stop()
      const [nodes, settings] = await Promise.all([
        window.omnicode.workspace.readTree(selected),
        window.omnicode.settings.read(selected).catch((cause) => {
          reportError(cause)
          return {} as WorkspaceSettings
        })
      ])
      setTree(nodes)
      applyWorkspaceSettings(settings)
      void window.omnicode.workspace.watch(selected).catch(reportError)
      void window.omnicode.ai.index(selected).then((status) => setOutputs((current) => [...current, `[AI Indexer] ${status.fileCount} files indexed; ${status.ignoredCount} ignored.`])).catch(() => undefined)
      void window.omnicode.git.status(selected).then(setGitStatus)
      return selected
    } catch (cause) { reportError(cause); return null }
  }, [applyWorkspaceSettings, confirmWorkspaceSwitch, reportError])

  const openFile = useCallback(async (path: string, line?: number, column?: number): Promise<void> => {
    if (line) pendingLocation.current = { line, column: column ?? 1 }
    const existing = documents.find((document) => document.path === path)
    if (existing) { setActivePath(path); return }
    try {
      const file = await window.omnicode.workspace.readFile(path)
      setDocuments((current) => [...current, { ...file, savedContent: file.content }])
      setActivePath(path)
    } catch (cause) { reportError(cause) }
  }, [documents, reportError])

  const openGrantedPath = useCallback(async (target: string, kind: 'file' | 'directory'): Promise<void> => {
    try {
      if (kind === 'directory') await openWorkspace(target)
      else await openFile(target)
    } catch (cause) { reportError(cause) }
  }, [openFile, openWorkspace, reportError])

  const selectNativeFile = useCallback(async (): Promise<void> => {
    const selected = await window.omnicode.workspace.selectFile()
    if (selected) await openFile(selected)
  }, [openFile])

  const updateActiveContent = (content = ''): void => {
    if (!activePath) return
    setDocuments((current) => current.map((document) => document.path === activePath ? { ...document, content } : document))
  }

  const saveDocument = useCallback(async (path = activePath): Promise<boolean> => {
    if (!path) return false
    const document = documents.find((item) => item.path === path)
    if (!document) return false
    try {
      const saved = await window.omnicode.workspace.writeFile(path, document.content, document.modifiedAt)
      setDocuments((current) => current.map((item) => item.path === path ? { ...item, savedContent: document.content, modifiedAt: saved.modifiedAt } : item))
      const unchangedWhileSaving = documentsRef.current.find((item) => item.path === path)?.content === document.content
      setToast({
        message: unchangedWhileSaving
          ? `Saved ${fileName(path)}`
          : `Saved the prior version of ${fileName(path)}; save again to include edits made during the save.`,
        kind: unchangedWhileSaving ? 'success' : 'warning'
      })
      return unchangedWhileSaving
    } catch (cause) {
      reportError(cause)
      return false
    }
  }, [activePath, documents, reportError])

  const saveAs = useCallback(async (): Promise<void> => {
    if (!activeDocument) return
    try {
      const newPath = await window.omnicode.workspace.saveAs(activeDocument.content, activeDocument.path)
      if (!newPath) return
      const saved = await window.omnicode.workspace.readFile(newPath)
      setDocuments((current) => current.map((item) => item.path === activeDocument.path ? { ...item, path: newPath, savedContent: item.content, modifiedAt: saved.modifiedAt } : item))
      setActivePath(newPath); void refreshTree()
    } catch (cause) { reportError(cause) }
  }, [activeDocument, refreshTree, reportError])

  const saveAllDocuments = useCallback(async (): Promise<void> => {
    const dirtyDocuments = documents.filter((document) => document.content !== document.savedContent)
    if (!dirtyDocuments.length) return
    const results = await Promise.allSettled(dirtyDocuments.map(async (document) => ({
      path: document.path,
      content: document.content,
      result: await window.omnicode.workspace.writeFile(document.path, document.content, document.modifiedAt)
    })))
    const saved = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    const byPath = new Map(saved.map((item) => [item.path, item]))
    setDocuments((current) => current.map((document) => {
      const item = byPath.get(document.path)
      if (!item || document.content !== item.content) return document
      return { ...document, savedContent: item.content, modifiedAt: item.result.modifiedAt }
    }))
    const captured = new Map(dirtyDocuments.map((document) => [document.path, document.content]))
    const changedWhileSaving = documentsRef.current.some((document) => {
      const capturedContent = captured.get(document.path)
      return capturedContent === undefined
        ? document.content !== document.savedContent
        : document.content !== capturedContent
    })
    if (changedWhileSaving) throw new Error('A file changed while OmniCode was saving. Review the latest edits and try the Agent task again.')
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) throw failure.reason
    setToast({ message: `Saved ${saved.length} file${saved.length === 1 ? '' : 's'} before Agent planning.`, kind: 'success' })
  }, [documents])

  const closeDocument = useCallback((path = activePath): void => {
    if (!path) return
    const document = documents.find((item) => item.path === path)
    if (document && document.content !== document.savedContent && !window.confirm(`Close ${fileName(path)} without saving?`)) return
    const index = documents.findIndex((item) => item.path === path)
    const remaining = documents.filter((item) => item.path !== path)
    setDocuments(remaining)
    if (activePath === path) setActivePath(remaining[Math.max(0, index - 1)]?.path ?? null)
  }, [activePath, documents])

  const makeRunRequest = (name: string, command: string, args: string[], cwd: string, env?: Record<string, string>): void => {
    setPanelVisible(true); setPanelTab('terminal')
    setRunRequest({ token: Date.now(), name, command, args, cwd, env })
  }

  const newTerminal = (): void => {
    setPanelVisible(true); setPanelTab('terminal')
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('omnicode:terminal-new')), 0)
  }

  const runCurrent = useCallback(async (): Promise<void> => {
    if (!activeDocument || !workspacePath) return
    if (activeDocument.content !== activeDocument.savedContent && !(await saveDocument(activeDocument.path))) return
    try {
      const language = languageDefinitionForPath(activeDocument.path)
      if (language.executionKind === 'preview') {
        const state = await window.omnicode.server.start(workspacePath)
        setServerState(state)
        setOutputs((current) => [...current, `[Local Server] Running at ${state.url}`])
        return
      }
      if (['jsx', 'tsx', 'vue', 'svelte'].includes(language.id)) {
        const option = (await window.omnicode.server.detect(workspacePath)).find((candidate) => candidate.kind === 'package')
        if (option?.script) {
          const state = await window.omnicode.server.startProject(workspacePath, option.script)
          setServerState(state)
          setOutputs((current) => [...current, `[Local Server] Started ${option.name}`])
          return
        }
      }
      const configuration = await window.omnicode.run.resolve(activeDocument.path, workspacePath)
      if (configuration.requiredTool) {
        const tools = await window.omnicode.tools.detect()
        const available = tools.some((tool) => tool.installed && (tool.id === configuration.requiredTool || tool.command === configuration.requiredTool || tool.path === configuration.requiredTool))
        if (!available) throw new Error(configuration.missingTool ?? `${configuration.requiredTool} is required for this run configuration.`)
      }
      if (configuration.description?.startsWith('Loaded from ') && !window.confirm(
        `Run this workspace-authored configuration?\n\n${configuration.command} ${configuration.args.join(' ')}\n\nWorking directory: ${configuration.cwd}\n\nOnly run configuration files from projects you trust.`
      )) return
      makeRunRequest(configuration.name, configuration.command, configuration.args, configuration.cwd, configuration.env)
    } catch (cause) { reportError(cause) }
  }, [activeDocument, workspacePath, saveDocument, reportError])

  const runScript = (script: PackageScript): void => {
    if (!workspacePath) return
    makeRunRequest(`npm: ${script.name}`, '/bin/zsh', ['-lc', script.command], workspacePath)
  }

  const startServer = useCallback(async (restart = false): Promise<void> => {
    if (!workspacePath) return
    try {
      if (restart) await window.omnicode.server.stop()
      const configuredScript = workspaceSettings.developmentServer?.script?.trim()
      const configuredPort = workspaceSettings.developmentServer?.port
      const projectScript = restart && serverState.mode === 'project' && serverState.script
        ? serverState.script
        : configuredScript
      const state = projectScript
        ? await window.omnicode.server.startProject(workspacePath, projectScript, restart ? serverState.port ?? configuredPort : configuredPort)
        : await window.omnicode.server.start(workspacePath, restart ? serverState.port ?? configuredPort : configuredPort)
      setServerState(state); setOutputs((current) => [...current, `[Local Server] Running at ${state.url}`])
    } catch (cause) { reportError(cause) }
  }, [workspacePath, serverState, workspaceSettings, reportError])

  const startServerOption = async (option: DevServerOption, port?: number): Promise<void> => {
    if (!workspacePath) return
    try {
      const state = option.kind === 'static'
        ? await window.omnicode.server.start(workspacePath, port ?? workspaceSettings.developmentServer?.port)
        : await window.omnicode.server.startProject(workspacePath, option.script ?? '', port ?? workspaceSettings.developmentServer?.port)
      setServerState(state)
      setOutputs((current) => [...current, `[Local Server] Started ${option.name}${state.url ? ` at ${state.url}` : ''}`])
    } catch (cause) { reportError(cause) }
  }

  const createEntry = (parent: string, kind: 'file' | 'directory'): void => {
    setModalInput({ title: kind === 'file' ? 'New File' : 'New Folder', label: 'Name', value: '', confirmLabel: 'Create', onConfirm: async (name) => {
      try { const target = await window.omnicode.workspace.createEntry(parent, name, kind); setModalInput(null); await refreshTree(); if (kind === 'file') await openFile(target) }
      catch (cause) { reportError(cause) }
    } })
  }

  const renameEntry = (node: FileNode): void => {
    setModalInput({ title: `Rename ${node.name}`, label: 'New name', value: node.name, confirmLabel: 'Rename', onConfirm: async (name) => {
      try { const nextPath = await window.omnicode.workspace.renameEntry(node.path, name); setModalInput(null); setDocuments((current) => current.map((item) => ({ ...item, path: remapPath(item.path, node.path, nextPath) }))); if (activePath && isPathAtOrBelow(activePath, node.path)) setActivePath(remapPath(activePath, node.path, nextPath)); await refreshTree() }
      catch (cause) { reportError(cause) }
    } })
  }

  const handleInlineAI = useCallback((): void => {
    if (appMode !== 'code' || !activeDocument || !editorRef.current) return
    const selection = editorRef.current.getSelection()
    const model = editorRef.current.getModel()
    if (!selection || !model) return
    const hasSelection = !selection.isEmpty()
    const range = hasSelection ? selection : model.getFullModelRange()
    setInlineEdit({ phase: 'prompt', instruction: '', original: model.getValueInRange(range), proposal: '', range })
  }, [activeDocument, appMode])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'i') return
      event.preventDefault()
      handleInlineAI()
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [handleInlineAI])

  useEffect(() => {
    const dismissOverlay = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (inlineEdit) {
        event.preventDefault()
        setInlineEdit(null)
      } else if (showHelp) {
        event.preventDefault()
        setShowHelp(false)
      } else if (palette) {
        event.preventDefault()
        setPalette(null)
      }
    }
    window.addEventListener('keydown', dismissOverlay, true)
    return () => window.removeEventListener('keydown', dismissOverlay, true)
  }, [inlineEdit, palette, showHelp])

  const submitInlineAI = async (): Promise<void> => {
    if (!inlineEdit || !activeDocument) return
    const instruction = inlineEdit.instruction.trim()
    if (!instruction) return
    setInlineEdit({ ...inlineEdit, phase: 'loading', error: undefined })
    try {
      const [models, preferences] = await Promise.all([window.omnicode.ai.models(), window.omnicode.ai.modelPreferences()])
      const preferred = models.find((model) => model.id === (preferences.selectedModel ?? preferences.defaultModel)) ?? models[0]
      if (!preferred) throw new Error('No Ollama model is available. Install a local model or use AI Chat with a configured cloud provider.')
      const response = await window.omnicode.ai.chat({
        provider: 'ollama', model: preferred.id, attachedPaths: [activeDocument.path],
        usageContext: { mode: 'code', feature: 'inline-edit' },
        messages: [{ role: 'system', content: 'You are editing selected code. Return only the complete replacement code with no Markdown fence or commentary.' }, { role: 'user', content: `${instruction}\n\nSelected code:\n${inlineEdit.original}` }]
      })
      const proposal = response.content.replace(/^```[\w+-]*\n?/, '').replace(/\n?```$/, '')
      setInlineEdit({ ...inlineEdit, phase: 'review', proposal })
    } catch (cause) { setInlineEdit({ ...inlineEdit, phase: 'prompt', error: cause instanceof Error ? cause.message : String(cause) }) }
  }

  const acceptInlineAI = (): void => {
    if (!inlineEdit || !editorRef.current) return
    editorRef.current.executeEdits('omnicode-inline-ai', [{ range: inlineEdit.range, text: inlineEdit.proposal, forceMoveMarkers: true }])
    updateActiveContent(editorRef.current.getValue())
    setInlineEdit(null); editorRef.current.focus()
  }

  const handleEditorMount: OnMount = (instance, monaco) => {
    editorRef.current = instance
    instance.onDidChangeCursorPosition((event) => setCursor({ line: event.position.lineNumber, column: event.position.column }))
    const pending = pendingLocation.current
    if (pending) { instance.setPosition({ lineNumber: pending.line, column: pending.column }); instance.revealLineInCenter(pending.line); pendingLocation.current = null }

    autocompleteRegistration.current?.dispose()
    autocompleteRegistration.current = monaco.languages.registerInlineCompletionsProvider('*', {
      provideInlineCompletions: async (
        textModel: editor.ITextModel,
        position: Position,
        _context: languages.InlineCompletionContext,
        token: CancellationToken
      ) => {
        const settings = autocompleteSettingsRef.current
        if (!settings.enabled) return { items: [] }

        await new Promise((resolve) => window.setTimeout(resolve, 220))
        if (token.isCancellationRequested || !autocompleteSettingsRef.current.enabled) return { items: [] }

        const offset = textModel.getOffsetAt(position)
        const content = textModel.getValue()
        const prefix = content.slice(Math.max(0, offset - 5_000), offset)
        const suffix = content.slice(offset, offset + 1_200)
        const recentLine = prefix.slice(prefix.lastIndexOf('\n') + 1)
        if (recentLine.trim().length < 2 && !/[}\])>"'`]\s*$/.test(prefix)) return { items: [] }

        let chosenModel = settings.model
        if (!chosenModel && settings.provider === 'ollama') {
          const [models, preferences] = await Promise.all([
            window.omnicode.ai.models().catch(() => []),
            window.omnicode.ai.modelPreferences().catch(() => ({ selectedModel: undefined, defaultModel: undefined }))
          ])
          const preferred = models.find((model) => model.id === (preferences.selectedModel ?? preferences.defaultModel))
          chosenModel = preferred?.id ?? models[0]?.id ?? ''
        }
        if (!chosenModel || token.isCancellationRequested) return { items: [] }

        const key = `${settings.provider}\0${chosenModel}\0${textModel.getLanguageId()}\0${prefix}\0${suffix}`
        const cached = autocompleteCache.current
        let completion: string
        if (cached?.key === key && Date.now() - cached.at < 30_000) completion = cached.value
        else {
          let request = autocompleteInFlight.current?.key === key ? autocompleteInFlight.current.promise : undefined
          if (!request) {
            request = window.omnicode.ai.chat({
              provider: settings.provider,
              model: chosenModel,
              usageContext: { mode: 'code', feature: 'code-completion' },
              messages: [
                { role: 'system', content: 'Complete code at the cursor. Return only the exact text to insert, without Markdown or explanation. Prefer a concise next line or block and do not repeat existing code.' },
                { role: 'user', content: `Language: ${textModel.getLanguageId()}\n\nCode before cursor:\n${prefix}\n\n<CURSOR>\n\nCode after cursor:\n${suffix}` }
              ]
            }).then((response) => cleanInlineCompletion(response.content)).catch(() => '')
            autocompleteInFlight.current = { key, promise: request }
          }
          completion = await request
          if (autocompleteInFlight.current?.key === key) autocompleteInFlight.current = null
          autocompleteCache.current = { key, value: completion, at: Date.now() }
        }

        if (!completion || token.isCancellationRequested) return { items: [] }
        return {
          items: [{
            insertText: completion,
            range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column)
          }]
        }
      },
      disposeInlineCompletions: () => undefined
    } satisfies languages.InlineCompletionsProvider)
  }

  const showGitDiff = async (relativePath: string, staged = false): Promise<void> => {
    if (!workspacePath) return
    try { const diff = await window.omnicode.git.diff(workspacePath, relativePath, staged); setOutputs((current) => [...current, `\n[Git Diff · ${staged ? 'Staged' : 'Working Tree'}] ${relativePath}\n${diff || '(No diff)'}`]); setPanelVisible(true); setPanelTab('output') }
    catch (cause) { reportError(cause) }
  }

  const cloneRepository = async (): Promise<boolean> => {
    if (!confirmWorkspaceSwitch()) return false
    try {
      const url = await requestTextInput({ title: 'Clone Repository', label: 'Git repository URL', confirmLabel: 'Choose Destination' })
      if (!url) return false
      const destination = await window.omnicode.workspace.selectDestinationFolder()
      if (!destination) return false
      const requestId = crypto.randomUUID()
      setCloneProgress({ requestId, phase: 'starting', message: 'Preparing the Git clone…', done: false, cancellable: true, destination })
      const cloned = await window.omnicode.git.clone(requestId, destination, url)
      await openWorkspace(cloned, true)
      changeAppMode('code')
      setActivity('source')
      setSidebarVisible(true)
      setCloneProgress(null)
      setToast({ message: `Cloned and opened ${fileName(cloned)}.`, kind: 'success' })
      return true
    }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (/cancelled/u.test(message)) setToast({ message: 'Repository clone cancelled.', kind: 'info' })
      else reportError(cause)
      return false
    }
  }

  const openExistingRepository = async (): Promise<boolean> => {
    const opened = await openWorkspace()
    if (!opened) return false
    changeAppMode('code')
    try {
      const info = await window.omnicode.git.inspect(opened)
      if (info.isRepository) {
        setActivity('source')
        setSidebarVisible(true)
        const remote = info.host === 'github' ? ' GitHub' : info.host === 'other' ? ' remote' : ''
        setToast({ message: `Opened${remote} repository on ${info.branch || 'HEAD'}.`, kind: 'success' })
      } else {
        setActivity('explorer')
        setToast({ message: 'Opened the folder normally; it is not a Git repository.', kind: 'info' })
      }
      return true
    } catch (cause) {
      reportError(cause)
      return true
    }
  }

  const createProject = async (): Promise<boolean> => {
    if (!confirmWorkspaceSwitch()) return false
    try {
      const name = await requestTextInput({ title: 'New Project', label: 'Project folder name', confirmLabel: 'Choose Destination' })
      if (!name) return false
      const destination = await window.omnicode.workspace.selectDestinationFolder()
      if (!destination) return false
      const project = await window.omnicode.workspace.createProject(destination, name)
      await openWorkspace(project, true)
      return true
    } catch (cause) { reportError(cause); return false }
  }

  const runAgentCommand = (command: string, reason: string): void => {
    if (!workspacePath) return
    void window.omnicode.agent.approveCommand(workspacePath, command, reason).then((approved) => {
      if (approved) makeRunRequest('AI Agent command', '/bin/zsh', ['-lc', command], workspacePath)
    }).catch((cause) => {
      setToast({ message: cause instanceof Error ? cause.message : String(cause), kind: 'error' })
    })
  }

  const handleProposalChange = useCallback((proposal: DiffProposal): void => {
    const deleted = new Set(proposal.files.filter((file) => file.kind === 'delete' && file.status === 'accepted').map((file) => file.path))
    setDocuments((current) => current.flatMap((document) => {
      const changed = proposal.files.find((file) => file.path === document.path)
      if (!changed || document.content !== document.savedContent) return [document]
      if (deleted.has(document.path)) return []
      return [{ ...document, content: changed.currentContent, savedContent: changed.currentContent }]
    }))
    if (activePath && deleted.has(activePath)) setActivePath(null)
    void refreshTree()
  }, [activePath, refreshTree])

  useEffect(() => {
    applyTheme(theme); localStorage.setItem('omnicode.theme', theme)
  }, [theme])
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const update = (): void => setSystemDark(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => { localStorage.setItem('omnicode.autosave', String(autosave)) }, [autosave])
  useEffect(() => { documentsRef.current = documents }, [documents])
  useEffect(() => {
    autocompleteSettingsRef.current = { enabled: aiAutocomplete, provider: autocompleteProvider, model: autocompleteModel }
    localStorage.setItem('omnicode.aiAutocomplete', String(aiAutocomplete))
    localStorage.setItem('omnicode.autocompleteProvider', autocompleteProvider)
    localStorage.setItem('omnicode.autocompleteModel', autocompleteModel)
    if (!aiAutocomplete) autocompleteCache.current = null
  }, [aiAutocomplete, autocompleteProvider, autocompleteModel])
  useEffect(() => () => autocompleteRegistration.current?.dispose(), [])
  useEffect(() => { localStorage.setItem('omnicode.permission', permission) }, [permission])
  const refreshSetup = useCallback((): Promise<void> => {
    if (setupRefreshRef.current) return setupRefreshRef.current
    const request = (async () => {
      const results = await Promise.allSettled([
        window.omnicode.tools.detect(),
        window.omnicode.ai.ollamaStatus(),
        window.omnicode.ai.modelCatalog()
      ])
      const [tools, status, catalog] = results
      if (tools.status === 'fulfilled') setDetectedTools(tools.value)
      if (catalog.status === 'fulfilled') setSetupModelCatalog(catalog.value)
      if (status.status === 'fulfilled') {
        setOllamaState({
          status: status.value.available ? 'ready' : status.value.installed ? 'unavailable' : 'not-installed',
          version: status.value.version,
          models: catalog.status === 'fulfilled' ? catalog.value.filter((model) => model.installed).map((model) => model.name) : []
        })
      } else setOllamaState({ status: 'error', hint: String(status.reason) })
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })()
    setupRefreshRef.current = request
    void request.finally(() => { setupRefreshRef.current = null }).catch(() => undefined)
    return request
  }, [])

  useEffect(() => {
    const unsubscribeTools = window.omnicode.tools.onInstallationProgress((progress) => {
      setToolInstallations((current) => ({ ...current, [progress.toolId]: progress }))
      if (progress.done) void refreshSetup().catch(reportError)
    })
    const unsubscribeModels = window.omnicode.ai.onModelPullProgress((progress) => {
      setSetupModelPulls((current) => ({ ...current, [progress.model]: progress }))
      if (progress.done) void refreshSetup().catch(reportError)
    })
    void Promise.all([window.omnicode.tools.installations(), window.omnicode.ai.modelPulls()])
      .then(([installs, pulls]) => {
        setToolInstallations((current) => ({ ...Object.fromEntries(installs.map((item) => [item.toolId, item])), ...current }))
        setSetupModelPulls((current) => ({ ...Object.fromEntries(pulls.map((item) => [item.model, item])), ...current }))
      }).catch(reportError)
    void refreshSetup().catch(reportError)
    return () => { unsubscribeTools(); unsubscribeModels() }
  }, [refreshSetup, reportError])

  useEffect(() => {
    if (!showOnboarding) return
    const refresh = (): void => { void refreshSetup().catch(() => undefined) }
    window.addEventListener('focus', refresh)
    // Native installers continue outside this window; keep detection current.
    const interval = window.setInterval(refresh, 15_000)
    return () => { window.removeEventListener('focus', refresh); window.clearInterval(interval) }
  }, [showOnboarding, refreshSetup])

  const installSetupTool = async (toolId: string): Promise<void> => {
    try { await window.omnicode.tools.install(toolId) }
    finally { await refreshSetup() }
  }
  const downloadSetupModel = async (model: string): Promise<void> => {
    try {
      const result = await window.omnicode.ai.pullModel(model)
      if (!result.cancelled) {
        const preferences = await window.omnicode.ai.modelPreferences()
        if (!preferences.selectedModel && !preferences.defaultModel) {
          await window.omnicode.ai.selectModel(model, true)
        }
      }
    } finally { await refreshSetup() }
  }
  useEffect(() => window.omnicode.server.onState(setServerState), [])
  useEffect(() => window.omnicode.server.onLog((line) => setOutputs((current) => [...current.slice(-2_000), `[Local Server] ${line}`])), [])
  useEffect(() => {
    const unsubscribe = window.omnicode.workspace.onChanged((changedPath) => {
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current)
      refreshTimer.current = window.setTimeout(() => void refreshTree(), 300)
      if (indexRefreshTimer.current) window.clearTimeout(indexRefreshTimer.current)
      if (workspacePath) {
        indexRefreshTimer.current = window.setTimeout(() => {
          void window.omnicode.ai.index(workspacePath).catch(() => undefined)
        }, 700)
      }
      const open = documentsRef.current.find((document) => document.path === changedPath)
      if (!open) return
      void window.omnicode.workspace.readFile(changedPath).then((disk) => {
        if (Math.abs(disk.modifiedAt - open.modifiedAt) <= 1) return
        if (open.content !== open.savedContent) {
          setToast({ message: `${fileName(changedPath)} changed on disk. Save is paused until you review the conflict.`, kind: 'error' })
          return
        }
        setDocuments((current) => current.map((document) => document.path === changedPath && document.content === document.savedContent
          ? { ...disk, savedContent: disk.content }
          : document))
        setToast({ message: `Reloaded ${fileName(changedPath)} after an external change.`, kind: 'info' })
      }).catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause)
        const latest = documentsRef.current.find((document) => document.path === changedPath)
        if (/ENOENT|no such file/i.test(message) && latest?.content === latest?.savedContent) {
          setDocuments((current) => current.filter((document) => document.path !== changedPath))
          setActivePath((current) => current === changedPath ? null : current)
          setToast({ message: `Closed ${fileName(changedPath)} after it was removed on disk.`, kind: 'info' })
        } else if (latest) {
          setToast({ message: `${fileName(changedPath)} could not be reloaded: ${message}`, kind: 'error' })
        }
      })
    })
    return () => {
      unsubscribe()
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current)
      if (indexRefreshTimer.current) window.clearTimeout(indexRefreshTimer.current)
    }
  }, [refreshTree, workspacePath])
  useEffect(() => {
    if (!autosave) return
    const dirtyDocuments = documents.filter((document) => document.content !== document.savedContent)
    if (!dirtyDocuments.length) return
    const timer = window.setTimeout(() => {
      for (const document of dirtyDocuments) void saveDocument(document.path)
    }, 900)
    return () => window.clearTimeout(timer)
  }, [autosave, documents, saveDocument])
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      const hasUnsavedDocuments = documentsRef.current.some((document) => document.content !== document.savedContent)
      if (!allowUnloadRef.current && hasUnsavedDocuments) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [])
  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(null), 3500)
    return () => window.clearTimeout(timeout)
  }, [toast])
  useEffect(() => window.omnicode.git.onCloneProgress(setCloneProgress), [])

  const commands = useMemo(() => [
    ['Open File…', () => void selectNativeFile()], ['Open Folder…', () => void openWorkspace()],
    ['Open Existing Repository…', () => void openExistingRepository()], ['Clone Repository…', () => void cloneRepository()], ['Save', () => void saveDocument()],
    ['Save As…', () => void saveAs()], ['Run Current File', () => void runCurrent()], ['New Terminal', newTerminal],
    ['Start Local Server', () => void startServer()], ['Stop Local Server', () => void window.omnicode.server.stop()],
    ['Toggle AI Sidebar', () => setAiVisible((value) => !value)], ['Settings', () => setShowSettings(true)], ['Setup & Install Tools', () => setShowOnboarding(true)], ['Index Workspace', () => workspacePath && void window.omnicode.ai.index(workspacePath)]
  ] as Array<[string, () => void]>, [workspacePath, activeDocument, documents, selectNativeFile, openWorkspace, saveDocument, saveAs, runCurrent, startServer])

  useEffect(() => {
    const unsubscribe = window.omnicode.app.onCommand((command, payload) => {
      const handlers: Record<string, () => void> = {
      'open-file': () => void selectNativeFile(), 'open-folder': () => void openWorkspace(),
      'open-repository': () => void openExistingRepository(), 'clone-repository': () => void cloneRepository(),
      save: () => void saveDocument(), 'save-as': () => void saveAs(),
      'close-tab': () => closeDocument(), settings: () => setShowSettings(true), 'settings-ai': () => setShowSettings(true),
      'setup-tools': () => { setShowSettings(false); setPalette(null); setShowOnboarding(true) },
      'command-palette': () => { setPalette('commands'); setPaletteQuery('') }, 'quick-open': () => { setPalette('files'); setPaletteQuery('') },
      'workspace-search': () => { setActivity('search'); setSidebarVisible(true) }, 'toggle-sidebar': () => setSidebarVisible((value) => !value),
      'toggle-panel': () => setPanelVisible((value) => !value), 'toggle-ai': () => payload === true ? setAiVisible(true) : setAiVisible((value) => !value),
      'terminal-toggle': () => { setPanelTab('terminal'); setPanelVisible((value) => !value) }, 'terminal-new': newTerminal,
      'terminal-clear': () => window.dispatchEvent(new CustomEvent('omnicode:terminal-clear')), 'terminal-kill': () => window.dispatchEvent(new CustomEvent('omnicode:terminal-kill')),
      'run-current': () => void runCurrent(), 'server-start': () => void startServer(), 'server-restart': () => void startServer(true),
      'server-stop': () => void window.omnicode.server.stop(), 'inline-ai': handleInlineAI,
      'index-workspace': () => workspacePath && void window.omnicode.ai.index(workspacePath), 'editor-find': () => editorRef.current?.trigger('menu', 'actions.find', null),
      'activate-omni': () => changeAppMode('omni'),
      'editor-undo': () => {
        const active = document.activeElement
        if (active?.closest('.monaco-editor')) void editorRef.current?.getModel()?.undo()
        else if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) document.execCommand('undo')
      },
      'editor-redo': () => {
        const active = document.activeElement
        if (active?.closest('.monaco-editor')) void editorRef.current?.getModel()?.redo()
        else if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) document.execCommand('redo')
      },
      'go-to-line': () => editorRef.current?.trigger('menu', 'editor.action.gotoLine', null),
      'expand-selection': () => editorRef.current?.trigger('menu', 'editor.action.smartSelect.expand', null),
      'shrink-selection': () => editorRef.current?.trigger('menu', 'editor.action.smartSelect.shrink', null),
      'open-path': () => {
        externalOpenReceivedRef.current = true
        if (!payload || typeof payload !== 'object') return
        const opened = payload as { path?: unknown; kind?: unknown }
        if (typeof opened.path === 'string' && (opened.kind === 'file' || opened.kind === 'directory')) void openGrantedPath(opened.path, opened.kind)
      },
      'save-all-and-close': () => {
        void (async () => {
          try {
            const dirtyDocuments = documentsRef.current.filter((document) => document.content !== document.savedContent)
            const results = await Promise.allSettled(dirtyDocuments.map(async (document) => ({
              document,
              saved: await window.omnicode.workspace.writeFile(document.path, document.content, document.modifiedAt)
            })))
            const completed = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
            const byPath = new Map(completed.map((item) => [item.document.path, item]))
            setDocuments((current) => current.map((document) => {
              const item = byPath.get(document.path)
              if (!item || document.content !== item.document.content) return document
              return { ...document, savedContent: item.document.content, modifiedAt: item.saved.modifiedAt }
            }))
            const captured = new Map(dirtyDocuments.map((document) => [document.path, document.content]))
            const changedWhileSaving = documentsRef.current.some((document) => {
              const capturedContent = captured.get(document.path)
              return capturedContent === undefined
                ? document.content !== document.savedContent
                : document.content !== capturedContent
            })
            if (changedWhileSaving) throw new Error('A file changed while OmniCode was saving. Review the latest edits before closing.')
            const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
            if (failure) throw failure.reason
            allowUnloadRef.current = true
            await window.omnicode.app.closeWindow()
          } catch (cause) {
            allowUnloadRef.current = false
            await window.omnicode.app.cancelClose().catch(() => undefined)
            reportError(cause)
          }
        })()
      },
      help: () => setShowHelp(true)
      }
      handlers[command]?.()
    })
    void window.omnicode.app.ready().then(async (pendingOpenCount) => {
      if (startupInitializedRef.current) return
      startupInitializedRef.current = true
      const recent = await window.omnicode.workspace.recentWorkspaces()
      setRecentFolders(recent)
      if (!showOnboarding && recent[0] && pendingOpenCount === 0 && !externalOpenReceivedRef.current) {
        await openWorkspace(recent[0])
      }
    }).catch(reportError)
    return unsubscribe
  }, [workspacePath, runCurrent, startServer, saveDocument, saveAs, closeDocument, selectNativeFile, openWorkspace, openGrantedPath, handleInlineAI, reportError, showOnboarding, changeAppMode])

  const startResize = (kind: 'sidebar' | 'ai' | 'panel', event: React.PointerEvent): void => {
    event.preventDefault()
    const startX = event.clientX, startY = event.clientY, initialSidebar = sidebarWidth, initialAi = aiWidth, initialPanel = panelHeight
    const move = (moveEvent: PointerEvent): void => {
      if (kind === 'sidebar') setSidebarWidth(Math.min(480, Math.max(200, initialSidebar + moveEvent.clientX - startX)))
      if (kind === 'ai') setAiWidth(Math.min(640, Math.max(300, initialAi - moveEvent.clientX + startX)))
      if (kind === 'panel') setPanelHeight(Math.min(innerHeight * 0.6, Math.max(140, initialPanel - moveEvent.clientY + startY)))
    }
    const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  const onboardingTools: DetectedTool[] = detectedTools.map((tool) => ({ id: tool.id, name: tool.name, status: tool.installed ? 'available' : 'missing', version: tool.version, path: tool.path, hint: tool.guidance, installable: tool.installable }))

  if (showOnboarding) return <Onboarding detectedTools={onboardingTools} ollama={ollamaState} appearance={theme}
    toolInstallations={toolInstallations} modelCatalog={setupModelCatalog} modelPulls={setupModelPulls}
    onInstallTool={installSetupTool} onRefreshSetup={refreshSetup} onPullModel={downloadSetupModel}
    onCancelToolInstallation={async (toolId) => { await window.omnicode.tools.cancelInstallation(toolId) }}
    onCancelModelPull={async (model) => { await window.omnicode.ai.cancelModelPull(model) }}
    onAppearanceChange={setTheme} onComplete={() => { localStorage.setItem('omnicode.onboardingComplete', 'true'); setShowOnboarding(false) }}
    onSaveProvider={(provider, apiKey) => window.omnicode.ai.setCredential(provider, apiKey)}
    onCloneRepository={async () => { if (await cloneRepository()) { localStorage.setItem('omnicode.onboardingComplete', 'true'); setShowOnboarding(false) } }} onCreateProject={async () => { if (await createProject()) { localStorage.setItem('omnicode.onboardingComplete', 'true'); setShowOnboarding(false) } }}
    onOpenFolder={async () => { const opened = await openWorkspace(); if (opened) { localStorage.setItem('omnicode.onboardingComplete', 'true'); setShowOnboarding(false) } }} />

  return <div className="app-shell" onDragOver={(event) => { if (appMode === 'code') event.preventDefault() }} onDrop={(event) => {
    if (appMode !== 'code') return
    event.preventDefault(); const file = event.dataTransfer.files[0]; if (!file) return
    void window.omnicode.workspace.inspectDroppedFile(file).then((opened) => openGrantedPath(opened.path, opened.kind)).catch(reportError)
  }}>
    <header className="titlebar">
      <div className="titlebar-spacer" />
      <ModeSwitcher value={appMode} onChange={changeAppMode} />
      {appMode === 'code' ? <>
        <button className="layout-button" title="Toggle sidebar" onClick={() => setSidebarVisible((value) => !value)}><Menu /></button>
        <button className="command-center" onClick={() => { setPalette('files'); setPaletteQuery('') }}><Search /><span>{workspacePath ? fileName(workspacePath) : 'Search files by name'}</span><kbd>⌘P</kbd></button>
        <button className="run-button" disabled={!activeDocument || !workspacePath || !activeLanguage?.runnableOnMacOS} title={!workspacePath && activeDocument ? 'Open the containing folder as a workspace before running this file.' : activeLanguage && !activeLanguage.runnableOnMacOS ? `${activeLanguage.displayName} files are editable but do not have a native macOS run action.` : 'Run current file or project'} onClick={() => void runCurrent()}><Play /><span>Run</span></button>
        <button className="run-menu" title="Run configurations" onClick={() => { setActivity('run'); setSidebarVisible(true) }}><ChevronDown /></button>
        <div className="titlebar-layout"><button className={sidebarVisible ? 'active' : ''} title="Primary sidebar" onClick={() => setSidebarVisible((value) => !value)}><Files /></button><button className={panelVisible ? 'active' : ''} title="Bottom panel" onClick={() => setPanelVisible((value) => !value)}><PanelBottom /></button><button className={aiVisible ? 'active' : ''} title="AI sidebar" onClick={() => setAiVisible((value) => !value)}><Sparkles /></button></div>
      </> : <ModeTitlebarLabel mode={appMode} />}
    </header>
    <div className="mode-content">
    <div className={`code-mode-host${appMode === 'code' ? '' : ' mode-hidden'}`} aria-hidden={appMode !== 'code'}>
    <div className="workbench">
      <nav className="activity-bar" aria-label="Primary activities">
        <div><ActivityButton id="explorer" current={activity} label="Explorer" onClick={() => { if (activity === 'explorer') setSidebarVisible((value) => !value); else { setActivity('explorer'); setSidebarVisible(true) } }}><Files /></ActivityButton>
          <ActivityButton id="search" current={activity} label="Search" onClick={() => { setActivity('search'); setSidebarVisible(true) }}><Search /></ActivityButton>
          <ActivityButton id="source" current={activity} label="Source Control" badge={gitStatus?.changes.length} onClick={() => { setActivity('source'); setSidebarVisible(true) }}><GitBranch /></ActivityButton>
          <ActivityButton id="run" current={activity} label="Run & Build" onClick={() => { setActivity('run'); setSidebarVisible(true) }}><Bug /></ActivityButton>
          <ActivityButton id="ai" current={aiVisible ? 'ai' : ''} label="AI Chat" onClick={() => setAiVisible((value) => !value)}><Bot /></ActivityButton>
          <ActivityButton id="models" current={activity} label="AI Models" onClick={() => { setActivity('models'); setSidebarVisible(true) }}><Cpu /></ActivityButton>
          <ActivityButton id="tools" current={activity} label="Tools & Runtimes" onClick={() => { setActivity('tools'); setSidebarVisible(true) }}><Boxes /></ActivityButton></div>
        <div><ActivityButton id="settings" current={showSettings ? 'settings' : ''} label="Settings" onClick={() => setShowSettings(true)}><Settings /></ActivityButton></div>
      </nav>
      {sidebarVisible && <><aside className="primary-sidebar" style={{ width: sidebarWidth }}>
        {!workspacePath && activity !== 'models' && activity !== 'tools' && <div className="sidebar-view"><div className="sidebar-title">{activity[0].toUpperCase() + activity.slice(1)}</div><div className="sidebar-empty"><FolderOpen /><p>{activity === 'source' ? 'Open an existing repository or clone one to use Source Control.' : 'Open a folder to use this view.'}</p><button className="primary-button" onClick={() => void (activity === 'source' ? openExistingRepository() : openWorkspace())}>{activity === 'source' ? 'Open Repository' : 'Open Folder'}</button>{activity === 'source' && <button onClick={() => void cloneRepository()}>Clone Repository</button>}</div></div>}
        {workspacePath && activity === 'explorer' && <Explorer root={workspacePath} nodes={tree} activePath={activePath ?? undefined} onOpen={(path) => void openFile(path)} onRefresh={() => void refreshTree()} onCreate={createEntry} onRename={renameEntry}
          onMove={async (source, destination) => { try { const moved = await window.omnicode.workspace.moveEntry(source, destination); setDocuments((current) => current.map((item) => ({ ...item, path: remapPath(item.path, source, moved) }))); if (activePath && isPathAtOrBelow(activePath, source)) setActivePath(remapPath(activePath, source, moved)); await refreshTree() } catch (cause) { reportError(cause) } }}
          onDuplicate={async (node) => { try { await window.omnicode.workspace.duplicateEntry(node.path); await refreshTree() } catch (cause) { reportError(cause) } }}
          onTrash={async (node) => { const affected = documents.filter((document) => isPathAtOrBelow(document.path, node.path)); const dirty = affected.filter((document) => document.content !== document.savedContent); if (!confirm(`Move “${node.name}” to the Trash?${dirty.length ? `\n\n${dirty.length} open file${dirty.length === 1 ? '' : 's'} inside it have unsaved changes that will be discarded.` : ''}`)) return; try { await window.omnicode.workspace.trashEntry(node.path); setDocuments((current) => current.filter((document) => !isPathAtOrBelow(document.path, node.path))); if (activePath && isPathAtOrBelow(activePath, node.path)) setActivePath(null); await refreshTree() } catch (cause) { reportError(cause) } }}
          onReveal={(node) => void window.omnicode.workspace.revealInFinder(node.path).catch(reportError)} onCopyPath={(node) => void window.omnicode.workspace.copyPath(node.path).catch(reportError)} onOpenExternal={(node) => void window.omnicode.workspace.openExternal(node.path).catch(reportError)} onOpenWith={(node) => void window.omnicode.workspace.openWith(node.path).catch(reportError)} />}
        {workspacePath && activity === 'search' && <SearchView root={workspacePath} onOpen={(path, line, column) => void openFile(path, line, column)} />}
        {workspacePath && activity === 'source' && <SourceControlView root={workspacePath} onOpenDiff={(path, staged) => void showGitDiff(path, staged)} onStatus={setGitStatus} onRequestText={requestTextInput} onOpenRepository={() => void openExistingRepository()} onCloneRepository={() => void cloneRepository()} />}
        {workspacePath && activity === 'run' && <RunView root={workspacePath} activeFile={activeLanguage?.runnableOnMacOS ? activePath ?? undefined : undefined} serverState={serverState} onRun={() => void runCurrent()} onRunScript={runScript} onStartServer={(option, port) => void startServerOption(option, port)} onStopServer={() => void window.omnicode.server.stop()} onRestartServer={() => void startServer(true)} onOpenServer={() => void window.omnicode.server.open()} />}
        {activity === 'models' && <ModelsView />}
        {activity === 'tools' && <ToolsView />}
      </aside><div className="resize-handle vertical" onPointerDown={(event) => startResize('sidebar', event)} /> </>}
      <main className="editor-column">
        {documents.length > 0 && <div className="editor-tabs">{documents.map((document) => <button key={document.path} className={activePath === document.path ? 'active' : ''} onClick={() => setActivePath(document.path)} title={document.path}><FileCode2 /><span>{fileName(document.path)}</span>{document.content !== document.savedContent && <CircleDot className="dirty-dot" />}<X className="tab-close" onClick={(event) => { event.stopPropagation(); closeDocument(document.path) }} /></button>)}<button className="new-tab" title="Open file" onClick={() => void selectNativeFile()}><Plus /></button></div>}
        {activeDocument ? <>
          <div className="breadcrumbs">{activeDocument.path.split('/').filter(Boolean).map((part, index, parts) => <span key={`${part}-${index}`}>{part}{index < parts.length - 1 && <b>›</b>}</span>)}<div><button title="Save" disabled={activeDocument.content === activeDocument.savedContent} onClick={() => void saveDocument()}><Save /></button><button title="AI inline edit" onClick={handleInlineAI}><Sparkles /></button></div></div>
          <div className="editor-host"><Editor path={activeDocument.path} value={activeDocument.content} language={languageForPath(activeDocument.path)} theme={dark ? 'vs-dark' : 'light'} onMount={handleEditorMount} onChange={(value) => updateActiveContent(value ?? '')} onValidate={(markers) => setProblems(markers)} options={{
            automaticLayout: true, fontFamily: "'SFMono-Regular', Menlo, Monaco, monospace", fontSize: 13, lineHeight: 20,
            minimap: { enabled: true }, folding: true, glyphMargin: true, bracketPairColorization: { enabled: true },
            guides: { bracketPairs: true, indentation: true }, smoothScrolling: true, cursorSmoothCaretAnimation: 'on',
            padding: { top: 8 }, scrollBeyondLastLine: false, renderWhitespace: 'selection', tabSize: activeLanguageSettings?.tabSize ?? editorTabSize, insertSpaces: activeLanguageSettings?.insertSpaces ?? true,
            wordWrap: 'off', quickSuggestions: true, suggestOnTriggerCharacters: true
          }} /></div>
        </> : <div className="welcome-editor"><div className="welcome-mark"><Code2 /></div><h1>OmniCode</h1><p>Native tools. Local context. Your code stays in your control.</p><div className="welcome-actions"><button onClick={() => void openWorkspace()}><FolderOpen /> Open Folder <kbd>⌘⇧O</kbd></button><button onClick={() => void selectNativeFile()}><FileCode2 /> Open File <kbd>⌘O</kbd></button><button onClick={() => void openExistingRepository()}><GitBranch /> Open Existing Repository</button><button onClick={() => void cloneRepository()}><GitFork /> Clone Repository</button><button onClick={() => void createProject()}><Plus /> New Project</button></div>{recentFolders.length > 0 && <div className="recent-list"><h2>Recent</h2>{recentFolders.map((folder) => <button key={folder} onClick={() => void openWorkspace(folder)}><FolderOpen /><span><strong>{fileName(folder)}</strong><small>{folder}</small></span></button>)}</div>}<div className="shortcut-grid"><span><kbd>⌘P</kbd> Quick Open</span><span><kbd>⌘⇧P</kbd> Commands</span><span><kbd>⌘`</kbd> Terminal</span><span><kbd>⌘I</kbd> Inline AI</span></div></div>}
        <><div className="resize-handle horizontal" style={{ display: panelVisible ? undefined : 'none' }} onPointerDown={(event) => startResize('panel', event)} /><section className="bottom-panel" style={{ height: panelVisible ? panelHeight : 0, display: panelVisible ? undefined : 'none' }}>
          <div className="panel-tabs">{(['terminal', 'output', 'problems', 'runlog'] as PanelTab[]).map((tab) => <button key={tab} className={panelTab === tab ? 'active' : ''} onClick={() => setPanelTab(tab)}>{tab === 'runlog' ? 'Run Log' : tab}{tab === 'problems' && problems.length > 0 && <span>{problems.length}</span>}</button>)}<div /><button title="Close panel" onClick={() => setPanelVisible(false)}><X /></button></div>
          <div className="panel-content"><TerminalPanel workspacePath={workspacePath} visible={appMode === 'code' && panelVisible && panelTab === 'terminal'} onRequestClose={() => setPanelVisible(false)} runRequest={runRequest} onOutput={captureTerminalOutput} onRequestText={requestTextInput} />
            {panelTab === 'output' && <pre className="output-view">{outputs.join('\n')}</pre>}
            {panelTab === 'problems' && <div className="problems-view">{problems.map((problem, index) => <button key={index} onClick={() => { editorRef.current?.setPosition({ lineNumber: problem.startLineNumber, column: problem.startColumn }); editorRef.current?.revealLineInCenter(problem.startLineNumber) }}><CircleAlert className={problem.severity === 8 ? 'error' : 'warning'} /><span>{problem.message}</span><small>{problem.startLineNumber}:{problem.startColumn}</small></button>)}{!problems.length && <div className="panel-empty"><CheckCircle2 /> No problems detected in the active file.</div>}</div>}
            {panelTab === 'runlog' && (terminalOutput
              ? <pre className="output-view">{terminalOutput}</pre>
              : <div className="panel-empty"><Bug /> Run a task to inspect its captured console output here.</div>)}
          </div>
        </section></>
      </main>
      {aiVisible && <><div className="resize-handle vertical ai-resizer" onPointerDown={(event) => startResize('ai', event)} /><div style={{ width: aiWidth, minWidth: aiWidth }}><AIChat key={workspacePath ?? 'no-workspace'} workspacePath={workspacePath} defaultProvider={workspaceChatProvider} defaultModel={workspaceChatModel} activeFile={activePath ?? undefined} openFiles={documents.map((document) => document.path)} selectedCode={() => { const selection = editorRef.current?.getSelection(); const model = editorRef.current?.getModel(); return selection && model && !selection.isEmpty() ? model.getValueInRange(selection) : '' }} terminalOutput={terminalOutput} problems={problems.map((problem) => `${problem.startLineNumber}:${problem.startColumn} ${problem.message}`).join('\n')} gitChanges={gitStatus?.changes.map((change) => `${change.indexStatus}${change.workingTreeStatus} ${change.path}`).join('\n') ?? ''} permission={permission} prepareWorkspace={saveAllDocuments} onReviewProposal={setDiffProposalId} onRunAgentCommand={runAgentCommand} onOpenSettings={() => setShowSettings(true)} /></div></>}
    </div>
    <footer className="status-bar"><button title="Git branch"><GitBranch />{gitStatus?.isRepository ? gitStatus.branch : 'No Git'}</button><button onClick={() => { setPanelVisible(true); setPanelTab('problems') }}><CircleAlert />{problems.length}</button><span className="status-spacer" /><button title={serverState.running ? 'Open local server (stop it from the Run menu)' : 'Open Run view'} onClick={() => serverState.running && serverState.url ? void window.omnicode.server.open() : (setActivity('run'), setSidebarVisible(true))}>{serverState.running ? <><Server className="server-on" /> {serverState.name ?? 'Running'}{serverState.port ? ` :${serverState.port}` : ''}</> : <><Server /> Server off</>}</button>{activeRuntime && <button title={activeRuntime.installed ? `${activeRuntime.path ?? activeRuntime.command}${activeRuntime.version ? ` · ${activeRuntime.version}` : ''}` : activeRuntime.guidance} onClick={() => { setActivity('tools'); setSidebarVisible(true) }}><Boxes />{activeRuntime.name}: {activeRuntime.installed ? 'Ready' : 'Missing'}</button>}<span title={aiAutocomplete ? `${autocompleteProvider}: ${autocompleteModel || 'automatic local model'}` : 'AI autocomplete is disabled'}><Sparkles /> {aiAutocomplete ? 'Autocomplete on' : 'Autocomplete off'}</span><span><Cpu /> {ollamaState.status === 'ready' ? 'Local AI' : 'AI optional'}</span><span>UTF-8</span><span>Ln {cursor.line}, Col {cursor.column}</span><span>{activeLanguage?.displayName ?? 'Plain Text'}</span></footer>
    </div>
    <div className={`work-mode-host${appMode === 'work' ? '' : ' mode-hidden'}`} aria-hidden={appMode !== 'work'}><WorkMode active={appMode === 'work'} onOpenSettings={() => setShowSettings(true)} onError={reportError} onRequireAttention={() => changeAppMode('work')} requestText={requestTextInput} /></div>
    <div className={`omni-mode-host${appMode === 'omni' ? '' : ' mode-hidden'}`} aria-hidden={appMode !== 'omni'}><OmniMode active={appMode === 'omni'} /></div>
    </div>
    {palette && <div className="palette-backdrop" onMouseDown={() => setPalette(null)}><div className="palette" onMouseDown={(event) => event.stopPropagation()}><div><Command /><input autoFocus value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)} placeholder={palette === 'commands' ? 'Type a command' : 'Search files by name'} /></div><div className="palette-results">{palette === 'commands' ? commands.filter(([label]) => label.toLowerCase().includes(paletteQuery.toLowerCase())).map(([label, action]) => <button key={label} onClick={() => { setPalette(null); action() }}><Command /><span>{label}</span></button>) : allFiles.filter((file) => file.path.toLowerCase().includes(paletteQuery.toLowerCase())).slice(0, 100).map((file) => <button key={file.path} onClick={() => { setPalette(null); void openFile(file.path) }}><FileCode2 /><span><strong>{file.name}</strong><small>{file.path.replace(`${workspacePath}/`, '')}</small></span></button>)}</div></div></div>}
    {cloneProgress && <div className="modal-backdrop clone-progress-backdrop"><section className="clone-progress-dialog" role="dialog" aria-modal="true" aria-label="Repository clone progress">
      <header><div className={`clone-progress-icon phase-${cloneProgress.phase}`}>{cloneProgress.done ? cloneProgress.phase === 'completed' ? <CheckCircle2 /> : <CircleAlert /> : <LoaderCircle className="spin" />}</div><span><h2>Clone Repository</h2><small>{cloneProgress.message}</small></span></header>
      {cloneProgress.percent !== undefined
        ? <div className="clone-progress-meter"><progress max="100" value={cloneProgress.percent} /><span>{Math.round(cloneProgress.percent)}%</span></div>
        : !cloneProgress.done && <div className="clone-progress-meter indeterminate"><progress /><span>Working…</span></div>}
      {cloneProgress.destination && <div className="clone-progress-destination"><strong>{cloneProgress.phase === 'completed' ? 'Repository' : 'Destination'}</strong><code>{cloneProgress.destination}</code></div>}
      {cloneProgress.error && <p className="clone-progress-error">{cloneProgress.error}</p>}
      <footer>{cloneProgress.cancellable
        ? <button type="button" onClick={() => {
            setCloneProgress((current) => current ? { ...current, phase: 'cancelling', message: 'Stopping Git…', cancellable: false } : current)
            void window.omnicode.git.cancelClone(cloneProgress.requestId)
          }}>Cancel Clone</button>
        : cloneProgress.done && <button type="button" className="primary-button" onClick={() => setCloneProgress(null)}>Close</button>}</footer>
    </section></div>}
    {modalInput && <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) { modalInput.onCancel?.(); setModalInput(null) }
    }}><form className="input-modal" role="dialog" aria-modal="true" aria-label={modalInput.title} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); modalInput.onCancel?.(); setModalInput(null) }
    }} onSubmit={(event) => { event.preventDefault(); modalInput.onConfirm(modalInput.value) }}><h2>{modalInput.title}</h2><label>{modalInput.label}<input autoFocus value={modalInput.value} onChange={(event) => setModalInput({ ...modalInput, value: event.target.value })} /></label><div><button type="button" onClick={() => { modalInput.onCancel?.(); setModalInput(null) }}>Cancel</button><button className="primary-button" disabled={!modalInput.value.trim()}>{modalInput.confirmLabel}</button></div></form></div>}
    {showHelp && <div className="modal-backdrop"><section className="help-modal" role="dialog" aria-modal="true" aria-label="OmniCode help"><header><div><Code2 /><span><h2>OmniCode</h2><small>macOS developer workspace</small></span></div><button title="Close help" onClick={() => setShowHelp(false)}><X /></button></header><p>Write, run, host, version, and review AI-assisted changes without leaving your workspace. AI is optional; local models stay on this Mac.</p><div className="help-shortcuts">{[['⌘ P', 'Quick Open'], ['⌘ ⇧ P', 'Command Palette'], ['⌘ S', 'Save'], ['⌘ ⇧ F', 'Workspace Search'], ['⌘ `', 'Terminal'], ['⌘ I', 'Inline AI'], ['⌃ R', 'Run Current File'], ['⌘ ,', 'Settings']].map(([shortcut, label]) => <div key={shortcut}><kbd>{shortcut}</kbd><span>{label}</span></div>)}</div><footer><button onClick={() => { setShowHelp(false); setShowOnboarding(true) }}>Run Setup Guide Again</button><button className="primary-button" onClick={() => setShowHelp(false)}>Done</button></footer></section></div>}
    {inlineEdit && <div className="inline-ai-overlay"><div className={`inline-ai-dialog ${inlineEdit.phase === 'review' ? 'review' : ''}`}><header><Sparkles /><strong>OmniCode Inline Edit</strong><span className="privacy-badge local"><Cpu /> LOCAL</span><button onClick={() => setInlineEdit(null)}><X /></button></header>{inlineEdit.phase !== 'review' ? <><textarea autoFocus value={inlineEdit.instruction} disabled={inlineEdit.phase === 'loading'} onChange={(event) => setInlineEdit({ ...inlineEdit, instruction: event.target.value })} placeholder="Describe the change…" />{inlineEdit.error && <div className="inline-error">{inlineEdit.error}</div>}<footer><span>{inlineEdit.original.split('\n').length} selected line(s)</span><button onClick={() => setInlineEdit(null)}>Cancel</button><button className="primary-button" disabled={!inlineEdit.instruction.trim() || inlineEdit.phase === 'loading'} onClick={() => void submitInlineAI()}>{inlineEdit.phase === 'loading' ? 'Generating…' : 'Generate Diff'}</button></footer></> : <><div className="diff-host"><DiffEditor original={inlineEdit.original} modified={inlineEdit.proposal} language={activeDocument ? languageForPath(activeDocument.path) : 'plaintext'} theme={dark ? 'vs-dark' : 'light'} options={{ automaticLayout: true, readOnly: true, minimap: { enabled: false }, renderSideBySide: true, fontSize: 12 }} /></div><footer><span>Review the proposed replacement before applying.</span><button onClick={() => setInlineEdit(null)}>Reject</button><button className="primary-button" onClick={acceptInlineAI}>Accept Change</button></footer></>}</div></div>}
    {diffProposalId && <div className="change-review-overlay"><div className="change-review-dialog"><DiffReview proposalId={diffProposalId} onClose={() => setDiffProposalId(null)} onProposalChange={handleProposalChange} /></div></div>}
    {showSettings && <SettingsPanel workspacePath={workspacePath} theme={theme} autosave={autosave} permission={permission} aiAutocomplete={aiAutocomplete} autocompleteProvider={autocompleteProvider} autocompleteModel={autocompleteModel} onTheme={setTheme} onAutosave={setAutosave} onPermission={setPermission} onAIAutocomplete={setAiAutocomplete} onAutocompleteProvider={setAutocompleteProvider} onAutocompleteModel={setAutocompleteModel} onWorkspaceSettings={applyWorkspaceSettings} onClose={() => setShowSettings(false)} />}
    {toast && <ToastNotice toast={toast} onClose={() => setToast(null)} />}
  </div>
}
