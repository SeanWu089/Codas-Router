import Foundation

struct DirectoryResponse: Decodable {
    let version: Int
    let localDeviceId: String
    let devices: [DeviceInfo]
}

struct DeviceInfo: Decodable, Identifiable {
    let id: String
    let installationId: String?
    let name: String
    let platform: String
    let kind: String
    let isThisDevice: Bool
    let status: String
    let online: Bool
    // nil means no backend check was performed, which differs from false.
    let backendReachable: Bool?
    // A successful heartbeat or HTTP health response is not execution proof.
    let executionVerified: Bool?
    let lastSeenAt: Double?

    var displayTitle: String {
        if status == "external-unavailable" { return "External unavailable" }
        if status == "degraded" { return "Degraded" }
        if status == "unknown" { return "Unknown" }
        if status == "offline" || !online { return "Offline" }
        if isThisDevice { return backendReachable == true ? "Ready" : "Degraded" }
        if executionVerified == false { return "Execution failed" }
        if backendReachable == false && kind != "agent" { return "Backend unavailable" }
        if executionVerified == true { return "Ready" }
        return kind == "agent" ? "Agent online" : "Online"
    }

    enum DisplaySeverity { case ready, connected, caution, offline, unknown }

    var displaySeverity: DisplaySeverity {
        switch displayTitle {
        case "Ready": return .ready
        case "Online", "Agent online": return .connected
        case "Offline": return .offline
        case "Unknown": return .unknown
        default: return .caution
        }
    }

    var backendTitle: String {
        if kind == "agent" { return "Unverified (heartbeat only)" }
        switch backendReachable {
        case true: return "Reachable (not execution proof)"
        case false: return "Unreachable"
        case nil: return "Not checked"
        }
    }

    var executionTitle: String {
        switch executionVerified {
        case true: return "Verified"
        case false: return "Failed"
        case nil: return "Not verified"
        }
    }

    static func localFallback(connected: Bool, backend: Bool) -> DeviceInfo {
        DeviceInfo(id: "__local_preview__", installationId: nil,
                   name: Host.current().localizedName ?? "This Mac", platform: "darwin",
                   kind: "router", isThisDevice: true,
                   status: !connected ? "offline" : backend ? "online" : "degraded",
                   online: connected && backend, backendReachable: backend,
                   executionVerified: nil,
                   lastSeenAt: nil)
    }

    func withLocalHealth(connected: Bool, backend: Bool) -> DeviceInfo {
        DeviceInfo(id: id, installationId: installationId, name: name,
                   platform: platform, kind: kind, isThisDevice: isThisDevice,
                   status: !connected ? "offline" : backend ? "online" : "degraded",
                   online: connected && backend, backendReachable: backend,
                   executionVerified: executionVerified, lastSeenAt: lastSeenAt)
    }

    func withExternalUnavailable() -> DeviceInfo {
        DeviceInfo(id: id, installationId: installationId, name: name,
                   platform: platform, kind: kind, isThisDevice: isThisDevice,
                   status: "external-unavailable", online: online, backendReachable: backendReachable,
                   executionVerified: executionVerified, lastSeenAt: lastSeenAt)
    }

    func withUnknownStatus() -> DeviceInfo {
        DeviceInfo(id: id, installationId: installationId, name: name,
                   platform: platform, kind: kind, isThisDevice: isThisDevice,
                   status: "unknown", online: false, backendReachable: nil,
                   executionVerified: nil,
                   lastSeenAt: lastSeenAt)
    }
}

struct RouterHealth {
    let connected: Bool
    let backendReachable: Bool
}

enum DirectoryFailure: Error, LocalizedError {
    case notInstalled
    case noAdminToken
    case unauthorized
    case invalidReply
    case serviceUnavailable
    case requestFailed(String)

    var errorDescription: String? {
        switch self {
        case .notInstalled: return "Device Registry is not yet installed on this Router."
        case .noAdminToken: return "Local Router has no device-directory admin token yet."
        case .unauthorized: return "The Router rejected the local admin token."
        case .invalidReply: return "Invalid device directory response."
        case .serviceUnavailable: return "Local Router is unreachable."
        case .requestFailed(let message): return message
        }
    }
}

/// All catalog requests are loopback-only; never forwards an admin bearer to remote peers.
struct DeviceDirectoryClient {
    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.timeoutIntervalForRequest = 4
        config.timeoutIntervalForResource = 5
        return URLSession(configuration: config)
    }()
    private let base: URL
    private let stateFile: URL

    init(routerPort: Int = 17676, stateFile: URL? = nil) {
        base = URL(string: "http://127.0.0.1:\(routerPort)")!
        self.stateFile = stateFile ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codassol/router.json")
    }

    private func adminToken() throws -> String {
        guard let data = try? Data(contentsOf: stateFile),
              let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = record["adminToken"] as? String, token.count >= 32 else {
            throw DirectoryFailure.noAdminToken
        }
        return token
    }

    /// Read only display metadata from legacy Agent *and Peer* registrations.
    /// Neither source stores trustworthy freshness, so status MUST be unknown.
    func legacyRegistrations() -> [DeviceInfo] {
        let state = ((try? Data(contentsOf: stateFile)).flatMap {
            try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
        }) ?? [:]
        let agents = state["agents"] as? [String: [String: Any]] ?? [:]
        var entries: [String: DeviceInfo] = [:]
        for (id, record) in agents {
            guard !id.isEmpty, id.count <= 128 else { continue }
            let label = record["label"] as? String ?? id
            let platform = record["platform"] as? String ?? "unknown"
            entries[id] = DeviceInfo(id: id, installationId: nil,
                              name: label.isEmpty ? id : label, platform: platform,
                              kind: "agent", isThisDevice: false, status: "unknown",
                              online: false, backendReachable: nil,
                              executionVerified: nil, lastSeenAt: nil)
        }
        let peersPath = stateFile.deletingLastPathComponent().appendingPathComponent("peers.json")
        if let data = try? Data(contentsOf: peersPath),
           let peers = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
            for peer in peers {
                guard let id = peer["id"] as? String, !id.isEmpty, id.count <= 128,
                      entries[id] == nil else { continue }
                let label = peer["label"] as? String ?? id
                entries[id] = DeviceInfo(id: id, installationId: nil,
                    name: label.isEmpty ? id : label,
                    platform: peer["platform"] as? String ?? "unknown", kind: "router",
                    isThisDevice: false, status: "unknown", online: false,
                    backendReachable: nil, executionVerified: nil, lastSeenAt: nil)
            }
        }
        return entries.values.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// Keep enrolled machines visible even while the network/Router is unavailable.
    /// Disk metadata carries no liveness proof, so every cached row starts Unknown.
    func cachedDirectory() -> [DeviceInfo] {
        let file = stateFile.deletingLastPathComponent().appendingPathComponent("devices.json")
        guard let data = try? Data(contentsOf: file),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let records = json["devices"] as? [[String: Any]] else { return legacyRegistrations() }
        let state = (try? Data(contentsOf: stateFile)).flatMap {
            try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
        }
        let localInstallation = state?["installationId"] as? String
        return records.compactMap { record in
            guard let id = record["id"] as? String, !id.isEmpty else { return nil }
            let installation = record["installationId"] as? String
            let rename = record["rename"] as? [String: Any]
            return DeviceInfo(id: id, installationId: installation,
                name: rename?["name"] as? String ?? record["defaultName"] as? String ?? id,
                platform: record["platform"] as? String ?? "unknown",
                kind: record["kind"] as? String ?? "router",
                isThisDevice: installation != nil && installation == localInstallation,
                status: "unknown", online: false, backendReachable: nil,
                executionVerified: nil, lastSeenAt: nil)
        }
    }

    func usage() async throws -> TrafficSnapshot {
        let data = try await fetch("/_codassol/usage")
        let result = try JSONDecoder().decode(TrafficSnapshot.self, from: data)
        guard result.version == 1, result.httpsRequests >= 0,
              result.receivedBytes >= 0, result.sentBytes >= 0 else { throw DirectoryFailure.invalidReply }
        return result
    }

    private func fetch(_ endpoint: String, method: String = "GET", payload: Data? = nil) async throws -> Data {
        let url = URL(string: endpoint, relativeTo: base)!.absoluteURL
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 3
        request.setValue("Bearer \(try adminToken())", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let payload {
            request.httpBody = payload
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await Self.session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw DirectoryFailure.invalidReply }
        switch http.statusCode {
        case 200: return data
        case 401, 403: throw DirectoryFailure.unauthorized
        case 404: throw DirectoryFailure.notInstalled
        default: throw DirectoryFailure.requestFailed("Device Registry HTTP \(http.statusCode)")
        }
    }

    func devices() async throws -> [DeviceInfo] {
        let data = try await fetch("/_codassol/devices")
        let result = try JSONDecoder().decode(DirectoryResponse.self, from: data)
        guard result.version == 1, result.devices.contains(where: { $0.id == result.localDeviceId && $0.isThisDevice }) else {
            throw DirectoryFailure.invalidReply
        }
        return result.devices.sorted {
            if $0.isThisDevice != $1.isThisDevice { return $0.isThisDevice }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    func rename(id: String, to name: String) async throws -> (attempted: Int, delivered: Int) {
        let valid = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#%"))
        guard let escaped = id.addingPercentEncoding(withAllowedCharacters: valid) else {
            throw DirectoryFailure.requestFailed("Invalid device identifier")
        }
        let json = try JSONSerialization.data(withJSONObject: ["name": name])
        let data = try await fetch("/_codassol/devices/\(escaped)", method: "PATCH", payload: json)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["ok"] as? Bool == true else { throw DirectoryFailure.invalidReply }
        let sync = object["sync"] as? [String: Any] ?? [:]
        return (sync["attempted"] as? Int ?? 0, sync["delivered"] as? Int ?? 0)
    }

    func health(port: Int, path: String) async -> RouterHealth {
        guard let url = URL(string: "http://127.0.0.1:\(port)\(path)") else {
            return RouterHealth(connected: false, backendReachable: false)
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        do {
            let (data, response) = try await Self.session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let ok = json["ok"] as? Bool, ok else {
                return RouterHealth(connected: false, backendReachable: false)
            }
            return RouterHealth(connected: true,
                                backendReachable: json["backendReachable"] as? Bool ?? true)
        } catch {
            return RouterHealth(connected: false, backendReachable: false)
        }
    }
}

/// Network checks do not assert that a ChatGPT account/connector is authenticated.
struct ExternalConnectivity {
    let chatGPT: Bool
    let ingress: Bool
    let checkedAt: Date
    let ingressCheckedAt: Date
    init(chatGPT: Bool, ingress: Bool, checkedAt: Date, ingressCheckedAt: Date? = nil) {
        self.chatGPT = chatGPT
        self.ingress = ingress
        self.checkedAt = checkedAt
        self.ingressCheckedAt = ingressCheckedAt ?? checkedAt
    }
    func isFresh(at now: Date = Date()) -> Bool {
        let age = now.timeIntervalSince(checkedAt)
        return age >= 0 && age < 40 && now.timeIntervalSince(ingressCheckedAt) < 330
    }
    func ready(at now: Date = Date()) -> Bool { isFresh(at: now) && chatGPT && ingress }
}

extension DeviceDirectoryClient {
    static func configuredIngress() -> URL? {
        let file = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/com.codassol.ngrok.ingress.plist")
        guard let data = try? Data(contentsOf: file),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let env = plist["EnvironmentVariables"] as? [String: String],
              let raw = env["CODASSOL_PUBLIC_URL"], let url = URL(string: raw),
              url.scheme == "https", url.host != nil, url.user == nil, url.password == nil else { return nil }
        return url.appendingPathComponent("_codassol/health")
    }

    func externalConnectivity(chatURL: URL = URL(string: "https://chatgpt.com/robots.txt")!,
                              ingressURL: URL? = DeviceDirectoryClient.configuredIngress(),
                              previous: ExternalConnectivity? = nil) async -> ExternalConnectivity {
        async let chat = probeExternal(chatURL, health: false)
        // The free public ingress has a request quota. Reuse its result for at most
        // five minutes; network changes and manual refresh discard this snapshot.
        if let previous, Date().timeIntervalSince(previous.ingressCheckedAt) < (previous.ingress ? 300 : 30) {
            return await ExternalConnectivity(chatGPT: chat, ingress: previous.ingress,
                checkedAt: Date(), ingressCheckedAt: previous.ingressCheckedAt)
        }
        async let ingress = probeExternal(ingressURL, health: true)
        return await ExternalConnectivity(chatGPT: chat, ingress: ingress, checkedAt: Date())
    }

    private func probeExternal(_ url: URL?, health: Bool) async -> Bool {
        guard let url else { return false }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 4)
        request.httpMethod = health ? "GET" : "HEAD"
        if health { request.setValue("true", forHTTPHeaderField: "ngrok-skip-browser-warning") }
        do {
            let (data, response) = try await Self.session.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  http.url?.host == url.host else { return false }
            if !health { return true }
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
            return json["ok"] as? Bool == true && json["backendReachable"] as? Bool == true
        } catch { return false }
    }
}

struct TrafficSnapshot: Decodable {
    let version: Int
    let since: Double
    let sampledAt: Double
    let httpsRequests: Int64
    let receivedBytes: Int64
    let sentBytes: Int64
    let persistenceError: Bool
    let classifiedSince: Double?
    let categories: [TrafficCategory]?
    let recentRequests: [TrafficRequestRecord]?
    init(version: Int, since: Double, sampledAt: Double, httpsRequests: Int64,
         receivedBytes: Int64, sentBytes: Int64, persistenceError: Bool,
         classifiedSince: Double? = nil, categories: [TrafficCategory]? = nil,
         recentRequests: [TrafficRequestRecord]? = nil) {
        self.version = version; self.since = since; self.sampledAt = sampledAt
        self.httpsRequests = httpsRequests; self.receivedBytes = receivedBytes
        self.sentBytes = sentBytes; self.persistenceError = persistenceError
        self.classifiedSince = classifiedSince; self.categories = categories
        self.recentRequests = recentRequests
    }
    var totalBytes: Int64 { receivedBytes + sentBytes }
    func rates(since previous: TrafficSnapshot?) -> (received: Double, sent: Double) {
        guard let previous, previous.since == since, sampledAt > previous.sampledAt,
              receivedBytes >= previous.receivedBytes, sentBytes >= previous.sentBytes else { return (0, 0) }
        let elapsed = (sampledAt - previous.sampledAt) / 1000
        return (Double(receivedBytes - previous.receivedBytes) / elapsed,
                Double(sentBytes - previous.sentBytes) / elapsed)
    }
    static func bytes(_ value: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: value, countStyle: .decimal)
    }
}


struct TrafficCategory: Decodable, Identifiable {
    let id: String
    let requests: Int64
    let receivedBytes: Int64
    let sentBytes: Int64
    var totalBytes: Int64 { receivedBytes + sentBytes }
    var title: String { Self.title(id) }
    static func title(_ id: String) -> String {
        switch id {
        case "mcp": return "MCP / tool requests"
        case "health": return "Health checks"
        case "heartbeat": return "Device heartbeats"
        case "device_stream": return "Device stream / reconnect"
        case "device_poll": return "Device polling"
        case "device_results": return "Device results"
        case "discovery": return "Device directory"
        case "peer_sync": return "Peer synchronization"
        case "enrollment": return "Device enrollment"
        case "historical": return "Historical · unclassified"
        default: return "Other requests"
        }
    }
}
struct TrafficRequestRecord: Decodable, Identifiable {
    let id: Int64
    let startedAt: Double
    let category: String
    let method: String
    let receivedBytes: Int64
    let sentBytes: Int64
    let statusCode: Int?
    let durationMs: Double?
    let outcome: String
    var title: String { TrafficCategory.title(category) }
    var resultTitle: String {
        if outcome == "active" { return "In progress" }
        if outcome == "interrupted" { return "Interrupted by restart" }
        if outcome == "aborted" { return "Connection closed" }
        return statusCode.map { "HTTP \($0)" } ?? "No response"
    }
}


/// The menu icon and panel share this aggregate of the displayed device states.
enum PanelConnectionStatus: Equatable {
    case checking, connected, partial, offline
    static func resolve(_ states: [DeviceInfo.DisplaySeverity]) -> PanelConnectionStatus {
        guard !states.isEmpty else { return .checking }
        let online = states.filter { $0 == .ready || $0 == .connected }.count
        if online == states.count { return .connected }
        if online > 0 || states.contains(.caution) { return .partial }
        if states.contains(.unknown) { return .checking }
        return .offline
    }
    var title: String {
        switch self {
        case .connected: return "Connected"
        case .partial: return "Partial connection"
        case .checking: return "Checking"
        case .offline: return "Offline"
        }
    }
    var iconAlpha: Double {
        switch self {
        case .connected: return 1
        case .partial: return 1
        case .checking: return 0.45
        case .offline: return 0.35
        }
    }
}
