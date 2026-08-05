import Foundation

/// When to poll GitHub next.
///
/// The shape matters more than it looks. A laptop wakes with its network still
/// coming back, so the first refresh after sleep often fails; backing straight off
/// to minutes leaves the operator staring at an overnight-stale board at exactly the
/// moment they opened the lid to look at it. So the first failure is retried
/// quickly, and only a genuine run of them backs off.
public struct RefreshSchedule: Sendable, Equatable {
    public let interval: TimeInterval
    public let firstRetry: TimeInterval
    public let maxBackoff: TimeInterval

    public static let standard = RefreshSchedule(interval: 60, firstRetry: 15, maxBackoff: 600)

    public init(interval: TimeInterval, firstRetry: TimeInterval, maxBackoff: TimeInterval) {
        self.interval = interval
        self.firstRetry = firstRetry
        self.maxBackoff = maxBackoff
    }

    public func delay(afterFailures failures: Int) -> TimeInterval {
        guard failures > 0 else { return interval }
        return min(firstRetry * pow(2, Double(failures - 1)), maxBackoff)
    }
}
