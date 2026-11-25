import Foundation

@main
struct DevicePanelClientTest {
    static func main() async throws {
        guard CommandLine.arguments.count == 4,
              let livePort = Int(CommandLine.arguments[1]),
              let oldPort = Int(CommandLine.arguments[2]) else { fatalError("Expected fixture ports and state path") }
        let state = URL(fileURLWithPath: CommandLine.arguments[3])
        let api = DeviceDirectoryClient(routerPort: livePort, stateFile: state)
        let legacy = api.legacyRegistrations()
        precondition(legacy.count == 2)
        precondition(legacy.contains(where: { $0.id == "legacy-win" && $0.kind == "agent" }))
        precondition(legacy.contains(where: { $0.id == "peer-win" && $0.kind == "router" }))
        precondition(legacy.allSatisfy { $0.status == "unknown" && !$0.online })
        print("PASS: legacy Agent and Peer registrations both visible with unknown status")
        let usage = try await api.usage()
        precondition(usage.httpsRequests == 42 && usage.totalBytes == 6144)
        precondition(usage.categories?.reduce(0, { $0 + $1.requests }) == usage.httpsRequests)
        precondition(usage.categories?.contains { $0.id == "historical" && $0.requests == 30 } == true)
        precondition(usage.recentRequests?.first?.resultTitle == "HTTP 200")
        precondition(usage.recentRequests?.first?.title == "MCP / tool requests")
        let previous = TrafficSnapshot(version: 1, since: 1000, sampledAt: 1000,
            httpsRequests: 40, receivedBytes: 1024, sentBytes: 2048, persistenceError: false)
        precondition(usage.rates(since: previous).received == 512)
        precondition(usage.rates(since: previous).sent == 1024)
        let reset = TrafficSnapshot(version: 1, since: 3000, sampledAt: 4000,
            httpsRequests: 0, receivedBytes: 0, sentBytes: 0, persistenceError: false)
        precondition(reset.rates(since: usage).received == 0)
        print("PASS: real usage schema, bytes, sampled rates and reset handling")
        let catalog = state.deletingLastPathComponent().appendingPathComponent("devices.json")
        try Data("""
        {"devices":[{"id":"windows-current","installationId":"win-install","defaultName":"Windows Router","platform":"win32","kind":"router"}]}
        """.utf8).write(to: catalog)
        precondition(api.cachedDirectory().count == 1)
        precondition(api.cachedDirectory()[0].name == "Windows Router")
        precondition(api.cachedDirectory()[0].displaySeverity == .unknown)
        print("PASS: registered Windows survives offline startup without false liveness")
        let devices = try await api.devices()
        precondition(devices.count == 2)
        precondition(devices[0].id == "mac-id" && devices[0].isThisDevice)
        precondition(devices[1].id == "win-id" && devices[1].status == "offline")
        func device(_ json: String) -> DeviceInfo {
            try! JSONDecoder().decode(DeviceInfo.self, from: Data(json.utf8))
        }
        let oldAgent = device("""
        {"id":"agent-win","name":"Wins","platform":"win32","kind":"agent",
         "isThisDevice":false,"status":"online","online":true,
         "backendReachable":true,"lastSeenAt":1700000000000}
        """)
        precondition(oldAgent.displayTitle == "Agent online")
        precondition(oldAgent.displaySeverity == .connected)
        precondition(oldAgent.backendTitle == "Unverified (heartbeat only)")
        precondition(oldAgent.executionTitle == "Not verified")
        let newAgent = device("""
        {"id":"agent-v1","name":"Wins","platform":"win32","kind":"agent",
         "isThisDevice":false,"status":"online","online":true,
         "backendReachable":null,"executionVerified":null}
        """)
        precondition(newAgent.displayTitle == "Agent online")
        precondition(newAgent.displaySeverity == .connected)
        let remotePeer = device("""
        {"id":"peer-win","name":"Peer","platform":"win32","kind":"router",
         "isThisDevice":false,"status":"online","online":true,
         "backendReachable":true}
        """)
        precondition(remotePeer.displayTitle == "Online" && remotePeer.displaySeverity == .connected)
        let onlineWindows = device("""
        {"id":"windows-sse","name":"Windows","platform":"win32","kind":"router",
         "isThisDevice":false,"status":"online","online":true,"backendReachable":null}
        """)
        precondition(onlineWindows.displaySeverity == .connected)
        precondition(onlineWindows.executionTitle == "Not verified")
        let failed = device("""
        {"id":"windows-failed","name":"Windows","platform":"win32","kind":"router",
         "isThisDevice":false,"status":"online","online":true,"backendReachable":false}
        """)
        precondition(failed.displaySeverity == .caution)
        let executionFailed = device("""
        {"id":"windows-exec","name":"Windows","platform":"win32","kind":"router",
         "isThisDevice":false,"status":"online","online":true,"executionVerified":false}
        """)
        precondition(executionFailed.displaySeverity == .caution)
        precondition(onlineWindows.withUnknownStatus().displaySeverity == .unknown)
        let verifiedLocal = device("""
        {"id":"mac","name":"Mac","platform":"darwin","kind":"router",
         "isThisDevice":true,"status":"online","online":true,"backendReachable":true}
        """)
        precondition(verifiedLocal.displayTitle == "Ready" && verifiedLocal.displaySeverity == .ready)
        let degradedLocal = device("""
        {"id":"mac","name":"Mac","platform":"darwin","kind":"router",
         "isThisDevice":true,"status":"degraded","online":false,"backendReachable":false}
        """)
        precondition(verifiedLocal.withLocalHealth(connected: false, backend: true).displaySeverity == .offline)
        precondition(verifiedLocal.withLocalHealth(connected: true, backend: false).displaySeverity == .caution)
        precondition(verifiedLocal.withLocalHealth(connected: true, backend: true).displaySeverity == .ready)
        precondition(degradedLocal.displayTitle == "Degraded" && degradedLocal.displaySeverity == .caution)
        precondition(devices[1].displayTitle == "Offline")
        print("PASS: Agent heartbeat and peer backend health never falsely show execution ready")
        precondition(PanelConnectionStatus.resolve([.ready, .connected]) == .connected)
        precondition(PanelConnectionStatus.connected.iconAlpha == 1)
        precondition(PanelConnectionStatus.partial.iconAlpha == 1)
        precondition(PanelConnectionStatus.offline.iconAlpha < 1)
        precondition(PanelConnectionStatus.resolve([.ready, .offline]) == .partial)
        precondition(PanelConnectionStatus.resolve([.ready, .unknown]) == .partial)
        precondition(PanelConnectionStatus.resolve([.unknown, .unknown]) == .checking)
        precondition(PanelConnectionStatus.resolve([.offline, .offline]) == .offline)
        print("PASS: icon summary matches all-green, partial, stale and offline device rows")
        let now = Date()
        let healthy = ExternalConnectivity(chatGPT: true, ingress: true, checkedAt: now)
        precondition(healthy.ready(at: now))
        precondition(!healthy.ready(at: now.addingTimeInterval(41)))
        precondition(!ExternalConnectivity(chatGPT: false, ingress: true, checkedAt: now).ready(at: now))
        precondition(!ExternalConnectivity(chatGPT: true, ingress: false, checkedAt: now).ready(at: now))
        precondition(verifiedLocal.withExternalUnavailable().displaySeverity == .caution)
        precondition(verifiedLocal.withUnknownStatus().displaySeverity == .unknown)
        let base = "http://127.0.0.1:\(livePort)/probe/"
        func probe(_ path: String) -> URL { URL(string: base + path)! }
        let up = await api.externalConnectivity(chatURL: probe("ok"), ingressURL: probe("ok"))
        precondition(up.ready())
        let down = await api.externalConnectivity(chatURL: probe("down"), ingressURL: probe("ok"))
        precondition(!down.chatGPT && down.ingress && !down.ready())
        let broken = await api.externalConnectivity(chatURL: probe("ok"), ingressURL: probe("backend-down"))
        precondition(broken.chatGPT && !broken.ingress && !broken.ready())
        let cached = await api.externalConnectivity(chatURL: probe("ok"), ingressURL: probe("down"), previous: up)
        precondition(cached.ingress && cached.ingressCheckedAt == up.ingressCheckedAt)
        let expired = ExternalConnectivity(chatGPT: true, ingress: true, checkedAt: Date(),
            ingressCheckedAt: Date().addingTimeInterval(-301))
        let rechecked = await api.externalConnectivity(chatURL: probe("ok"), ingressURL: probe("down"), previous: expired)
        precondition(!rechecked.ingress)
        let start = Date()
        let hung = await api.externalConnectivity(chatURL: probe("hang"), ingressURL: probe("ok"))
        precondition(!hung.ready() && Date().timeIntervalSince(start) < 8)
        let recovered = await api.externalConnectivity(chatURL: probe("ok"), ingressURL: probe("ok"))
        precondition(recovered.ready())
        print("PASS: disconnect, failed backend, stale health, bounded timeout, recovery and credential isolation")
        let sync = try await api.rename(id: "win-id", to: "Home GPU")
        precondition(sync.attempted == 2 && sync.delivered == 1)
        print("PASS: valid schema, local-first sorting, offline presence, rename delivery count")

        let old = DeviceDirectoryClient(routerPort: oldPort, stateFile: state)
        do { _ = try await old.devices(); fatalError("Old Router incorrectly accepted") }
        catch DirectoryFailure.notInstalled { print("PASS: missing Registry endpoint reported as not installed") }

        let missing = DeviceDirectoryClient(routerPort: livePort,
                                            stateFile: URL(fileURLWithPath: state.path + ".missing"))
        do { _ = try await missing.devices(); fatalError("Missing auth token incorrectly accepted") }
        catch DirectoryFailure.noAdminToken { print("PASS: missing admin credential fails closed") }

        let wrong = URL(fileURLWithPath: state.path + ".wrong")
        try Data("{\"adminToken\":\"\(String(repeating: "x", count: 40))\"}".utf8).write(to: wrong)
        let unauthorized = DeviceDirectoryClient(routerPort: livePort, stateFile: wrong)
        do { _ = try await unauthorized.devices(); fatalError("Wrong admin credential incorrectly accepted") }
        catch DirectoryFailure.unauthorized { print("PASS: invalid admin credential rejected") }
    }
}
