import Foundation
import Testing
@testable import BoardKit

/// OrchestratorLocation must resolve the SAME root as the CLI's loadRoot from
/// the same environment — the app reads and FS-watches the root cards.json that
/// `board refresh` writes, and any divergence is a board silently frozen on a
/// path nothing writes to. loadRoot's order: SUPERSET_ORCH_ROOT (the app also
/// honours its own BOARD_ORCHESTRATOR_DIR above it), then the machine config's
/// stateDir, then ~/.claude/superset-orchestrator.
struct OrchestratorLocationTests {

    /// A throwaway XDG_CONFIG_HOME with a machine config carrying `stateDir`.
    private func makeConfigHome(machineConfig: String?) throws -> URL {
        let home = FileManager.default.temporaryDirectory
            .appendingPathComponent("board-orch-location-\(UUID().uuidString)")
        if let machineConfig {
            let dir = home.appendingPathComponent("superset-board")
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try Data(machineConfig.utf8).write(to: dir.appendingPathComponent("config.json"))
        } else {
            try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        }
        return home
    }

    @Test func stateDirRelocatesTheRoot() throws {
        let configHome = try makeConfigHome(machineConfig: #"{"stateDir": "/tmp/relocated-orch"}"#)
        defer { try? FileManager.default.removeItem(at: configHome) }
        let root = OrchestratorLocation.root(environment: ["XDG_CONFIG_HOME": configHome.path])
        #expect(root.path == "/tmp/relocated-orch")
    }

    @Test func environmentOverridesStillWinOverStateDir() throws {
        let configHome = try makeConfigHome(machineConfig: #"{"stateDir": "/tmp/relocated-orch"}"#)
        defer { try? FileManager.default.removeItem(at: configHome) }
        let env = [
            "XDG_CONFIG_HOME": configHome.path,
            "SUPERSET_ORCH_ROOT": "/tmp/env-root",
        ]
        #expect(OrchestratorLocation.root(environment: env).path == "/tmp/env-root")
        var withDir = env
        withDir["BOARD_ORCHESTRATOR_DIR"] = "/tmp/app-dir"
        #expect(OrchestratorLocation.root(environment: withDir).path == "/tmp/app-dir")
    }

    @Test func missingOrUselessMachineConfigFallsToTheDefault() throws {
        let noConfig = try makeConfigHome(machineConfig: nil)
        defer { try? FileManager.default.removeItem(at: noConfig) }
        let fallback = OrchestratorLocation.root(environment: ["XDG_CONFIG_HOME": noConfig.path])
        #expect(fallback.path.hasSuffix(".claude/superset-orchestrator"))

        // Unparseable, non-object, and empty-string stateDir all mean "no
        // relocation" — the CLI's loadRoot reads them the same tolerant way.
        for body in ["not json", "[1,2]", #"{"stateDir": ""}"#, #"{"stateDir": 7}"#] {
            let home = try makeConfigHome(machineConfig: body)
            defer { try? FileManager.default.removeItem(at: home) }
            let root = OrchestratorLocation.root(environment: ["XDG_CONFIG_HOME": home.path])
            #expect(root.path.hasSuffix(".claude/superset-orchestrator"))
        }
    }
}
