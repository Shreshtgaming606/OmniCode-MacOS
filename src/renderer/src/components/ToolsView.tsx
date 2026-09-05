import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, CircleAlert, Cpu, ExternalLink, RefreshCw, Wrench } from 'lucide-react'

import type { HardwareInfo, ToolInfo } from '../../../shared/contracts'

function formatMemory(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(bytes >= 16 * 1024 ** 3 ? 0 : 1)} GB`
}

function guidanceURL(value?: string): string | undefined {
  return value?.match(/https:\/\/[^\s]+/)?.[0]
}

export function ToolsView() {
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [hardware, setHardware] = useState<HardwareInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')

  const load = async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const [detected, machine] = await Promise.all([window.omnicode.tools.detect(), window.omnicode.tools.hardware()])
      setTools(detected)
      setHardware(machine)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [])
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return tools.filter((tool) => !normalized || `${tool.name} ${tool.command} ${tool.path ?? ''}`.toLowerCase().includes(normalized))
  }, [query, tools])

  return <div className="sidebar-view tools-view">
    <div className="sidebar-title"><span>Development Tools</span><div className="toolbar compact"><button disabled={loading} title="Detect tools again" onClick={() => void load()}><RefreshCw className={loading ? 'spin' : ''} /></button></div></div>
    {hardware && <div className="tools-machine"><Cpu /><span><strong>{hardware.cpuModel}</strong><small>{hardware.appleSilicon ? 'Apple Silicon' : hardware.architecture} · {hardware.logicalCores} logical cores · {formatMemory(hardware.memoryBytes)} memory{hardware.metalSupported ? ' · Metal' : ''}</small></span></div>}
    <div className="tools-search"><Wrench /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter runtimes and tools" /></div>
    <div className="tools-summary"><span>{tools.filter((tool) => tool.installed).length} detected</span><span>{tools.filter((tool) => !tool.installed).length} optional or missing</span></div>
    {error && <div className="inline-error">{error}</div>}
    <div className="tools-list">{visible.map((tool) => {
      const url = guidanceURL(tool.guidance)
      return <article className={tool.installed ? 'installed' : 'missing'} key={tool.id}>
        {tool.installed ? <CheckCircle2 /> : <CircleAlert />}
        <div><strong>{tool.name}</strong><code>{tool.path ?? tool.command}</code><small>{tool.installed ? tool.version || 'Ready to use' : tool.guidance || 'Install this only if your projects require it.'}</small></div>
        {url && <button title={`Open ${tool.name} installation information`} onClick={() => void window.omnicode.app.openExternal(url)}><ExternalLink /></button>}
      </article>
    })}</div>
    {loading && !tools.length && <div className="empty-compact">Inspecting macOS development tools…</div>}
  </div>
}

