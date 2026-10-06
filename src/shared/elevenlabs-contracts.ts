export interface ElevenLabsVoice {
  id: string
  name: string
  category: string
  description: string
  accent: string
  language: string
}

export interface ElevenLabsModel {
  id: string
  name: string
  canUseStyle: boolean
  canUseSpeakerBoost: boolean
  canUseSpeed: boolean
  canUseSimilarity: boolean
  maximumTextLength: number
}

export interface ElevenLabsVoiceSettings {
  stability: number
  similarityBoost: number
  style: number
  speed: number
}

export interface ElevenLabsConnection {
  connected: boolean
  reason?: string
}
