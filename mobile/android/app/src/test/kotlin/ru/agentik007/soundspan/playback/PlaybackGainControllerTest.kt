package ru.agentik007.soundspan.playback

import org.junit.Assert.*
import org.junit.Test

class PlaybackGainControllerTest {
    @Test fun faultInjectionIsDeniedBeforeReleaseOrMutationOutsideDebug() {
        val effect = Effect()
        var creates = 0
        val controller = PlaybackGainController { creates++; effect }
        controller.bind(1, 42)
        controller.setGain(1, 3.0)
        val denied = controller.bind(2, 43, forceUnsupported = true, debuggable = false)
        assertEquals("gain_protocol", denied.failure)
        assertEquals(1L, denied.lease)
        assertFalse(effect.released)
        assertEquals(300, effect.gain)
        assertEquals(1, creates)
        val injected = controller.bind(2, 43, forceUnsupported = true, debuggable = true)
        assertFalse(injected.available)
        assertEquals("loudness_unavailable", injected.failure)
        assertEquals(1, creates)
    }
    private class Effect : GainEffect {
        var gain = 0
        var active = false
        var released = false
        var throwSet = false
        var throwClose = false
        override fun setTargetGainMb(value: Int) { if (throwSet) error("unavailable"); gain = value }
        override fun setEnabled(value: Boolean) { active = value }
        override fun read() = GainEffectState(gain.toDouble(), active)
        override fun close() { released = true; active = false; if (throwClose) error("release failed") }
    }
    @Test fun unsupportedConstructorIsTypedAndZeroDoesNotRetry() {
        var creates = 0
        val controller = PlaybackGainController { creates++; error("Unsupported device") }
        assertFalse(controller.bind(1, 42).available)
        assertEquals("loudness_unavailable", controller.setGain(1, 0.0).failure)
        assertFalse(controller.setGain(1, 3.0).available)
        controller.release(1)
        assertEquals(1, creates)
    }
    @Test fun bindsActualSessionAndReadsNativeMillibels() {
        val effect = Effect()
        val sessions = mutableListOf<Int>()
        val controller = PlaybackGainController { sessions.add(it); effect }
        assertTrue(controller.bind(1, 42).available)
        val applied = controller.setGain(1, 3.0)
        assertEquals(listOf(42), sessions)
        assertEquals(300.0, applied.targetGainMb, 0.0)
        assertTrue(applied.enabled)
        assertEquals(123.0, controller.setGain(1, 1.236).targetGainMb, 0.0)
        assertFalse(controller.setGain(1, 0.0).enabled)
        controller.release(1)
        assertTrue(effect.released)
    }
    @Test fun oldGainBindAndReleaseNeverTouchReplacement() {
        val effects = mutableListOf<Effect>()
        val controller = PlaybackGainController { Effect().also(effects::add) }
        controller.bind(1, 42)
        controller.setGain(1, 3.0)
        controller.bind(2, 43)
        controller.setGain(2, 1.5)
        controller.setGain(1, 3.0)
        controller.release(1)
        controller.bind(1, 42)
        assertEquals(2, effects.size)
        assertTrue(effects[0].released)
        assertFalse(effects[1].released)
        assertEquals(150, effects[1].gain)
        controller.close()
        assertTrue(effects[1].released)
    }
    @Test fun setterFailureReleasesEffectAndNeverEscapesToPlayer() {
        val effect = Effect()
        val controller = PlaybackGainController { effect }
        controller.bind(1, 42)
        effect.throwSet = true
        val state = controller.setGain(1, 3.0)
        assertFalse(state.available)
        assertEquals("loudness_unavailable", state.failure)
        assertTrue(effect.released)
        assertFalse(controller.setGain(1, 0.0).available)
    }
    @Test fun malformedValuesNeverCreateOrMutateEffects() {
        val effect = Effect()
        val controller = PlaybackGainController { effect }
        assertFalse(controller.bind(0, 0).available)
        controller.bind(1, 42)
        for (db in listOf(Double.NaN, Double.POSITIVE_INFINITY, -1.0, 3.01)) {
            assertEquals("gain_protocol", controller.setGain(1, db).failure)
        }
        assertEquals(0, effect.gain)
        assertEquals("gain_protocol", controller.setGain(1, 3.0, 99).failure)
        assertEquals("gain_protocol", controller.release(1, 99).failure)
        assertFalse(effect.released)
        effect.throwClose = true
        controller.close()
        assertTrue(effect.released)
    }
}
