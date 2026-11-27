import AppKit
import SwiftUI

/// AppKit owns the outer size; page content only determines the scroll extent.
enum DevicePanelLayout {
    static let preferredSize = NSSize(width: 354, height: 620)

    static func size(in visibleFrame: NSRect) -> NSSize {
        NSSize(width: min(preferredSize.width, max(1, visibleFrame.width - 24)),
               height: min(preferredSize.height, max(1, visibleFrame.height - 24)))
    }
}

@MainActor
final class DevicePanelHostingController: NSHostingController<DevicePanelView> {
    init(model: DevicePanelModel, size: NSSize = DevicePanelLayout.preferredSize) {
        super.init(rootView: DevicePanelView(model: model, size: size))
        // Prevent SwiftUI's changing ideal content size from resizing a shown
        // popover around the menu-bar anchor while navigating or refreshing.
        if #available(macOS 13.0, *) { sizingOptions = [] }
        resize(to: size)
    }

    @MainActor required dynamic init?(coder: NSCoder) { nil }

    func resize(to size: NSSize) {
        rootView = DevicePanelView(model: rootView.model, size: size)
        preferredContentSize = size
        view.setFrameSize(size)
    }
}
