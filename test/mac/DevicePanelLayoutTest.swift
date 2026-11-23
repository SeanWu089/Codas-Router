import AppKit
import SwiftUI

/// Exercise the real usage decoder/model against an isolated loopback fixture.
@main
struct DevicePanelLayoutTest {
    @MainActor
    static func main() throws {
        guard CommandLine.arguments.count == 2,
              let fixturePort = Int(CommandLine.arguments[1]),
              (1...65535).contains(fixturePort) else {
            fatalError("Usage: device-panel-layout-test <loopback-fixture-port>")
        }
        _ = NSApplication.shared
        let temporary = FileManager.default.temporaryDirectory
            .appendingPathComponent("codas-panel-layout-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let state = temporary.appendingPathComponent("router.json")
        try Data("{\"installationId\":\"layout-test-local\",\"adminToken\":\"layout-test-secret-not-a-real-admin-token\"}".utf8).write(to: state)
        let records = (0..<12).map { index -> [String: Any] in
            ["id": "test-device-\(index)", "installationId": index == 0 ? "layout-test-local" : "layout-test-\(index)",
             "defaultName": "Layout test device \(index)", "platform": index == 0 ? "darwin" : "win32",
             "kind": "router"]
        }
        try JSONSerialization.data(withJSONObject: ["devices": records])
            .write(to: temporary.appendingPathComponent("devices.json"))

        let desktop = NSRect(x: 0, y: 0, width: 1440, height: 900)
        let shortDesktop = NSRect(x: 0, y: 0, width: 1024, height: 384)
        let translatedDesktop = NSRect(x: -1440, y: 1200, width: 1440, height: 900)
        let translatedShortDesktop = NSRect(x: 1440, y: -900, width: 1024, height: 384)
        let normalSize = DevicePanelLayout.size(in: desktop)
        let shortSize = DevicePanelLayout.size(in: shortDesktop)
        require(normalSize.height <= desktop.height, "Normal panel exceeds the usable screen")
        require(shortSize.height < normalSize.height, "Short screens must shrink the panel")
        require(shortSize.height <= shortDesktop.height - 20, "Popover has no clearance on a short screen")
        require(DevicePanelLayout.size(in: translatedDesktop) == normalSize,
                "Secondary-display origin must not change available size")
        require(DevicePanelLayout.size(in: translatedShortDesktop) == shortSize,
                "Negative secondary-display coordinates must not change available size")

        for size in [normalSize, shortSize] {
            let model = DevicePanelModel(client: DeviceDirectoryClient(routerPort: fixturePort, stateFile: state))
            // View appearance must not contact real services during a layout test.
            model.loading = true
            Task { await model.refreshUsage() }
            let deadline = Date().addingTimeInterval(5)
            while !model.usageAvailable && Date() < deadline {
                RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            }
            require(model.usage?.recentRequests?.count == 100, "Loopback usage fixture did not load 100 request records")
            let host = DevicePanelHostingController(model: model, size: size)
            let popover = NSPopover()
            popover.contentViewController = host
            popover.contentSize = size
            let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                                  styleMask: .borderless, backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentViewController = host
            window.setContentSize(size)
            // This test window is never ordered on screen or made active.

            settle(host)
            verifyGeometry(host, popover: popover, size: size, route: "devices")
            try savePreview(host, size: size, route: "devices")
            let listing = scrollView(in: host.view)
            require(listing.documentView!.bounds.height > listing.contentView.bounds.height,
                    "Many devices must overflow inside the scroll viewport")
            scrollToBottom(listing)
            require(listing.contentView.bounds.minY > 0, "Device list cannot scroll to later devices")

            model.choose(model.local)
            settle(host)
            verifyGeometry(host, popover: popover, size: size, route: "local detail")
            try savePreview(host, size: size, route: "detail")
            let detail = scrollView(in: host.view)
            require(abs(detail.contentView.bounds.minY) < 1, "Device detail inherited the list scroll offset")
            require(detail.documentView!.bounds.height > detail.contentView.bounds.height,
                    "Local details must scroll rather than enlarge the panel")
            scrollToBottom(detail)
            verifyGeometry(host, popover: popover, size: size, route: "scrolled local detail")

            model.showingRequests = true
            settle(host)
            verifyGeometry(host, popover: popover, size: size, route: "requests")
            try savePreview(host, size: size, route: "requests")
            require(abs(scrollView(in: host.view).contentView.bounds.minY) < 1,
                    "Requests inherited the device scroll offset")
            let requests = scrollView(in: host.view)
            require(requests.documentView!.bounds.height > requests.contentView.bounds.height * 5,
                    "The 100 request rows must overflow the scroll viewport")
            scrollToBottom(requests)
            require(requests.contentView.bounds.minY > 0, "Recent requests cannot scroll to the final record")
            verifyGeometry(host, popover: popover, size: size, route: "scrolled requests")
            try savePreview(host, size: size, route: "requests-bottom")

            model.showingRequests = false
            settle(host)
            verifyGeometry(host, popover: popover, size: size, route: "back to local detail")
            require(abs(scrollView(in: host.view).contentView.bounds.minY) < 1,
                    "Returning from requests must reset device detail scrolling")
            model.selectedDeviceID = nil
            settle(host)
            verifyGeometry(host, popover: popover, size: size, route: "back to devices")
            require(abs(scrollView(in: host.view).contentView.bounds.minY) < 1,
                    "Returning to devices must reset scrolling")
            let resized = size == normalSize ? shortSize : normalSize
            host.resize(to: resized)
            popover.contentSize = resized
            window.setContentSize(resized)
            settle(host)
            verifyGeometry(host, popover: popover, size: resized, route: "devices after resize")
            window.contentViewController = nil
            window.close()
            print("PASS: stable \(Int(size.width))×\(Int(size.height)) panel, scrolling and route resets")
        }
        print("PASS: screen limits ignore secondary-display coordinate offsets")
    }

    @MainActor
    private static func settle(_ host: NSViewController) {
        RunLoop.main.run(until: Date().addingTimeInterval(0.06))
        host.view.layoutSubtreeIfNeeded()
    }

    @MainActor
    private static func verifyGeometry(_ host: DevicePanelHostingController, popover: NSPopover,
                                       size: NSSize, route: String) {
        require(abs(host.view.bounds.width - size.width) < 1 && abs(host.view.bounds.height - size.height) < 1,
                "\(route): host bounds changed from the screen-bounded panel size")
        require(host.preferredContentSize == size, "\(route): preferred size changed during navigation")
        require(popover.contentSize == size, "\(route): popover size changed during navigation")
        let measured = host.sizeThatFits(in: size)
        require(abs(measured.width - size.width) < 1 && abs(measured.height - size.height) < 1,
                "\(route): SwiftUI content requires \(measured), beyond its \(size) container")
        let scroll = scrollView(in: host.view)
        let frame = scroll.convert(scroll.bounds, to: host.view)
        require(host.view.bounds.insetBy(dx: -1, dy: -1).contains(frame),
                "\(route): scroll viewport extends beyond the host bounds")
        require(frame.minY >= 25 && host.view.bounds.maxY - frame.maxY >= 25,
                "\(route): scrolling content displaced the pinned header or footer")
    }

    @MainActor
    private static func scrollView(in view: NSView) -> NSScrollView {
        func find(_ view: NSView) -> NSScrollView? {
            if let scroll = view as? NSScrollView { return scroll }
            return view.subviews.lazy.compactMap(find).first
        }
        guard let scroll = find(view), scroll.documentView != nil else {
            fatalError("Panel must contain an AppKit scroll view with a document")
        }
        return scroll
    }

    @MainActor
    private static func scrollToBottom(_ scroll: NSScrollView) {
        let maximum = max(0, scroll.documentView!.bounds.height - scroll.contentView.bounds.height)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: maximum))
        scroll.reflectScrolledClipView(scroll.contentView)
    }

    @MainActor
    private static func savePreview(_ host: NSViewController, size: NSSize, route: String) throws {
        guard let directory = ProcessInfo.processInfo.environment["CODASSOL_LAYOUT_ARTIFACTS"] else { return }
        let output = URL(fileURLWithPath: directory, isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        guard let bitmap = host.view.bitmapImageRepForCachingDisplay(in: host.view.bounds) else {
            fatalError("Cannot create offscreen panel bitmap")
        }
        host.view.cacheDisplay(in: host.view.bounds, to: bitmap)
        guard let data = bitmap.representation(using: .png, properties: [:]) else {
            fatalError("Cannot encode offscreen panel bitmap")
        }
        try data.write(to: output.appendingPathComponent("panel-\(Int(size.height))-\(route).png"))
    }

    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else {
            FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
            exit(1)
        }
    }
}
