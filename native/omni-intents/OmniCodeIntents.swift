import AppIntents
import AppKit
import ExtensionFoundation

@main
struct OmniCodeIntentsExtension: AppIntentsExtension {}

private enum OmniCodeIntentError: Error, LocalizedError {
    case couldNotOpen

    var errorDescription: String? {
        "OmniCode could not be opened. Please open the app and try again."
    }
}

private func openOmniCode(_ route: String) throws {
    guard let url = URL(string: "omnicode://\(route)"),
          NSWorkspace.shared.open(url) else {
        throw OmniCodeIntentError.couldNotOpen
    }
}

struct OpenCodeModeIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Code Mode"
    static let description = IntentDescription("Open the Code workspace in OmniCode.")

    func perform() async throws -> some IntentResult {
        try openOmniCode("mode/code")
        return .result()
    }
}

struct OpenWorkModeIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Work Mode"
    static let description = IntentDescription("Open Work Mode in OmniCode.")

    func perform() async throws -> some IntentResult {
        try openOmniCode("mode/work")
        return .result()
    }
}

struct OpenOmniModeIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Omni Mode"
    static let description = IntentDescription("Open Omni Mode in OmniCode.")

    func perform() async throws -> some IntentResult {
        try openOmniCode("mode/omni")
        return .result()
    }
}

struct StartOmniVoiceIntent: AppIntent {
    static let title: LocalizedStringResource = "Start Omni Voice"
    static let description = IntentDescription("Open OmniCode's voice overlay.")

    func perform() async throws -> some IntentResult {
        try openOmniCode("action/start-voice")
        return .result()
    }
}

struct AskOmniIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Omni"
    static let description = IntentDescription("Open OmniCode to ask its regular Omni agent.")

    func perform() async throws -> some IntentResult {
        try openOmniCode("action/ask-omni")
        return .result()
    }
}

struct OpenWorkspaceIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Workspace"
    static let description = IntentDescription("Choose an existing folder to open in OmniCode.")

    func perform() async throws -> some IntentResult {
        try openOmniCode("action/open-workspace")
        return .result()
    }
}

struct OpenRecentWorkspaceIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Recent Workspace"
    static let description = IntentDescription("Open the most recently used OmniCode workspace.")

    func perform() async throws -> some IntentResult {
        try openOmniCode("action/open-recent-workspace")
        return .result()
    }
}

@available(macOS 15.0, *)
struct TranslateClipboardIntent: AppIntent {
    static let title: LocalizedStringResource = "Translate Clipboard"
    static let description = IntentDescription("Open OmniCode's on-device clipboard translation.")

    func perform() async throws -> some IntentResult {
        try openOmniCode("action/translate-clipboard")
        return .result()
    }
}
