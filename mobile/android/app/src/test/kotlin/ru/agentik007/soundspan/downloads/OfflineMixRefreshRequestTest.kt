package ru.agentik007.soundspan.downloads

import org.junit.Assert.*
import org.junit.Test

class OfflineMixRefreshRequestTest {
    private val identity = DownloadWorkIdentity("b".repeat(64), "https://fixture.invalid", "owner", 3, 1)
    @Test fun refreshProtocolIsClosedOwnerRevisionOnlyAndSurvivesRetry() {
        val request = OfflineMixRefreshRequest.parse(mapOf("fence" to identity.wire()["fence"], "revision" to 7))
        assertEquals(setOf("kind", "workProtocolVersion", "origin", "userId", "epoch", "revision"), request.flat().keys)
        assertEquals(setOf("kind", "fence", "revision"), request.wire().keys)
        assertEquals(request.flat(), OfflineMixRefreshRequest.fromFlat(request.flat()).flat())
        assertEquals(identity.ownerTag, request.ownerTag)
        for (bad in listOf(null, 0, -1, 1.0, "7", true)) {
            try { OfflineMixRefreshRequest.parse(mapOf("fence" to identity.wire()["fence"], "revision" to bad)); fail("bad revision") }
            catch (_: IllegalArgumentException) { }
        }
        try { OfflineMixRefreshRequest.fromFlat(request.flat() + ("source" to "daily:other")); fail("extra input") }
        catch (_: IllegalArgumentException) { }
        try { DownloadWorkIdentity.fromFlat(request.flat()); fail("old worker accepted trigger") }
        catch (_: IllegalArgumentException) { }
    }
    @Test fun independentRevisionAndOwnerHaveDifferentCancellationNames() {
        val first = OfflineMixRefreshRequest.parse(mapOf("fence" to identity.wire()["fence"], "revision" to 1))
        val second = OfflineMixRefreshRequest.parse(mapOf("fence" to identity.wire()["fence"], "revision" to 2))
        assertNotEquals(first.uniqueName, second.uniqueName)
    }
}
