import { contextBridge, ipcRenderer } from 'electron'

import type { OmniOverlayAPI } from '../shared/contracts'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: OmniOverlayAPI = {
  settings: {
    get: () => ipcRenderer.invoke('omni:overlay:settings')
  },
  tasks: {
    start: (input) => ipcRenderer.invoke('omni:overlay:start', input),
    pause: (taskId) => ipcRenderer.invoke('omni:overlay:pause', taskId),
    resume: (taskId) => ipcRenderer.invoke('omni:overlay:resume', taskId),
    stop: (taskId) => ipcRenderer.invoke('omni:overlay:stop', taskId),
    get: (taskId) => ipcRenderer.invoke('omni:overlay:get', taskId),
    list: () => ipcRenderer.invoke('omni:overlay:list'),
    onTaskChanged: (callback) => subscribe('omni:task-changed', callback),
    onEvent: (callback) => subscribe('omni:event', callback)
  },
  activation: {
    hide: () => ipcRenderer.invoke('omni:overlay:hide'),
    openMainWindow: () => ipcRenderer.invoke('omni:overlay:open-main')
  }
}

contextBridge.exposeInMainWorld('omniOverlay', api)
