package ru.agentik007.soundspan.downloads

import androidx.work.WorkInfo
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DownloadWorkerStopReasonTest {
    @Test fun knownChargingAndNetworkStopsRetainRetryOnSupportedApi() {
        for (api in listOf(31, 36)) {
            assertTrue(retryableDownloadStop(api, WorkInfo.STOP_REASON_CONSTRAINT_CHARGING, true, WorkInfo.State.RUNNING))
            assertTrue(retryableDownloadStop(api, WorkInfo.STOP_REASON_CONSTRAINT_CONNECTIVITY, true, WorkInfo.State.ENQUEUED))
        }
    }
    @Test fun userAppUnknownAndFutureReasonsNeverResumePausedWork() {
        for (reason in listOf(WorkInfo.STOP_REASON_CANCELLED_BY_APP, WorkInfo.STOP_REASON_USER,
                WorkInfo.STOP_REASON_UNKNOWN, WorkInfo.STOP_REASON_NOT_STOPPED, 100000)) {
            assertFalse(retryableDownloadStop(36, reason, true, WorkInfo.State.RUNNING))
        }
    }
    @Test fun android30StoppedUnfinishedWorkRemainsOwnedByScheduler() {
        for (state in listOf(WorkInfo.State.RUNNING, WorkInfo.State.ENQUEUED)) {
            assertTrue(retryableDownloadStop(30, WorkInfo.STOP_REASON_UNKNOWN, true, state))
        }
    }
    @Test fun cancelledAndFinishedStateDominatesEvenKnownConstraintStop() {
        for (api in listOf(30, 31, 36)) {
            for (state in listOf(null, WorkInfo.State.CANCELLED, WorkInfo.State.FAILED,
                    WorkInfo.State.SUCCEEDED, WorkInfo.State.BLOCKED)) {
                assertFalse(retryableDownloadStop(api, WorkInfo.STOP_REASON_CONSTRAINT_CHARGING, true, state))
            }
        }
    }
    @Test fun unfinishedWorkWithoutActualStopIsNotRetryAuthority() {
        assertFalse(retryableDownloadStop(30, WorkInfo.STOP_REASON_UNKNOWN, false, WorkInfo.State.RUNNING))
        assertFalse(retryableDownloadStop(36, WorkInfo.STOP_REASON_CONSTRAINT_CONNECTIVITY, false, WorkInfo.State.ENQUEUED))
    }
    @Test fun lateCancellationCannotBeUpgradedByRememberedConstraintCause() {
        assertTrue(retryableDownloadStop(30, WorkInfo.STOP_REASON_UNKNOWN, true, WorkInfo.State.RUNNING))
        // A subsequent cancel transaction wins before a later classification.
        assertFalse(retryableDownloadStop(30, WorkInfo.STOP_REASON_CONSTRAINT_CHARGING, true, WorkInfo.State.CANCELLED))
    }
}
