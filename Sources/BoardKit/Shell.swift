import Foundation

/// Just enough process plumbing to call `gh`.
public enum Shell {
    public struct Output: Sendable {
        public var status: Int32
        public var stdout: Data
        public var stderr: Data

        public var stderrText: String {
            String(data: stderr, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        }
    }

    public enum Failure: Error, CustomStringConvertible {
        case notFound(String)
        case launch(String)
        case timedOut(String, seconds: TimeInterval)
        case exited(String, status: Int32, stderr: String)

        public var description: String {
            switch self {
            case .notFound(let what): "\(what) not found"
            case .launch(let message): message
            case .timedOut(let what, let seconds): "\(what) did not finish within \(Int(seconds))s"
            case .exited(let what, let status, let stderr):
                "\(what) exited \(status)\(stderr.isEmpty ? "" : ": \(stderr)")"
            }
        }
    }

    private static let queue = DispatchQueue(
        label: "io.github.shrimbly.nice-job-team.shell", attributes: .concurrent)

    /// Runs to completion, draining both pipes concurrently — `gh pr list --json`
    /// with a check rollup comfortably exceeds a pipe buffer, and a single-threaded
    /// read would deadlock on it.
    public static func run(
        _ executable: URL, _ arguments: [String], timeout: TimeInterval = 30
    ) async throws -> Output {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    continuation.resume(returning: try runBlocking(executable, arguments, timeout))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private static func runBlocking(
        _ executable: URL, _ arguments: [String], _ timeout: TimeInterval
    ) throws -> Output {
        let name = executable.lastPathComponent
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        // gh needs HOME for its config and keyring, and git on PATH for some paths.
        process.environment = ProcessInfo.processInfo.environment

        let out = Pipe(), err = Pipe()
        process.standardOutput = out
        process.standardError = err
        process.standardInput = FileHandle.nullDevice

        let collected = Collector()
        let group = DispatchGroup()
        queue.async(group: group) { collected.appendOut(out.fileHandleForReading.readDataToEndOfFile()) }
        queue.async(group: group) { collected.appendErr(err.fileHandleForReading.readDataToEndOfFile()) }

        do {
            try process.run()
        } catch {
            throw Failure.launch("could not run \(executable.path): \(error.localizedDescription)")
        }

        if group.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            _ = group.wait(timeout: .now() + 2)
            throw Failure.timedOut(name, seconds: timeout)
        }
        process.waitUntilExit()

        let output = Output(
            status: process.terminationStatus, stdout: collected.out, stderr: collected.err)
        guard output.status == 0 else {
            throw Failure.exited(name, status: output.status, stderr: output.stderrText)
        }
        return output
    }

    private final class Collector: @unchecked Sendable {
        private let lock = NSLock()
        private var _out = Data()
        private var _err = Data()

        func appendOut(_ data: Data) { lock.withLock { _out.append(data) } }
        func appendErr(_ data: Data) { lock.withLock { _err.append(data) } }
        var out: Data { lock.withLock { _out } }
        var err: Data { lock.withLock { _err } }
    }
}

// MARK: - Finding gh

extension Shell {
    /// A bundled app inherits launchd's PATH — `/usr/bin:/bin:/usr/sbin:/sbin` —
    /// so a Homebrew `gh` is invisible unless it is looked for by hand.
    public static func locate(_ tool: String, overrideEnvironment: String) -> URL? {
        let environment = ProcessInfo.processInfo.environment
        var candidates: [String] = []
        if let override = environment[overrideEnvironment], !override.isEmpty {
            candidates.append(override)
        }
        candidates += [
            "/opt/homebrew/bin/\(tool)", "/usr/local/bin/\(tool)", "/usr/bin/\(tool)",
            "/opt/local/bin/\(tool)", "\(NSHomeDirectory())/.local/bin/\(tool)",
        ]
        if let path = environment["PATH"] {
            candidates += path.split(separator: ":").map { "\($0)/\(tool)" }
        }
        if let found = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
            return URL(fileURLWithPath: found)
        }
        return loginShellLookup(tool)
    }

    /// Last resort for installs the list above cannot guess (mise, nix, asdf).
    private static func loginShellLookup(_ tool: String) -> URL? {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        guard FileManager.default.isExecutableFile(atPath: shell) else { return nil }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: shell)
        process.arguments = ["-lc", "command -v \(tool)"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let path = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !path.isEmpty, FileManager.default.isExecutableFile(atPath: path) else { return nil }
        return URL(fileURLWithPath: path)
    }
}
