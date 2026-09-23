import AVFoundation
import CoreFoundation
import Foundation
import Speech

private let protocolVersion = 1
private let maximumRequestBytes = 64 * 1024
private let maximumLocaleCharacters = 64
private let minimumDurationMs = 1_000
private let maximumDurationMs = 60_000
private let maximumTranscriptCharacters = 16_384
private let outputLock = NSLock()

private struct HelperFailure: Error {
    let code: String
    let message: String
}

private func writeObject(_ object: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    outputLock.lock()
    defer { outputLock.unlock() }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

private func writeEvent(id: String, event: String, values: [String: Any] = [:]) {
    var response: [String: Any] = ["version": protocolVersion, "id": id, "event": event]
    for (key, value) in values { response[key] = value }
    writeObject(response)
}

private func fail(id: String, _ failure: HelperFailure) -> Never {
    writeEvent(id: id, event: "error", values: [
        "error": ["code": failure.code, "message": failure.message]
    ])
    exit(1)
}

private func permissionName(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not-determined"
    @unknown default: return "unavailable"
    }
}

private func microphonePermissionName(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not-determined"
    @unknown default: return "unavailable"
    }
}

private func readInitialRequest() throws -> [String: Any] {
    guard let line = readLine(), let data = line.data(using: .utf8), data.count <= maximumRequestBytes,
          let object = try? JSONSerialization.jsonObject(with: data),
          let request = object as? [String: Any] else {
        throw HelperFailure(code: "invalid-request", message: "The speech helper request is invalid.")
    }
    return request
}

private func strictKeys(_ request: [String: Any], allowed: Set<String>) throws {
    guard Set(request.keys) == allowed else {
        throw HelperFailure(code: "invalid-request", message: "The speech helper request contains unsupported fields.")
    }
}

private func requestId(_ request: [String: Any]) throws -> String {
    guard let version = request["version"] as? NSNumber,
          CFGetTypeID(version) != CFBooleanGetTypeID(), version.intValue == protocolVersion,
          let id = request["id"] as? String,
          UUID(uuidString: id) != nil else {
        throw HelperFailure(code: "invalid-request", message: "The speech helper request identity is invalid.")
    }
    return id
}

private func localeIdentifier(_ request: [String: Any]) throws -> String {
    guard let locale = request["locale"] as? String,
          !locale.isEmpty, locale.count <= maximumLocaleCharacters,
          locale.range(of: #"^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$"#, options: .regularExpression) != nil else {
        throw HelperFailure(code: "invalid-request", message: "Choose a valid speech-recognition locale.")
    }
    return locale.replacingOccurrences(of: "_", with: "-")
}

private func boundedInteger(_ value: Any?, minimum: Int, maximum: Int, label: String) throws -> Int {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite, number.doubleValue == Double(number.intValue),
          number.intValue >= minimum, number.intValue <= maximum else {
        throw HelperFailure(code: "invalid-request", message: "\(label) is outside the supported range.")
    }
    return number.intValue
}

private func status(id: String, locale: String) -> Never {
    let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale))
    let supportedLocales = SFSpeechRecognizer.supportedLocales()
        .map(\.identifier).sorted().prefix(512)
    writeEvent(id: id, event: "status", values: [
        "microphonePermission": microphonePermissionName(AVCaptureDevice.authorizationStatus(for: .audio)),
        "speechRecognitionPermission": permissionName(SFSpeechRecognizer.authorizationStatus()),
        "recognizerAvailable": recognizer?.isAvailable ?? false,
        "onDevice": recognizer?.supportsOnDeviceRecognition ?? false,
        "streaming": true,
        "locale": locale,
        "supportedLocales": Array(supportedLocales)
    ])
    exit(0)
}

private func requestPermission(id: String, permission: String) -> Never {
    if permission == "speech-recognition" {
        let current = SFSpeechRecognizer.authorizationStatus()
        if current == .notDetermined {
            SFSpeechRecognizer.requestAuthorization { result in
                writeEvent(id: id, event: "permission", values: [
                    "permission": permission,
                    "state": permissionName(result)
                ])
                exit(0)
            }
            RunLoop.main.run()
        }
        writeEvent(id: id, event: "permission", values: ["permission": permission, "state": permissionName(current)])
        exit(0)
    }
    if permission == "microphone" {
        let current = AVCaptureDevice.authorizationStatus(for: .audio)
        if current == .notDetermined {
            AVCaptureDevice.requestAccess(for: .audio) { _ in
                writeEvent(id: id, event: "permission", values: [
                    "permission": permission,
                    "state": microphonePermissionName(AVCaptureDevice.authorizationStatus(for: .audio))
                ])
                exit(0)
            }
            RunLoop.main.run()
        }
        writeEvent(id: id, event: "permission", values: ["permission": permission, "state": microphonePermissionName(current)])
        exit(0)
    }
    fail(id: id, HelperFailure(code: "invalid-request", message: "The requested speech permission is unsupported."))
}

private final class RecognitionController {
    private let id: String
    private let locale: String
    private let requireOnDevice: Bool
    private let maximumDurationMs: Int
    private let maximumTranscriptCharacters: Int
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var finalTranscript = ""
    private var finishing = false
    private var stopping = false
    private var tapInstalled = false
    private var timeout: DispatchSourceTimer?
    private var lastAmplitudeAt = 0.0

    init(id: String, locale: String, requireOnDevice: Bool, maximumDurationMs: Int, maximumTranscriptCharacters: Int) {
        self.id = id
        self.locale = locale
        self.requireOnDevice = requireOnDevice
        self.maximumDurationMs = maximumDurationMs
        self.maximumTranscriptCharacters = maximumTranscriptCharacters
    }

    func begin() {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)), recognizer.isAvailable else {
            fail(id: id, HelperFailure(code: "recognizer-unavailable", message: "Speech recognition is unavailable for the selected locale."))
        }
        if requireOnDevice && !recognizer.supportsOnDeviceRecognition {
            fail(id: id, HelperFailure(code: "on-device-unavailable", message: "On-device speech recognition is unavailable for the selected locale."))
        }
        requestSpeechPermission { [weak self] speechGranted in
            guard let self else { return }
            guard speechGranted else {
                fail(id: self.id, HelperFailure(code: "speech-permission-denied", message: "Speech Recognition permission is required for voice input."))
            }
            self.requestMicrophonePermission { [weak self] microphoneGranted in
                guard let self else { return }
                guard microphoneGranted else {
                    fail(id: self.id, HelperFailure(code: "microphone-permission-denied", message: "Microphone permission is required for voice input."))
                }
                do { try self.startRecognition() }
                catch let failure as HelperFailure { fail(id: self.id, failure) }
                catch { fail(id: self.id, HelperFailure(code: "recognition-failed", message: "Voice recognition could not start.")) }
            }
        }
    }

    private func requestSpeechPermission(completion: @escaping (Bool) -> Void) {
        if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
            SFSpeechRecognizer.requestAuthorization { status in
                DispatchQueue.main.async { completion(status == .authorized) }
            }
        } else {
            completion(SFSpeechRecognizer.authorizationStatus() == .authorized)
        }
    }

    private func requestMicrophonePermission(completion: @escaping (Bool) -> Void) {
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                DispatchQueue.main.async { completion(granted) }
            }
        } else {
            completion(AVCaptureDevice.authorizationStatus(for: .audio) == .authorized)
        }
    }

    private func startRecognition() throws {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)), recognizer.isAvailable else {
            throw HelperFailure(code: "recognizer-unavailable", message: "Speech recognition is unavailable for the selected locale.")
        }
        if requireOnDevice && !recognizer.supportsOnDeviceRecognition {
            throw HelperFailure(code: "on-device-unavailable", message: "On-device speech recognition is unavailable for the selected locale.")
        }

        let recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        recognitionRequest.shouldReportPartialResults = true
        recognitionRequest.requiresOnDeviceRecognition = requireOnDevice
        request = recognitionRequest

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw HelperFailure(code: "microphone-unavailable", message: "No usable microphone input format is available.")
        }
        inputNode.installTap(onBus: 0, bufferSize: 1_024, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            self.request?.append(buffer)
            let now = ProcessInfo.processInfo.systemUptime
            guard now - self.lastAmplitudeAt >= 0.05,
                  let samples = buffer.floatChannelData?[0] else { return }
            self.lastAmplitudeAt = now
            let frames = Int(buffer.frameLength)
            guard frames > 0 else { return }
            var sum: Float = 0
            for index in 0..<frames { sum += samples[index] * samples[index] }
            let rms = sqrt(sum / Float(frames))
            let normalized = min(1, max(0, (rms - 0.006) / 0.18))
            writeEvent(id: self.id, event: "amplitude", values: ["amplitude": normalized])
        }
        tapInstalled = true
        audioEngine.prepare()
        do { try audioEngine.start() }
        catch {
            inputNode.removeTap(onBus: 0)
            throw HelperFailure(code: "microphone-unavailable", message: "The microphone could not be started.")
        }

        task = recognizer.recognitionTask(with: recognitionRequest) { [weak self] result, error in
            guard let self, !self.finishing else { return }
            if let result {
                let transcript = String(result.bestTranscription.formattedString.prefix(self.maximumTranscriptCharacters))
                self.finalTranscript = transcript
                writeEvent(id: self.id, event: result.isFinal ? "final" : "partial", values: [
                    "transcript": transcript,
                    "cancelled": false
                ])
                if result.isFinal { self.finish(exitCode: 0, emitFinal: false) }
            } else if error != nil {
                if self.stopping {
                    writeEvent(id: self.id, event: "final", values: ["transcript": self.finalTranscript, "cancelled": false])
                    self.finish(exitCode: 0, emitFinal: false)
                } else {
                    self.finishWithError(HelperFailure(code: "recognition-failed", message: "Speech recognition stopped before producing a final transcript."))
                }
            }
        }

        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + .milliseconds(maximumDurationMs))
        timer.setEventHandler { [weak self] in self?.stop() }
        timer.resume()
        timeout = timer
        writeEvent(id: id, event: "ready", values: ["locale": locale, "onDevice": requireOnDevice])
        listenForCommands()
    }

    private func listenForCommands() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            while let line = readLine() {
                guard let data = line.data(using: .utf8), data.count <= maximumRequestBytes,
                      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      object["version"] as? Int == protocolVersion,
                      object["id"] as? String == self?.id,
                      let command = object["command"] as? String else { continue }
                if command == "stop" {
                    DispatchQueue.main.async { self?.stop() }
                    return
                }
                if command == "cancel" {
                    DispatchQueue.main.async { self?.cancel() }
                    return
                }
            }
            // The parent disappearing closes stdin. Release the microphone
            // immediately instead of waiting for the session-duration cap.
            DispatchQueue.main.async { self?.cancel() }
        }
    }

    func stop() {
        guard !finishing else { return }
        stopping = true
        stopAudio()
        request?.endAudio()
        timeout?.cancel()
        timeout = nil
        // Give Speech a short opportunity to emit its final result.
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(1_500)) { [weak self] in
            guard let self, !self.finishing else { return }
            writeEvent(id: self.id, event: "final", values: ["transcript": self.finalTranscript, "cancelled": false])
            self.finish(exitCode: 0, emitFinal: false)
        }
    }

    func cancel() {
        guard !finishing else { return }
        writeEvent(id: id, event: "final", values: ["transcript": "", "cancelled": true])
        finish(exitCode: 0, emitFinal: false, cancelTask: true)
    }

    private func finishWithError(_ failure: HelperFailure) {
        guard !finishing else { return }
        cleanup(cancelTask: true)
        writeEvent(id: id, event: "error", values: ["error": ["code": failure.code, "message": failure.message]])
        exit(1)
    }

    private func finish(exitCode: Int32, emitFinal: Bool, cancelTask: Bool = false) {
        guard !finishing else { return }
        cleanup(cancelTask: cancelTask)
        if emitFinal {
            writeEvent(id: id, event: "final", values: ["transcript": finalTranscript, "cancelled": cancelTask])
        }
        exit(exitCode)
    }

    private func cleanup(cancelTask: Bool) {
        finishing = true
        timeout?.cancel()
        timeout = nil
        stopAudio()
        request?.endAudio()
        if cancelTask { task?.cancel() } else { task?.finish() }
        task = nil
        request = nil
    }

    private func stopAudio() {
        if audioEngine.isRunning { audioEngine.stop() }
        if tapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
    }
}

do {
    let request = try readInitialRequest()
    let id = try requestId(request)
    guard let command = request["command"] as? String else {
        throw HelperFailure(code: "invalid-request", message: "The speech helper command is missing.")
    }
    let locale = try localeIdentifier(request)
    if command == "status" {
        try strictKeys(request, allowed: ["version", "id", "command", "locale"])
        status(id: id, locale: locale)
    }
    if command == "request-permission" {
        try strictKeys(request, allowed: ["version", "id", "command", "locale", "permission"])
        guard let permission = request["permission"] as? String else {
            throw HelperFailure(code: "invalid-request", message: "The speech permission is missing.")
        }
        requestPermission(id: id, permission: permission)
    }
    guard command == "recognize" else {
        throw HelperFailure(code: "invalid-request", message: "The speech helper command is unsupported.")
    }
    try strictKeys(request, allowed: [
        "version", "id", "command", "locale", "requireOnDevice", "maximumDurationMs", "maximumTranscriptCharacters"
    ])
    guard let requireOnDevice = request["requireOnDevice"] as? Bool else {
        throw HelperFailure(code: "invalid-request", message: "The recognition privacy policy is invalid.")
    }
    let duration = try boundedInteger(request["maximumDurationMs"], minimum: minimumDurationMs, maximum: maximumDurationMs, label: "Recognition duration")
    let transcriptCharacters = try boundedInteger(request["maximumTranscriptCharacters"], minimum: 1, maximum: maximumTranscriptCharacters, label: "Transcript size")
    let controller = RecognitionController(
        id: id,
        locale: locale,
        requireOnDevice: requireOnDevice,
        maximumDurationMs: duration,
        maximumTranscriptCharacters: transcriptCharacters
    )
    controller.begin()
    RunLoop.main.run()
} catch let failure as HelperFailure {
    fail(id: "invalid", failure)
} catch {
    fail(id: "invalid", HelperFailure(code: "invalid-request", message: "The speech helper request could not be processed."))
}
