import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Box,
  Check,
  CircleAlert,
  Code2,
  Cpu,
  Database,
  Download,
  HardDrive,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  Trash2,
  Wrench,
  X
} from 'lucide-react'

import type {
  AIModel,
  AIModelPreferences,
  HardwareInfo,
  OllamaPullProgress,
  OllamaStatus
} from '../../../shared/contracts'

function formatBytes(value?: number): string {
  if (value === undefined) return 'Size unknown'
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(0)} MB`
  return `${(value / 1024 ** 3).toFixed(1)} GB`
}

function formatContext(value?: number): string {
  if (!value) return 'Context unknown'
  return value >= 1024 ? `${Math.round(value / 1024)}K context` : `${value} context`
}

function recommendationClass(value: AIModel['recommendation']): string {
  return value?.toLowerCase().replaceAll(' ', '-') ?? ''
}

function matches(model: AIModel, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return [
    model.id,
    model.name,
    model.description,
    model.parameterSize,
    model.family,
    model.codingCapability,
    ...(model.capabilities ?? [])
  ].filter(Boolean).join(' ').toLowerCase().includes(normalized)
}

export function ModelsView() {
  const [catalog, setCatalog] = useState<AIModel[]>([])
  const [hardware, setHardware] = useState<HardwareInfo | null>(null)
  const [ollama, setOllama] = useState<OllamaStatus | null>(null)
  const [pulls, setPulls] = useState<Record<string, OllamaPullProgress>>({})
  const [operations, setOperations] = useState<Record<string, string>>({})
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const [nextCatalog, nextHardware, nextOllama, activePulls] = await Promise.all([
        window.omnicode.ai.modelCatalog(),
        window.omnicode.tools.hardware(),
        window.omnicode.ai.ollamaStatus(),
        window.omnicode.ai.modelPulls()
      ])
      setCatalog(nextCatalog)
      setHardware(nextHardware)
      setOllama(nextOllama)
      setPulls((current) => {
        const next = Object.fromEntries(activePulls.map((progress) => [progress.model, progress]))
        for (const [model, progress] of Object.entries(current)) {
          if (!progress.done) next[model] = progress
        }
        return next
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.omnicode.ai.onModelPullProgress((progress) => {
      setPulls((current) => ({ ...current, [progress.model]: progress }))
    })
    void load()
    return unsubscribe
  }, [load])

  const visibleModels = useMemo(
    () => catalog.filter((model) => matches(model, query)),
    [catalog, query]
  )
  const installedModels = visibleModels.filter((model) => model.installed)
  const availableModels = visibleModels.filter((model) => !model.installed)

  const setOperation = (model: string, operation?: string): void => {
    setOperations((current) => {
      const next = { ...current }
      if (operation) next[model] = operation
      else delete next[model]
      return next
    })
  }

  const pullModel = async (model: AIModel): Promise<void> => {
    setError('')
    setOperation(model.id, 'Downloading')
    try {
      const result = await window.omnicode.ai.pullModel(model.id)
      await load()
      if (!result.cancelled) await window.omnicode.app.notify('Model ready', `${model.name} finished downloading.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setOperation(model.id)
    }
  }

  const cancelPull = async (model: string): Promise<void> => {
    try {
      await window.omnicode.ai.cancelModelPull(model)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const applyPreferences = (preferences: AIModelPreferences): void => {
    setCatalog((current) => current.map((model) => ({
      ...model,
      selected: model.id === preferences.selectedModel,
      isDefault: model.id === preferences.defaultModel
    })))
  }

  const selectModel = async (model: AIModel, makeDefault: boolean): Promise<void> => {
    setError('')
    setOperation(model.id, makeDefault ? 'Setting default' : 'Selecting')
    try {
      applyPreferences(await window.omnicode.ai.selectModel(model.id, makeDefault))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setOperation(model.id)
    }
  }

  const deleteModel = async (model: AIModel): Promise<void> => {
    setError('')
    setOperation(model.id, 'Deleting')
    try {
      const deleted = await window.omnicode.ai.deleteModel(model.id)
      if (deleted) await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setOperation(model.id)
    }
  }

  const setLoaded = async (model: AIModel, loaded: boolean): Promise<void> => {
    setError('')
    setOperation(model.id, loaded ? 'Loading into memory' : 'Unloading from memory')
    try {
      if (loaded) await window.omnicode.ai.loadModel(model.id)
      else await window.omnicode.ai.unloadModel(model.id)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setOperation(model.id)
    }
  }

  const renderModel = (model: AIModel) => {
    const progress = pulls[model.id]
    const busy = Boolean(operations[model.id]) || Boolean(progress && !progress.done)
    const shownSize = model.installed ? model.size : model.approximateDownloadSize
    return <article className={`model-card ${model.installed ? 'installed' : ''}`} key={model.id}>
      <div className="model-card__heading">
        <span className="model-card__icon"><Box /></span>
        <div>
          <strong>{model.name}</strong>
          <code>{model.id}</code>
        </div>
        <div className="model-card__badges">
          {model.isDefault && <span className="model-badge default"><Star />Default</span>}
          {model.selected && <span className="model-badge selected"><Check />Selected</span>}
          {model.loaded && <span className="model-badge loaded"><Power />Loaded{model.loadedSize ? ` · ${formatBytes(model.loadedSize)}` : ''}</span>}
          <span className={`model-badge ${model.installed ? 'local' : ''}`}>
            {model.installed ? 'Installed' : 'Local download'}
          </span>
        </div>
      </div>

      {model.description && <p>{model.description}</p>}
      <div className="model-metadata">
        <span><Code2 />{model.parameterSize ?? 'Parameters unknown'}</span>
        <span><HardDrive />{formatBytes(shownSize)}</span>
        <span>{formatContext(model.contextWindow)}</span>
        <span><Wrench />{model.toolUse ? 'Tool use' : 'No tool use metadata'}</span>
      </div>
      <div className="model-card__footer">
        <span className={`recommendation ${recommendationClass(model.recommendation)}`} title="Hardware recommendations are advisory and never block a download.">
          {model.recommendation ?? 'Compatibility unknown'}
        </span>
        <span className="model-capability">{model.codingCapability ?? 'General'} coding</span>
        <div className="model-actions">
          {model.installed ? <>
            <button disabled={busy || !ollama?.available} onClick={() => void setLoaded(model, !model.loaded)} title={model.loaded ? 'Unload this model from memory' : 'Load this model into memory'}>
              {model.loaded ? <PowerOff /> : <Power />}{model.loaded ? 'Unload' : 'Load'}
            </button>
            <button disabled={busy || model.selected} onClick={() => void selectModel(model, false)}>
              {model.selected ? <Check /> : <Sparkles />}{model.selected ? 'Selected' : 'Select'}
            </button>
            <button disabled={busy || model.isDefault} onClick={() => void selectModel(model, true)} title="Use this model by default">
              <Star />{model.isDefault ? 'Default' : 'Make default'}
            </button>
            <button className="danger-quiet" disabled={busy} onClick={() => void deleteModel(model)} title={`Delete ${model.name}`}>
              <Trash2 />
            </button>
          </> : <button
            className="model-download"
            disabled={busy || !ollama?.available}
            title={ollama?.available ? `Download ${model.name}` : 'Start Ollama before downloading a model'}
            onClick={() => void pullModel(model)}
          >
            <Download />Download
          </button>}
        </div>
      </div>

      {progress && <div className={`model-progress ${progress.error ? 'error' : ''}`}>
        <div>
          <span>{progress.status}</span>
          <span>{progress.percent !== undefined ? `${progress.percent.toFixed(1)}%` : progress.completed !== undefined ? formatBytes(progress.completed) : ''}</span>
        </div>
        {progress.percent !== undefined
          ? <progress max={100} value={progress.percent} />
          : <progress />}
        {!progress.done && <button onClick={() => void cancelPull(model.id)}><X />Cancel</button>}
        {progress.error && <small>{progress.error}</small>}
      </div>}
      {operations[model.id] && !progress && <small className="model-operation">{operations[model.id]}…</small>}
    </article>
  }

  return <div className="sidebar-view models-view">
    <div className="sidebar-title">
      <span>Local Models</span>
      <div className="toolbar compact">
        <button title="Refresh model list" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={loading ? 'spin' : ''} />
        </button>
      </div>
    </div>

    {hardware && <div className="hardware-summary">
      <Cpu />
      <div>
        <strong>{hardware.cpuModel}</strong>
        <small>{hardware.architecture} · {formatBytes(hardware.memoryBytes)} memory · {hardware.metalSupported ? 'Metal available' : 'Metal unavailable'}</small>
      </div>
    </div>}
    {ollama && <div className={`ollama-state ${ollama.available ? 'connected' : ''}`}>
      {ollama.available ? <Sparkles /> : <CircleAlert />}
      <span>
        <strong>{ollama.available ? 'Ollama connected' : ollama.installed ? 'Ollama is not running' : 'Ollama not installed'}</strong>
        <small>{ollama.version ?? 'Local AI is optional. Start Ollama to manage downloads.'}</small>
      </span>
    </div>}

    <label className="model-search">
      <Search />
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search coding models" aria-label="Search coding models" />
      {query && <button onClick={() => setQuery('')} title="Clear search"><X /></button>}
    </label>

    {error && <div className="models-error"><CircleAlert /><span>{error}</span></div>}
    {loading && !catalog.length && <div className="empty-compact">Inspecting local models and hardware…</div>}

    {installedModels.length > 0 && <section className="models-section">
      <div className="section-heading"><span>Installed on this Mac</span><span>{installedModels.length}</span></div>
      <div className="model-list">{installedModels.map(renderModel)}</div>
    </section>}

    {availableModels.length > 0 && <section className="models-section">
      <div className="section-heading"><span>Curated coding models</span><span>{availableModels.length}</span></div>
      <p className="models-advisory">Compatibility labels use this Mac’s memory. They are advice only and never prevent downloads.</p>
      <div className="model-list">{availableModels.map(renderModel)}</div>
    </section>}

    {!visibleModels.length && !loading && <div className="sidebar-empty">
      <Database />
      <p>{query ? `No models match “${query}”.` : 'No Ollama models are available.'}</p>
      <small>{query ? 'Try a model family, size, or capability.' : 'Check that the local Ollama service is running.'}</small>
    </div>}
  </div>
}
