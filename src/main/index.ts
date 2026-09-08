import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, session, shell } from 'electron'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { installApplicationMenu } from './menu'
import { FileSystemManager, isPathInside } from './services/filesystem-manager'
import { TerminalManager } from './services/terminal-manager'
import { RunManager } from './services/run-manager'
import { DevServerManager } from './services/dev-server-manager'
import { GitManager } from './services/git-manager'
import { CredentialManager } from './services/credential-manager'
import { WorkspaceIndexer } from './services/workspace-indexer'
import { AIManager } from './services/ai-manager'
import { DiffManager } from './services/diff-manager'
import { SettingsManager } from './services/settings-manager'
import { WorkspaceHistoryManager } from './services/workspace-history-manager'
import { RUNTIME_TOOL_DEFINITIONS, detectHardware, detectTools } from './services/runtime-manager'
import { RuntimeInstaller, installationPlanFor, runtimeToolId } from './services/runtime-installer'
import { validateAgentCommand } from './services/agent-command-policy'
import { DiagnosticLogger } from './services/diagnostic-logger'

let mainWindow: BrowserWindow | null = null
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()
let rendererReady = false
let quitRequested = false
let closeAfterSave: 'window' | 'quit' | null = null
let finalCleanupStarted = false
const pendingOpenPaths: Array<{ path: string; kind: 'file' | 'directory' }> = []
let pendingDestinationRoot: string | null = null
let pendingDestinationExpiresAt = 0
const fileSystem = new FileSystemManager()
const diffs = new DiffManager(fileSystem)
const terminals = new TerminalManager()
const runner = new RunManager()
const server = new DevServerManager()
const git = new GitManager()
const credentials = new CredentialManager()
const indexer = new WorkspaceIndexer()
const ai = new AIManager(credentials, indexer, detectHardware, {
  settingsPath: path.join(app.getPath('userData'), 'ai-model-preferences.json')
})
const settings = new SettingsManager()
const workspaceHistory = new WorkspaceHistoryManager(path.join(app.getPath('userData'), 'recent-workspaces.json'))
const diagnostics = new DiagnosticLogger(path.join(app.getPath('userData'), 'logs'))
const runtimeInstaller = new RuntimeInstaller({
  openPath: (target) => shell.openPath(target)
})
runtimeInstaller.setProgressListener((progress) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tools:installation-progress', progress)
  }
})

function assertCurrentWorkspace(root: string): string {
  const current = fileSystem.getWorkspace()
  if (!current || path.resolve(root) !== path.resolve(current)) throw new Error('Workspace settings are limited to the currently open folder.')
  return current
}

function assertWorkspacePath(target: string): string {
  const current = fileSystem.getWorkspace()
  if (!current) throw new Error('Open a workspace first.')
  const safe = fileSystem.resolveAuthorizedPath(target)
  if (!isPathInside(current, safe)) throw new Error('This action is limited to the current workspace.')
  return safe
}

function consumeDestination(target: string): string {
  const resolved = path.resolve(target)
  if (!pendingDestinationRoot || Date.now() > pendingDestinationExpiresAt || resolved !== pendingDestinationRoot) {
    pendingDestinationRoot = null
    pendingDestinationExpiresAt = 0
    throw new Error('Choose the destination folder through the macOS folder picker.')
  }
  pendingDestinationRoot = null
  pendingDestinationExpiresAt = 0
  return resolved
}

function isTrustedRendererUrl(value: string): boolean {
  try {
    const candidate = new URL(value)
    if (process.env.ELECTRON_RENDERER_URL) {
      const development = new URL(process.env.ELECTRON_RENDERER_URL)
      return candidate.origin === development.origin && candidate.pathname === development.pathname
    }
    if (candidate.protocol !== 'file:') return false
    const rendererPath = path.resolve(__dirname, '../renderer/index.html')
    return path.resolve(decodeURIComponent(candidate.pathname)) === rendererPath
  } catch {
    return false
  }
}

function assertTrustedSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): void {
  const senderFrame = event.senderFrame
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    !senderFrame ||
    senderFrame !== event.sender.mainFrame ||
    !isTrustedRendererUrl(senderFrame.url)
  ) {
    throw new Error('OmniCode blocked an IPC request from an untrusted page or frame.')
  }
}

function handle(
  channel: string,
  listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      assertTrustedSender(event)
      return await listener(event, ...args)
    } catch (error) {
      await diagnostics.failure(channel, error).catch(() => undefined)
      throw error
    }
  })
}

function createWindow(): void {
  rendererReady = false
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'OmniCode',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#18191c' : '#f5f5f6',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame && isTrustedRendererUrl(url)) rendererReady = false
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault()
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    void diagnostics.failure('renderer:process-gone', new Error(`${details.reason}; exit code ${details.exitCode}`)).catch(() => undefined)
  })
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    if (!mainWindow) return
    const response = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Save All', 'Discard Changes', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      message: 'Save your changes before closing OmniCode?',
      detail: 'One or more editor tabs contain changes that have not been saved.'
    })
    if (response === 0) {
      closeAfterSave = quitRequested ? 'quit' : 'window'
      mainWindow.webContents.send('app:command', 'save-all-and-close')
    }
    if (response === 1) event.preventDefault()
    if (response === 2) {
      quitRequested = false
      closeAfterSave = null
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  mainWindow.on('closed', () => {
    terminals.shutdown()
    if (!quitRequested) {
      void server.stop()
      void fileSystem.unwatch()
    }
    mainWindow = null
    rendererReady = false
  })
}

async function openPathFromFinder(target: string): Promise<void> {
  const stats = await fs.stat(target)
  let payload: { path: string; kind: 'file' | 'directory' }
  if (stats.isDirectory()) {
    const root = await fs.realpath(target)
    await workspaceHistory.add(root)
    payload = { path: root, kind: 'directory' }
  } else if (stats.isFile()) payload = { path: fileSystem.authorizeFile(target), kind: 'file' }
  else throw new Error('Only files and folders can be opened.')
  if (mainWindow && rendererReady) {
    mainWindow.webContents.send('app:command', 'open-path', payload)
    mainWindow.show()
    mainWindow.focus()
  } else {
    pendingOpenPaths.push(payload)
  }
}

async function openLaunchArguments(argumentsList: string[]): Promise<void> {
  if (!app.isPackaged) return
  for (const candidate of argumentsList.slice(1).filter((value) => !value.startsWith('-')).slice(0, 20)) {
    const target = path.resolve(candidate)
    try {
      await openPathFromFinder(target)
      return
    } catch { /* command-line arguments that are not existing files are ignored */ }
  }
}

function registerIpc(): void {
  handle('app:version', () => app.getVersion())
  handle('app:renderer-ready', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return
    rendererReady = true
    const pending = pendingOpenPaths.splice(0)
    for (const target of pending) mainWindow.webContents.send('app:command', 'open-path', target)
    return pending.length
  })
  handle('app:close-window', (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner || owner !== mainWindow) return
    const action = closeAfterSave
    closeAfterSave = null
    if (action === 'quit') app.quit()
    else owner.close()
  })
  handle('app:cancel-close', () => {
    closeAfterSave = null
    quitRequested = false
  })
  handle('app:open-external', async (_event, value: string) => {
    const url = new URL(value)
    if (url.protocol !== 'https:') throw new Error('OmniCode opens only secure external links.')
    await shell.openExternal(url.toString())
  })
  handle('app:notify', (_event, title: string, body: string) => {
    if (typeof title !== 'string' || typeof body !== 'string' || !title.trim() || title.length > 120 || body.length > 500) {
      throw new Error('The notification content is invalid or too long.')
    }
    if (Notification.isSupported()) new Notification({ title: title.trim(), body: body.trim() }).show()
  })
  handle('workspace:select-folder', async () => {
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const root = await fs.realpath(result.filePaths[0])
    if (!(await fs.stat(root)).isDirectory()) throw new Error('Choose a folder to open as a workspace.')
    await workspaceHistory.add(root)
    return root
  })
  handle('workspace:select-destination', async () => {
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const selected = await fs.realpath(result.filePaths[0])
    if (!(await fs.stat(selected)).isDirectory()) throw new Error('Choose a destination folder.')
    pendingDestinationRoot = selected
    pendingDestinationExpiresAt = Date.now() + 5 * 60_000
    return selected
  })
  handle('workspace:select-file', async () => {
    const options: Electron.OpenDialogOptions = { properties: ['openFile'] }
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    return fileSystem.authorizeFile(result.filePaths[0])
  })
  handle('workspace:recent', () => workspaceHistory.list())
  handle('workspace:reopen', async (_event, root: string) => {
    const authorized = await workspaceHistory.authorize(root)
    const opened = fileSystem.setWorkspace(authorized)
    await workspaceHistory.add(opened)
    return opened
  })
  handle('workspace:create-project', async (_event, selectedParent: string, name: string) => {
    const parent = consumeDestination(selectedParent)
    if (!name.trim() || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) throw new Error('Enter a valid project folder name.')
    const project = path.join(parent, name.trim())
    if (!isPathInside(parent, project) || project === parent) throw new Error('The project folder must be inside the selected destination.')
    await fs.mkdir(project)
    const opened = fileSystem.setWorkspace(project)
    await workspaceHistory.add(opened)
    return opened
  })
  handle('workspace:inspect-dropped', async (_event, target: string) => {
    const stats = await fs.stat(target)
    if (stats.isDirectory()) {
      const root = await fs.realpath(target)
      await workspaceHistory.add(root)
      return { path: root, kind: 'directory' }
    }
    if (stats.isFile()) {
      return { path: fileSystem.authorizeFile(target), kind: 'file' }
    }
    throw new Error('Only files and folders can be opened.')
  })
  handle('workspace:read-tree', (_event, root: string) => fileSystem.readTree(root))
  handle('workspace:read-file', (_event, target: string) => fileSystem.readFile(target))
  handle('workspace:write-file', (_event, target: string, content: string, expectedModifiedAt?: number) => fileSystem.writeFile(target, content, expectedModifiedAt))
  handle('workspace:save-as', async (_event, content: string, suggestedPath?: string) => {
    const options: Electron.SaveDialogOptions = {
      defaultPath: suggestedPath,
      properties: ['createDirectory', 'showOverwriteConfirmation']
    }
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    fileSystem.authorizeFile(result.filePath)
    await fileSystem.writeFile(result.filePath, content)
    return result.filePath
  })
  handle('workspace:create-entry', (_event, parent: string, name: string, kind: 'file' | 'directory') => fileSystem.createEntry(parent, name, kind))
  handle('workspace:rename-entry', (_event, target: string, name: string) => fileSystem.renameEntry(target, name))
  handle('workspace:move-entry', (_event, source: string, destination: string) => fileSystem.moveEntry(source, destination))
  handle('workspace:duplicate-entry', (_event, target: string) => fileSystem.duplicateEntry(target))
  handle('workspace:trash-entry', (_event, target: string) => fileSystem.trashEntry(target))
  handle('workspace:reveal', (_event, target: string) => fileSystem.revealInFinder(target))
  handle('workspace:copy-path', (_event, target: string) => fileSystem.copyPath(target))
  handle('workspace:open-external', (_event, target: string) => fileSystem.openExternal(target))
  handle('workspace:open-with', async (_event, target: string) => {
    const options: Electron.OpenDialogOptions = {
      title: 'Open With',
      defaultPath: '/Applications',
      properties: ['openFile'],
      filters: [{ name: 'Applications', extensions: ['app'] }]
    }
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    if (!result.canceled && result.filePaths[0]) await fileSystem.openWith(target, result.filePaths[0])
  })
  handle('workspace:search', (_event, root: string, query: string, options) => fileSystem.search(root, query, options))
  handle('workspace:replace-all', (_event, root: string, query: string, replacement: string, options) => fileSystem.replaceAll(root, query, replacement, options))
  handle('workspace:watch', async (_event, root: string) => fileSystem.watch(root, (target) => mainWindow?.webContents.send('workspace:changed', target)))
  handle('workspace:unwatch', () => fileSystem.unwatch())

  handle('diff:propose', (_event, request) => diffs.propose(request))
  handle('diff:get', (_event, proposalId: string) => diffs.get(proposalId))
  handle('diff:accept', (_event, proposalId: string, target) => diffs.accept(proposalId, target))
  handle('diff:reject', (_event, proposalId: string, target) => diffs.reject(proposalId, target))
  handle('diff:undo', (_event, proposalId: string) => diffs.undo(proposalId))
  handle('diff:discard', (_event, proposalId: string) => diffs.discard(proposalId))
  diffs.on('changed', (proposal) => mainWindow?.webContents.send('diff:changed', proposal))

  handle('terminal:create', (_event, options) => terminals.create({ ...options, cwd: assertWorkspacePath(options.cwd) }))
  ipcMain.on('terminal:write', (event, id: string, data: string) => {
    try {
      assertTrustedSender(event)
      terminals.write(id, data)
    } catch {
      // Terminal input is fire-and-forget. A stale session/input race must not
      // become an uncaught exception in the main process.
    }
  })
  ipcMain.on('terminal:resize', (event, id: string, cols: number, rows: number) => {
    try {
      assertTrustedSender(event)
      terminals.resize(id, cols, rows)
    } catch {
      // A resize can arrive after a PTY exits; it is safe to ignore.
    }
  })
  handle('terminal:kill', (_event, id: string) => terminals.kill(id))
  handle('terminal:restart', (_event, id: string) => terminals.restart(id))
  handle('terminal:list-shells', () => terminals.listShells())
  terminals.on('data', (payload) => mainWindow?.webContents.send('terminal:data', payload))
  terminals.on('exit', (payload) => mainWindow?.webContents.send('terminal:exit', payload))

  handle('tools:detect', () => detectTools())
  handle('tools:hardware', () => detectHardware())
  handle('tools:installations', () => runtimeInstaller.installations())
  handle('tools:cancel-installation', (_event, toolId: string) => runtimeInstaller.cancel(toolId))
  handle('tools:install', async (event, value: unknown) => {
    const toolId = runtimeToolId(value)
    const definition = RUNTIME_TOOL_DEFINITIONS.find((tool) => tool.id === toolId)
    const plan = installationPlanFor(toolId)
    if (!definition || !plan) throw new Error('This development tool does not have an in-app installer.')
    const detail = plan.kind === 'xcode-command-line-tools'
      ? 'OmniCode will ask macOS to open Apple’s Command Line Tools installer. macOS handles the download, license, and administrator approval.'
      : plan.kind === 'homebrew-installer'
        ? 'OmniCode will download the official Homebrew.pkg release over HTTPS and open it with the macOS Installer. You remain in control of administrator approval.'
        : toolId === 'ollama'
          ? 'OmniCode will download Ollama if needed, then start its local AI service. If Homebrew is unavailable, it downloads the official macOS app for you to install.'
          : `OmniCode will download ${definition.name} and its dependencies through Homebrew. ${plan.cask ? 'The downloaded installer opens in macOS to finish installation.' : 'Installation progress appears here.'} If Homebrew is missing, OmniCode first downloads its macOS installer. macOS may ask for administrator approval.`
    const owner = BrowserWindow.fromWebContents(event.sender)
    const response = owner
      ? await dialog.showMessageBox(owner, {
          type: 'question',
          buttons: ['Install', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
          message: `Install ${definition.name}?`,
          detail
        })
      : await dialog.showMessageBox({
          type: 'question',
          buttons: ['Install', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
          message: `Install ${definition.name}?`,
          detail
        })
    if (response.response !== 0) return { toolId, installed: false, cancelled: true }
    return runtimeInstaller.install(toolId)
  })
  handle('run:resolve', (_event, filePath: string, workspacePath: string) => runner.resolve(assertWorkspacePath(filePath), assertCurrentWorkspace(workspacePath)))
  handle('run:package-scripts', (_event, workspacePath: string) => runner.packageScripts(assertCurrentWorkspace(workspacePath)))

  handle('server:detect', (_event, root: string) => server.detect(assertCurrentWorkspace(root)))
  handle('server:start', (_event, root: string, port?: number) => server.start(assertCurrentWorkspace(root), port))
  handle('server:start-project', (_event, root: string, script: string, port?: number) => server.startProject(assertCurrentWorkspace(root), script, port))
  handle('server:stop', () => server.stop())
  handle('server:state', () => server.state())
  handle('server:open', () => server.open())
  server.setStateListener((state) => mainWindow?.webContents.send('server:state-changed', state))
  server.setLogListener((line) => mainWindow?.webContents.send('server:log', line))

  handle('git:status', (_event, root: string) => git.status(assertCurrentWorkspace(root)))
  handle('git:diff', (_event, root: string, target?: string, staged?: boolean) => git.diff(assertCurrentWorkspace(root), target, staged))
  handle('git:stage', (_event, root: string, paths: string[]) => git.stage(assertCurrentWorkspace(root), paths))
  handle('git:unstage', (_event, root: string, paths: string[]) => git.unstage(assertCurrentWorkspace(root), paths))
  handle('git:commit', (_event, root: string, message: string) => git.commit(assertCurrentWorkspace(root), message))
  handle('git:operation', (_event, root: string, operation) => git.operation(assertCurrentWorkspace(root), operation))
  handle('git:branches', (_event, root: string) => git.branches(assertCurrentWorkspace(root)))
  handle('git:switch-branch', (_event, root: string, name: string, create?: boolean) => git.switchBranch(assertCurrentWorkspace(root), name, create))
  handle('git:delete-branch', (_event, root: string, name: string, force?: boolean) => git.deleteBranch(assertCurrentWorkspace(root), name, force))
  handle('git:clone', async (_event, destinationParent: string, repositoryUrl: string) => {
    const cloned = await git.clone(consumeDestination(destinationParent), repositoryUrl)
    const opened = fileSystem.setWorkspace(cloned)
    await workspaceHistory.add(opened)
    return opened
  })

  handle('ai:ollama-status', () => ai.ollamaStatus())
  handle('ai:models', () => ai.models())
  handle('ai:model-catalog', (_event, query?: string) => ai.modelCatalog(query))
  handle('ai:model-preferences', () => ai.modelPreferences())
  handle('ai:select-model', (_event, model: string, makeDefault?: boolean) => ai.selectModel(model, makeDefault))
  handle('ai:model-pulls', () => ai.modelPulls())
  handle('ai:pull-model', async (event, model: string) => {
    const catalog = await ai.modelCatalog()
    const selected = catalog.find((item) => item.id === model && item.catalog)
    if (!selected) throw new Error('Choose a model from OmniCode’s curated local catalog.')
    const size = selected.approximateDownloadSize
      ? selected.approximateDownloadSize >= 1024 ** 3
        ? `${(selected.approximateDownloadSize / 1024 ** 3).toFixed(1)} GB`
        : `${Math.round(selected.approximateDownloadSize / 1024 ** 2)} MB`
      : 'an unknown amount of data'
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      buttons: ['Download Model', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      message: `Download ${selected.name}?`,
      detail: `Ollama will download approximately ${size} and store the model locally in your user account. Hardware guidance: ${selected.recommendation ?? 'compatibility unknown'}.`
    }
    const response = owner
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options)
    if (response.response !== 0) return { model, cancelled: true }
    return ai.pullModel(model, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('ai:model-pull-progress', progress)
    })
  })
  handle('ai:cancel-model-pull', (_event, model: string) => ai.cancelModelPull(model))
  handle('ai:load-model', (_event, model: string) => ai.loadModel(model))
  handle('ai:unload-model', (_event, model: string) => ai.unloadModel(model))
  handle('ai:delete-model', async (event, model: string) => {
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['Delete Model', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message: `Delete ${model}?`,
      detail: 'The local model files will be removed from Ollama. You can download the model again later.'
    }
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = owner
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options)
    if (result.response !== 0) return false
    await ai.deleteModel(model)
    return true
  })
  handle('ai:chat', (_event, request) => ai.chat({
    ...request,
    workspacePath: request.workspacePath ? assertCurrentWorkspace(request.workspacePath) : undefined,
    attachedPaths: Array.isArray(request.attachedPaths) ? request.attachedPaths.map((target: string) => fileSystem.resolveAuthorizedPath(target)) : undefined
  }))
  handle('ai:set-credential', (_event, provider, apiKey: string) => ai.setCredential(provider, apiKey))
  handle('ai:has-credential', (_event, provider) => ai.hasCredential(provider))
  handle('ai:test-provider-connection', (_event, provider) => ai.testProviderConnection(provider))
  handle('ai:delete-credential', (_event, provider) => ai.deleteCredential(provider))
  handle('ai:index', (_event, root: string) => ai.index(assertCurrentWorkspace(root)))
  handle('ai:context-preview', (_event, root: string, query: string) => ai.contextPreview(assertCurrentWorkspace(root), query))
  handle('agent:approve-command', async (event, workspaceRoot: string, command: string, reason: string) => {
    assertCurrentWorkspace(workspaceRoot)
    const validated = validateAgentCommand(command, reason)
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['Run Command', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message: 'Run this AI Agent command?',
      detail: `${validated.command}\n\nReason: ${validated.reason}\n\nThe command will run inside the current workspace with your normal macOS user permissions.`
    }
    const owner = BrowserWindow.fromWebContents(event.sender)
    const response = owner
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options)
    return response.response === 0
  })
  handle('settings:read', (_event, root: string) => settings.read(assertCurrentWorkspace(root)))
  handle('settings:write', (_event, root: string, value) => settings.write(assertCurrentWorkspace(root), value))
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return
  app.setName('OmniCode')
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  registerIpc()
  createWindow()
  void diagnostics.lifecycle('ready', `OmniCode ${app.getVersion()} started on ${process.platform}/${process.arch}.`).catch(() => undefined)
  void openLaunchArguments(process.argv)
  installApplicationMenu(() => mainWindow)
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('second-instance', (_event, argv) => {
  void openLaunchArguments(argv)
  mainWindow?.show()
  mainWindow?.focus()
})

app.on('open-file', (event, target) => {
  event.preventDefault()
  void openPathFromFinder(target).catch(() => undefined)
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => {
  quitRequested = true
})

app.on('will-quit', (event) => {
  if (finalCleanupStarted) return
  event.preventDefault()
  finalCleanupStarted = true
  ai.shutdown()
  runtimeInstaller.shutdown()
  terminals.shutdown()
  void Promise.allSettled([
    server.stop(),
    fileSystem.unwatch(),
    diagnostics.lifecycle('shutdown', 'OmniCode completed its shutdown sequence.')
  ]).finally(() => app.exit(0))
})
