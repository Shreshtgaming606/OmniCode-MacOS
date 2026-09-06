import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

function send(window: BrowserWindow, command: string, payload?: unknown): void {
  window.webContents.send('app:command', command, payload)
}

export function installApplicationMenu(getWindow: () => BrowserWindow | null): void {
  const withWindow = (command: string, payload?: unknown) => (): void => {
    const window = getWindow()
    if (window) send(window, command, payload)
  }
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'OmniCode',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CommandOrControl+,', click: withWindow('settings') },
        { label: 'Setup & Install Tools…', click: withWindow('setup-tools') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CommandOrControl+O', click: withWindow('open-file') },
        { label: 'Open Folder…', accelerator: 'CommandOrControl+Shift+O', click: withWindow('open-folder') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CommandOrControl+S', click: withWindow('save') },
        { label: 'Save As…', accelerator: 'CommandOrControl+Shift+S', click: withWindow('save-as') },
        { type: 'separator' },
        { label: 'Close Editor', accelerator: 'CommandOrControl+W', click: withWindow('close-tab') }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CommandOrControl+Z', click: withWindow('editor-undo') },
        { label: 'Redo', accelerator: 'CommandOrControl+Shift+Z', click: withWindow('editor-redo') },
        { type: 'separator' }, { role: 'cut' }, { role: 'copy' },
        { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' },
        { type: 'separator' }, { label: 'Find', accelerator: 'CommandOrControl+F', click: withWindow('editor-find') },
        { label: 'Find in Workspace', accelerator: 'CommandOrControl+Shift+F', click: withWindow('workspace-search') }
      ]
    },
    {
      label: 'Selection',
      submenu: [
        { label: 'Select All', accelerator: 'CommandOrControl+A', role: 'selectAll' },
        { label: 'Expand Selection', accelerator: 'Control+Shift+Right', click: withWindow('expand-selection') },
        { label: 'Shrink Selection', accelerator: 'Control+Shift+Left', click: withWindow('shrink-selection') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette…', accelerator: 'CommandOrControl+Shift+P', click: withWindow('command-palette') },
        { label: 'Quick Open…', accelerator: 'CommandOrControl+P', click: withWindow('quick-open') },
        { type: 'separator' },
        { label: 'Toggle Primary Sidebar', accelerator: 'CommandOrControl+B', click: withWindow('toggle-sidebar') },
        { label: 'Toggle Bottom Panel', accelerator: 'CommandOrControl+J', click: withWindow('toggle-panel') },
        { label: 'Toggle AI Sidebar', accelerator: 'CommandOrControl+Option+B', click: withWindow('toggle-ai') },
        { type: 'separator' }, { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Go',
      submenu: [
        { label: 'Go to File…', accelerator: 'CommandOrControl+P', click: withWindow('quick-open') },
        { label: 'Go to Line…', accelerator: 'Control+G', click: withWindow('go-to-line') }
      ]
    },
    {
      label: 'Run',
      submenu: [
        { label: 'Run Current File', accelerator: 'Control+R', click: withWindow('run-current') },
        { type: 'separator' },
        { label: 'Start Local Server', click: withWindow('server-start') },
        { label: 'Restart Local Server', click: withWindow('server-restart') },
        { label: 'Stop Local Server', click: withWindow('server-stop') }
      ]
    },
    {
      label: 'Terminal',
      submenu: [
        { label: 'New Terminal', accelerator: 'Control+Shift+`', click: withWindow('terminal-new') },
        { label: 'Toggle Terminal', accelerator: 'CommandOrControl+`', click: withWindow('terminal-toggle') },
        { label: 'Clear Terminal', accelerator: 'CommandOrControl+K', click: withWindow('terminal-clear') },
        { label: 'Kill Active Terminal', click: withWindow('terminal-kill') }
      ]
    },
    {
      label: 'AI',
      submenu: [
        { label: 'Open AI Chat', click: withWindow('toggle-ai', true) },
        { label: 'Inline Edit…', accelerator: 'CommandOrControl+I', click: withWindow('inline-ai') },
        { label: 'Index Workspace', click: withWindow('index-workspace') },
        { type: 'separator' }, { label: 'AI Provider Settings…', click: withWindow('settings-ai') }
      ]
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
    {
      role: 'help',
      submenu: [
        { label: 'Welcome & Keyboard Shortcuts', click: withWindow('help') }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
