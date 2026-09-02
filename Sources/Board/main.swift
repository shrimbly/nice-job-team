import AppKit
import BoardKit
import SwiftUI

// AppKit rather than SwiftUI's MenuBarExtra: the status button has to carry a count
// and a tint that survive the menu bar's template rendering, and the panel has to
// close itself when a link sends the operator to the browser.
let application = NSApplication.shared
let controller = StatusItemController()
application.delegate = controller
application.setActivationPolicy(.accessory)
application.run()
