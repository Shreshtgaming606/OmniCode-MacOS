import Foundation

// Sonoma never imports or executes macOS 15-only frameworks.
@main
struct OmniModernLegacyStub {
    static func main() {
        let response = #"{"ok":false,"error":"This system feature requires Current OmniCode on macOS 15 or later."}"#
        FileHandle.standardOutput.write(Data((response + "\n").utf8))
    }
}
