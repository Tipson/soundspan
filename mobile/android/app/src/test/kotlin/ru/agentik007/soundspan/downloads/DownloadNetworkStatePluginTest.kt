package ru.agentik007.soundspan.downloads

import org.junit.Assert.*
import org.junit.Test
import java.util.ArrayDeque

class DownloadNetworkStatePluginTest {
    private class Source : DownloadNetworkStateSource {
        var route: Any? = "route-a"
        var facts: DownloadNetworkCapabilities? = DownloadNetworkCapabilities(true, true, false, true)
        var duringRead: (() -> Unit)? = null
        var failRead = false
        var failRegister = false
        var failUnregister = false
        var registrations = 0
        var active = 0
        var closed = 0
        val callbacks = mutableListOf<() -> Unit>()
        override fun activeNetwork(): Any? {
            if (failRead) throw SecurityException("Synthetic denied platform read")
            return route
        }
        override fun capabilities(network: Any): DownloadNetworkCapabilities? {
            duringRead?.invoke()
            return facts
        }
        override fun watch(changed: () -> Unit): AutoCloseable {
            if (failRegister) throw SecurityException("Synthetic denied registration")
            registrations++; active++; callbacks += changed
            return AutoCloseable {
                closed++
                if (failUnregister) throw IllegalStateException("Synthetic unregister failure")
                active--
            }
        }
    }
    private class Fixture {
        val source = Source()
        val queued = ArrayDeque<() -> Unit>()
        val events = mutableListOf<Map<String, Any?>>()
        val monitor = DownloadNetworkStateMonitor(source) { queued.add(it) }
        fun listen() = monitor.listen { events += it }
        fun flush() { while (queued.isNotEmpty()) queued.removeFirst().invoke() }
    }
    private val unknown = mapOf("v" to 1, "connected" to false, "wifi" to null, "metered" to null, "roaming" to null)

    @Test fun wifiCanBeMeteredAndWireIsClosedVersionOne() {
        val f = Fixture()
        val state = f.monitor.snapshot()
        assertEquals(setOf("v", "connected", "wifi", "metered", "roaming"), state.keys)
        assertEquals(1, state["v"])
        assertEquals(true, state["connected"])
        assertEquals(true, state["wifi"])
        assertEquals(true, state["metered"])
        f.source.facts = f.source.facts!!.copy(notMetered = true)
        assertEquals(false, f.monitor.snapshot()["metered"])
    }
    @Test fun roamingUsesCurrentCapabilityAndLegacyOnlyWhenKnown() {
        val f = Fixture()
        f.source.facts = DownloadNetworkCapabilities(true, false, false, false)
        assertEquals(true, f.monitor.snapshot()["roaming"])
        f.source.facts = DownloadNetworkCapabilities(true, false, false, null, legacyRoaming = true)
        assertEquals(true, f.monitor.snapshot()["roaming"])
        f.source.facts = f.source.facts!!.copy(legacyRoaming = false)
        assertEquals(false, f.monitor.snapshot()["roaming"])
        f.source.facts = f.source.facts!!.copy(legacyRoaming = null)
        assertNull(f.monitor.snapshot()["roaming"])
    }
    @Test fun legacyVpnCannotClaimNonRoamingFromLegacyNetworkInfo() {
        val f = Fixture()
        f.source.facts = DownloadNetworkCapabilities(true, false, false, null, legacyRoaming = false, vpn = true)
        assertNull(f.monitor.snapshot()["roaming"])
        assertEquals(true, f.monitor.snapshot()["metered"])
    }
    @Test fun missingRouteCapabilitiesInternetOrPermissionFailsClosed() {
        val f = Fixture()
        f.source.route = null; assertEquals(unknown, f.monitor.snapshot())
        f.source.route = "route-a"; f.source.facts = null
        assertEquals(unknown, f.monitor.snapshot())
        f.source.facts = DownloadNetworkCapabilities(false, true, true, true)
        assertEquals(unknown, f.monitor.snapshot())
        f.source.failRead = true; assertEquals(unknown, f.monitor.snapshot())
    }
    @Test fun changedActiveRouteCannotMixOldCapabilitiesWithNewRoute() {
        val f = Fixture()
        f.source.duringRead = { f.source.route = "route-b" }
        assertEquals(unknown, f.monitor.snapshot())
    }
    @Test fun initialAndCallbackEventsUseSameCurrentRouteExtractorOnDispatch() {
        val f = Fixture(); f.listen()
        assertTrue(f.events.isEmpty()); assertEquals(1, f.source.active)
        f.flush(); assertEquals(f.monitor.snapshot(), f.events.single())
        f.source.callbacks.single().invoke()
        f.source.route = "route-b"
        f.source.facts = DownloadNetworkCapabilities(true, false, true, false)
        assertEquals(1, f.events.size)
        f.flush()
        assertEquals(f.monitor.snapshot(), f.events.last())
        assertEquals(false, f.events.last()["wifi"])
        assertEquals(false, f.events.last()["metered"])
        assertEquals(true, f.events.last()["roaming"])
    }
    @Test fun cancelInvalidatesAlreadyQueuedInitialAndPlatformCallbacks() {
        val f = Fixture(); f.listen()
        f.source.callbacks.single().invoke(); f.monitor.cancel(); f.flush()
        assertTrue(f.events.isEmpty()); assertEquals(0, f.source.active)
        assertEquals(1, f.source.closed)
    }
    @Test fun replacementSinkCannotBeRevivedByOldCallback() {
        val f = Fixture(); val old = mutableListOf<Map<String, Any?>>()
        f.monitor.listen { old += it }; val callback = f.source.callbacks.single()
        f.listen(); callback(); f.flush()
        assertTrue(old.isEmpty()); assertEquals(1, f.events.size)
        assertEquals(1, f.source.active); assertEquals(2, f.source.registrations)
    }
    @Test fun detachClosesCallbackAndRejectsLateEventsOrNewListen() {
        val f = Fixture(); f.listen(); val callback = f.source.callbacks.single()
        f.monitor.close(); callback(); f.listen(); f.flush()
        assertEquals(unknown, f.monitor.snapshot()); assertTrue(f.events.isEmpty())
        assertEquals(0, f.source.active); assertEquals(1, f.source.registrations)
    }
    @Test fun registrationFailureCannotPublishOrRefreshAnAllow() {
        val f = Fixture(); f.source.failRegister = true; f.listen(); f.flush()
        assertEquals(listOf(unknown), f.events)
        assertEquals(unknown, f.monitor.snapshot())
    }
    @Test fun failedUnregisterCannotAccumulateCallbacksOnResubscribe() {
        val f = Fixture(); f.listen(); f.source.failUnregister = true
        f.listen(); f.flush()
        assertEquals(1, f.source.registrations); assertEquals(1, f.source.active)
        assertEquals(listOf(unknown), f.events)
        f.source.failUnregister = false; f.monitor.close()
        assertEquals(0, f.source.active)
    }
    @Test fun platformErrorDuringEventNeverRetainsLastAllow() {
        val f = Fixture(); f.listen(); f.flush()
        assertEquals(true, f.events.single()["connected"])
        f.source.failRead = true; f.source.callbacks.single().invoke(); f.flush()
        assertEquals(unknown, f.events.last())
    }
}
