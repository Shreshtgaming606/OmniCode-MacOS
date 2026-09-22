import AppKit
import ApplicationServices
import CoreFoundation
import Darwin
import Foundation

private let protocolVersion = 1
private let maximumRequestBytes = 64 * 1024
private let maximumCoordinateMagnitude = 100_000.0
private let maximumMovementDurationMs = 1_000
private let maximumScrollDelta = 2_000
private let maximumTextCharacters = 8_192
private let maximumKeyRepeats = 20
private let takeoverTolerance = 12.0
private let eventMarker: Int64 = 0x4f4d4e4943555253 // "OMNICURS"

private let allowedBundleIdentifiers: Set<String> = [
    "com.omnicode.editor",
    "com.apple.finder",
    "com.apple.Safari",
    "com.google.Chrome",
    "com.apple.mail",
    "com.apple.iCal",
    "com.apple.Notes",
    "com.apple.Terminal",
    "com.apple.dt.Xcode",
    "com.apple.iphonesimulator",
    "com.apple.Preview",
    "com.apple.TextEdit"
]
private let omniCodeBundleIdentifier = "com.omnicode.editor"

private let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5,
    "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
    "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
    "9": 25, "7": 26, "8": 28, "0": 29,
    "o": 31, "u": 32, "i": 34, "p": 35,
    "return": 36, "l": 37, "j": 38, "k": 40,
    "n": 45, "m": 46,
    "tab": 48, "space": 49, "delete": 51, "escape": 53,
    "f5": 96, "f6": 97, "f7": 98, "f3": 99, "f8": 100,
    "f9": 101, "f11": 103, "f10": 109, "f12": 111,
    "home": 115, "page-up": 116, "forward-delete": 117, "f4": 118,
    "end": 119, "f2": 120, "page-down": 121, "f1": 122,
    "left": 123, "right": 124, "down": 125, "up": 126
]

private let allowedModifiers: Set<String> = ["command", "control", "option", "shift", "function"]

private struct HelperFailure: Error {
    let code: String
    let message: String
    let details: [String: Any]?

    init(_ code: String, _ message: String, details: [String: Any]? = nil) {
        self.code = code
        self.message = message
        self.details = details
    }
}

private func writeResponse(id: String, ok: Bool, result: Any? = nil, error: HelperFailure? = nil) {
    var response: [String: Any] = [
        "version": protocolVersion,
        "id": id,
        "ok": ok
    ]
    if ok {
        response["result"] = result ?? NSNull()
    } else if let error {
        var encodedError: [String: Any] = ["code": error.code, "message": error.message]
        if let details = error.details { encodedError["details"] = details }
        response["error"] = encodedError
    }
    guard JSONSerialization.isValidJSONObject(response),
          let data = try? JSONSerialization.data(withJSONObject: response),
          var line = String(data: data, encoding: .utf8) else {
        FileHandle.standardOutput.write(Data("{\"version\":1,\"id\":\"invalid\",\"ok\":false,\"error\":{\"code\":\"execution-failed\",\"message\":\"The native response could not be encoded.\"}}\n".utf8))
        return
    }
    line.append("\n")
    FileHandle.standardOutput.write(Data(line.utf8))
}

private func strictKeys(_ request: [String: Any], operationKeys: Set<String>) throws {
    let common: Set<String> = ["version", "id", "command"]
    guard Set(request.keys) == common.union(operationKeys) else {
        throw HelperFailure("invalid-request", "The native cursor request contains unsupported fields.")
    }
}

private func jsonNumber(_ value: Any?, named name: String) throws -> NSNumber {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
        throw HelperFailure("invalid-request", "\(name) must be numeric.")
    }
    return number
}

private func finiteDouble(_ value: Any?, named name: String, magnitude: Double) throws -> Double {
    let number = try jsonNumber(value, named: name).doubleValue
    guard number.isFinite, abs(number) <= magnitude else {
        throw HelperFailure("invalid-request", "\(name) is outside the supported range.")
    }
    return number
}

private func boundedInteger(_ value: Any?, named name: String, minimum: Int, maximum: Int) throws -> Int {
    let number = try jsonNumber(value, named: name)
    let double = number.doubleValue
    let integer = number.intValue
    guard double.isFinite, double == Double(integer), integer >= minimum, integer <= maximum else {
        throw HelperFailure("invalid-request", "\(name) is outside the supported range.")
    }
    return integer
}

private func cursorLocation() throws -> CGPoint {
    guard let event = CGEvent(source: nil) else {
        throw HelperFailure("execution-failed", "The current pointer location is unavailable.")
    }
    return event.location
}

private func pointObject(_ point: CGPoint) -> [String: Any] {
    ["x": point.x, "y": point.y]
}

private func frontmostWindowFrame(processIdentifier: pid_t) -> Any {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return NSNull()
    }
    for window in windows {
        guard let owner = window[kCGWindowOwnerPID as String] as? NSNumber,
              owner.int32Value == processIdentifier,
              let layer = window[kCGWindowLayer as String] as? NSNumber,
              layer.intValue == 0,
              let bounds = window[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: bounds),
              frame.width > 0, frame.height > 0 else { continue }
        return [
            "x": frame.origin.x,
            "y": frame.origin.y,
            "width": frame.width,
            "height": frame.height
        ] as [String: Any]
    }
    return NSNull()
}

private func observation() throws -> [String: Any] {
    let cursor = try cursorLocation()
    let frontmost = NSWorkspace.shared.frontmostApplication
    let application: Any
    if let frontmost {
        application = [
            "name": frontmost.localizedName ?? NSNull(),
            "bundleIdentifier": frontmost.bundleIdentifier ?? NSNull(),
            "processIdentifier": Int(frontmost.processIdentifier)
        ] as [String: Any]
    } else {
        application = NSNull()
    }
    return [
        "cursor": pointObject(cursor),
        "frontmostApplication": application,
        "frontmostWindow": frontmost.map { frontmostWindowFrame(processIdentifier: $0.processIdentifier) } ?? NSNull(),
        "observedAt": Date().timeIntervalSince1970 * 1_000
    ]
}

private func pointIsOnActiveDisplay(_ point: CGPoint) -> Bool {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return false }
    var displays = Array(repeating: CGDirectDisplayID(), count: Int(count))
    guard CGGetActiveDisplayList(count, &displays, &count) == .success else { return false }
    return displays.prefix(Int(count)).contains { CGDisplayBounds($0).contains(point) }
}

private func eventSource() throws -> CGEventSource {
    guard let source = CGEventSource(stateID: .hidSystemState) else {
        throw HelperFailure("execution-failed", "The macOS input event source is unavailable.")
    }
    source.localEventsSuppressionInterval = 0
    return source
}

private func requireAllowedInteractiveApplication() throws {
    guard let bundleIdentifier = NSWorkspace.shared.frontmostApplication?.bundleIdentifier,
          allowedBundleIdentifiers.contains(bundleIdentifier),
          bundleIdentifier != omniCodeBundleIdentifier else {
        throw HelperFailure(
            "invalid-request",
            "Omni Cursor Mode will not send input to OmniCode or an application outside its allowlist."
        )
    }
}

private func markAndPost(_ event: CGEvent) {
    event.setIntegerValueField(.eventSourceUserData, value: eventMarker)
    event.post(tap: .cghidEventTap)
}

private func postMouseMove(source: CGEventSource, point: CGPoint) throws {
    guard let event = CGEvent(
        mouseEventSource: source,
        mouseType: .mouseMoved,
        mouseCursorPosition: point,
        mouseButton: .left
    ) else {
        throw HelperFailure("execution-failed", "The pointer move event could not be created.")
    }
    markAndPost(event)
}

private func distanceFromPoint(_ point: CGPoint, toSegmentFrom start: CGPoint, through end: CGPoint) -> Double {
    let deltaX = end.x - start.x
    let deltaY = end.y - start.y
    let squaredLength = deltaX * deltaX + deltaY * deltaY
    if squaredLength == 0 { return hypot(point.x - start.x, point.y - start.y) }
    let projection = max(0, min(1, ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / squaredLength))
    let nearest = CGPoint(x: start.x + projection * deltaX, y: start.y + projection * deltaY)
    return hypot(point.x - nearest.x, point.y - nearest.y)
}

private func moveCursor(to destination: CGPoint, durationMs: Int) throws {
    guard pointIsOnActiveDisplay(destination) else {
        throw HelperFailure("invalid-request", "The requested pointer location is outside all active displays.")
    }
    let source = try eventSource()
    let start = try cursorLocation()
    let movementDistance = hypot(destination.x - start.x, destination.y - start.y)
    let timeSteps = Int(ceil(Double(durationMs) / 16.0))
    // Keep adjacent native events close enough that delayed cursor-state
    // updates are not mistaken for human takeover on long, fast moves.
    let spatialSteps = Int(ceil(movementDistance / 6.0))
    let steps = durationMs == 0 ? 1 : max(1, min(240, max(timeSteps, spatialSteps)))
    var lastPosted = start
    for index in 1...steps {
        if index > 1 {
            let current = try cursorLocation()
            // macOS can report cursor state several posted events behind on a
            // fast move. Remaining on the intended path is therefore safe;
            // moving off that path is treated as immediate human takeover.
            if distanceFromPoint(current, toSegmentFrom: start, through: destination) > takeoverTolerance {
                throw HelperFailure(
                    "user-takeover",
                    "Cursor control paused because the pointer was moved by the user.",
                    details: ["previousCursor": pointObject(lastPosted), "currentCursor": pointObject(current)]
                )
            }
        }
        let progress = Double(index) / Double(steps)
        let point = CGPoint(
            x: start.x + (destination.x - start.x) * progress,
            y: start.y + (destination.y - start.y) * progress
        )
        try postMouseMove(source: source, point: point)
        lastPosted = point
        if index < steps { usleep(useconds_t(max(1, durationMs / steps) * 1_000)) }
    }
    // CGEvent posting is asynchronous. Keep the short-lived helper alive until
    // macOS reaches the final point so the subsequent click cannot land on an
    // earlier point in the path.
    for _ in 0..<50 {
        usleep(5_000)
        let current = try cursorLocation()
        if hypot(current.x - destination.x, current.y - destination.y) <= 2.0 { return }
        if distanceFromPoint(current, toSegmentFrom: start, through: destination) > takeoverTolerance {
            throw HelperFailure(
                "user-takeover",
                "Cursor control paused because the pointer was moved by the user.",
                details: ["previousCursor": pointObject(lastPosted), "currentCursor": pointObject(current)]
            )
        }
    }
    throw HelperFailure("execution-failed", "macOS did not move the pointer to the requested location in time.")
}

private func click(buttonName: String, count: Int) throws {
    let source = try eventSource()
    let point = try cursorLocation()
    let button: CGMouseButton = buttonName == "right" ? .right : .left
    let downType: CGEventType = buttonName == "right" ? .rightMouseDown : .leftMouseDown
    let upType: CGEventType = buttonName == "right" ? .rightMouseUp : .leftMouseUp
    for clickIndex in 1...count {
        guard let down = CGEvent(mouseEventSource: source, mouseType: downType, mouseCursorPosition: point, mouseButton: button),
              let up = CGEvent(mouseEventSource: source, mouseType: upType, mouseCursorPosition: point, mouseButton: button) else {
            throw HelperFailure("execution-failed", "The pointer click event could not be created.")
        }
        down.setIntegerValueField(.mouseEventClickState, value: Int64(clickIndex))
        up.setIntegerValueField(.mouseEventClickState, value: Int64(clickIndex))
        markAndPost(down)
        usleep(35_000)
        markAndPost(up)
        if clickIndex < count { usleep(70_000) }
    }
}

private func scroll(deltaX: Int, deltaY: Int) throws {
    let source = try eventSource()
    guard let event = CGEvent(
        scrollWheelEvent2Source: source,
        units: .pixel,
        wheelCount: 2,
        wheel1: Int32(-deltaY),
        wheel2: Int32(-deltaX),
        wheel3: 0
    ) else {
        throw HelperFailure("execution-failed", "The scroll event could not be created.")
    }
    markAndPost(event)
}

private func unicodeChunks(_ text: String, maximumUTF16Units: Int = 20) -> [[UInt16]] {
    var chunks: [[UInt16]] = []
    var current: [UInt16] = []
    for character in text {
        let units = Array(String(character).utf16)
        if !current.isEmpty && current.count + units.count > maximumUTF16Units {
            chunks.append(current)
            current = []
        }
        current.append(contentsOf: units)
    }
    if !current.isEmpty { chunks.append(current) }
    return chunks
}

private func focusedUIElement() throws -> AXUIElement {
    guard let frontmost = NSWorkspace.shared.frontmostApplication else {
        throw HelperFailure("execution-failed", "No frontmost application is available for text input.")
    }
    let application = AXUIElementCreateApplication(frontmost.processIdentifier)
    var focusedValue: CFTypeRef?
    if AXUIElementCopyAttributeValue(application, kAXFocusedUIElementAttribute as CFString, &focusedValue) == .success,
       let focusedValue {
        return focusedValue as! AXUIElement
    }
    let system = AXUIElementCreateSystemWide()
    focusedValue = nil
    if AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focusedValue) == .success,
       let focusedValue {
        return focusedValue as! AXUIElement
    }
    throw HelperFailure("execution-failed", "No focused user-interface element is available for text input.")
}

private func stringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value as? String
}

private func typeTextWithEvents(_ text: String) throws {
    let source = try eventSource()
    for units in unicodeChunks(text) {
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
            throw HelperFailure("execution-failed", "The text input event could not be created.")
        }
        units.withUnsafeBufferPointer { buffer in
            down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress!)
            up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress!)
        }
        markAndPost(down)
        markAndPost(up)
        // The helper is intentionally short lived. Give WindowServer enough
        // time to consume each Unicode pair before its event source exits.
        usleep(20_000)
    }
}

private func typeText(_ text: String) throws {
    let focused = try focusedUIElement()
    let role = stringAttribute(focused, kAXRoleAttribute as CFString)
    let subrole = stringAttribute(focused, kAXSubroleAttribute as CFString)
    guard role != "AXSecureTextField", subrole != "AXSecureTextField" else {
        throw HelperFailure("invalid-request", "Omni Cursor Mode refuses to type into a secure or password field.")
    }

    var selectedTextIsSettable = DarwinBoolean(false)
    if AXUIElementIsAttributeSettable(focused, kAXSelectedTextAttribute as CFString, &selectedTextIsSettable) == .success,
       selectedTextIsSettable.boolValue {
        let result = AXUIElementSetAttributeValue(focused, kAXSelectedTextAttribute as CFString, text as CFTypeRef)
        guard result == .success else {
            throw HelperFailure("execution-failed", "macOS rejected text input for the focused control.")
        }
        usleep(20_000)
        return
    }

    // Some canvas-backed editors expose focus and secure-field metadata but do
    // not expose a settable selected-text attribute.
    try typeTextWithEvents(text)
}

private func flags(for modifiers: [String]) throws -> CGEventFlags {
    var flags: CGEventFlags = []
    for modifier in modifiers {
        guard allowedModifiers.contains(modifier) else {
            throw HelperFailure("invalid-request", "The keyboard modifier is not allowlisted.")
        }
        switch modifier {
        case "command": flags.insert(.maskCommand)
        case "control": flags.insert(.maskControl)
        case "option": flags.insert(.maskAlternate)
        case "shift": flags.insert(.maskShift)
        case "function": flags.insert(.maskSecondaryFn)
        default: break
        }
    }
    return flags
}

private func pressKey(_ key: String, modifiers: [String], repeatCount: Int) throws {
    guard let keyCode = keyCodes[key] else {
        throw HelperFailure("invalid-request", "The keyboard key is not allowlisted.")
    }
    let source = try eventSource()
    let eventFlags = try flags(for: modifiers)
    for _ in 0..<repeatCount {
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) else {
            throw HelperFailure("execution-failed", "The keyboard event could not be created.")
        }
        down.flags = eventFlags
        up.flags = eventFlags
        markAndPost(down)
        usleep(20_000)
        markAndPost(up)
        usleep(10_000)
    }
    usleep(40_000)
}

private func focusApplication(bundleIdentifier: String) throws {
    guard allowedBundleIdentifiers.contains(bundleIdentifier) else {
        throw HelperFailure("invalid-request", "The application is not allowlisted for Cursor Mode.")
    }
    guard let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).first else {
        throw HelperFailure("application-not-running", "The requested application is not currently running.")
    }
    guard running.activate(options: [.activateAllWindows]) else {
        throw HelperFailure("execution-failed", "macOS did not allow the requested application to become active.")
    }
    usleep(80_000)
}

private func execute(_ request: [String: Any]) throws -> Any {
    guard AXIsProcessTrusted() else {
        throw HelperFailure("accessibility-denied", "Omni Cursor Mode requires Accessibility permission in System Settings.")
    }
    guard let command = request["command"] as? String else {
        throw HelperFailure("invalid-request", "The native cursor command is missing.")
    }
    switch command {
    case "observe":
        try strictKeys(request, operationKeys: [])
        return try observation()
    case "move":
        try strictKeys(request, operationKeys: ["x", "y", "durationMs"])
        let x = try finiteDouble(request["x"], named: "x-coordinate", magnitude: maximumCoordinateMagnitude)
        let y = try finiteDouble(request["y"], named: "y-coordinate", magnitude: maximumCoordinateMagnitude)
        let durationMs = try boundedInteger(request["durationMs"], named: "movement duration", minimum: 0, maximum: maximumMovementDurationMs)
        try moveCursor(to: CGPoint(x: x, y: y), durationMs: durationMs)
    case "click":
        try strictKeys(request, operationKeys: ["button", "count"])
        guard let button = request["button"] as? String, button == "left" || button == "right" else {
            throw HelperFailure("invalid-request", "The pointer button is not supported.")
        }
        let count = try boundedInteger(request["count"], named: "click count", minimum: 1, maximum: 2)
        try requireAllowedInteractiveApplication()
        try click(buttonName: button, count: count)
    case "scroll":
        try strictKeys(request, operationKeys: ["deltaX", "deltaY"])
        let deltaX = try boundedInteger(request["deltaX"], named: "horizontal scroll distance", minimum: -maximumScrollDelta, maximum: maximumScrollDelta)
        let deltaY = try boundedInteger(request["deltaY"], named: "vertical scroll distance", minimum: -maximumScrollDelta, maximum: maximumScrollDelta)
        guard deltaX != 0 || deltaY != 0 else {
            throw HelperFailure("invalid-request", "The scroll distance must not be zero.")
        }
        try requireAllowedInteractiveApplication()
        try scroll(deltaX: deltaX, deltaY: deltaY)
    case "type-text":
        try strictKeys(request, operationKeys: ["text"])
        guard let text = request["text"] as? String, !text.isEmpty, !text.contains("\0"), text.count <= maximumTextCharacters else {
            throw HelperFailure("invalid-request", "The text input is empty, invalid, or too large.")
        }
        try requireAllowedInteractiveApplication()
        try typeText(text)
    case "press-key":
        try strictKeys(request, operationKeys: ["key", "modifiers", "repeat"])
        guard let key = request["key"] as? String, keyCodes[key] != nil,
              let modifiers = request["modifiers"] as? [String], Set(modifiers).isSubset(of: allowedModifiers) else {
            throw HelperFailure("invalid-request", "The keyboard action is not allowlisted.")
        }
        let repeatCount = try boundedInteger(request["repeat"], named: "key repeat count", minimum: 1, maximum: maximumKeyRepeats)
        let isEmergencyStop = key == "escape" && Set(modifiers) == Set(["command", "shift"]) && repeatCount == 1
        if !isEmergencyStop { try requireAllowedInteractiveApplication() }
        try pressKey(key, modifiers: modifiers, repeatCount: repeatCount)
    case "focus-application":
        try strictKeys(request, operationKeys: ["bundleIdentifier"])
        guard let bundleIdentifier = request["bundleIdentifier"] as? String else {
            throw HelperFailure("invalid-request", "The application identifier is missing.")
        }
        try focusApplication(bundleIdentifier: bundleIdentifier)
    default:
        throw HelperFailure("invalid-request", "The native cursor command is not supported.")
    }
    return ["observation": try observation()]
}

var responseId = "invalid"
do {
    guard let requestData = try FileHandle.standardInput.read(upToCount: maximumRequestBytes + 1),
          !requestData.isEmpty, requestData.count <= maximumRequestBytes else {
        throw HelperFailure("invalid-request", "The native cursor request is empty or too large.")
    }
    guard let object = try JSONSerialization.jsonObject(with: requestData) as? [String: Any] else {
        throw HelperFailure("invalid-request", "The native cursor request is not a JSON object.")
    }
    if let id = object["id"] as? String,
       !id.isEmpty, id.count <= 64,
       id.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }) {
        responseId = id
    } else {
        throw HelperFailure("invalid-request", "The native cursor request identifier is invalid.")
    }
    let version = try boundedInteger(object["version"], named: "protocol version", minimum: protocolVersion, maximum: protocolVersion)
    guard version == protocolVersion else {
        throw HelperFailure("invalid-request", "The native cursor protocol version is unsupported.")
    }
    writeResponse(id: responseId, ok: true, result: try execute(object))
} catch let failure as HelperFailure {
    writeResponse(id: responseId, ok: false, error: failure)
} catch {
    writeResponse(id: responseId, ok: false, error: HelperFailure("execution-failed", "The native cursor action failed safely."))
}
