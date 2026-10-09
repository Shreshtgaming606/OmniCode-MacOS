import AppKit
import Foundation
import ScreenCaptureKit
import SwiftUI
import Translation
import Vision

// This process accepts one bounded JSON request on stdin. It never writes
// transcript, image, or translated text to stderr or a diagnostic log.
@main
struct OmniModernHelper {
    static func main() async {
        do {
            let input = FileHandle.standardInput.readDataToEndOfFile()
            guard input.count <= 2_000_000,
                  let request = try JSONSerialization.jsonObject(with: input) as? [String: Any],
                  let command = request["command"] as? String else {
                throw HelperError.invalidRequest
            }
            let result: [String: Any]
            switch command {
            case "translate":
                result = try await translate(request)
            case "recognize-text":
                result = try await recognizeText(request)
            case "capture-window":
                result = try await captureWindow(request)
            default:
                throw HelperError.invalidRequest
            }
            try emit(["ok": true, "result": result])
        } catch {
            // Keep failures useful but never interpolate arbitrary request data.
            let message = (error as? HelperError)?.message ?? "The native macOS operation failed. Check permissions and installed language assets."
            try? emit(["ok": false, "error": message])
        }
    }

    static func emit(_ value: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: value)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }

    static func translate(_ request: [String: Any]) async throws -> [String: Any] {
        guard let text = request["text"] as? String, !text.isEmpty, text.utf8.count <= 100_000,
              let source = request["source"] as? String, source.count <= 16,
              let target = request["target"] as? String, target.count <= 16 else {
            throw HelperError.invalidRequest
        }
        let sourceLanguage = Locale.Language(identifier: source)
        let targetLanguage = Locale.Language(identifier: target)
        let availability = LanguageAvailability()
        guard await availability.status(from: sourceLanguage, to: targetLanguage) == .installed else {
            throw HelperError.languagesNotInstalled
        }
        if #available(macOS 26.0, *) {
            let session = TranslationSession(installedSource: sourceLanguage, target: targetLanguage)
            let response = try await session.translate(text)
            return ["text": response.targetText, "engine": "Apple Translation · on-device"]
        }
        let translated = try await translateWithSystemView(text, source: sourceLanguage, target: targetLanguage)
        return ["text": translated, "engine": "Apple Translation · on-device"]
    }

    static func recognizeText(_ request: [String: Any]) async throws -> [String: Any] {
        guard let path = request["imagePath"] as? String, path.utf8.count <= 4_096,
              FileManager.default.fileExists(atPath: path) else { throw HelperError.invalidRequest }
        var recognition = RecognizeTextRequest()
        recognition.recognitionLevel = .accurate
        recognition.automaticallyDetectsLanguage = true
        let observations = try await recognition.perform(on: URL(fileURLWithPath: path))
        let lines = observations.compactMap { $0.topCandidates(1).first?.string }
        return ["text": lines.joined(separator: "\n").prefix(100_000).description,
                "lineCount": lines.count, "engine": "Apple Vision · on-device"]
    }

    @MainActor
    static func translateWithSystemView(_ text: String, source: Locale.Language, target: Locale.Language) async throws -> String {
        NSApplication.shared.setActivationPolicy(.accessory)
        return try await withCheckedThrowingContinuation { continuation in
            let completion = TranslationCompletion { result in continuation.resume(with: result) }
            let view = NativeTranslationView(text: text, source: source, target: target) { result in
                completion.finish(result)
            }
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 92),
                                  styleMask: [.titled], backing: .buffered, defer: false)
            window.title = "OmniCode · On-device Translation"
            window.contentView = NSHostingView(rootView: view)
            window.center()
            window.orderFrontRegardless()
        }
    }

    static func captureWindow(_ request: [String: Any]) async throws -> [String: Any] {
        guard let rawWindow = request["windowId"] as? Int, rawWindow > 0,
              let outputPath = request["outputPath"] as? String, outputPath.utf8.count <= 4_096 else {
            throw HelperError.invalidRequest
        }
        // ScreenCaptureKit's window filter calls into SkyLight's display
        // inventory. A command-line process must initialize AppKit/CGS first;
        // otherwise macOS aborts in CGS_REQUIRE_INIT before returning an error.
        await MainActor.run { _ = NSApplication.shared }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        // The trusted Electron main process supplies its own BrowserWindow ID;
        // the helper never chooses a broad display capture as a fallback.
        guard let window = content.windows.first(where: { Int($0.windowID) == rawWindow }) else {
            throw HelperError.windowUnavailable
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config: SCStreamConfiguration
        #if arch(arm64)
        config = SCStreamConfiguration(preset: .captureHDRScreenshotLocalDisplay)
        #else
        config = SCStreamConfiguration()
        #endif
        config.width = max(1, Int(filter.contentRect.width * CGFloat(filter.pointPixelScale)))
        config.height = max(1, Int(filter.contentRect.height * CGFloat(filter.pointPixelScale)))
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let representation = NSBitmapImageRep(cgImage: image)
        guard let png = representation.representation(using: .png, properties: [:]) else { throw HelperError.captureFailed }
        try png.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
        #if arch(arm64)
        let dynamicRange = "HDR"
        #else
        let dynamicRange = "SDR"
        #endif
        return ["path": outputPath, "width": image.width, "height": image.height,
                "scope": "OmniCode window only", "dynamicRange": dynamicRange]
    }
}

private final class TranslationCompletion {
    private let lock = NSLock()
    private var finished = false
    private let callback: (Result<String, Error>) -> Void
    init(_ callback: @escaping (Result<String, Error>) -> Void) { self.callback = callback }
    func finish(_ result: Result<String, Error>) {
        lock.lock()
        let shouldFinish = !finished
        finished = true
        lock.unlock()
        if shouldFinish { callback(result) }
    }
}

@available(macOS 15.0, *)
private struct NativeTranslationView: View {
    let text: String
    let source: Locale.Language
    let target: Locale.Language
    let completed: (Result<String, Error>) -> Void

    var body: some View {
        Text("Translating on this Mac…")
            .padding()
            .translationTask(source: source, target: target) { session in
                do {
                    let response = try await session.translate(text)
                    completed(.success(response.targetText))
                } catch {
                    completed(.failure(error))
                }
            }
    }
}

enum HelperError: Error {
    case invalidRequest, languagesNotInstalled, windowUnavailable, captureFailed
    var message: String {
        switch self {
        case .invalidRequest: return "The native request is invalid."
        case .languagesNotInstalled: return "Install the source and target languages in macOS before using on-device translation."
        case .windowUnavailable: return "OmniCode's window is unavailable for capture or Screen Recording permission is missing."
        case .captureFailed: return "The selected OmniCode window could not be captured."
        }
    }
}
