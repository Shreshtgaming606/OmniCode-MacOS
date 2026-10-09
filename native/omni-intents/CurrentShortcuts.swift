import AppIntents

struct OmniCodeShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: OpenCodeModeIntent(), phrases: ["Open Code Mode in \(.applicationName)"], shortTitle: "Code Mode", systemImageName: "chevron.left.forwardslash.chevron.right")
        AppShortcut(intent: OpenWorkModeIntent(), phrases: ["Open Work Mode in \(.applicationName)"], shortTitle: "Work Mode", systemImageName: "briefcase")
        AppShortcut(intent: OpenOmniModeIntent(), phrases: ["Open Omni Mode in \(.applicationName)"], shortTitle: "Omni Mode", systemImageName: "sparkles")
        AppShortcut(intent: StartOmniVoiceIntent(), phrases: ["Start voice in \(.applicationName)"], shortTitle: "Omni Voice", systemImageName: "mic")
        AppShortcut(intent: AskOmniIntent(), phrases: ["Ask \(.applicationName)"], shortTitle: "Ask Omni", systemImageName: "bubble.left.and.text.bubble.right")
        AppShortcut(intent: OpenWorkspaceIntent(), phrases: ["Open a workspace in \(.applicationName)"], shortTitle: "Open Workspace", systemImageName: "folder")
        AppShortcut(intent: OpenRecentWorkspaceIntent(), phrases: ["Open my recent workspace in \(.applicationName)"], shortTitle: "Recent Workspace", systemImageName: "clock.arrow.circlepath")
        AppShortcut(intent: TranslateClipboardIntent(), phrases: ["Translate clipboard in \(.applicationName)"], shortTitle: "Translate Clipboard", systemImageName: "translate")
    }
}
