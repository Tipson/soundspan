package ru.agentik007.soundspan.downloads

import org.junit.Assert.*
import org.junit.Test

class DownloadWorkerHeadlessPermissionTest {
    @Test fun headlessMissingPermissionNeverStartsAnActivityRequest() {
        for (pending in listOf(false, true)) {
            assertEquals(false, DownloadWorkerPlugin.notificationPermissionDecision(33, false, false, pending))
            assertEquals(false, DownloadWorkerPlugin.notificationPermissionDecision(36, false, false, pending))
        }
        assertEquals(true, DownloadWorkerPlugin.notificationPermissionDecision(24, false, false, false))
        assertEquals(true, DownloadWorkerPlugin.notificationPermissionDecision(36, true, false, false))
        assertNull(DownloadWorkerPlugin.notificationPermissionDecision(36, false, true, false))
    }
}
