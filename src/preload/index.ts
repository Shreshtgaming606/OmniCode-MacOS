import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AIChatRequest, AIProviderId, OllamaPullProgress, OmniCodeAPI, ServerState,
  TerminalDataEvent, TerminalExitEvent, ToolInstallationProgress
} from '../shared/contracts'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: OmniCodeAPI = {
  workspace: {
    inspectDroppedFile: (file) => {
      const path = webUtils.getPathForFile(file)
      if (!path) return Promise.reject(new Error('Only files selected through macOS can be dropped into OmniCode.'))
      return ipcRenderer.invoke('workspace:inspect-dropped', path)
    },
    selectFolder: () => ipcRenderer.invoke('workspace:select-folder'),
    selectDestinationFolder: () => ipcRenderer.invoke('workspace:select-destination'),
    selectFile: () => ipcRenderer.invoke('workspace:select-file'),
    recentWorkspaces: () => ipcRenderer.invoke('workspace:recent'),
    reopenWorkspace: (path) => ipcRenderer.invoke('workspace:reopen', path),
    createProject: (parent, name) => ipcRenderer.invoke('workspace:create-project', parent, name),
    readTree: (root) => ipcRenderer.invoke('workspace:read-tree', root),
    readFile: (path) => ipcRenderer.invoke('workspace:read-file', path),
    writeFile: (path, content, expectedModifiedAt) => ipcRenderer.invoke('workspace:write-file', path, content, expectedModifiedAt),
    saveAs: (content, suggestedPath) => ipcRenderer.invoke('workspace:save-as', content, suggestedPath),
    createEntry: (parent, name, kind) => ipcRenderer.invoke('workspace:create-entry', parent, name, kind),
    renameEntry: (path, newName) => ipcRenderer.invoke('workspace:rename-entry', path, newName),
    moveEntry: (source, destinationDirectory) => ipcRenderer.invoke('workspace:move-entry', source, destinationDirectory),
    duplicateEntry: (path) => ipcRenderer.invoke('workspace:duplicate-entry', path),
    trashEntry: (path) => ipcRenderer.invoke('workspace:trash-entry', path),
    revealInFinder: (path) => ipcRenderer.invoke('workspace:reveal', path),
    copyPath: (path) => ipcRenderer.invoke('workspace:copy-path', path),
    openExternal: (path) => ipcRenderer.invoke('workspace:open-external', path),
    openWith: (path) => ipcRenderer.invoke('workspace:open-with', path),
    search: (root, query, options) => ipcRenderer.invoke('workspace:search', root, query, options),
    replaceAll: (root, query, replacement, options) => ipcRenderer.invoke('workspace:replace-all', root, query, replacement, options),
    watch: (root) => ipcRenderer.invoke('workspace:watch', root),
    unwatch: () => ipcRenderer.invoke('workspace:unwatch'),
    onChanged: (callback) => subscribe<string>('workspace:changed', callback)
  },
  terminal: {
    create: (options) => ipcRenderer.invoke('terminal:create', options),
    write: (id, data) => ipcRenderer.send('terminal:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('terminal:resize', id, cols, rows),
    kill: (id) => ipcRenderer.invoke('terminal:kill', id),
    restart: (id) => ipcRenderer.invoke('terminal:restart', id),
    listShells: () => ipcRenderer.invoke('terminal:list-shells'),
    onData: (callback) => subscribe<TerminalDataEvent>('terminal:data', callback),
    onExit: (callback) => subscribe<TerminalExitEvent>('terminal:exit', callback)
  },
  diff: {
    propose: (request) => ipcRenderer.invoke('diff:propose', request),
    get: (proposalId) => ipcRenderer.invoke('diff:get', proposalId),
    accept: (proposalId, target) => ipcRenderer.invoke('diff:accept', proposalId, target),
    reject: (proposalId, target) => ipcRenderer.invoke('diff:reject', proposalId, target),
    undo: (proposalId) => ipcRenderer.invoke('diff:undo', proposalId),
    discard: (proposalId) => ipcRenderer.invoke('diff:discard', proposalId),
    onChanged: (callback) => subscribe('diff:changed', callback)
  },
  tools: {
    detect: () => ipcRenderer.invoke('tools:detect'),
    hardware: () => ipcRenderer.invoke('tools:hardware'),
    install: (toolId) => ipcRenderer.invoke('tools:install', toolId),
    installations: () => ipcRenderer.invoke('tools:installations'),
    cancelInstallation: (toolId) => ipcRenderer.invoke('tools:cancel-installation', toolId),
    onInstallationProgress: (callback) => subscribe<ToolInstallationProgress>('tools:installation-progress', callback)
  },
  run: {
    resolve: (filePath, workspacePath) => ipcRenderer.invoke('run:resolve', filePath, workspacePath),
    packageScripts: (workspacePath) => ipcRenderer.invoke('run:package-scripts', workspacePath)
  },
  server: {
    detect: (root) => ipcRenderer.invoke('server:detect', root),
    start: (root, port) => ipcRenderer.invoke('server:start', root, port),
    startProject: (root, script, port) => ipcRenderer.invoke('server:start-project', root, script, port),
    stop: () => ipcRenderer.invoke('server:stop'),
    state: () => ipcRenderer.invoke('server:state'),
    open: () => ipcRenderer.invoke('server:open'),
    onState: (callback) => subscribe<ServerState>('server:state-changed', callback),
    onLog: (callback) => subscribe<string>('server:log', callback)
  },
  git: {
    status: (root) => ipcRenderer.invoke('git:status', root),
    diff: (root, path, staged) => ipcRenderer.invoke('git:diff', root, path, staged),
    stage: (root, paths) => ipcRenderer.invoke('git:stage', root, paths),
    unstage: (root, paths) => ipcRenderer.invoke('git:unstage', root, paths),
    commit: (root, message) => ipcRenderer.invoke('git:commit', root, message),
    operation: (root, operation) => ipcRenderer.invoke('git:operation', root, operation),
    branches: (root) => ipcRenderer.invoke('git:branches', root),
    switchBranch: (root, name, create) => ipcRenderer.invoke('git:switch-branch', root, name, create),
    deleteBranch: (root, name, force) => ipcRenderer.invoke('git:delete-branch', root, name, force),
    clone: (destinationParent, repositoryUrl) => ipcRenderer.invoke('git:clone', destinationParent, repositoryUrl)
  },
  ai: {
    ollamaStatus: () => ipcRenderer.invoke('ai:ollama-status'),
    models: () => ipcRenderer.invoke('ai:models'),
    modelCatalog: (query) => ipcRenderer.invoke('ai:model-catalog', query),
    modelPreferences: () => ipcRenderer.invoke('ai:model-preferences'),
    selectModel: (model, makeDefault) => ipcRenderer.invoke('ai:select-model', model, makeDefault),
    pullModel: (model) => ipcRenderer.invoke('ai:pull-model', model),
    modelPulls: () => ipcRenderer.invoke('ai:model-pulls'),
    cancelModelPull: (model) => ipcRenderer.invoke('ai:cancel-model-pull', model),
    loadModel: (model) => ipcRenderer.invoke('ai:load-model', model),
    unloadModel: (model) => ipcRenderer.invoke('ai:unload-model', model),
    deleteModel: (model) => ipcRenderer.invoke('ai:delete-model', model),
    onModelPullProgress: (callback) => subscribe<OllamaPullProgress>('ai:model-pull-progress', callback),
    chat: (request: AIChatRequest) => ipcRenderer.invoke('ai:chat', request),
    setCredential: (provider: Exclude<AIProviderId, 'ollama'>, apiKey: string) => ipcRenderer.invoke('ai:set-credential', provider, apiKey),
    hasCredential: (provider: Exclude<AIProviderId, 'ollama'>) => ipcRenderer.invoke('ai:has-credential', provider),
    testProviderConnection: (provider: Exclude<AIProviderId, 'ollama'>) => ipcRenderer.invoke('ai:test-provider-connection', provider),
    deleteCredential: (provider: Exclude<AIProviderId, 'ollama'>) => ipcRenderer.invoke('ai:delete-credential', provider),
    index: (root) => ipcRenderer.invoke('ai:index', root),
    contextPreview: (root, query) => ipcRenderer.invoke('ai:context-preview', root, query)
  },
  agent: {
    approveCommand: (workspaceRoot, command, reason) => ipcRenderer.invoke('agent:approve-command', workspaceRoot, command, reason)
  },
  settings: {
    read: (root) => ipcRenderer.invoke('settings:read', root),
    write: (root, settings) => ipcRenderer.invoke('settings:write', root, settings)
  },
  app: {
    platform: process.platform,
    version: () => ipcRenderer.invoke('app:version'),
    ready: () => ipcRenderer.invoke('app:renderer-ready'),
    closeWindow: () => ipcRenderer.invoke('app:close-window'),
    cancelClose: () => ipcRenderer.invoke('app:cancel-close'),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
    notify: (title, body) => ipcRenderer.invoke('app:notify', title, body),
    onCommand: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, command: string, payload?: unknown): void => callback(command, payload)
      ipcRenderer.on('app:command', listener)
      return () => ipcRenderer.removeListener('app:command', listener)
    }
  }
}

contextBridge.exposeInMainWorld('omnicode', api)
