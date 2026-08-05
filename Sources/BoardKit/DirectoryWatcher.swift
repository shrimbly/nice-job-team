import CoreServices
import Foundation

/// Watches a directory tree with FSEvents. The orchestrator's files change when an
/// agent writes its status — far more often, and far less predictably, than a poll
/// interval would catch, and far too rarely to be worth re-reading on a timer.
public final class DirectoryWatcher: @unchecked Sendable {
    /// Holds the callback so FSEvents has something to point at that is fully
    /// initialised before the stream exists.
    private final class Box {
        let handler: @Sendable () -> Void
        init(_ handler: @escaping @Sendable () -> Void) { self.handler = handler }
    }

    private let box: Box
    private let stream: FSEventStreamRef
    private let queue = DispatchQueue(label: "io.github.shrimbly.nice-job-team.fsevents")

    /// Nil when the directory is not there; the caller polls for its arrival.
    public init?(url: URL, latency: TimeInterval = 0.4, onChange: @escaping @Sendable () -> Void) {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory),
              isDirectory.boolValue else { return nil }

        let box = Box(onChange)
        self.box = box

        let callback: FSEventStreamCallback = { _, info, _, _, _, _ in
            guard let info else { return }
            Unmanaged<Box>.fromOpaque(info).takeUnretainedValue().handler()
        }
        var context = FSEventStreamContext(
            version: 0, info: Unmanaged.passUnretained(box).toOpaque(),
            retain: nil, release: nil, copyDescription: nil)

        // The latency is the debounce: a burst of writes from one agent arrives as
        // a single callback.
        guard let stream = FSEventStreamCreate(
            kCFAllocatorDefault, callback, &context, [url.path] as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow), latency,
            FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents))
        else { return nil }
        self.stream = stream

        FSEventStreamSetDispatchQueue(stream, queue)
        FSEventStreamStart(stream)
    }

    deinit {
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
    }
}
