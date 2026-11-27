import AppKit
import Foundation
import SwiftUI

struct WorkspaceRootReview: Codable, Equatable, Sendable {
    struct Operation: Codable, Equatable, Sendable { let type: String; let path: String }
    struct Selection: Codable, Equatable, Sendable { let path: String; let dev: String; let ino: String }
    let version: Int
    let before: [String]
    let after: [String]
    let operation: Operation
    let selection: Selection
    let restartRequired: Bool
    let verificationRequired: Bool
    let digest: String
}

struct WorkspaceRootRequest: Encodable, Sendable {
    let command: String
    var path: String? = nil
    var review: WorkspaceRootReview? = nil
}

struct WorkspaceRootResponse: Decodable, Sendable {
    let ok: Bool
    var roots: [String]? = nil
    var managed: Bool? = nil
    var recoveryPending: Bool? = nil
    var review: WorkspaceRootReview? = nil
    var status: String? = nil
    var reason: String? = nil
    var probeRevoked: Bool? = nil
    var code: String? = nil
    var message: String? = nil
}

enum WorkspaceRootHelper {
    static func request(_ request: WorkspaceRootRequest) async throws -> WorkspaceRootResponse {
        try await Task.detached(priority: .userInitiated) {
            guard let runner = Bundle.main.path(forResource: "devspace-runner", ofType: "zsh") else {
                throw CocoaError(.fileNoSuchFile)
            }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/zsh")
            process.arguments = [runner, "--workspace-root-helper"]
            // Never inherit a remote session's runtime overrides, secret
            // variables, or NODE_OPTIONS into this local administrator helper.
            process.environment = [
                "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
                "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
                "TMPDIR": FileManager.default.temporaryDirectory.path,
                "LANG": "en_US.UTF-8"
            ]
            let input = Pipe(), output = Pipe()
            process.standardInput = input
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            let encoded = try JSONEncoder().encode(request)
            try process.run()
            try input.fileHandleForWriting.write(contentsOf: encoded)
            try input.fileHandleForWriting.close()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0, data.count < 1024 * 1024 else {
                throw CocoaError(.fileReadUnknown)
            }
            return try JSONDecoder().decode(WorkspaceRootResponse.self, from: data)
        }.value
    }
}

@MainActor
final class WorkspaceDirectoryModel: ObservableObject {
    @Published private(set) var roots: [String] = []
    @Published private(set) var managed = false
    @Published private(set) var recoveryPending = false
    @Published private(set) var loaded = false
    @Published private(set) var busy = false
    @Published private(set) var message = ""
    @Published private(set) var failed = false
    @Published private(set) var verifiedPath: String?
    private let request: (WorkspaceRootRequest) async throws -> WorkspaceRootResponse

    init(request: @escaping (WorkspaceRootRequest) async throws -> WorkspaceRootResponse = WorkspaceRootHelper.request) {
        self.request = request
    }

    var canAdd: Bool { loaded && managed && !busy && !recoveryPending }

    private func report(_ text: String, failure: Bool) { message = text; failed = failure }

    private func fetchList() async {
        do {
            let response = try await request(.init(command: "list"))
            guard response.ok, let list = response.roots else {
                loaded = false; managed = false; roots = []
                report(response.message ?? "Configuration unavailable.", failure: true); return
            }
            roots = list
            loaded = true
            managed = response.managed == true
            recoveryPending = response.recoveryPending == true
            if let verifiedPath, !roots.contains(verifiedPath) { self.verifiedPath = nil }
            if recoveryPending { report("A previous change needs recovery review. Further changes are blocked.", failure: true) }
            else if !managed { report("The running backend is not recognized as the managed DevSpace service.", failure: true) }
        } catch {
            loaded = false; managed = false; roots = []
            report("Could not read the local workspace configuration.", failure: true)
        }
    }

    func refresh() async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        message = ""; failed = false; verifiedPath = nil
        await fetchList()
    }

    func chooseDirectory() async {
        guard canAdd else { return }
        let panel = NSOpenPanel()
        panel.title = "Authorize a Working Directory"
        panel.prompt = "Review"
        panel.message = "Choose a project folder on this Mac. Existing permissions will be preserved."
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let selected = panel.url else { return }
        await reviewAndApply(path: selected.path) { review in
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = "Authorize this working directory?"
            alert.informativeText = "\(review.selection.path)\n\nExisting roots will be retained. DevSpace must restart and active operations may be interrupted. Choose Apply only when your work is idle. macOS will request local owner authentication. This does not sandbox shell commands."
            alert.addButton(withTitle: "Apply and Restart")
            alert.addButton(withTitle: "Cancel")
            return alert.runModal() == .alertFirstButtonReturn
        }
    }

    // The confirmation callback is injected in layout/model tests; production
    // always uses the native picker and confirmation dialog above. The bundled
    // helper additionally requires macOS owner authentication before writing.
    func reviewAndApply(path: String, confirm: (WorkspaceRootReview) -> Bool) async {
        guard canAdd else { return }
        busy = true; defer { busy = false }
        message = ""; failed = false; verifiedPath = nil
        do {
            let proposed = try await request(.init(command: "review", path: path))
            guard proposed.ok, let review = proposed.review else {
                report(proposed.message ?? "The selected folder could not be reviewed.", failure: true); return
            }
            guard confirm(review) else { return }
            report("Applying reviewed change and verifying access…", failure: false)
            let applied = try await request(.init(command: "apply", review: review))
            if applied.ok && applied.status == "committed" {
                roots = applied.roots ?? []
                verifiedPath = review.selection.path
                report(applied.probeRevoked == false ? "New workspace access verified. Temporary verification credentials could not be confirmed revoked." : "New workspace access verified.", failure: applied.probeRevoked == false)
            } else if applied.ok && applied.status == "rolled_back" {
                report("Change was not activated. The original configuration and access were restored.", failure: true)
            } else {
                report(applied.message ?? "Change could not be verified. Check the local recovery state.", failure: true)
            }
            await fetchList()
        } catch {
            report("Local operation failed. Refresh to check the configuration and recovery state.", failure: true)
            await fetchList()
        }
    }
}
