import type {
  AIModelCatalogQuery,
  AIModelCatalogResult,
  CloudAIProviderId
} from './model-contracts'
import type {
  ConnectorDescriptor,
  ToolDescriptor,
  ToolExecutionRequest,
  ToolExecutionResult,
  WorkActionHistoryEntry,
  WorkApprovalMode,
  WorkApprovalRequest,
  WorkPermissionSettings
} from './tool-contracts'
import type {
  CreateWorkConversationRequest,
  CreateWorkMessageRequest,
  RecoverWorkConversationStoreResult,
  UpdateWorkConversationRequest,
  UpdateWorkMessageRequest,
  WorkConversation,
  WorkConversationSearchRequest,
  WorkConversationSummary,
  WorkAgentChatRequest,
  WorkAgentChatResponse,
  WorkAgentStreamEvent,
  WorkAttachment,
  WorkMessage
} from './work-contracts'
import type {
  CodeAgentEvent,
  CodeAgentFocusBehavior,
  CodeAgentStartRequest,
  CodeAgentTask,
  CodeAgentTaskSummary,
  CodeAgentVisibility
} from './code-agent-contracts'
import type {
  OmniActivationSource,
  OmniEvent,
  OmniExecutionMode,
  OmniInstalledVoice,
  OmniPermissionId,
  OmniPermissionsSnapshot,
  OmniPermissionDetail,
  OmniSpeechInputAvailability,
  OmniSpeechInputEvent,
  OmniSpeechRecognitionResult,
  OmniSpeechStartOptions,
  OmniSettings,
  OmniSpeechOutputEvent,
  OmniStartRequest,
  OmniTask,
  OmniTaskSummary,
  OmniVoiceAvailability
} from './omni-contracts'
import type { OmniCursorRuntimeStatus } from './omni-cursor-contracts'
import type {
  AICostEstimate,
  AIUsageDeleteResult,
  AIUsageExportFormat,
  AIUsageExportResult,
  AIUsageQuery,
  AIUsageSettings,
  AIUsageSummary,
  AIUsageContext,
  ModelPricing
} from './ai-usage-contracts'

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

export interface GitRepositoryInfo {
  isRepository: boolean
  branch: string
  remoteUrl?: string
  host: 'github' | 'other' | 'none'
}

export type GitClonePhase =
  | 'starting'
  | 'receiving'
  | 'resolving'
  | 'checking-out'
  | 'completed'
  | 'cancelling'
  | 'cancelled'
  | 'failed'

export interface GitCloneProgress {
  requestId: string
  phase: GitClonePhase
  message: string
  percent?: number
  done: boolean
  cancellable: boolean
  destination?: string
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

export type ProviderPolicyVerificationState =
  | 'VERIFIED_ELIGIBLE'
  | 'UNVERIFIED'
  | 'INELIGIBLE'
  | 'UNKNOWN'

export type ProviderPolicyVerificationMethod =
  | 'local-runtime'
  | 'documented-api-terms'
  | 'manual-ai-studio-paid-plan'
  | 'manual-ai-studio-free-plan'
  | 'none'

export interface ProviderDataPolicy {
  provider: AIProviderId
  model?: string
  displayName: string
  verificationState: ProviderPolicyVerificationState
  verificationMethod: ProviderPolicyVerificationMethod
  workspaceDataEligible: boolean
  allowsGoogleWorkspaceData: boolean
  consentRequired: boolean
  consentGranted: boolean
  plan: 'local' | 'paid' | 'free' | 'unknown'
  zeroDataRetention: 'not-applicable' | 'not-configured' | 'unknown'
  verifiedAt?: string
  verificationExpiresAt?: string
  cloud: boolean
  endpointType: string
  retention: string
  training: string
  dataRegion: string
  rationale: string
  lastReviewed: string
  documentationUrls: string[]
}

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
  /** Set by trusted OmniCode call sites; the main process normalizes IPC values. */
  usageContext?: AIUsageContext
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
  inspect(root: string): Promise<GitRepositoryInfo>
  diff(root: string, path?: string, staged?: boolean): Promise<string>
  stage(root: string, paths: string[]): Promise<void>
  unstage(root: string, paths: string[]): Promise<void>
  commit(root: string, message: string): Promise<string>
  operation(root: string, operation: 'init' | 'fetch' | 'pull' | 'push'): Promise<string>
  branches(root: string): Promise<string[]>
  switchBranch(root: string, name: string, create?: boolean): Promise<void>
  deleteBranch(root: string, name: string, force?: boolean): Promise<void>
  clone(requestId: string, destinationParent: string, repositoryUrl: string): Promise<string>
  cancelClone(requestId: string): Promise<boolean>
  onCloneProgress(callback: (progress: GitCloneProgress) => void): () => void
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

export interface WorkAPI {
  conversations: {
    list(): Promise<WorkConversationSummary[]>
    search(request?: WorkConversationSearchRequest): Promise<WorkConversationSummary[]>
    get(id: string): Promise<WorkConversation>
    create(request?: CreateWorkConversationRequest): Promise<WorkConversation>
    update(id: string, request: UpdateWorkConversationRequest): Promise<WorkConversation>
    delete(id: string): Promise<void>
    addMessage(id: string, request: CreateWorkMessageRequest): Promise<WorkMessage>
    updateMessage(conversationId: string, messageId: string, request: UpdateWorkMessageRequest): Promise<WorkMessage>
    deleteMessage(conversationId: string, messageId: string): Promise<WorkConversation>
    clearMessages(id: string): Promise<WorkConversation>
    recover(): Promise<RecoverWorkConversationStoreResult>
  }
  connectors: {
    list(refresh?: boolean): Promise<ConnectorDescriptor[]>
    connect(id: string): Promise<ConnectorDescriptor['status']>
    disconnect(id: string): Promise<ConnectorDescriptor['status']>
  }
  providerPolicy(provider: AIProviderId, model?: string): Promise<ProviderDataPolicy>
  configureGeminiWorkspace(request: {
    plan: 'paid' | 'free'
    confirmedAiStudioPlan?: boolean
    confirmedMatchingCredential?: boolean
  }): Promise<ProviderDataPolicy>
  clearGeminiWorkspaceVerification(): Promise<ProviderDataPolicy>
  setGoogleWorkspaceConsent(provider: AIProviderId, granted: boolean): Promise<ProviderDataPolicy>
  permissions: {
    get(): Promise<WorkPermissionSettings>
    setGlobal(mode: WorkApprovalMode, acknowledgeFullAccess?: boolean): Promise<WorkPermissionSettings>
    setConnector(id: string, mode: WorkApprovalMode | null, acknowledgeFullAccess?: boolean): Promise<WorkPermissionSettings>
    onChanged(callback: (settings: WorkPermissionSettings) => void): () => void
  }
  approvals: {
    resolve(id: string, approved: boolean): Promise<boolean>
    onRequest(callback: (request: WorkApprovalRequest) => void): () => void
    onSettled(callback: (id: string) => void): () => void
  }
  activity: {
    list(limit?: number): Promise<WorkActionHistoryEntry[]>
    clear(): Promise<void>
    onChanged(callback: (entry: WorkActionHistoryEntry) => void): () => void
    onCleared(callback: () => void): () => void
  }
  attachments: {
    select(): Promise<WorkAttachment[]>
    importDroppedFile(file: File): Promise<WorkAttachment>
    remove(id: string): Promise<void>
  }
  tools: {
    list(): Promise<ToolDescriptor[]>
    execute(request: ToolExecutionRequest): Promise<ToolExecutionResult>
  }
  agent: {
    chat(requestId: string, request: WorkAgentChatRequest): Promise<WorkAgentChatResponse>
    cancel(requestId: string): Promise<boolean>
    onEvent(callback: (event: WorkAgentStreamEvent) => void): () => void
  }
}

/** Renderer-safe settings changes. Full Access acknowledgement is a separate, explicit IPC argument. */
export interface OmniSettingsChanges {
  enabled?: boolean
  setupCompleted?: boolean
  showTextInput?: boolean
  launchHelperAtLogin?: boolean
  menuBarItem?: boolean
  activation?: Partial<OmniSettings['activation']>
  voice?: Partial<OmniSettings['voice']>
  model?: Partial<OmniSettings['model']>
  executionMode?: OmniSettings['executionMode']
  approvalMode?: OmniSettings['approvalMode']
  privacy?: Partial<OmniSettings['privacy']>
}

export interface OmniAPI {
  settings: {
    get(): Promise<OmniSettings>
    update(changes: OmniSettingsChanges, acknowledgeFullAccess?: boolean): Promise<OmniSettings>
    onChanged(callback: (settings: OmniSettings) => void): () => void
  }
  tasks: {
    start(request: OmniStartRequest): Promise<OmniTask>
    pause(taskId: string): Promise<OmniTask>
    resume(taskId: string): Promise<OmniTask>
    stop(taskId: string): Promise<OmniTask>
    switchExecutionMode(taskId: string, mode: OmniExecutionMode): Promise<OmniTask>
    modifyPlan(taskId: string, instruction: string): Promise<OmniTask>
    skipStep(taskId: string): Promise<OmniTask>
    get(taskId: string): Promise<OmniTask>
    list(): Promise<OmniTaskSummary[]>
    clearHistory(): Promise<void>
    onTaskChanged(callback: (task: OmniTaskSummary) => void): () => void
    onEvent(callback: (event: OmniEvent) => void): () => void
  }
  activation: {
    showOverlay(): Promise<void>
  }
  permissions: {
    status(): Promise<OmniPermissionsSnapshot>
    request(permissionId: OmniPermissionId): Promise<OmniPermissionDetail>
    openSettings(permissionId: OmniPermissionId): Promise<void>
    onChanged(callback: (snapshot: OmniPermissionsSnapshot) => void): () => void
  }
  voice: {
    availability(): Promise<OmniVoiceAvailability>
    voices(): Promise<OmniInstalledVoice[]>
    test(): Promise<void>
    stop(): Promise<boolean>
    inputAvailability(): Promise<OmniSpeechInputAvailability>
    startInput(options?: OmniSpeechStartOptions): Promise<{ sessionId: string }>
    stopInput(sessionId: string): Promise<OmniSpeechRecognitionResult>
    cancelInput(sessionId: string): Promise<boolean>
    onInputEvent(callback: (event: OmniSpeechInputEvent) => void): () => void
    onOutputEvent(callback: (event: OmniSpeechOutputEvent) => void): () => void
  }
  cursor: {
    status(): Promise<OmniCursorRuntimeStatus>
  }
}

/** Deliberately smaller API exposed to the global Omni overlay preload. */
export interface OmniOverlayAPI {
  settings: {
    get(): Promise<OmniSettings>
  }
  tasks: {
    start(input: string): Promise<OmniTask>
    pause(taskId: string): Promise<OmniTask>
    resume(taskId: string): Promise<OmniTask>
    stop(taskId: string): Promise<OmniTask>
    get(taskId: string): Promise<OmniTask>
    list(): Promise<OmniTaskSummary[]>
    onTaskChanged(callback: (task: OmniTaskSummary) => void): () => void
    onEvent(callback: (event: OmniEvent) => void): () => void
  }
  activation: {
    hide(): Promise<void>
    openMainWindow(): Promise<void>
    onShow(callback: (payload: { source: OmniActivationSource }) => void): () => void
  }
  permissions: {
    status(): Promise<OmniPermissionsSnapshot>
    request(permissionId: OmniPermissionId): Promise<OmniPermissionDetail>
    openSettings(permissionId: OmniPermissionId): Promise<void>
    onChanged(callback: (snapshot: OmniPermissionsSnapshot) => void): () => void
  }
  voice: {
    inputAvailability(): Promise<OmniSpeechInputAvailability>
    startInput(options?: OmniSpeechStartOptions): Promise<{ sessionId: string }>
    stopInput(sessionId: string): Promise<OmniSpeechRecognitionResult>
    cancelInput(sessionId: string): Promise<boolean>
    stop(): Promise<boolean>
    onInputEvent(callback: (event: OmniSpeechInputEvent) => void): () => void
    onOutputEvent(callback: (event: OmniSpeechOutputEvent) => void): () => void
  }
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
  work: WorkAPI
  omni: OmniAPI
  ai: {
    ollamaStatus(): Promise<OllamaStatus>
    models(): Promise<AIModel[]>
    modelCatalog(query?: string): Promise<AIModel[]>
    cloudModelCatalog(provider: CloudAIProviderId, query?: AIModelCatalogQuery): Promise<AIModelCatalogResult>
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
    usage: {
      summary(query?: AIUsageQuery): Promise<AIUsageSummary>
      settings(): Promise<AIUsageSettings>
      updateSettings(settings: AIUsageSettings): Promise<AIUsageSettings>
      pricing(): Promise<ModelPricing[]>
      estimate(provider: AIProviderId, model: string, inputTokens: number, expectedOutputTokens: number): Promise<AICostEstimate>
      export(format: AIUsageExportFormat, query?: AIUsageQuery): Promise<AIUsageExportResult>
      deleteHistory(): Promise<AIUsageDeleteResult>
    }
  }
  agent: {
    approveCommand(workspaceRoot: string, command: string, reason: string): Promise<boolean>
    start(request: CodeAgentStartRequest): Promise<CodeAgentTask>
    pause(taskId: string): Promise<CodeAgentTask>
    resume(taskId: string): Promise<CodeAgentTask>
    modifyPlan(taskId: string, instruction: string): Promise<CodeAgentTask>
    skipStep(taskId: string): Promise<CodeAgentTask>
    stop(taskId: string): Promise<CodeAgentTask>
    get(taskId: string): Promise<CodeAgentTask>
    list(): Promise<CodeAgentTaskSummary[]>
    clearHistory(): Promise<void>
    setPreferences(visibility: CodeAgentVisibility, focusBehavior: CodeAgentFocusBehavior): Promise<{ visibility: CodeAgentVisibility; focusBehavior: CodeAgentFocusBehavior }>
    getPreferences(): Promise<{ visibility: CodeAgentVisibility; focusBehavior: CodeAgentFocusBehavior }>
    onTaskChanged(callback: (task: CodeAgentTaskSummary) => void): () => void
    onEvent(callback: (event: CodeAgentEvent) => void): () => void
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
    copyText(value: string): Promise<void>
    notify(title: string, body: string): Promise<void>
    onCommand(callback: (command: string, payload?: unknown) => void): () => void
  }
}
