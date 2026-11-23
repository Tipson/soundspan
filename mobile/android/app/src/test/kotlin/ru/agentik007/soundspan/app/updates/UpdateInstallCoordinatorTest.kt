package ru.agentik007.soundspan.app.updates

import org.junit.Assert.*
import org.junit.Test

class UpdateInstallCoordinatorTest {
    @Test fun crashBeforeReceiptCanRecoverOnlyOneExactOwnSessionAsUnknown() {
        val own = UpdateSessionOwner(7, ApkUpdateVerifier.PACKAGE, ApkUpdateVerifier.PACKAGE)
        assertEquals(7, ApkUpdateVerifier.recoverSession(listOf(own)))
        assertNull(ApkUpdateVerifier.recoverSession(listOf(own.copy(installer = "other"), own.copy(target = "other"))))
        try { ApkUpdateVerifier.recoverSession(listOf(own, own.copy(id = 8))); fail() } catch (_: IllegalArgumentException) {}
    }
    @Test fun repeatedPendingCallbackCanOpenConfirmationOnlyOnce() {
        val gate = UpdateCommitGate("nonce", 7)
        gate.commit("nonce", 7, true) {}
        assertFalse(gate.claimConfirmation("other", 7))
        assertTrue(gate.claimConfirmation("nonce", 7))
        assertFalse(gate.claimConfirmation("nonce", 7))
    }
    @Test fun explicitCurrentForegroundCommitRunsExactlyOnce() {
        val gate = UpdateCommitGate("nonce", 7); var commits = 0
        gate.commit("nonce", 7, true) { commits++ }
        try { gate.commit("nonce", 7, true) { commits++ }; fail() } catch (_: IllegalStateException) {}
        assertEquals(1, commits)
    }
    @Test fun finalGenerationAndForegroundGateRejectStaleStage() {
        for (kind in listOf("cancel", "background", "nonce", "session")) {
            val gate = UpdateCommitGate("nonce", 7); var commits = 0
            if (kind == "cancel") assertTrue(gate.cancel())
            try { gate.commit(if (kind == "nonce") "other" else "nonce", if (kind == "session") 8 else 7,
                kind != "background") { commits++ }; fail() } catch (_: IllegalStateException) {}
            assertEquals(0, commits)
        }
    }
    @Test fun callbackIdentityAndCancelledGenerationNeverAcceptLateConfirmation() {
        val gate = UpdateCommitGate("nonce", 7)
        assertFalse(gate.accepts("other", 7)); assertFalse(gate.accepts("nonce", 8))
        gate.commit("nonce", 7, true) {}
        assertTrue(gate.accepts("nonce", 7))
        assertFalse(gate.cancel()) // Accepted OS commit is not promised to roll back.
        assertFalse(gate.accepts("nonce", 7))
    }
}
