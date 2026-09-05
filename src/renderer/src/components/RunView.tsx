import { useEffect, useState } from 'react'
import { Box, CheckCircle2, CircleAlert, ExternalLink, Play, RefreshCw, RotateCcw, Server, Square } from 'lucide-react'
import type { DevServerOption, PackageScript, ServerState, ToolInfo } from '../../../shared/contracts'

export function RunView({ root, activeFile, serverState, onRun, onRunScript, onStartServer, onStopServer, onRestartServer, onOpenServer }: {
  root: string
  activeFile?: string
  serverState: ServerState
  onRun(): void
  onRunScript(script: PackageScript): void
  onStartServer(option: DevServerOption, port?: number): void
  onStopServer(): void
  onRestartServer(): void
  onOpenServer(): void
}) {
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [scripts, setScripts] = useState<PackageScript[]>([])
  const [servers, setServers] = useState<DevServerOption[]>([])
  const [port, setPort] = useState('')
  const [loading, setLoading] = useState(true)
  const detect = async (): Promise<void> => {
    setLoading(true)
    const [nextTools, nextScripts, nextServers] = await Promise.all([window.omnicode.tools.detect(), window.omnicode.run.packageScripts(root), window.omnicode.server.detect(root)])
    setTools(nextTools); setScripts(nextScripts); setServers(nextServers); setLoading(false)
  }
  useEffect(() => { void detect() }, [root])
  return <div className="sidebar-view run-view">
    <div className="sidebar-title"><span>Run & Build</span><div className="toolbar compact"><button title="Detect tools again" onClick={() => void detect()}><RefreshCw /></button></div></div>
    <button className="run-primary" disabled={!activeFile} onClick={onRun}><Play /> Run {activeFile?.split('/').pop() ?? 'Current File'}</button>
    {serverState.running && <div className="running-server"><Server /><span><strong>{serverState.name ?? 'Development server'}</strong><small>{serverState.url ?? 'Waiting for the server URL…'}</small></span><div>{serverState.url && <button title="Open in default browser" onClick={onOpenServer}><ExternalLink /></button>}<button title="Restart server" onClick={onRestartServer}><RotateCcw /></button><button title="Stop server" onClick={onStopServer}><Square /></button></div></div>}
    <div className="section-heading"><span>Development Servers</span><span>{servers.length}</span></div>
    <div className="server-port"><label>Port <input inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value.replace(/\D/g, '').slice(0, 5))} placeholder="Auto" /></label></div>
    <div className="script-list server-list">{servers.map((option) => <button key={option.id} onClick={() => onStartServer(option, port ? Number(port) : undefined)}><Server /><span><strong>{option.name}</strong><code>{option.framework}</code></span></button>)}</div>
    {scripts.length > 0 && <><div className="section-heading"><span>Package Scripts</span><span>{scripts.length}</span></div><div className="script-list">
      {scripts.map((script) => <button key={script.name} onClick={() => onRunScript(script)}><Play /><span><strong>{script.name}</strong><code>{script.command}</code></span></button>)}
    </div></>}
    <div className="section-heading"><span>Development Tools</span><span>{tools.filter((tool) => tool.installed).length}/{tools.length}</span></div>
    <div className="tool-list">{tools.map((tool) => <div className="tool-row" key={tool.id} title={tool.guidance}>
      {tool.installed ? <CheckCircle2 className="ok" /> : <CircleAlert className="missing" />}<Box /><span><strong>{tool.name}</strong><small>{tool.installed ? tool.version || tool.path : tool.guidance}</small></span>
    </div>)}</div>
    {loading && <div className="empty-compact">Detecting local toolchains…</div>}
  </div>
}
