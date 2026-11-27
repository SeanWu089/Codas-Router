import AppKit
import SwiftUI
import Network

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private var statusItem: NSStatusItem!
    private var dotsView: DeviceStatusDotsView!
    private let popover = NSPopover()
    private let model = DevicePanelModel()
    private var panelController: DevicePanelHostingController!
    private var timer: Timer?
    private let pathMonitor = NWPathMonitor()
    private var tick = 0
    private var globalClickMonitor: Any?
    private var localClickMonitor: Any?

    private func setStatusIcon() {
        statusItem.button?.image = CodasPeerArtwork.templateImage()
        statusItem.button?.imagePosition = .imageOnly
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "◈"
        statusItem.button?.toolTip = "Codas · macOS · Devices"
        setStatusIcon()
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePanel(_:))

        popover.delegate = self
        popover.behavior = .transient
        popover.animates = true
        panelController = DevicePanelHostingController(model: model)
        popover.contentViewController = panelController
        popover.contentSize = DevicePanelLayout.preferredSize
        if let button = statusItem.button {
            dotsView = DeviceStatusDotsView(image: button.image)
            button.image = nil
            button.title = ""
            button.addSubview(dotsView)
        }
        model.onStatusChange = { [weak self] status in
            guard let self, let button = self.statusItem.button else { return }
            button.alphaValue = 1
            let entries = DeviceStatusDot.entries(self.model.devices, updated: self.model.lastUpdated)
            let tooltip = DeviceStatusDot.tooltip(entries, title: status.title)
            button.toolTip = tooltip
            button.setAccessibilityLabel(tooltip)
            self.statusItem.length = self.dotsView.update(entries: entries, partial: false,
                height: button.bounds.height)
        }
        statusItem.button?.alphaValue = 1
        pathMonitor.pathUpdateHandler = { [weak self] _ in
            Task { @MainActor in
                self?.model.invalidateConnectivity()
                await self?.model.refresh()
            }
        }
        pathMonitor.start(queue: DispatchQueue(label: "com.codas.connectivity"))
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(woke),
            name: NSWorkspace.didWakeNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(screenParametersChanged),
            name: NSApplication.didChangeScreenParametersNotification, object: nil)
        Task { await model.refresh() }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.model.expireStatus()
                self.tick += 1
                if self.tick % 2 == 0 { Task { await self.model.refreshUsage() } }
                if self.tick % 8 == 0 { await self.model.refresh() }
            }
        }
    }

    private func stopOutsideClickMonitors() {
        if let monitor = globalClickMonitor { NSEvent.removeMonitor(monitor) }
        if let monitor = localClickMonitor { NSEvent.removeMonitor(monitor) }
        globalClickMonitor = nil
        localClickMonitor = nil
    }

    private func closePanel() {
        model.panelVisible = false
        model.closeEnrollment()
        stopOutsideClickMonitors()
        if popover.isShown { popover.performClose(nil) }
    }

    private func watchOutsideClicks() {
        stopOutsideClickMonitors()
        let clicks: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        // Global mouse monitoring needs no keyboard/accessibility permissions.
        globalClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: clicks) { [weak self] _ in
            Task { @MainActor in self?.closePanel() }
        }
        localClickMonitor = NSEvent.addLocalMonitorForEvents(matching: clicks) { [weak self] event in
            MainActor.assumeIsolated { () -> Void in
                guard let self else { return }
                let panelWindow = self.popover.contentViewController?.view.window
                if let panelWindow, let window = event.window,
                   window === panelWindow || window.sheetParent === panelWindow || window.parent === panelWindow { return }
                if let button = self.statusItem.button, event.window === button.window,
                   button.bounds.contains(button.convert(event.locationInWindow, from: nil)) { return }
                // Let the original outside click reach its intended target.
                self.closePanel()
            }
            return event
        }
    }

    func popoverDidClose(_ notification: Notification) {
        model.panelVisible = false
        model.closeEnrollment()
        stopOutsideClickMonitors()
    }
    func applicationDidResignActive(_ notification: Notification) { closePanel() }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        model.workspaceDirectories.busy ? .terminateCancel : .terminateNow
    }
    func applicationWillTerminate(_ notification: Notification) {
        stopOutsideClickMonitors()
        timer?.invalidate()
        pathMonitor.cancel()
    }

    @objc private func screenParametersChanged() {
        // Re-anchor using the current status item's screen on the next opening.
        closePanel()
    }

    @objc private func woke() {
        model.invalidateConnectivity()
        Task { await model.refresh() }
    }

    @objc private func togglePanel(_ sender: NSStatusBarButton) {
        if popover.isShown {
            closePanel()
        } else {
            let visibleFrame = sender.window?.screen?.visibleFrame ?? NSScreen.main?.visibleFrame
            let size = visibleFrame.map { DevicePanelLayout.size(in: $0) } ?? DevicePanelLayout.preferredSize
            panelController.resize(to: size)
            popover.contentSize = size
            popover.show(relativeTo: sender.bounds, of: sender, preferredEdge: .minY)
            model.panelVisible = true
            NSApp.activate(ignoringOtherApps: true)
            watchOutsideClicks()
            // Opening the panel reuses fresh public health checks, avoiding a
            // quota-consuming HTTPS request on every click.
            Task { await model.refresh() }
        }
    }
}

MainActor.assumeIsolated {
    let application = NSApplication.shared
    let delegate = AppDelegate()
    application.delegate = delegate
    application.run()
}
