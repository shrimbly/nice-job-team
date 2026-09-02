import Foundation
import Testing
@testable import BoardKit

/// The backoff shape is what left an overnight-stale board on screen: the first
/// refresh after waking failed on a network that had not come back, and the loop
/// went straight to minutes.
struct RefreshScheduleTests {
    private let schedule = RefreshSchedule.standard

    @Test("a healthy loop polls on the interval")
    func healthy() {
        #expect(schedule.delay(afterFailures: 0) == 60)
    }

    @Test("the first failure is retried quickly, not backed off to minutes")
    func firstFailureRetriesFast() {
        #expect(schedule.delay(afterFailures: 1) == 15)
        #expect(schedule.delay(afterFailures: 1) < schedule.interval)
    }

    @Test("a run of failures backs off, and stops at the cap")
    func backsOffAndCaps() {
        #expect(schedule.delay(afterFailures: 2) == 30)
        #expect(schedule.delay(afterFailures: 3) == 60)
        #expect(schedule.delay(afterFailures: 4) == 120)
        #expect(schedule.delay(afterFailures: 5) == 240)
        #expect(schedule.delay(afterFailures: 6) == 480)
        #expect(schedule.delay(afterFailures: 7) == 600)
        // However long it has been failing, it never stops trying.
        for failures in 8...200 {
            #expect(schedule.delay(afterFailures: failures) == 600)
        }
    }

    @Test("delays only ever grow")
    func monotonic() {
        let delays = (1...12).map { schedule.delay(afterFailures: $0) }
        #expect(delays == delays.sorted())
    }
}
