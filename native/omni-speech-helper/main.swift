import AVFoundation
import CoreAudio
import CoreFoundation
import Foundation
import Speech

private let protocolVersion = 1
private let maximumRequestBytes = 64 * 1024
private let maximumLocaleCharacters = 64
private let minimumDurationMs = 1_000
private let maximumDurationMs = 300_000
private let maximumTranscriptCharacters = 16_384
private let outputLock = NSLock()

// ElevenLabs returns signed 16-bit mono PCM at 24 kHz. This playback mode reads
// the stream from stdin and keeps audio in memory; no temporary audio file or
// unrelated player process is created. The process is terminated on barge-in.
private func playPCMStream() throws {
    guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24_000, channels: 1, interleaved: true) else {
        throw HelperFailure(code: "audio-format", message: "Omni could not configure voice playback.")
    }
    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    engine.attach(player)
    engine.connect(player, to: engine.mainMixerNode, format: format)
    try engine.start()
    let playback = DispatchGroup()
    var pending = Data()
    var started = false
    var totalBytes = 0
    while let chunk = try FileHandle.standardInput.read(upToCount: 8_192), !chunk.isEmpty {
        totalBytes += chunk.count
        if totalBytes > 24 * 1_024 * 1_024 {
            throw HelperFailure(code: "audio-size", message: "The generated voice response was too long.")
        }
        pending.append(chunk)
        let playableBytes = min(pending.count & ~1, 16_384)
        if playableBytes == 0 { continue }
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(playableBytes / 2)),
              let samples = buffer.int16ChannelData?[0] else {
            throw HelperFailure(code: "audio-buffer", message: "Omni could not prepare voice playback.")
        }
        pending.copyBytes(to: UnsafeMutableRawBufferPointer(start: samples, count: playableBytes), count: playableBytes)
        pending.removeFirst(playableBytes)
        buffer.frameLength = AVAudioFrameCount(playableBytes / 2)
        playback.enter()
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in playback.leave() }
        if !started {
            player.play()
            started = true
            FileHandle.standardOutput.write(Data("STARTED\n".utf8))
        }
    }
    if !pending.isEmpty { throw HelperFailure(code: "audio-format", message: "The generated voice audio was incomplete.") }
    if started {
        if playback.wait(timeout: .now() + 180) == .timedOut {
            throw HelperFailure(code: "audio-timeout", message: "Voice playback timed out.")
        }
    }
    player.stop()
    engine.stop()
}

private enum VoiceSessionState: String {
    case starting = "STARTING"
    case listening = "LISTENING"
    case speechDetected = "SPEECH_DETECTED"
    case waitingForEnd = "WAITING_FOR_END"
    case finalizingTranscript = "FINALIZING_TRANSCRIPT"
    case completed = "COMPLETED"
    case cancelled = "CANCELLED"
    case failed = "FAILED"
}

private enum FinishSpeakingMode: String {
    case auto
    case enter
}

private enum FinalizationReason: String {
    case silence = "SILENCE"
    case enter = "ENTER"
    case timeout = "TIMEOUT"
    case manual = "MANUAL"
    case speechFramework = "SPEECH_FRAMEWORK"
    case cancel = "CANCEL"
}

private struct InputDeviceInfo {
    let id: AudioDeviceID
    let name: String
    let transport: String
    let sampleRate: Double
    let channelCount: UInt32
}

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

private func propertyString(_ object: AudioObjectID, selector: AudioObjectPropertySelector) -> String? {
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var value: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr else { return nil }
    return value as String
}

private func transportName(_ value: UInt32) -> String {
    switch value {
    case kAudioDeviceTransportTypeBluetooth: return "Bluetooth"
    case kAudioDeviceTransportTypeBluetoothLE: return "Bluetooth LE"
    case kAudioDeviceTransportTypeBuiltIn: return "Built-in"
    case kAudioDeviceTransportTypeUSB: return "USB"
    case kAudioDeviceTransportTypeDisplayPort: return "DisplayPort"
    case kAudioDeviceTransportTypeHDMI: return "HDMI"
    case kAudioDeviceTransportTypeAggregate: return "Aggregate"
    case kAudioDeviceTransportTypeVirtual: return "Virtual"
    default: return "Other"
    }
}

private func defaultInputDeviceInfo() -> InputDeviceInfo? {
    var device = AudioDeviceID(kAudioObjectUnknown)
    var deviceSize = UInt32(MemoryLayout<AudioDeviceID>.size)
    var defaultAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    guard AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &defaultAddress, 0, nil, &deviceSize, &device
    ) == noErr, device != kAudioObjectUnknown else { return nil }

    var sampleRate = 0.0
    var sampleRateSize = UInt32(MemoryLayout<Double>.size)
    var sampleRateAddress = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyNominalSampleRate,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    _ = AudioObjectGetPropertyData(device, &sampleRateAddress, 0, nil, &sampleRateSize, &sampleRate)

    var transport = UInt32(0)
    var transportSize = UInt32(MemoryLayout<UInt32>.size)
    var transportAddress = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyTransportType,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    _ = AudioObjectGetPropertyData(device, &transportAddress, 0, nil, &transportSize, &transport)

    var channelCount: UInt32 = 0
    var streamsAddress = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: kAudioDevicePropertyScopeInput,
        mElement: kAudioObjectPropertyElementMain
    )
    var streamsSize: UInt32 = 0
    if AudioObjectGetPropertyDataSize(device, &streamsAddress, 0, nil, &streamsSize) == noErr, streamsSize > 0 {
        let storage = UnsafeMutableRawPointer.allocate(
            byteCount: Int(streamsSize), alignment: MemoryLayout<AudioBufferList>.alignment
        )
        defer { storage.deallocate() }
        let list = storage.assumingMemoryBound(to: AudioBufferList.self)
        if AudioObjectGetPropertyData(device, &streamsAddress, 0, nil, &streamsSize, list) == noErr {
            channelCount = UnsafeMutableAudioBufferListPointer(list).reduce(0) { $0 + $1.mNumberChannels }
        }
    }

    return InputDeviceInfo(
        id: device,
        name: propertyString(device, selector: kAudioObjectPropertyName) ?? "System Default",
        transport: transportName(transport),
        sampleRate: sampleRate,
        channelCount: channelCount
    )
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
    let input = defaultInputDeviceInfo()
    let supportedLocales = SFSpeechRecognizer.supportedLocales()
        .map(\.identifier).sorted().prefix(512)
    writeEvent(id: id, event: "status", values: [
        "microphonePermission": microphonePermissionName(AVCaptureDevice.authorizationStatus(for: .audio)),
        "speechRecognitionPermission": permissionName(SFSpeechRecognizer.authorizationStatus()),
        "recognizerAvailable": recognizer?.isAvailable ?? false,
        "onDevice": recognizer?.supportsOnDeviceRecognition ?? false,
        "streaming": true,
        "locale": locale,
        "supportedLocales": Array(supportedLocales),
        "inputDeviceName": input?.name ?? "System Default",
        "inputDeviceTransport": input?.transport ?? "Unknown",
        "sampleRate": input?.sampleRate ?? 0,
        "channelCount": input?.channelCount ?? 0
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
    private let finishMode: FinishSpeakingMode
    private let initialSilenceTimeoutMs: Int
    private let endSilenceMs: Int
    private let maximumDurationMs: Int
    private let maximumTranscriptCharacters: Int
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var finalTranscript = ""
    private var state: VoiceSessionState = .starting
    private var finalizationStarted = false
    private var finished = false
    private var tapInstalled = false
    private var monitor: DispatchSourceTimer?
    private var finalizationFallback: DispatchWorkItem?
    private var lastAmplitudeAt = 0.0
    private var startedAt = 0.0
    private var speechStartedAt: Double?
    private var lastVoiceAt: Double?
    private var lastPartialAt: Double?
    private var voiceCandidateAt: Double?
    private var noiseFloor: Float = 0.004
    private var partialResultCount = 0
    private var finalizationReason: FinalizationReason?
    private var inputDevice: InputDeviceInfo?
    private var captureSampleRate = 0.0
    private var captureChannelCount: AVAudioChannelCount = 0
    private var defaultInputListener: AudioObjectPropertyListenerBlock?
    private var configurationObserver: NSObjectProtocol?

    init(
        id: String,
        locale: String,
        requireOnDevice: Bool,
        finishMode: FinishSpeakingMode,
        initialSilenceTimeoutMs: Int,
        endSilenceMs: Int,
        maximumDurationMs: Int,
        maximumTranscriptCharacters: Int
    ) {
        self.id = id
        self.locale = locale
        self.requireOnDevice = requireOnDevice
        self.finishMode = finishMode
        self.initialSilenceTimeoutMs = initialSilenceTimeoutMs
        self.endSilenceMs = endSilenceMs
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
        inputDevice = defaultInputDeviceInfo()
        captureSampleRate = format.sampleRate
        captureChannelCount = format.channelCount
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
            DispatchQueue.main.async { [weak self] in self?.observeAudioEnergy(rms, at: now) }
        }
        tapInstalled = true
        audioEngine.prepare()
        do { try audioEngine.start() }
        catch {
            inputNode.removeTap(onBus: 0)
            throw HelperFailure(code: "microphone-unavailable", message: "The microphone could not be started.")
        }

        task = recognizer.recognitionTask(with: recognitionRequest) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, !self.finished else { return }
                if let result {
                    let transcript = String(result.bestTranscription.formattedString.prefix(self.maximumTranscriptCharacters))
                    self.finalTranscript = transcript
                    if result.isFinal {
                        if self.finalizationStarted { self.finishSuccess(transcript: transcript) }
                        else { self.beginFinalization(reason: .speechFramework, finalTranscript: transcript) }
                    } else {
                        self.observePartial(transcript)
                    }
                } else if error != nil {
                    if self.finalizationStarted { self.finishSuccess(transcript: self.finalTranscript) }
                    else {
                        self.finishWithError(HelperFailure(code: "recognition-failed", message: "Speech recognition stopped before producing a final transcript."))
                    }
                }
            }
        }

        startedAt = ProcessInfo.processInfo.systemUptime
        transition(to: .listening)
        installAudioRouteObservers()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
        timer.setEventHandler { [weak self] in self?.evaluateEndOfSpeech() }
        timer.resume()
        monitor = timer
        let device = inputDevice
        writeEvent(id: id, event: "ready", values: [
            "locale": locale,
            "onDevice": requireOnDevice,
            "onDeviceSupported": recognizer.supportsOnDeviceRecognition,
            "inputDeviceName": device?.name ?? "System Default",
            "inputDeviceTransport": device?.transport ?? "Unknown",
            "sampleRate": format.sampleRate,
            "channelCount": format.channelCount,
            "finishSpeaking": finishMode.rawValue
        ])
        emitDiagnostics()
        listenForCommands()
    }

    private func transition(to next: VoiceSessionState, reason: FinalizationReason? = nil) {
        guard !finished || next == .completed || next == .cancelled || next == .failed else { return }
        guard state != next else { return }
        state = next
        var values: [String: Any] = ["state": next.rawValue]
        if let reason { values["reason"] = reason.rawValue }
        writeEvent(id: id, event: "state", values: values)
    }

    private func observePartial(_ transcript: String) {
        guard !finalizationStarted, !finished else { return }
        finalTranscript = transcript
        partialResultCount += 1
        let now = ProcessInfo.processInfo.systemUptime
        lastPartialAt = now
        if !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            markSpeechDetected(at: now)
        }
        writeEvent(id: id, event: "partial", values: ["transcript": transcript, "cancelled": false])
    }

    private func observeAudioEnergy(_ rms: Float, at now: Double) {
        guard !finalizationStarted, !finished else { return }
        let threshold = max(0.008, min(0.035, noiseFloor * 3.0))
        let voiced = rms >= threshold
        if speechStartedAt == nil && !voiced {
            noiseFloor = max(0.001, min(0.02, noiseFloor * 0.97 + rms * 0.03))
        }
        if voiced {
            if voiceCandidateAt == nil { voiceCandidateAt = now }
            if speechStartedAt != nil || now - (voiceCandidateAt ?? now) >= 0.12 {
                lastVoiceAt = now
                markSpeechDetected(at: now)
            }
        } else {
            voiceCandidateAt = nil
        }
    }

    private func markSpeechDetected(at now: Double) {
        if speechStartedAt == nil { speechStartedAt = now }
        if state == .listening || state == .waitingForEnd { transition(to: .speechDetected) }
    }

    private func evaluateEndOfSpeech() {
        guard !finalizationStarted, !finished else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if now - startedAt >= Double(maximumDurationMs) / 1_000 {
            beginFinalization(reason: .timeout)
            return
        }
        guard speechStartedAt != nil else {
            if finishMode == .auto && now - startedAt >= Double(initialSilenceTimeoutMs) / 1_000 {
                beginFinalization(reason: .timeout)
            }
            return
        }
        let lastActivity = max(lastVoiceAt ?? speechStartedAt ?? now, lastPartialAt ?? speechStartedAt ?? now)
        let silence = now - lastActivity
        if silence >= 0.3 && state == .speechDetected { transition(to: .waitingForEnd) }
        if silence < 0.3 && state == .waitingForEnd { transition(to: .speechDetected) }
        if finishMode == .auto && silence >= Double(endSilenceMs) / 1_000 {
            beginFinalization(reason: .silence)
        }
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
                    let rawReason = object["reason"] as? String
                    let reason = rawReason.flatMap(FinalizationReason.init(rawValue:)) ?? .manual
                    DispatchQueue.main.async { self?.beginFinalization(reason: reason) }
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

    private func beginFinalization(reason: FinalizationReason, finalTranscript: String? = nil) {
        guard !finalizationStarted, !finished else { return }
        finalizationStarted = true
        finalizationReason = reason
        transition(to: .finalizingTranscript, reason: reason)
        stopAudio()
        request?.endAudio()
        monitor?.cancel()
        monitor = nil
        if let finalTranscript {
            finishSuccess(transcript: finalTranscript)
            return
        }
        let fallback = DispatchWorkItem { [weak self] in
            guard let self, !self.finished else { return }
            self.finishSuccess(transcript: self.finalTranscript)
        }
        finalizationFallback = fallback
        // Bluetooth routes can deliver their final recognition result later
        // than built-in microphones. Keep the request alive long enough to
        // preserve the last word after endAudio().
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(2_500), execute: fallback)
    }

    func cancel() {
        guard !finished else { return }
        finalizationReason = .cancel
        finished = true
        transition(to: .cancelled, reason: .cancel)
        cleanup(cancelTask: true)
        emitDiagnostics()
        writeEvent(id: id, event: "final", values: [
            "transcript": "", "cancelled": true, "reason": FinalizationReason.cancel.rawValue
        ])
        exit(0)
    }

    private func finishWithError(_ failure: HelperFailure) {
        guard !finished else { return }
        finished = true
        transition(to: .failed)
        cleanup(cancelTask: true)
        emitDiagnostics()
        writeEvent(id: id, event: "error", values: ["error": ["code": failure.code, "message": failure.message]])
        exit(1)
    }

    private func finishSuccess(transcript: String) {
        guard !finished else { return }
        finished = true
        finalTranscript = transcript
        finalizationFallback?.cancel()
        finalizationFallback = nil
        cleanup(cancelTask: false)
        transition(to: .completed, reason: finalizationReason)
        emitDiagnostics()
        writeEvent(id: id, event: "final", values: [
            "transcript": finalTranscript,
            "cancelled": false,
            "reason": (finalizationReason ?? .speechFramework).rawValue
        ])
        exit(0)
    }

    private func cleanup(cancelTask: Bool) {
        monitor?.cancel()
        monitor = nil
        finalizationFallback?.cancel()
        finalizationFallback = nil
        stopAudio()
        request?.endAudio()
        if cancelTask { task?.cancel() } else { task?.finish() }
        task = nil
        request = nil
        removeAudioRouteObservers()
    }

    private func stopAudio() {
        if audioEngine.isRunning { audioEngine.stop() }
        if tapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
    }

    private func installAudioRouteObservers() {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            DispatchQueue.main.async { self?.handleAudioRouteChange() }
        }
        if AudioObjectAddPropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject), &address, DispatchQueue.main, listener
        ) == noErr {
            defaultInputListener = listener
        }
        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: audioEngine,
            queue: .main
        ) { [weak self] _ in self?.handleAudioRouteChange() }
    }

    private func removeAudioRouteObservers() {
        if let listener = defaultInputListener {
            var address = AudioObjectPropertyAddress(
                mSelector: kAudioHardwarePropertyDefaultInputDevice,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )
            AudioObjectRemovePropertyListenerBlock(
                AudioObjectID(kAudioObjectSystemObject), &address, DispatchQueue.main, listener
            )
            defaultInputListener = nil
        }
        if let configurationObserver {
            NotificationCenter.default.removeObserver(configurationObserver)
            self.configurationObserver = nil
        }
    }

    private func handleAudioRouteChange() {
        guard !finalizationStarted, !finished else { return }
        let current = defaultInputDeviceInfo()
        let format = audioEngine.inputNode.outputFormat(forBus: 0)
        let changedDevice = current?.id != inputDevice?.id
        let invalidFormat = format.sampleRate <= 0 || format.channelCount == 0
        let changedFormat = abs(format.sampleRate - captureSampleRate) > 1 || format.channelCount != captureChannelCount
        if changedDevice || invalidFormat || changedFormat {
            finishWithError(HelperFailure(
                code: "microphone-disconnected",
                message: "Microphone disconnected or changed. Try the voice request again."
            ))
        }
    }

    private func emitDiagnostics() {
        let now = ProcessInfo.processInfo.systemUptime
        let lastActivity = max(lastVoiceAt ?? speechStartedAt ?? now, lastPartialAt ?? speechStartedAt ?? now)
        var values: [String: Any] = [
            "inputDeviceName": inputDevice?.name ?? "System Default",
            "inputDeviceTransport": inputDevice?.transport ?? "Unknown",
            "sampleRate": captureSampleRate,
            "channelCount": captureChannelCount,
            "locale": locale,
            "onDeviceRequested": requireOnDevice,
            "onDeviceSupported": true,
            "onDeviceActive": requireOnDevice,
            "sessionDurationMs": max(0, Int((now - startedAt) * 1_000)),
            "partialResultCount": partialResultCount
        ]
        if let speechStartedAt { values["speechStartMs"] = max(0, Int((speechStartedAt - startedAt) * 1_000)) }
        if speechStartedAt != nil { values["finalSilenceMs"] = max(0, Int((now - lastActivity) * 1_000)) }
        if let finalizationReason { values["finalizationReason"] = finalizationReason.rawValue }
        writeEvent(id: id, event: "diagnostic", values: values)
    }
}

if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--play-pcm-24000" {
    do {
        try playPCMStream()
        exit(0)
    } catch {
        // Audio-mode errors are deliberately generic; request text and credentials
        // are never written to this helper's stdout or stderr.
        exit(1)
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
        "version", "id", "command", "locale", "requireOnDevice", "finishSpeaking", "initialSilenceTimeoutMs",
        "endSilenceMs", "maximumDurationMs", "maximumTranscriptCharacters"
    ])
    guard let requireOnDevice = request["requireOnDevice"] as? Bool else {
        throw HelperFailure(code: "invalid-request", message: "The recognition privacy policy is invalid.")
    }
    guard let finishModeValue = request["finishSpeaking"] as? String,
          let finishMode = FinishSpeakingMode(rawValue: finishModeValue) else {
        throw HelperFailure(code: "invalid-request", message: "The finish-speaking mode is invalid.")
    }
    let initialSilence = try boundedInteger(
        request["initialSilenceTimeoutMs"], minimum: 5_000, maximum: 30_000, label: "Initial listening timeout"
    )
    let endSilence = try boundedInteger(
        request["endSilenceMs"], minimum: 1_200, maximum: 2_500, label: "End-of-speech delay"
    )
    let duration = try boundedInteger(request["maximumDurationMs"], minimum: minimumDurationMs, maximum: maximumDurationMs, label: "Recognition duration")
    let transcriptCharacters = try boundedInteger(request["maximumTranscriptCharacters"], minimum: 1, maximum: maximumTranscriptCharacters, label: "Transcript size")
    let controller = RecognitionController(
        id: id,
        locale: locale,
        requireOnDevice: requireOnDevice,
        finishMode: finishMode,
        initialSilenceTimeoutMs: initialSilence,
        endSilenceMs: endSilence,
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
