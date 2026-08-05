import AppKit
import BoardKit
import SwiftUI

// `Board --dump-cards` prints the board it would draw, as the same JSON shape
// render-board.sh emits. It is how the app's model gets diffed against the
// dashboard's without a screenshot in the middle.
if CommandLine.arguments.contains("--dump-cards") {
    await DumpCards.run()
    exit(0)
}

// AppKit rather than SwiftUI's MenuBarExtra: the status button has to carry a count
// and a tint that survive the menu bar's template rendering, and the panel has to
// close itself when a link sends the operator to the browser.
let application = NSApplication.shared
let controller = StatusItemController()
application.delegate = controller
application.setActivationPolicy(.accessory)
application.run()
