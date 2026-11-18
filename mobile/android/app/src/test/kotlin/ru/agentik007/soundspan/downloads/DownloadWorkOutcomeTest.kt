package ru.agentik007.soundspan.downloads

import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class DownloadWorkOutcomeTest {
    private val old = mapOf<String, Any>("outcome" to "retry", "retryAfterMillis" to 120000L)
    private val diagnostic = mapOf("phase" to "refresh", "code" to "network_unavailable", "state" to "waiting/queued")

    @Test fun optionalClosedDiagnosticPreservesExistingOutcomeAndHoldoff() {
        val value = DownloadWorkOutcome.parse(old + ("diagnostic" to diagnostic))
        assertEquals("retry", value.outcome)
        assertEquals(120000L, value.backoffMillis)
    }

    @Test fun oldTwoFieldEnvelopeRemainsAccepted() {
        val value = DownloadWorkOutcome.parse(old)
        assertEquals("retry", value.outcome)
        assertNull(value.diagnostic)
        assertEquals("ready", DownloadWorkOutcome.parse(mapOf("outcome" to "ready", "retryAfterMillis" to 0)).outcome)
    }

    @Test fun boundedEventContainsOnlySystemWorkUuidKindAndValidatedFacts() {
        val value = DownloadWorkOutcome.parse(old + ("diagnostic" to diagnostic))
        val event = value.event(UUID.fromString("00000000-0000-0000-0000-000000000001"), "refresh")
        assertTrue(event.length < 256)
        assertTrue(event.contains("phase=refresh code=network_unavailable state=waiting/queued"))
        assertFalse(event.contains("origin="))
        assertFalse(event.contains("user="))
        try { value.event(UUID.randomUUID(), "https://private.invalid"); fail("Accepted arbitrary request kind") }
        catch (_: IllegalArgumentException) { }
    }

    @Test fun unknownFieldsTypesAndSecretShapedValuesAreRejected() {
        val malformed = listOf<Any?>(null, "private", diagnostic + ("token" to "secret"),
            diagnostic + ("phase" to "https://private.invalid"), diagnostic + ("code" to "https://private.invalid?token=secret"),
            diagnostic + ("state" to "D:/private/file"), diagnostic + ("code" to 1),
            diagnostic + ("phase" to "future"), diagnostic + ("code" to "owner_opaque_identifier"),
            diagnostic + ("state" to "waiting/opaque-user"))
        for (bad in malformed) {
            try { DownloadWorkOutcome.parse(old + ("diagnostic" to bad)); fail("Accepted unsafe diagnostic") }
            catch (_: IllegalArgumentException) { } catch (_: ClassCastException) { } catch (_: NullPointerException) { }
        }
        try { DownloadWorkOutcome.parse(old + ("extra" to "secret")); fail("Accepted extra output field") }
        catch (_: IllegalArgumentException) { }
    }
}
