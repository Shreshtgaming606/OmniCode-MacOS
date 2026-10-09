export interface SpotlightSettings {
  enabled: boolean
  recentWorkspaces: boolean
  conversationTitles: boolean
  savedWorkflows: boolean
  workspaceFilenames: boolean
}

export interface SpotlightItem {
  id: string
  title: string
  kind: 'workspace' | 'conversation' | 'action'
}

export interface SpotlightSettingsSnapshot extends SpotlightSettings {
  available: boolean
}
