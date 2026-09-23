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
    openMainWindow: () => ipcRenderer.invoke('omni:overlay:open-main'),
    onShow: (callback) => subscribe('omni:overlay-activated', callback)
  },
  permissions: {
    status: () => ipcRenderer.invoke('omni:overlay:permissions-status'),
    request: (permissionId) => ipcRenderer.invoke('omni:overlay:permissions-request', permissionId),
    openSettings: (permissionId) => ipcRenderer.invoke('omni:overlay:permissions-open-settings', permissionId),
    onChanged: (callback) => subscribe('omni:permissions-changed', callback)
  },
  voice: {
    inputAvailability: () => ipcRenderer.invoke('omni:overlay:voice-input-availability'),
    startInput: (options) => ipcRenderer.invoke('omni:overlay:voice-start-input', options),
    stopInput: (sessionId) => ipcRenderer.invoke('omni:overlay:voice-stop-input', sessionId),
    cancelInput: (sessionId) => ipcRenderer.invoke('omni:overlay:voice-cancel-input', sessionId),
    stop: () => ipcRenderer.invoke('omni:overlay:voice-stop'),
    onInputEvent: (callback) => subscribe('omni:voice-input-event', callback),
    onOutputEvent: (callback) => subscribe('omni:voice-output-event', callback)
  }
}

contextBridge.exposeInMainWorld('omniOverlay', api)
