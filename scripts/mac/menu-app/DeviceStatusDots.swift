import AppKit

struct DeviceStatusDot {
    let id: String
    let name: String
    let online: Bool
    let state: String

    static func entries(_ devices: [DeviceInfo], updated: Date?, now: Date = Date()) -> [DeviceStatusDot] {
        let fresh = updated.map { now.timeIntervalSince($0) >= 0 && now.timeIntervalSince($0) <= 20 } ?? false
        // Match DevicePanelModel.others: the shared directory snapshot already
        // determines row order. Sorting IDs here would attach dots to other rows.
        return devices.filter { !$0.isThisDevice }.map { device in
            let known = fresh && device.status != "unknown"
            return DeviceStatusDot(id: device.id, name: device.name,
                online: known && (device.displaySeverity == .ready || device.displaySeverity == .connected),
                state: known ? device.displayTitle : "Unknown / stale")
        }
    }

    static func tooltip(_ entries: [DeviceStatusDot], title: String) -> String {
        var lines = ["Codas-mac · " + title]
        lines += entries.enumerated().map { index, entry in
            "\(index + 1). \(entry.name): \(entry.state)" + (index >= 5 ? " (menu only)" : "")
        }
        if entries.count > 5 { lines.append("Showing first 5 of \(entries.count) devices; open panel for all devices.") }
        return lines.joined(separator: "\n")
    }
}

/// Separate views keep the original template asset and colored dots independent.
@MainActor
final class DeviceStatusDotsView: NSView {
    private let icon = NSImageView()
    private var entries: [DeviceStatusDot] = []
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    init(image: NSImage?) {
        super.init(frame: .zero)
        icon.image = image
        icon.imageScaling = .scaleProportionallyDown
        addSubview(icon)
    }
    required init?(coder: NSCoder) { nil }

    func update(entries: [DeviceStatusDot], partial: Bool, height: CGFloat) -> CGFloat {
        self.entries = Array(entries.prefix(5))
        let width: CGFloat = 25 + (entries.isEmpty ? 0 : 8)
        frame = NSRect(x: 0, y: 0, width: width, height: height)
        icon.frame = NSRect(x: 2, y: (height - 21) / 2, width: 21, height: 21)
        needsDisplay = true
        return width
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        if icon.image == nil {
            ("◈" as NSString).draw(at: NSPoint(x: 3, y: 2), withAttributes: [.foregroundColor: NSColor.labelColor])
        }
        let diameter: CGFloat = 3
        let spacing: CGFloat = 1
        let total = CGFloat(entries.count) * (diameter + spacing) - spacing
        for (index, entry) in entries.enumerated() {
            let rect = NSRect(x: bounds.width - 6, y: (bounds.height - total) / 2 + CGFloat(index) * (diameter + spacing), width: diameter, height: diameter)
            (entry.online ? NSColor.systemGreen : NSColor.systemGray).setFill()
            NSBezierPath(ovalIn: rect).fill()
            NSColor.labelColor.withAlphaComponent(0.25).setStroke()
            let outline = NSBezierPath(ovalIn: rect.insetBy(dx: 0.25, dy: 0.25))
            outline.lineWidth = 0.5
            outline.stroke()
        }
    }
}
