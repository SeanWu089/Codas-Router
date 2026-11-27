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
    @Published var panelVisible = false
    @Published var showingEnrollment = false
    @Published private(set) var enrollmentCode: String?
    @Published private(set) var enrollmentError = ""

    func enrollmentCodeHidden() { enrollmentCode = nil; enrollmentError = "" }

    func closeEnrollment() {
        enrollmentCode = nil
        enrollmentError = ""
        showingEnrollment = false
    }

    func revealEnrollmentCode() {
        guard localHealthIsFresh && router.connected else {
            enrollmentError = "Local Router is not ready."
            return
        }
        do { enrollmentCode = try client.existingPairingCode(); enrollmentError = "" }
        catch { enrollmentError = "Pairing code unavailable. Check your local Router configuration." }
    }
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

// The PEER mark uses the exact geometry of assets/brand/codas-peer.svg.
// Menu bar: template artwork; the in-panel icon stays monochrome by design.
enum CodasPeerArtwork {
    static let dots: [(CGFloat, CGFloat, CGFloat)] = [
        (60,27,10),(25,87,10),(48.3,47,4),(36.7,67,4),
        (48.3,87,4),(71.7,87,4),(71.7,47,4),(83.3,67,4),(95,87,10)
    ]
    @MainActor static func templateImage() -> NSImage {
        let image = NSImage(size: NSSize(width: 21, height: 21), flipped: true) { rect in
            NSColor.black.setFill()
            let scale = min(rect.width, rect.height) / 120
            for (x,y,r) in dots {
                NSBezierPath(ovalIn: NSRect(x: rect.minX + (x-r)*scale,
                    y: rect.minY + (y-r)*scale, width: r*2*scale, height: r*2*scale)).fill()
            }
            return true
        }
        image.isTemplate = true
        return image
    }
}

private let codasPaper = Color(red: 246/255, green: 246/255, blue: 242/255)
private let codasInk = Color(red: 27/255, green: 28/255, blue: 26/255)
private let codasMuted = Color(red: 111/255, green: 115/255, blue: 108/255)
private let codasLine = Color(red: 228/255, green: 229/255, blue: 222/255)
private let codasAccent = Color(red: 217/255, green: 52/255, blue: 43/255)

private struct CodasPeerBadge: View {
    var body: some View {
        Canvas { context, size in
            let scale = min(size.width,size.height)/120
            for (x,y,r) in CodasPeerArtwork.dots {
                context.fill(Path(ellipseIn: CGRect(x:(x-r)*scale, y:(y-r)*scale,
                    width:r*2*scale,height:r*2*scale)),with:.color(codasPaper))
            }
        }
        .frame(width:33,height:33)
        .background(codasInk,in:RoundedRectangle(cornerRadius:9))
        .accessibilityHidden(true)
    }
}

private struct CodasNetworkArt: View {
    let active: Bool
    let animate: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0/12, paused: !animate || !active || reduceMotion)) { frame in
            Canvas { context, size in
                let scale = min(size.width/120,size.height/100)
                let t = frame.date.timeIntervalSinceReferenceDate
                let pulse = active && animate && !reduceMotion ? (sin(t * 2.8) + 1) / 2 : 0.5
                let points: [(CGFloat,CGFloat,CGFloat)] = [
                    (60,20,8),(20,80,8),(100,80,8),(47,40,3),(34,60,3),
                    (46,80,3),(73,80,3),(73,40,3),(86,60,3)]
                for (i, point) in points.enumerated() {
                    let (x,y,r) = point
                    let color = i == 2 && active ? codasAccent : i < 3 ? codasPaper : Color.white.opacity(0.24)
                    context.fill(Path(ellipseIn:CGRect(x:(x-r)*scale,y:(y-r)*scale,
                        width:2*r*scale,height:2*r*scale)), with:.color(color))
                }
                if active {
                    let radius = CGFloat(12 + 3*pulse)
                    context.stroke(Path(ellipseIn:CGRect(x:(100-radius)*scale,y:(80-radius)*scale,
                        width:radius*2*scale,height:radius*2*scale)),
                        with:.color(codasAccent.opacity(0.3+0.7*pulse)),lineWidth:1)
                }
            }
        }
        .frame(width:109,height:90)
        .accessibilityHidden(true)
    }
}

private func statusColor(_ severity: DeviceInfo.DisplaySeverity) -> Color {
    switch severity {
    case .ready, .connected: return Color(red:0.29, green:0.58, blue:0.43)
    case .caution: return .orange
    case .offline, .unknown: return codasMuted
    }
}

struct DevicePanelView: View {
    @ObservedObject var model: DevicePanelModel
    var size = DevicePanelLayout.preferredSize

    private var onlineCount: Int {
        ([model.local] + model.others).filter {
            $0.displaySeverity == .ready || $0.displaySeverity == .connected
        }.count
    }

    private func sectionTitle(_ title: String, trailing: String? = nil) -> some View {
        HStack {
            Text(title).font(.system(size: 10, weight: .semibold)).tracking(1.1)
            Spacer()
            if let trailing { Text(trailing).font(.system(size: 10, weight: .medium)).monospacedDigit() }
        }.foregroundColor(codasMuted).padding(.top,15).padding(.bottom,6)
    }

    private func deviceSymbol(_ device: DeviceInfo) -> String {
        switch device.platform {
        case "android", "ios": return "iphone"
        case "win32", "windows": return "desktopcomputer"
        default: return "laptopcomputer"
        }
    }

    private func platformTitle(_ device: DeviceInfo) -> String {
        let platform: String
        switch device.platform {
        case "darwin", "macos": platform = "macOS"
        case "win32", "windows": platform = "Windows"
        case "android": platform = "Android"
        case "ios": platform = "iOS"
        case "linux": platform = "Linux"
        default: platform = device.platform
        }
        return platform + " · " + (device.kind == "agent" ? "Agent" : "Router")
    }

    private var networkSummary: some View {
        HStack(spacing:8) {
            VStack(alignment:.leading,spacing:4) {
                Text("NETWORK STATUS")
                    .font(.system(size:9,weight:.semibold)).tracking(1.2)
                    .foregroundColor(.white.opacity(0.58))
                HStack(alignment:.firstTextBaseline,spacing:5) {
                    Text(String(onlineCount)).font(.system(size:36,weight:.semibold)).tracking(-1.5)
                    Text("/ \(1+model.others.count)").font(.system(size:20,weight:.regular))
                        .foregroundColor(.white.opacity(0.55))
                }.monospacedDigit().foregroundColor(codasPaper)
                Text(model.connectionStatus.title).font(.system(size:11))
                    .foregroundColor(.white.opacity(0.72))
            }
            Spacer(minLength:0)
            CodasNetworkArt(active: onlineCount > 0, animate: model.panelVisible)
        }
        .padding(15)
        .frame(minHeight:109)
        .background(codasInk,in:RoundedRectangle(cornerRadius:15))
        .accessibilityElement(children:.combine)
        .accessibilityLabel("\(onlineCount) of \(1+model.others.count) devices online. \(model.connectionStatus.title)")
    }

    private func deviceRow(_ device: DeviceInfo) -> some View {
        Button { model.choose(device) } label: {
            HStack(spacing: 10) {
                Image(systemName: deviceSymbol(device))
                    .font(.system(size: 16, weight: .regular))
                    .foregroundColor(codasInk)
                    .frame(width: 32,height:32)
                    .background(codasPaper,in:RoundedRectangle(cornerRadius:8))
                VStack(alignment: .leading, spacing: 4) {
                    Text(device.name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                    Text(platformTitle(device)).font(.system(size: 10))
                        .foregroundColor(codasMuted).lineLimit(1)
                }
                Spacer(minLength: 4)
                Circle().fill(statusColor(device.displaySeverity)).frame(width: 6, height: 6)
                Text(device.displayTitle)
                    .font(.system(size: 10)).foregroundColor(codasMuted).lineLimit(1)
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold)).foregroundColor(codasMuted)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func surface<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .background(Color.white,in:RoundedRectangle(cornerRadius:12))
            .clipShape(RoundedRectangle(cornerRadius:12))
            .overlay(RoundedRectangle(cornerRadius:12).strokeBorder(codasLine,lineWidth:1))
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
            networkSummary
            sectionTitle("THIS DEVICE", trailing: model.local.kind == "router" ? "ROUTER" : "AGENT")
            surface { deviceRow(model.local) }
            sectionTitle("OTHER DEVICES", trailing: String(format:"%02d",model.others.count))
            surface {
                VStack(spacing:0) {
                    if model.others.isEmpty {
                        Text("No other registered devices")
                            .font(.system(size: 12)).foregroundColor(codasMuted)
                            .frame(maxWidth:.infinity,alignment:.leading).padding(14)
                    } else {
                        ForEach(model.others) { device in
                            if device.id != model.others.first?.id { Divider().padding(.horizontal,10) }
                            deviceRow(device)
                        }
                    }
                }
            }
            if model.others.count > 5 {
                Text("Menu bar shows the first 5 devices · hover for dot order")
                    .font(.system(size: 10)).foregroundColor(codasMuted).padding(.top,6)
            }
            if !model.directoryMessage.isEmpty { directoryNotice }
            sectionTitle("CODAS USAGE", trailing:"TOTAL")
            usageSummary
            Button {
                model.closeEnrollment()
                model.showingEnrollment = true
            } label: {
                HStack(spacing:7) {
                    Image(systemName:"plus").font(.system(size:12,weight:.medium))
                    Text("Add device").font(.system(size:12,weight:.semibold))
                }.foregroundColor(codasPaper)
                    .frame(maxWidth:.infinity).padding(.vertical,12)
                    .background(codasInk,in:RoundedRectangle(cornerRadius:11))
                    .contentShape(Rectangle())
            }.buttonStyle(.plain).padding(.top,14)
        }.padding(.horizontal,16).padding(.bottom,14).padding(.top,4)
    }

    private func metricCard(_ label: String, value: String, suffix: String, arrow: Bool = false) -> some View {
        VStack(alignment:.leading,spacing:6) {
            HStack(spacing:3) {
                Text(label).font(.system(size:9,weight:.medium)).lineLimit(1)
                Spacer(minLength:0)
                if arrow { Image(systemName:"chevron.right").font(.system(size:8,weight:.medium)) }
            }.foregroundColor(codasMuted)
            Text(value).font(.system(size:21,weight:.semibold))
                .monospacedDigit().tracking(-0.7).lineLimit(1).minimumScaleFactor(0.65)
            Text(suffix).font(.system(size:9)).foregroundColor(codasMuted)
                .monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
        }.frame(maxWidth:.infinity,alignment:.leading).padding(11)
            .background(codasPaper,in:RoundedRectangle(cornerRadius:11))
            .overlay(RoundedRectangle(cornerRadius:11).strokeBorder(codasLine,lineWidth:1))
    }

    private var usageSummary: some View {
        VStack(alignment:.leading,spacing:6) {
            HStack(spacing:8) {
                Button { model.showingRequests = true } label: {
                    metricCard("HTTPS REQUESTS", value: model.usageAvailable ? model.usage!.httpsRequests.formatted() : "—",
                        suffix: "All requests", arrow:true)
                }.buttonStyle(.plain).disabled(!model.usageAvailable)
                metricCard("TRANSFERRED", value: model.usageAvailable ? TrafficSnapshot.bytes(model.usage!.totalBytes) : "—",
                    suffix: model.usageAvailable ? "↑ \(TrafficSnapshot.bytes(Int64(model.sentRate)))/s  ↓ \(TrafficSnapshot.bytes(Int64(model.receivedRate)))/s" : "Unavailable")
            }
            if model.usage?.persistenceError == true {
                Text("History could not be saved").font(.system(size:10)).foregroundColor(.orange)
            }
            if !model.usageAvailable {
                Text("Usage unavailable").font(.system(size:10)).foregroundColor(codasMuted)
            }
        }
    }

    private var enrollment: some View {
        VStack(alignment:.leading,spacing:12) {
            Text("Add a device").font(.system(size:18,weight:.semibold))
            Text("Install Codas on the new device. Enter the existing Router pairing code in its settings and authorize a dedicated workspace.")
                .font(.system(size:12)).foregroundColor(codasMuted).fixedSize(horizontal:false,vertical:true)
            if let endpoint = DeviceDirectoryClient.configuredIngress()?.deletingLastPathComponent() {
                Text("CURRENT ROUTER").font(.system(size:10,weight:.semibold)).tracking(1).foregroundColor(codasMuted)
                Text(endpoint.absoluteString).font(.system(size:11,design:.monospaced)).textSelection(.enabled)
                    .fixedSize(horizontal:false,vertical:true)
            }
            if let code = model.enrollmentCode {
                Text("CURRENT PAIRING CODE").font(.system(size:10,weight:.semibold)).tracking(1).foregroundColor(codasMuted)
                Text(code).font(.system(size:12,design:.monospaced)).textSelection(.enabled)
                    .fixedSize(horizontal:false,vertical:true)
                    .padding(10).frame(maxWidth:.infinity,alignment:.leading)
                    .background(Color.white,in:RoundedRectangle(cornerRadius:9))
                Button("Hide code") { model.enrollmentCodeHidden() }.buttonStyle(.borderless)
            } else {
                Button("Reveal pairing code") { model.revealEnrollmentCode() }
                    .disabled(!model.localHealthIsFresh || !model.router.connected)
            }
            if !model.enrollmentError.isEmpty {
                Text(model.enrollmentError).font(.system(size:11)).foregroundColor(codasMuted)
            }
            Text("This is the existing private enrollment credential, not a new or single-use code. Keep it private. Secure device removal and identity-preserving re-enrollment require Router support.")
                .font(.system(size:10)).foregroundColor(codasMuted).fixedSize(horizontal:false,vertical:true)
        }.padding(17)
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
                if !device.isThisDevice {
                    Divider()
                    Text("Device management").font(.system(size:12,weight:.medium))
                    Text("Secure removal is not available on the current Router. A device's existing authorization is not revoked by hiding its record.")
                        .font(.system(size:11)).foregroundColor(codasMuted).fixedSize(horizontal:false,vertical:true)
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
            HStack(spacing:9) {
                CodasPeerBadge()
                VStack(alignment:.leading,spacing:3) {
                    Text("Codas.").font(.system(size:19,weight:.bold)).tracking(-0.9)
                    Text("YOUR DEVICE NETWORK").font(.system(size:9,weight:.medium)).tracking(0.5)
                        .foregroundColor(codasMuted)
                }
                Spacer()
                Button {
                    model.invalidateConnectivity()
                    Task { await model.refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise").font(.system(size: 13, weight: .medium))
                        .frame(width:26,height:30)
                }.buttonStyle(.plain).disabled(model.loading).help("Refresh devices")
                Button {
                    model.closeEnrollment()
                    model.showingRequests = false
                    model.choose(model.local)
                } label: {
                    Image(systemName:"gearshape").font(.system(size:16,weight:.regular))
                        .frame(width:28,height:30)
                }.buttonStyle(.plain).help("Local device settings")
            }
            .padding(.horizontal,16)
            .frame(height:66)
            .accessibilityIdentifier("panel-header")
            if model.showingEnrollment || model.showingRequests || model.selectedDeviceID != nil {
                HStack(spacing: 9) {
                    Button {
                        if model.showingEnrollment { model.closeEnrollment() }
                        else if model.showingRequests { model.showingRequests = false }
                        else { model.selectedDeviceID = nil; model.actionMessage = "" }
                    } label: {
                        Label("Back", systemImage: "chevron.left")
                            .padding(.vertical, 6).padding(.horizontal, 3)
                    }.buttonStyle(.plain)
                    .accessibilityIdentifier("panel-back")
                    Spacer(minLength:0)
                    Text(model.showingEnrollment ? "Add device" : model.showingRequests ? "HTTPS requests" : "Device details")
                        .font(.system(size:12,weight:.medium)).foregroundColor(codasMuted).lineLimit(1)
                }
                .padding(.horizontal,16).frame(height:38)
                Divider().overlay(codasLine)
            }
            ScrollView {
                Group {
                    if model.showingEnrollment { enrollment }
                    else if model.showingRequests { requestDetail }
                    else if model.selectedDeviceID != nil { detail }
                    else { listing }
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
            .id(model.showingEnrollment ? "enrollment" : model.showingRequests ? "requests" : model.selectedDeviceID.map { "device:\($0)" } ?? "devices")
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .accessibilityIdentifier("panel-scroll")
            Divider().overlay(codasLine)
            HStack {
                Text(model.lastUpdated.map { "Synced \($0.formatted(date: .omitted, time: .shortened))" }
                     ?? "Local status only")
                    .font(.system(size:10)).foregroundColor(codasMuted)
                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }
                    .font(.system(size:11)).buttonStyle(.plain)
            }
            .padding(.horizontal,16).frame(height:36)
            .accessibilityIdentifier("panel-footer")
        }
        .frame(width:size.width,height:size.height,alignment:.top)
        .foregroundColor(codasInk)
        .background(codasPaper)
        .environment(\.colorScheme,.light)
        .onAppear { Task { await model.refresh() } }
    }
}
