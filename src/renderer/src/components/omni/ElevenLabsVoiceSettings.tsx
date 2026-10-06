import { useEffect, useMemo, useState } from 'react'
import { AudioWaveform, CheckCircle2, LoaderCircle, Search, Square, Volume2 } from 'lucide-react'

import type { ElevenLabsModel, ElevenLabsVoice, ElevenLabsVoiceSettings as VoiceControls } from '../../../../shared/elevenlabs-contracts'
import type { OmniVoiceSettings } from '../../../../shared/omni-contracts'

const DEFAULT_CONTROLS: VoiceControls = { stability: 0.5, similarityBoost: 0.75, style: 0, speed: 1 }

export function ElevenLabsVoiceSettings({ voice, busy, onUpdate }: {
  voice: OmniVoiceSettings
  busy: boolean
  onUpdate(changes: Partial<OmniVoiceSettings>): Promise<void>
}) {
  const [key, setKey] = useState('')
  const [connected, setConnected] = useState<boolean | null>(null)
  const [voices, setVoices] = useState<ElevenLabsVoice[]>([])
  const [models, setModels] = useState<ElevenLabsModel[]>([])
  const [search, setSearch] = useState('')
  const [showConnect, setShowConnect] = useState(false)
  const [working, setWorking] = useState<'connect' | 'disconnect' | 'refresh' | 'preview' | null>(null)
  const [previewVoiceId, setPreviewVoiceId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [draft, setDraft] = useState<VoiceControls>(voice.elevenlabsSettings ?? DEFAULT_CONTROLS)

  const refresh = async (): Promise<void> => {
    const [voiceList, modelList] = await Promise.all([
      window.omnicode.omni.voice.elevenlabsVoices(), window.omnicode.omni.voice.elevenlabsModels()
    ])
    setVoices(voiceList)
    setModels(modelList)
  }

  useEffect(() => {
    let active = true
    void window.omnicode.omni.voice.elevenlabsConnected().then(async (value) => {
      if (!active) return
      setConnected(value)
      if (value) {
        try {
          const [voiceList, modelList] = await Promise.all([
            window.omnicode.omni.voice.elevenlabsVoices(), window.omnicode.omni.voice.elevenlabsModels()
          ])
          if (active) { setVoices(voiceList); setModels(modelList) }
        } catch (error) {
          if (active) setMessage(error instanceof Error ? error.message : 'ElevenLabs voices are unavailable.')
        }
      }
    }).catch(() => { if (active) { setConnected(false); setMessage('Could not check ElevenLabs connection.') } })
    return () => { active = false }
  }, [])

  useEffect(() => { setDraft(voice.elevenlabsSettings ?? DEFAULT_CONTROLS) }, [voice.elevenlabsSettings])

  const model = models.find((item) => item.id === voice.elevenlabsModelId)
    ?? models.find((item) => item.id === 'eleven_flash_v2_5') ?? models[0]
  const selectedVoice = voices.find((item) => item.id === voice.elevenlabsVoiceId)
  const visibleVoices = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    return term ? voices.filter((item) => `${item.name} ${item.category} ${item.description} ${item.accent} ${item.language}`.toLocaleLowerCase().includes(term)) : voices
  }, [search, voices])

  const connect = async (): Promise<void> => {
    if (!key.trim() || working) return
    setWorking('connect'); setMessage('')
    try {
      await window.omnicode.omni.voice.elevenlabsConnect(key)
      setKey('')
      setConnected(true)
      setShowConnect(false)
      await refresh()
      await onUpdate({ outputProvider: 'elevenlabs' })
      setMessage('ElevenLabs connected. Choose a voice to begin.')
    } catch (error) {
      setKey('')
      setMessage(error instanceof Error ? error.message : 'ElevenLabs could not connect.')
    } finally { setWorking(null) }
  }

  const disconnect = async (): Promise<void> => {
    if (working) return
    setWorking('disconnect'); setMessage('')
    try {
      await window.omnicode.omni.voice.elevenlabsDisconnect()
      setConnected(false); setVoices([]); setModels([]); setPreviewVoiceId(null)
      setMessage('ElevenLabs disconnected. System Voice is active.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'ElevenLabs could not disconnect.')
    } finally { setWorking(null) }
  }

  const preview = async (voiceId: string): Promise<void> => {
    if (!model || working) return
    setWorking('preview'); setPreviewVoiceId(voiceId); setMessage('Generating a short voice preview…')
    try {
      const result = await window.omnicode.omni.voice.elevenlabsPreview(voiceId, model.id, draft)
      setMessage(result.status === 'interrupted' ? 'Preview stopped.' : 'Preview finished.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The voice preview failed.')
    } finally { setWorking(null); setPreviewVoiceId(null) }
  }

  const stopPreview = async (): Promise<void> => {
    await window.omnicode.omni.voice.stop()
    setWorking(null); setPreviewVoiceId(null); setMessage('Preview stopped.')
  }

  const selectProvider = async (value: 'system' | 'elevenlabs'): Promise<void> => {
    if (value === 'elevenlabs' && !connected) { setShowConnect(true); return }
    await onUpdate({ outputProvider: value })
  }

  const slider = (label: string, key: keyof VoiceControls, min: number, max: number, step: number) => (
    <label className="omni-elevenlabs-slider"><span>{label}<output>{draft[key].toFixed(key === 'speed' ? 2 : 2)}</output></span>
      <input aria-label={`ElevenLabs ${label}`} type="range" min={min} max={max} step={step} value={draft[key]}
        onChange={(event) => setDraft((current) => ({ ...current, [key]: Number(event.target.value) }))} /></label>
  )

  return <div className="omni-elevenlabs" aria-label="Voice output settings">
    <label className="omni-settings-select"><strong>Voice output provider</strong><select disabled={busy || working === 'connect'} value={voice.outputProvider} onChange={(event) => void selectProvider(event.target.value as 'system' | 'elevenlabs')}>
      <option value="system">System Voice · macOS</option><option value="elevenlabs">ElevenLabs</option>
    </select><small>System Voice stays available without an account.</small></label>
    {(!connected || showConnect) && <div className="omni-elevenlabs-connect"><div><strong>ElevenLabs account</strong><small>{connected ? 'Replace the saved key' : 'Connect to use natural AI voices'}</small></div>
      <label><span>ElevenLabs API key</span><input type="password" value={key} autoComplete="off" spellCheck={false} disabled={working === 'connect'} onChange={(event) => setKey(event.target.value)} placeholder="Paste your API key" /></label>
      <button type="button" disabled={!key.trim() || !!working} onClick={() => void connect()}>{working === 'connect' ? <><LoaderCircle className="spin" /> Connecting…</> : 'Connect'}</button>
    </div>}
    {connected && <><div className="omni-elevenlabs-account"><span><CheckCircle2 /><strong>ElevenLabs connected</strong></span><div><button type="button" disabled={!!working} onClick={() => { setWorking('refresh'); void refresh().catch((error) => setMessage(error instanceof Error ? error.message : 'Could not refresh voices.')).finally(() => setWorking(null)) }}>Refresh voices</button><button type="button" disabled={!!working} onClick={() => void disconnect()}>Disconnect</button></div></div>
      {voice.outputProvider === 'elevenlabs' && <>
        <label className="omni-settings-select"><strong>Speech model</strong><select value={model?.id ?? ''} disabled={!!working || busy || !models.length} onChange={(event) => void onUpdate({ elevenlabsModelId: event.target.value })}>{models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><small>Only models ElevenLabs reports as available for text to speech are listed.</small></label>
        <div className="omni-elevenlabs-browser"><div className="omni-elevenlabs-browser-heading"><strong>Choose voice</strong><small>{voices.length} available</small></div>
          <label className="omni-elevenlabs-search"><Search /><input aria-label="Search ElevenLabs voices" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search voices, accents, descriptions…" /></label>
          <div className="omni-elevenlabs-voices" role="list">{visibleVoices.map((item) => <div className="omni-elevenlabs-voice" role="listitem" key={item.id} data-selected={item.id === voice.elevenlabsVoiceId}>
            <span><strong>{item.name}</strong><small>{[item.category, item.accent, item.language].filter(Boolean).join(' · ') || item.description || 'Available voice'}</small></span>
            <div><button type="button" aria-label={`Preview ${item.name}`} disabled={!!working || !model} onClick={() => void preview(item.id)}><Volume2 /> Preview</button><button type="button" aria-label={`Use ${item.name}`} disabled={!!working || busy} onClick={() => void onUpdate({ elevenlabsVoiceId: item.id })}>{item.id === voice.elevenlabsVoiceId ? 'Selected' : 'Use voice'}</button></div>
          </div>)}{!visibleVoices.length && <p className="omni-settings-note">{voices.length ? 'No voices match your search.' : 'No available voices were returned. Refresh the list or check your account.'}</p>}</div>
        </div>
        {selectedVoice && <div className="omni-elevenlabs-character"><strong>Voice character · {selectedVoice.name}</strong>
          {slider('Stability', 'stability', 0, 1, model?.id.startsWith('eleven_v3') ? 0.5 : 0.05)}
          {model?.canUseSimilarity && slider('Similarity', 'similarityBoost', 0, 1, 0.05)}
          {model?.canUseStyle && slider('Style', 'style', 0, 1, 0.05)}
          {model?.canUseSpeed && slider('Speed', 'speed', 0.7, 1.2, 0.05)}
          <div className="omni-elevenlabs-actions">{working === 'preview' ? <button type="button" onClick={() => void stopPreview()}><Square /> Stop preview</button> : <button type="button" disabled={!model || !!working} onClick={() => void preview(selectedVoice.id)}><AudioWaveform /> Preview changes</button>}
            <button type="button" disabled={busy || !!working} onClick={() => void onUpdate({ elevenlabsSettings: draft })}>Save voice</button>
            <button type="button" disabled={busy || !!working} onClick={() => setDraft(DEFAULT_CONTROLS)}>Reset to defaults</button></div>
        </div>}
        <label className="setting-toggle"><span><strong>Fallback to System Voice</strong><small>If ElevenLabs fails, Omni can still speak its answer with macOS.</small></span><input type="checkbox" checked={voice.fallbackToSystem} disabled={busy} onChange={(event) => void onUpdate({ fallbackToSystem: event.target.checked })} /></label>
        <p className="omni-settings-note">Only text Omni speaks is sent to ElevenLabs. Microphone audio stays on this Mac. Voice generation and previews may count toward your ElevenLabs plan.</p>
      </>}
    </>}
    {message && <p className="omni-elevenlabs-message" role="status">{message}</p>}
    {previewVoiceId && working === 'preview' && previewVoiceId !== selectedVoice?.id && <button type="button" className="omni-elevenlabs-stop" onClick={() => void stopPreview()}><Square /> Stop preview</button>}
  </div>
}
