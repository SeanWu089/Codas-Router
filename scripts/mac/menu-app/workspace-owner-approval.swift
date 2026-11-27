import Foundation
import LocalAuthentication
import Darwin

// A local interactive OS prompt, deliberately without a password/token or
// noninteractive override. The existing same-account shell trust boundary
// still requires separate OS-level isolation; this is not a sandbox.
let context = LAContext()
context.localizedCancelTitle = "Cancel"
guard CommandLine.arguments.count == 2 else { exit(1) }
let selected = CommandLine.arguments[1]
guard selected.hasPrefix("/"), selected.count <= 1024,
      !selected.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { exit(1) }
var error: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { exit(1) }
let done = DispatchSemaphore(value: 0)
final class ApprovalResult: @unchecked Sendable { var approved = false }
let result = ApprovalResult()
context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Allow Codas to open this project folder: \(selected)") { success, _ in
    result.approved = success
    done.signal()
}
guard done.wait(timeout: .now() + 90) == .success else { context.invalidate(); exit(1) }
context.invalidate()
exit(result.approved ? 0 : 1)
