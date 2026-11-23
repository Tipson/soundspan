package ru.agentik007.soundspan.session

import org.junit.Assert.*
import org.junit.Test

class BrokerLeaseLedgerTest {
    @Test fun pendingWriteRetainsHostAfterEveryClientDetaches() {
        val ledger = BrokerLeaseLedger()
        ledger.acquire("ui")
        ledger.acquire("worker")
        val rpc = ledger.begin("worker")
        ledger.release("ui")
        assertFalse(ledger.isQuiescent)
        ledger.release("worker")
        assertFalse(ledger.isQuiescent)
        ledger.finish(rpc)
        assertTrue(ledger.isQuiescent)
        ledger.finish(rpc)
        assertTrue(ledger.isQuiescent)
    }
    @Test fun unattachedClientCannotDispatchAndDoubleAcquireIsRejected() {
        val ledger = BrokerLeaseLedger()
        assertThrows(IllegalStateException::class.java) { ledger.begin("forged") }
        ledger.acquire("one")
        assertThrows(IllegalStateException::class.java) { ledger.acquire("one") }
    }
}
