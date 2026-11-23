package ru.agentik007.soundspan.downloads

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

class DownloadExecutionPoolTest {
    @Test fun fortyRequestsStartOnlyTwoEnginesAndDrainWithoutLoss() = runBlocking {
        val pool = DownloadExecutionPool()
        val started = Channel<Unit>(Channel.UNLIMITED)
        val release = CompletableDeferred<Unit>()
        val active = AtomicInteger()
        val maximum = AtomicInteger()
        val completed = AtomicInteger()
        val jobs = List(40) {
            launch(Dispatchers.Default) {
                pool.run {
                    val count = active.incrementAndGet()
                    maximum.updateAndGet { old -> maxOf(old, count) }
                    started.send(Unit)
                    try { release.await(); completed.incrementAndGet() }
                    finally { active.decrementAndGet() }
                }
            }
        }
        try {
            withTimeout(2000) { repeat(2) { started.receive() } }
            assertNull(withTimeoutOrNull(100) { started.receive() })
            assertEquals(2, active.get())
        } finally { release.complete(Unit) }
        withTimeout(3000) { jobs.forEach { it.join() } }
        assertEquals(2, maximum.get())
        assertEquals(40, completed.get())
        assertEquals(0, active.get())
    }

    @Test fun cancelledWaiterAndFailedOrCancelledWorkerDoNotLeakPermits() = runBlocking {
        val pool = DownloadExecutionPool()
        val entered = Channel<Unit>(Channel.UNLIMITED)
        val release = CompletableDeferred<Unit>()
        val holder = launch { pool.run { entered.send(Unit); release.await() } }
        val cancelled = launch { pool.run { entered.send(Unit); CompletableDeferred<Unit>().await() } }
        withTimeout(2000) { repeat(2) { entered.receive() } }
        var waiterRan = false
        val waiter = launch { pool.run { waiterRan = true } }
        waiter.cancelAndJoin()
        cancelled.cancelAndJoin()
        try { pool.run<Unit> { throw IllegalStateException("fixture") }; fail("Expected failure") }
        catch (expected: IllegalStateException) { assertEquals("fixture", expected.message) }
        assertFalse(waiterRan)
        release.complete(Unit); holder.join()
        withTimeout(2000) { pool.run { pool.run { assertTrue(true) } } }
    }
}
