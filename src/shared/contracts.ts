export type ThemePreference = 'system' | 'dark' | 'light'

export interface FileNode {
  name: string
  path: string
  kind: 'file' | 'directory'
  children?: FileNode[]
}

export interface FileDocument {
  path: string
  content: string
  modifiedAt: number
  size: number
}

export interface SearchMatch {
  path: string
  line: number
  column: number
  preview: string
}

export interface WorkspaceSearchOptions {
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
  include?: string
  exclude?: string
}

export interface ReplaceResult {
  filesChanged: number
  replacements: number
}

export interface ToolInfo {
  id: string
  name: string
  command: string
  installed: boolean
  path?: string
  version?: string
  guidance?: string
  installable?: boolean
}

export type ToolInstallationPhase =
  | 'preparing'
  | 'downloading'
  | 'installing'
  | 'starting'
  | 'waiting-for-user'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface ToolInstallationProgress {
  toolId: string
  phase: ToolInstallationPhase
  message: string
  detail?: string
  percent?: number
  done: boolean
  cancellable: boolean
  error?: string
}

export interface ToolInstallationResult {
  toolId: string
  installed: boolean
  cancelled: boolean
  requiresUserAction?: boolean
}

export interface HardwareInfo {
  platform: string
  architecture: string
  appleSilicon: boolean
  cpuModel: string
  logicalCores: number
  memoryBytes: number
  availableMemoryBytes: number
  metalSupported: boolean
  gpu?: string
  macOSVersion?: string
}

export interface GitFileChange {
  path: string
  originalPath?: string
  indexStatus: string
  workingTreeStatus: string
}

export interface GitStatus {
  isRepository: boolean
  branch: string
  ahead: number
  behind: number
  changes: GitFileChange[]
  error?: string
}

export interface TerminalSessionInfo {
  id: string
  name: string
  shell: string
  cwd: string
}

export interface TerminalDataEvent {
  id: string
  data: string
}

export interface TerminalExitEvent {
  id: string
  exitCode: number
  signal?: number
}

export interface RunConfiguration {
  name: string
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  description?: string
  requiredTool?: string
  missingTool?: string
}

export interface ServerState {
  running: boolean
  port?: number
  url?: string
  root?: string
  mode?: 'static' | 'project'
  name?: string
  script?: string
  error?: string
}

export interface DevServerOption {
  id: string
  name: string
  framework: string
  script?: string
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun'
  kind: 'static' | 'package'
}

export interface PackageScript {
  name: string
  command: string
}

export type AIProviderId = 'ollama' | 'openai' | 'anthropic' | 'google'

export type AIProviderConnectionState =
  | 'not-configured'
  | 'stored'
  | 'connected'
  | 'authentication-failed'
  | 'unavailable'

export interface AIProviderConnectionStatus {
  provider: Exclude<AIProviderId, 'ollama'>
  state: AIProviderConnectionState
  stored: boolean
  message: string
  checkedAt?: string
}

export type AIModelRecommendation =
  | 'Recommended'
  | 'Should Run'
  | 'May Run Slowly'
  | 'Not Recommended'

export type AICodingCapability = 'General' | 'Good' | 'Strong' | 'Advanced'

export interface AIModel {
  id: string
  name: string
  provider: AIProviderId
  local: boolean
  description?: string
  size?: number
  approximateDownloadSize?: number
  estimatedMemoryBytes?: number
  parameterSize?: string
  quantization?: string
  contextWindow?: number
  family?: string
  capabilities?: string[]
  codingCapability?: AICodingCapability
  toolUse?: boolean
  digest?: string
  modifiedAt?: string
  catalog?: boolean
  installed?: boolean
  loaded?: boolean
  loadedSize?: number
  selected?: boolean
  isDefault?: boolean
  recommendation?: AIModelRecommendation
}

export interface AIModelPreferences {
  selectedModel?: string
  defaultModel?: string
}

export interface OllamaStatus {
  installed: boolean
  available: boolean
  version?: string
}

export interface OllamaPullProgress {
  model: string
  status: string
  digest?: string
  completed?: number
  total?: number
  percent?: number
  done: boolean
  cancelled?: boolean
  error?: string
}

export interface OllamaPullResult {
  model: string
  cancelled: boolean
}

export interface AIMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AIChatRequest {
  provider: AIProviderId
  model: string
  messages: AIMessage[]
  workspacePath?: string
  attachWorkspaceContext?: boolean
  attachedPaths?: string[]
}

export interface AIChatResponse {
  content: string
  contextFiles: string[]
}

export interface WorkspaceIndexStatus {
  fileCount: number
  indexedAt: number
  ignoredCount: number
}

export interface WorkspaceSettings {
  run?: {
    command?: string
    buildCommand?: string
    workingDirectory?: string
    args?: string[]
    environment?: Record<string, string>
    preRunCommand?: string
    postRunCommand?: string
  }
  developmentServer?: { script?: string; port?: number }
  ai?: { provider?: AIProviderId; chatModel?: string; autocompleteModel?: string; exclusions?: string[] }
  editor?: { autosave?: boolean; tabSize?: number }
  languages?: Record<string, { tabSize?: number; insertSpaces?: boolean }>
  toolchains?: Record<string, string>
  agentPermissions?: 'ask' | 'workspace' | 'agent'
}

export type DiffChangeKind = 'modify' | 'create' | 'delete'
export type DiffDecisionStatus = 'pending' | 'accepted' | 'rejected' | 'partial'

export type DiffProposalChangeInput =
  | { kind: 'modify' | 'create'; path: string; content: string }
  | { kind: 'delete'; path: string }

export interface CreateDiffProposalRequest {
  workspaceRoot: string
  title?: string
  changes: DiffProposalChangeInput[]
}

export interface DiffReviewLine {
  kind: 'context' | 'add' | 'delete'
  content: string
  oldLine?: number
  newLine?: number
}

export interface DiffHunk {
  id: string
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  status: Exclude<DiffDecisionStatus, 'partial'>
  lines: DiffReviewLine[]
}

export interface DiffProposalFile {
  id: string
  path: string
  relativePath: string
  kind: DiffChangeKind
  status: DiffDecisionStatus
  additions: number
  deletions: number
  originalContent: string
  proposedContent: string
  currentContent: string
  reviewContent: string
  unifiedDiff: string
  hunks: DiffHunk[]
}

export interface DiffProposal {
  id: string
  title: string
  workspaceRoot: string
  createdAt: number
  updatedAt: number
  status: DiffDecisionStatus
  pendingHunks: number
  acceptedHunks: number
  rejectedHunks: number
  canUndo: boolean
  files: DiffProposalFile[]
}

export type DiffDecisionTarget =
  | { scope: 'all' }
  | { scope: 'file'; fileId: string }
  | { scope: 'hunk'; fileId: string; hunkId: string }

export interface WorkspaceAPI {
  inspectDroppedFile(file: File): Promise<{ path: string; kind: 'file' | 'directory' }>
  selectFolder(): Promise<string | null>
  selectDestinationFolder(): Promise<string | null>
  selectFile(): Promise<string | null>
  recentWorkspaces(): Promise<string[]>
  reopenWorkspace(path: string): Promise<string>
  createProject(parent: string, name: string): Promise<string>
  readTree(root: string): Promise<FileNode[]>
  readFile(path: string): Promise<FileDocument>
  writeFile(path: string, content: string, expectedModifiedAt?: number): Promise<FileDocument>
  saveAs(content: string, suggestedPath?: string): Promise<string | null>
  createEntry(parent: string, name: string, kind: 'file' | 'directory'): Promise<string>
  renameEntry(path: string, newName: string): Promise<string>
  moveEntry(source: string, destinationDirectory: string): Promise<string>
  duplicateEntry(path: string): Promise<string>
  trashEntry(path: string): Promise<void>
  revealInFinder(path: string): Promise<void>
  copyPath(path: string): Promise<void>
  openExternal(path: string): Promise<string>
  openWith(path: string): Promise<void>
  search(root: string, query: string, options?: WorkspaceSearchOptions): Promise<SearchMatch[]>
  replaceAll(root: string, query: string, replacement: string, options?: WorkspaceSearchOptions): Promise<ReplaceResult>
  watch(root: string): Promise<void>
  unwatch(): Promise<void>
  onChanged(callback: (path: string) => void): () => void
}

export interface TerminalAPI {
  create(options: { cwd: string; shell?: string; name?: string }): Promise<TerminalSessionInfo>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  kill(id: string): Promise<void>
  restart(id: string): Promise<TerminalSessionInfo>
  listShells(): Promise<string[]>
  onData(callback: (event: TerminalDataEvent) => void): () => void
  onExit(callback: (event: TerminalExitEvent) => void): () => void
}

export interface GitAPI {
  status(root: string): Promise<GitStatus>
  diff(root: string, path?: string, staged?: boolean): Promise<string>
  stage(root: string, paths: string[]): Promise<void>
  unstage(root: string, paths: string[]): Promise<void>
  commit(root: string, message: string): Promise<string>
  operation(root: string, operation: 'init' | 'fetch' | 'pull' | 'push'): Promise<string>
  branches(root: string): Promise<string[]>
  switchBranch(root: string, name: string, create?: boolean): Promise<void>
  deleteBranch(root: string, name: string, force?: boolean): Promise<void>
  clone(destinationParent: string, repositoryUrl: string): Promise<string>
}

export interface DiffAPI {
  propose(request: CreateDiffProposalRequest): Promise<DiffProposal>
  get(proposalId: string): Promise<DiffProposal>
  accept(proposalId: string, target: DiffDecisionTarget): Promise<DiffProposal>
  reject(proposalId: string, target: DiffDecisionTarget): Promise<DiffProposal>
  undo(proposalId: string): Promise<DiffProposal>
  discard(proposalId: string): Promise<void>
  onChanged(callback: (proposal: DiffProposal) => void): () => void
}

export interface OmniCodeAPI {
  workspace: WorkspaceAPI
  terminal: TerminalAPI
  diff: DiffAPI
  tools: {
    detect(): Promise<ToolInfo[]>
    hardware(): Promise<HardwareInfo>
    install(toolId: string): Promise<ToolInstallationResult>
    installations(): Promise<ToolInstallationProgress[]>
    cancelInstallation(toolId: string): Promise<boolean>
    onInstallationProgress(callback: (progress: ToolInstallationProgress) => void): () => void
  }
  run: {
    resolve(filePath: string, workspacePath: string): Promise<RunConfiguration>
    packageScripts(workspacePath: string): Promise<PackageScript[]>
  }
  server: {
    detect(root: string): Promise<DevServerOption[]>
    start(root: string, port?: number): Promise<ServerState>
    startProject(root: string, script: string, port?: number): Promise<ServerState>
    stop(): Promise<ServerState>
    state(): Promise<ServerState>
    open(): Promise<void>
    onState(callback: (state: ServerState) => void): () => void
    onLog(callback: (line: string) => void): () => void
  }
  git: GitAPI
  ai: {
    ollamaStatus(): Promise<OllamaStatus>
    models(): Promise<AIModel[]>
    modelCatalog(query?: string): Promise<AIModel[]>
    modelPreferences(): Promise<AIModelPreferences>
    selectModel(model: string, makeDefault?: boolean): Promise<AIModelPreferences>
    pullModel(model: string): Promise<OllamaPullResult>
    modelPulls(): Promise<OllamaPullProgress[]>
    cancelModelPull(model: string): Promise<boolean>
    loadModel(model: string): Promise<void>
    unloadModel(model: string): Promise<void>
    deleteModel(model: string): Promise<boolean>
    onModelPullProgress(callback: (progress: OllamaPullProgress) => void): () => void
    chat(request: AIChatRequest): Promise<AIChatResponse>
    setCredential(provider: Exclude<AIProviderId, 'ollama'>, apiKey: string): Promise<void>
    hasCredential(provider: Exclude<AIProviderId, 'ollama'>): Promise<boolean>
    testProviderConnection(provider: Exclude<AIProviderId, 'ollama'>): Promise<AIProviderConnectionStatus>
    deleteCredential(provider: Exclude<AIProviderId, 'ollama'>): Promise<void>
    index(root: string): Promise<WorkspaceIndexStatus>
    contextPreview(root: string, query: string): Promise<string[]>
  }
  settings: {
    read(root: string): Promise<WorkspaceSettings>
    write(root: string, settings: WorkspaceSettings): Promise<void>
  }
  app: {
    platform: string
    version(): Promise<string>
    ready(): Promise<number>
    closeWindow(): Promise<void>
    cancelClose(): Promise<void>
    openExternal(url: string): Promise<void>
    notify(title: string, body: string): Promise<void>
    onCommand(callback: (command: string, payload?: unknown) => void): () => void
  }
}
