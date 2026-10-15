package ru.agentik007.soundspan.downloads

import org.junit.Assert.*
import org.junit.Test

class DownloadWorkIdentityTest {
    private val job = DownloadWorkIdentity("a".repeat(64), "https://fixture.invalid", "opaque/user", 1, 2)
    @Test fun originalFenceRoundTripsAndAbaGetsDistinctUniqueWork() {
        assertEquals(job, DownloadWorkIdentity.parse(job.wire()))
        assertEquals(job, DownloadWorkIdentity.fromFlat(job.flat()))
        assertEquals(job.uniqueName, job.copy().uniqueName)
        assertNotEquals(job.uniqueName, job.copy(epoch = 3).uniqueName)
        assertNotEquals(job.uniqueName, job.copy(generation = 3).uniqueName)
        assertNotEquals(job.ownerTag, job.copy(userId = "other").ownerTag)
    }
    @Test fun closedWorkDataRejectsSecretsAndMalformedIdentity() {
        for (bad in listOf(job.flat() + ("token" to "secret"), job.flat() + ("epoch" to 0L), job.flat() + ("generation" to 1.0), job.flat() + ("origin" to "https://fixture.invalid/path"), job.flat() + ("downloadId" to "../../a"))) {
            try { DownloadWorkIdentity.fromFlat(bad); fail("Accepted malformed WorkData") } catch (_: IllegalArgumentException) { } catch (_: ClassCastException) { }
        }
    }
    @Test fun holdoffFloorKeepsIdentityAndNeverBecomesSuccess() {
        val result = DownloadWorkOutcome.parse(mapOf("outcome" to "retry", "retryAfterMillis" to 240000L))
        assertEquals("retry", result.outcome)
        assertEquals(240000L, result.backoffMillis)
        assertEquals(60000L, DownloadWorkOutcome("retry", 0).backoffMillis)
        assertEquals(18000000L, DownloadWorkOutcome("retry", Long.MAX_VALUE).backoffMillis)
        try { DownloadWorkOutcome.parse(mapOf("outcome" to "ready", "retryAfterMillis" to 1L)); fail("Accepted ready holdoff") } catch (_: IllegalArgumentException) { }
    }
}
