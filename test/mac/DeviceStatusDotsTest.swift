import AppKit

private final class PreviewBackground: NSView {
    override func draw(_ rect: NSRect) {
        NSColor.windowBackgroundColor.setFill()
        bounds.fill()
    }
}

@main
struct DeviceStatusDotsTest {
    @MainActor static func main() throws {
        func device(_ id: String, _ status: String = "online", local: Bool = false,
                    name: String? = nil, kind: String = "agent") -> DeviceInfo {
            DeviceInfo(id: id, installationId: nil, name: name ?? id, platform: "win32", kind: kind,
                isThisDevice: local, status: status, online: status == "online", backendReachable: nil,
                executionVerified: nil, lastSeenAt: nil)
        }
        let now = Date()
        let input = [device("z", local: true), device("c", "unknown"), device("b", "offline"), device("a")]
        let entries = DeviceStatusDot.entries(input, updated: now, now: now)
        precondition(entries.map(\.id) == ["c", "b", "a"])
        precondition(entries.map(\.online) == [false, false, true])
        precondition(DeviceStatusDot.entries(input.reversed(), updated: now, now: now).map(\.id) == ["a", "b", "c"])
        precondition(DeviceStatusDot.entries(input, updated: now.addingTimeInterval(-21), now: now).allSatisfy { !$0.online })
        precondition(DeviceStatusDot.entries(input, updated: nil, now: now).allSatisfy { !$0.online })
        let many = DeviceStatusDot.entries((0..<7).map { device(String($0)) }, updated: now, now: now)
        precondition(DeviceStatusDot.tooltip(many, title: "Connected").contains("first 5 of 7"))
        precondition(DeviceStatusDot.tooltip(entries, title: "Partial").contains("Unknown"))

        // Reproduce the reported panel: name order is phone, laptop, PC, while
        // opaque IDs sort the online PC ahead of the offline laptop.
        let screenshotDevices = [
            device("local", local: true, name: "MacBook Air", kind: "router"),
            device("android-1", "offline", name: "Phone"),
            device("device-z", "offline", name: "Studio-PC"),
            device("device-a", name: "Workstation", kind: "router")
        ]
        let screenshotEntries = DeviceStatusDot.entries(screenshotDevices, updated: now, now: now)
        precondition(screenshotEntries.map(\.name) == ["Phone", "Studio-PC", "Workstation"])
        precondition(screenshotEntries.map(\.online) == [false, false, true])
        let tooltipLines = DeviceStatusDot.tooltip(screenshotEntries, title: "Partial").components(separatedBy: "\n")
        precondition(tooltipLines == ["Codas-mac · Partial", "1. Phone: Offline",
                                      "2. Studio-PC: Offline", "3. Workstation: Online"])

        _ = NSApplication.shared
        let icon = NSImage(contentsOfFile: CommandLine.arguments[1])!
        icon.isTemplate = true
        icon.size = NSSize(width: 21, height: 21)
        let output = URL(fileURLWithPath: CommandLine.arguments[2])
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        for dark in [false, true] {
            for scale in [1, 2, 3] {
                for count in [0, 3, 5, 7] {
                    let view = DeviceStatusDotsView(image: icon)
                    let data = count == 3 ? screenshotEntries : Array(many.prefix(count))
                    let width = view.update(entries: data, partial: true, height: 24)
                    precondition(width <= 40)
                    let background = PreviewBackground(frame: view.frame)
                    background.addSubview(view)
                    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(width) * scale,
                        pixelsHigh: 24 * scale, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                        isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
                    rep.size = NSSize(width: width, height: 24)
                    let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)!
                    background.appearance = appearance
                    appearance.performAsCurrentDrawingAppearance {
                        background.cacheDisplay(in: background.bounds, to: rep)
                    }
                    let name = "dots-\(dark ? "dark" : "light")-\(scale)x-\(count).png"
                    try rep.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent(name))
                }
            }
        }
        print("PASS: panel row order, screenshot grey/grey/green and tooltip numbering, local exclusion, online/offline/unknown/expiry, overflow; 24 offscreen renders")
    }
}
