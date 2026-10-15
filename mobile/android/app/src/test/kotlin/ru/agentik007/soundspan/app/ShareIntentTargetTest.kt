package ru.agentik007.soundspan.app

import org.junit.Assert.*
import org.junit.Test

class ShareIntentTargetTest {
    private val token = "a".repeat(64)
    @Test fun exactSameOriginCapabilityIsAccepted() {
        assertEquals("https://music.example/share/$token", ShareIntentTarget.validate("https://music.example", "https://music.example/share/$token"))
    }
    @Test fun externalEncodedCredentialAndNonCapabilityTargetsAreRejected() {
        val targets = listOf("https://evil.example/share/$token", "http://music.example/share/$token", "https://a@music.example/share/$token", "https://music.example/share/%61${token.drop(1)}", "https://music.example/share/$token?token=x", "https://music.example/share/$token#x", "https://music.example/api/share-links/access/$token", "file:///share/$token")
        for (target in targets) {
            try { ShareIntentTarget.validate("https://music.example", target); fail("Unsafe target accepted") }
            catch (_: IllegalArgumentException) { }
        }
    }
}
