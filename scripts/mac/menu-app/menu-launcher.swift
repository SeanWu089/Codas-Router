import AppKit
import Foundation

// Launch the installed URL, even when LaunchServices knows another same-ID copy.
// This helper does not terminate applications or manage connection services.
func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

guard CommandLine.arguments.count == 2, CommandLine.arguments[1].hasPrefix("/") else {
    fail("Usage: CodasMenuLauncher /absolute/path/Codas-mac.app", code: 64)
}
let target = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    .standardizedFileURL.resolvingSymlinksInPath()
guard target.pathExtension == "app",
      let bundle = Bundle(url: target),
      bundle.bundleIdentifier == "com.codassol.mac",
      let executable = bundle.executableURL,
      FileManager.default.isExecutableFile(atPath: executable.path) else {
    fail("The target is not a valid Codas-mac application.")
}

let configuration = NSWorkspace.OpenConfiguration()
configuration.allowsRunningApplicationSubstitution = false
configuration.createsNewApplicationInstance = false
configuration.activates = false
configuration.addsToRecentItems = false

DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
    fail("Timed out opening the exact Codas-mac application URL.", code: 70)
}
NSWorkspace.shared.openApplication(at: target, configuration: configuration) { app, error in
    if let error { fail("Cannot open Codas-mac: \(error.localizedDescription)") }
    guard let app,
          let actual = app.bundleURL?.standardizedFileURL.resolvingSymlinksInPath(),
          actual == target,
          app.executableURL?.standardizedFileURL.resolvingSymlinksInPath()
            == executable.standardizedFileURL.resolvingSymlinksInPath() else {
        fail("LaunchServices returned a different application installation.")
    }
    let receipt: [String: Any] = ["bundle_path": actual.path,
                                "pid": app.processIdentifier,
                                "bundle_id": app.bundleIdentifier ?? ""]
    guard let data = try? JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys]) else {
        fail("Could not encode launch receipt.")
    }
    FileHandle.standardOutput.write(data + Data("\n".utf8))
    exit(0)
}
RunLoop.main.run()
