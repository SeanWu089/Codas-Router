import AppKit
import Foundation
import SwiftUI

@MainActor
final class DevicePanelModel: ObservableObject {
    @Published private(set) var external: ExternalConnectivity?
    @Published private(set) var lastHealthCheck: Date?
    private var generation = 0
    private var connectivityLoading = false
    private var usageLoading = false
    @Published private(set) var usage: TrafficSnapshot?
    @Published private(set) var usageAvailable = false
    @Published private(set) var receivedRate = 0.0
    @Published private(set) var sentRate = 0.0
    @Published private(set) var devices: [DeviceInfo] = []
    @Published private(set) var directoryMessage = ""
    @Published private(set) var canRenameDevices = false
    @Published private(set) var lastUpdated: Date?
    @Published private(set) var devspace = RouterHealth(connected: false, backendReachable: false)
    @Published private(set) var router = RouterHealth(connected: false, backendReachable: false)
    @Published private(set) var devspaceManaged = false
    @Published var showingRequests = false
    @Published var selectedDeviceID: String?
    @Published var renameText = ""
    @Published var actionMessage = ""
    @Published var busy = false
    @Published var loading = false
    @Published var confirmStop = false

    private let client: DeviceDirectoryClient
    private let manager = DevSpaceManager()
    var onStatusChange: ((PanelConnectionStatus) -> Void)?

    init(client: DeviceDirectoryClient = DeviceDirectoryClient()) {
        self.client = client
        devices = client.cachedDirectory()
    }

    var local: DeviceInfo {
        let device = devices.first(where: { $0.isThisDevice }) ??
            .localFallback(connected: router.connected, backend: router.backendReachable)
        // Fresh local health is the same evidence used by the device row and icon.
        guard localHealthIsFresh else {
            return device.withUnknownStatus()
        }
        return device.withLocalHealth(connected: router.connected,
            backend: router.backendReachable && devspace.connected)
    }

    var localHealthIsFresh: Bool {
        guard let checked = lastHealthCheck else { return false }
        return Date().timeIntervalSince(checked) <= 20
    }

    var connectionStatus: PanelConnectionStatus {
        PanelConnectionStatus.resolve(([local] + others).map(\.displaySeverity))
    }

    var others: [DeviceInfo] { devices.filter { !$0.isThisDevice } }
    var selected: DeviceInfo? {
        guard let selectedDeviceID else { return nil }
        if selectedDeviceID == local.id { return local }
        return devices.first(where: { $0.id == selectedDeviceID }) ??
            (selectedDeviceID == "__local_preview__" ? local : nil)
    }

    func choose(_ device: DeviceInfo) {
        selectedDeviceID = device.id
        renameText = device.name
        actionMessage = ""
    }

    func invalidateConnectivity() {
        generation += 1
        external = nil
        devices = devices.map { $0.withUnknownStatus() }
        lastUpdated = nil
        lastHealthCheck = nil
        updateIcon()
    }

    func expireStatus(at now: Date = Date()) {
        if external?.isFresh(at: now) != true { external = nil }
        if let checked = lastHealthCheck, now.timeIntervalSince(checked) > 20 {
            lastHealthCheck = nil
        }
        if let updated = lastUpdated, now.timeIntervalSince(updated) > 20 {
            devices = devices.map { $0.withUnknownStatus() }
            lastUpdated = nil
        }
        updateIcon()
    }

    private func updateIcon() {
        onStatusChange?(connectionStatus)
    }

    func refreshConnectivity() async {
        guard !connectivityLoading else { return }
        if let external, Date().timeIntervalSince(external.checkedAt) < 7 { return }
        connectivityLoading = true
        let epoch = generation
        defer { connectivityLoading = false }
        let result = await client.externalConnectivity(previous: external)
        guard epoch == generation else { return }
        external = result
    }

    func refreshUsage() async {
        guard !usageLoading else { return }
        usageLoading = true
        defer { usageLoading = false }
        do {
            let next = try await client.usage()
            let rates = next.rates(since: usageAvailable ? usage : nil)
            receivedRate = rates.received
            sentRate = rates.sent
            usage = next
            usageAvailable = true
        } catch {
            usageAvailable = false
            receivedRate = 0
            sentRate = 0
        }
    }

    func refresh() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        // External checks cannot block or cancel the local device directory.
        Task { await refreshConnectivity() }
        Task { await refreshUsage() }
        async let dev = client.health(port: 7676, path: "/healthz")
        async let routerStatus = client.health(port: 17676, path: "/_codassol/health")
        devspace = await dev
        router = await routerStatus
        lastHealthCheck = Date()

        do {
            devices = try await client.devices()
            canRenameDevices = true
            lastUpdated = Date()
            directoryMessage = ""
        } catch {
            let known = devices.isEmpty ? client.cachedDirectory() : devices
            devices = known.map { $0.withUnknownStatus() }
            canRenameDevices = false
            lastUpdated = nil
            directoryMessage = router.connected ? "Device status unavailable · showing registered devices" : "Router unavailable · showing registered devices"
        }
        updateIcon()
        devspaceManaged = await Task.detached(priority: .utility) {
            DevSpaceManager().ownsRunningDevSpace()
        }.value
    }

    func saveName() async {
        guard let device = selected else { return }
        guard canRenameDevices else { return }
        let next = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !next.isEmpty, next.count <= 80, !next.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            actionMessage = "Name must contain 1–80 printable characters."
            return
        }
        busy = true
        defer { busy = false }
        do {
            let result = try await client.rename(id: device.id, to: next)
            actionMessage = result.delivered < result.attempted
                ? "Saved locally · syncing other devices when reachable"
                : "Name saved · \(result.delivered) peer(s) notified"
            await refresh()
        } catch {
            actionMessage = error.localizedDescription
        }
    }

    func controlDevSpace(start: Bool) async {
        guard !busy else { return }
        busy = true
        actionMessage = start ? "Starting DevSpace…" : "Stopping DevSpace…"
        let result = await Task.detached(priority: .userInitiated) { () -> DevSpaceManager.CommandResult in
            let manager = DevSpaceManager()
            return start ? manager.start() : manager.stop()
        }.value
        actionMessage = result.code == 0
            ? (start ? "Start requested · checking health…" : "Stop requested")
            : "Operation failed: \(result.output.prefix(140))"
        busy = false
        await refresh()
    }

    func diagnose() async {
        guard !busy else { return }
        busy = true
        let result = await Task.detached(priority: .userInitiated) {
            DevSpaceManager().diagnostic()
        }.value
        actionMessage = result.code == 0 ? "Startup configuration verified" :
            "Diagnostic failed: \(result.output.prefix(140))"
        busy = false
    }
}

private func statusColor(_ severity: DeviceInfo.DisplaySeverity) -> Color {
    switch severity {
    case .ready, .connected: return .green
    case .caution: return .orange
    case .offline: return .gray
    case .unknown: return .secondary
    }
}

struct DevicePanelView: View {
    @ObservedObject var model: DevicePanelModel
    var size = DevicePanelLayout.preferredSize

    private func sectionTitle(_ title: String) -> some View {
        Text(title).font(.system(size: 10, weight: .semibold))
            .foregroundColor(.secondary)
            .tracking(1.2)
            .padding(.horizontal, 17)
            .padding(.top, 15)
            .padding(.bottom, 6)
    }

    private func deviceRow(_ device: DeviceInfo) -> some View {
        Button {
            model.choose(device)
        } label: {
            HStack(spacing: 11) {
                Image(systemName: device.platform == "android" ? "iphone" : "laptopcomputer")
                    .font(.system(size: 16, weight: .regular))
                    .foregroundColor(.secondary)
                    .frame(width: 27)
                VStack(alignment: .leading, spacing: 3) {
                    Text(device.name).font(.system(size: 13, weight: .medium))
                        .lineLimit(1)
                    if device.isThisDevice { Text("This device").font(.system(size: 10)).foregroundColor(.secondary) }
                }
                Spacer(minLength: 6)
                Circle().fill(statusColor(device.displaySeverity)).frame(width: 7, height: 7)
                Text(device.displayTitle)
                    .font(.system(size: 11)).foregroundColor(.secondary)
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold)).foregroundColor(.secondary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var directoryNotice: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                Image(systemName: "info.circle").foregroundColor(.secondary)
                Text(model.directoryMessage)
            }
            .font(.system(size: 11))
            .foregroundColor(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 13)
    }

    private func connectionRow(_ title: String, available: Bool?) -> some View {
        HStack {
            Text(title)
            Spacer()
            Circle().fill(available == true ? Color.green : available == false ? Color.red : Color.orange)
                .frame(width: 7, height: 7)
            Text(available == true ? "Reachable" : available == false ? "Probe failed" : "Checking…")
        }.font(.system(size: 11)).padding(.horizontal, 17).padding(.vertical, 4)
    }

    private var listing: some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionTitle("THIS DEVICE")
            deviceRow(model.local)
            Divider().padding(.horizontal, 16).padding(.top, 7)
            sectionTitle("OTHER DEVICES")
            if model.others.isEmpty && model.directoryMessage.isEmpty {
                Text("No other registered devices yet")
                    .font(.system(size: 12)).foregroundColor(.secondary)
                    .padding(.horizontal, 18).padding(.vertical, 12)
            } else {
                ForEach(model.others) { device in deviceRow(device) }
            }
            if model.others.count > 5 {
                Text("Menu bar shows 5 of \(model.others.count) devices · hover for dot order")
                    .font(.system(size: 11)).foregroundColor(.secondary)
                    .padding(.horizontal, 18).padding(.vertical, 6)
            }
            if !model.directoryMessage.isEmpty { directoryNotice }
            Divider().padding(.horizontal, 16).padding(.top, 7)
            sectionTitle("CODAS USAGE")
            usageSummary.padding(.horizontal, 17).padding(.bottom, 12)
        }
    }

    private var usageSummary: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { model.showingRequests = true } label: {
                HStack {
                    Text("HTTPS requests")
                    Spacer()
                    Text(model.usageAvailable ? model.usage!.httpsRequests.formatted() : "—").monospacedDigit()
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
                        .foregroundColor(.secondary)
                }.contentShape(Rectangle())
            }.buttonStyle(.plain).disabled(!model.usageAvailable)
            HStack {
                Text("Data transferred")
                Spacer()
                Text(model.usageAvailable ? TrafficSnapshot.bytes(model.usage!.totalBytes) : "—").monospacedDigit()
            }
            if model.usageAvailable {
                Text("↓ \(TrafficSnapshot.bytes(Int64(model.receivedRate)))/s   ↑ \(TrafficSnapshot.bytes(Int64(model.sentRate)))/s")
                    .foregroundColor(.secondary).monospacedDigit()
                if model.usage?.persistenceError == true {
                    Text("History could not be saved").foregroundColor(.orange)
                }
            } else {
                Text("Usage unavailable").foregroundColor(.secondary)
            }
        }.font(.system(size: 11))
    }

    private var requestDetail: some View {
        VStack(alignment: .leading, spacing: 13) {
            Text("Total includes background checks and device traffic.")
                .font(.system(size: 11)).foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let usage = model.usage, model.usageAvailable {
                if let categories = usage.categories {
                    Text("REQUEST CATEGORIES").font(.system(size: 10, weight: .semibold)).foregroundColor(.secondary)
                    ForEach(categories.filter { $0.requests > 0 }) { category in
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(category.title)
                                Text(TrafficSnapshot.bytes(category.totalBytes)).font(.system(size: 10)).foregroundColor(.secondary)
                            }
                            Spacer()
                            Text(category.requests.formatted()).monospacedDigit()
                        }.font(.system(size: 12))
                    }
                    if let since = usage.classifiedSince {
                        Text("Classified since \(Date(timeIntervalSince1970: since / 1000).formatted()). Earlier totals remain unclassified.")
                            .font(.system(size: 10)).foregroundColor(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Divider()
                    Text("RECENT REQUESTS · LAST 100").font(.system(size: 10, weight: .semibold)).foregroundColor(.secondary)
                    if usage.recentRequests?.isEmpty != false {
                        Text("No requests recorded yet").foregroundColor(.secondary)
                    }
                    ForEach(usage.recentRequests ?? []) { request in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(request.title).font(.system(size: 12, weight: .medium))
                                Spacer()
                                Text(Date(timeIntervalSince1970: request.startedAt / 1000)
                                    .formatted(date: .omitted, time: .standard))
                                    .font(.system(size: 10)).foregroundColor(.secondary)
                            }
                            HStack {
                                Text("\(request.method) · \(request.resultTitle)")
                                Spacer()
                                Text(TrafficSnapshot.bytes(request.receivedBytes + request.sentBytes))
                            }.font(.system(size: 10)).foregroundColor(.secondary)
                        }.padding(.vertical, 3)
                        Divider()
                    }
                    Text("Logs contain category, time, status and byte counts.")
                        .font(.system(size: 10)).foregroundColor(.secondary)
                } else {
                    Text("Request classification is unavailable on this Router.").foregroundColor(.secondary)
                }
            } else {
                Text("Usage unavailable").foregroundColor(.secondary)
            }
        }.padding(17)
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 13) {
            if let device = model.selected {
                HStack(spacing: 10) {
                    Text(device.name).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                    Spacer()
                    Circle().fill(statusColor(device.displaySeverity)).frame(width: 8, height: 8)
                    Text(device.displayTitle).font(.system(size: 11)).foregroundColor(.secondary)
                }
                if model.canRenameDevices && device.id != "__local_preview__" {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("DEVICE NAME").font(.system(size: 10, weight: .semibold)).foregroundColor(.secondary)
                        HStack {
                            TextField("Device name", text: $model.renameText)
                                .textFieldStyle(.roundedBorder)
                                .onSubmit { Task { await model.saveName() } }
                            Button("Save") { Task { await model.saveName() } }
                                .disabled(model.busy)
                        }
                    }
                }
                VStack(alignment: .leading, spacing: 6) {
                    information("Platform", device.platform)
                    information("Device ID", device.id)
                    if let identity = device.installationId { information("Installation", identity) }
                    information("Backend", device.backendTitle)
                    information("Execution", device.executionTitle)
                    if let last = device.lastSeenAt {
                        information("Last seen", Date(timeIntervalSince1970: last / 1000).formatted())
                    }
                }.font(.system(size: 11))
                if device.isThisDevice {
                    Divider()
                    Text("CONNECTION").font(.system(size: 10, weight: .semibold)).foregroundColor(.secondary)
                    connectionRow("Outbound ChatGPT probe", available: model.external?.chatGPT)
                    connectionRow("Public URL probe", available: model.external?.ingress)
                    Text("Network reachability · connector session unverified")
                        .font(.system(size: 10)).foregroundColor(.secondary)
                    Divider()
                    Text("CODAS USAGE").font(.system(size: 10, weight: .semibold)).foregroundColor(.secondary)
                    usageSummary
                    if let usage = model.usage, model.usageAvailable {
                        information("Received", TrafficSnapshot.bytes(usage.receivedBytes))
                        information("Sent", TrafficSnapshot.bytes(usage.sentBytes))
                        Text("Counting since \(Date(timeIntervalSince1970: usage.since / 1000).formatted())")
                            .font(.system(size: 10)).foregroundColor(.secondary)
                        Text("HTTPS payloads through this Mac, including device traffic. Excludes headers/TLS overhead; not the provider’s billing total.")
                            .font(.system(size: 10)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    Divider()
                    HStack {
                        Text("DevSpace").font(.system(size: 12, weight: .medium))
                        Spacer()
                        Text(model.localHealthIsFresh ? (model.devspace.connected ? "Running" : "Stopped") : "Checking…")
                            .foregroundColor(model.localHealthIsFresh && model.devspace.connected ? .green : .secondary)
                        Text(model.devspaceManaged ? "· Managed" : "· External")
                            .foregroundColor(.secondary)
                    }
                    HStack {
                        Text("Router").font(.system(size: 12, weight: .medium))
                        Spacer()
                        Text(model.localHealthIsFresh ? (model.router.connected ? "Running" : "Offline") : "Checking…")
                            .foregroundColor(model.localHealthIsFresh && model.router.connected ? .green : .secondary)
                    }
                    HStack {
                        Button("Start") { Task { await model.controlDevSpace(start: true) } }
                            .disabled(model.busy || model.devspace.connected)
                        Button("Stop") { model.confirmStop = true }
                            .disabled(model.busy || !model.devspace.connected || !model.devspaceManaged)
                        Spacer()
                        Button("Diagnose") { Task { await model.diagnose() } }
                            .disabled(model.busy)
                    }
                    .alert("Stop local DevSpace?", isPresented: $model.confirmStop) {
                        Button("Cancel", role: .cancel) { }
                        Button("Stop and disconnect", role: .destructive) {
                            Task { await model.controlDevSpace(start: false) }
                        }
                    } message: {
                        Text("This may disconnect Codas MCP until DevSpace is restarted. Router will not be stopped.")
                    }
                }
                if !model.actionMessage.isEmpty {
                    Text(model.actionMessage).font(.system(size: 11))
                        .foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Text("Device unavailable").foregroundColor(.secondary)
                Button("Back") { model.selectedDeviceID = nil }
            }
        }
        .padding(17)
    }

    private func information(_ title: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).foregroundColor(.secondary).frame(width: 77, alignment: .leading)
            Text(value).lineLimit(1).truncationMode(.middle)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Codas-mac").font(.system(size: 16, weight: .semibold))
                Text("MAC").font(.system(size: 9, weight: .bold))
                    .foregroundColor(.secondary)
                Text(model.connectionStatus.title).font(.system(size: 10))
                    .foregroundColor(model.connectionStatus == .connected ? .green : model.connectionStatus == .partial ? .orange : .secondary)
                Spacer()
                Button { model.invalidateConnectivity(); Task { await model.refresh() } } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 12, weight: .medium))
                }.buttonStyle(.borderless).disabled(model.loading)
            }
            .padding(.horizontal, 16)
            .frame(height: 50)
            .accessibilityIdentifier("panel-header")
            Divider()
            if model.showingRequests || model.selectedDeviceID != nil {
                HStack(spacing: 9) {
                    Button {
                        if model.showingRequests { model.showingRequests = false }
                        else { model.selectedDeviceID = nil; model.actionMessage = "" }
                    } label: {
                        Label("Back", systemImage: "chevron.left")
                            .padding(.vertical, 6).padding(.horizontal, 3)
                    }.buttonStyle(.plain)
                    .accessibilityIdentifier("panel-back")
                    Divider().frame(height: 14)
                    Text(model.showingRequests ? "HTTPS requests" : "Device details")
                        .font(.system(size: 12, weight: .semibold)).lineLimit(1)
                    Spacer(minLength: 0)
                    if model.showingRequests {
                        Text(model.usageAvailable ? model.usage!.httpsRequests.formatted() : "—")
                            .font(.system(size: 12)).monospacedDigit()
                    }
                }
                .padding(.horizontal, 16)
                .frame(height: 44)
                Divider()
            }
            ScrollView {
                Group {
                    if model.showingRequests { requestDetail }
                    else if model.selectedDeviceID != nil { detail }
                    else { listing }
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
            .id(model.showingRequests ? "requests" : model.selectedDeviceID.map { "device:\($0)" } ?? "devices")
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .accessibilityIdentifier("panel-scroll")
            Divider()
            HStack {
                Text(model.lastUpdated.map { "Synced \($0.formatted(date: .omitted, time: .shortened))" }
                     ?? "Local status only")
                    .font(.system(size: 10)).foregroundColor(.secondary)
                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }
                    .font(.system(size: 11)).buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .frame(height: 34)
            .accessibilityIdentifier("panel-footer")
        }
        .frame(width: size.width, height: size.height, alignment: .top)
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear { Task { await model.refresh() } }
    }
}
