package ru.agentik007.soundspan.downloads

import androidx.work.NetworkType
import org.junit.Assert.*
import org.junit.Test

class DownloadWorkRequestTest {
    private val identity = DownloadWorkIdentity("b".repeat(64), "https://fixture.invalid", "owner", 3, 4)
    private fun rejects(action: () -> Unit) {
        try { action(); fail("Accepted invalid work envelope") }
        catch (_: IllegalArgumentException) { }
        catch (_: ClassCastException) { }
    }

    @Test fun dailyEnvelopeIsClosedMarkedAndSurvivesRetryWithoutWeakeningNetwork() {
        val request = DownloadWorkRequest.parse(identity.wire() + ("refreshRevision" to 7))
        assertEquals(identity, request.identity)
        assertEquals(NetworkType.UNMETERED, request.networkType)
        assertEquals(3, request.flat()["workProtocolVersion"])
        assertEquals(7L, request.flat()["refreshRevision"])
        assertEquals(request.flat(), DownloadWorkRequest.fromFlat(request.flat()).flat())
        rejects { DownloadWorkRequest.parse(identity.wire() + mapOf("refreshRevision" to 7, "networkConstraint" to "connected")) }
        rejects { DownloadWorkRequest.fromFlat(request.flat() - "refreshRevision") }
        rejects { DownloadWorkIdentity.fromFlat(request.flat()) }
    }

    @Test fun omittedScheduleConstraintIsUnmeteredAndIdentityIsUnchanged() {
        val request = DownloadWorkRequest.parse(identity.wire())
        assertEquals(identity, request.identity)
        assertEquals(identity.uniqueName, request.identity.uniqueName)
        assertEquals(identity.wire(), request.identity.wire())
        assertEquals(NetworkType.UNMETERED, request.networkType)
        assertFalse(request.requiresLegacyUpgrade)
    }
    @Test fun explicitConstraintsHaveExactCoarseWorkManagerMeaning() {
        for ((wire, expected) in mapOf("unmetered" to NetworkType.UNMETERED,
                "notRoaming" to NetworkType.NOT_ROAMING, "connected" to NetworkType.CONNECTED)) {
            val request = DownloadWorkRequest.parse(identity.wire() + ("networkConstraint" to wire))
            assertEquals(expected, request.networkType)
            assertEquals(wire, request.flat()["networkConstraint"])
            assertEquals(identity, request.identity)
        }
    }
    @Test fun newWorkDataHasSeparateVersionedConstraintAndOldActualParserRejectsIt() {
        val request = DownloadWorkRequest.parse(identity.wire())
        val flat = request.flat()
        assertEquals(identity.flat().keys + setOf("workProtocolVersion", "networkConstraint"), flat.keys)
        assertEquals(2, flat["workProtocolVersion"])
        assertEquals("unmetered", flat["networkConstraint"])
        rejects { DownloadWorkIdentity.fromFlat(flat) }
        assertEquals(identity, DownloadWorkIdentity.fromFlat(flat.filterKeys { it in identity.flat().keys }))
    }
    @Test fun v2ConstraintSurvivesRepeatedRetrySerializationForAllPolicies() {
        for (wire in listOf("unmetered", "notRoaming", "connected")) {
            var request = DownloadWorkRequest.parse(identity.wire() + ("networkConstraint" to wire))
            val holdoff = DownloadWorkOutcome.parse(mapOf("outcome" to "retry", "retryAfterMillis" to 240000L))
            repeat(3) {
                val updated = DownloadWorkRequest.fromFlat(request.flat())
                assertEquals(request.networkType, updated.networkType)
                assertEquals(request.flat(), updated.flat())
                assertEquals(identity, updated.identity)
                assertFalse(updated.requiresLegacyUpgrade)
                assertEquals(240000L, holdoff.backoffMillis)
                request = updated
            }
        }
    }
    @Test fun legacyInputRequiresUpgradeToMarkedUnmeteredBeforeWorkerAdmission() {
        val legacy = DownloadWorkRequest.fromFlat(identity.flat())
        assertTrue(legacy.requiresLegacyUpgrade)
        assertEquals(NetworkType.UNMETERED, legacy.networkType)
        assertEquals(identity, legacy.identity)
        val upgraded = DownloadWorkRequest.fromFlat(legacy.flat())
        assertFalse(upgraded.requiresLegacyUpgrade)
        assertEquals(NetworkType.UNMETERED, upgraded.networkType)
        rejects { DownloadWorkIdentity.fromFlat(legacy.flat()) }
    }
    @Test fun malformedScheduleConstraintCannotSilentlyBecomeConnected() {
        for (bad in listOf(null, true, 1, "", "wifi", "UNMETERED", "not_roaming", " connected ")) {
            rejects { DownloadWorkRequest.parse(identity.wire() + ("networkConstraint" to bad)) }
        }
        rejects { DownloadWorkRequest.parse(identity.wire() + ("token" to "secret")) }
        rejects { DownloadWorkRequest.parse(identity.wire() + ("workProtocolVersion" to 2)) }
    }
    @Test fun partialUnknownVersionOrUnknownFlatFieldFailsClosed() {
        val valid = identity.flat() + mapOf("workProtocolVersion" to 2, "networkConstraint" to "unmetered")
        for (version in listOf(null, 1, 3, 2L, 2.0, "2", true)) {
            rejects { DownloadWorkRequest.fromFlat(valid + ("workProtocolVersion" to version)) }
        }
        for (bad in listOf(valid - "networkConstraint", valid - "workProtocolVersion",
                valid + ("token" to "secret"), valid + ("networkConstraint" to null),
                valid + ("networkConstraint" to "unknown"), valid - "generation")) {
            rejects { DownloadWorkRequest.fromFlat(bad) }
        }
    }
    @Test fun additionalNetworkFieldsAreNotAcceptedByCoreWireParser() {
        rejects { DownloadWorkIdentity.parse(identity.wire() + ("networkConstraint" to "connected")) }
        rejects { DownloadWorkRequest.parse(identity.wire() + ("networkConstraint" to "connected") + ("fence" to mapOf("owner" to mapOf("origin" to "https://fixture.invalid", "userId" to "owner"), "epoch" to 0))) }
    }
}
