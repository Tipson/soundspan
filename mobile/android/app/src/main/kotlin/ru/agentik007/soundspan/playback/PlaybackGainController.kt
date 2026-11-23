package ru.agentik007.soundspan.playback

import kotlin.math.floor

internal data class GainEffectState(val targetGainMb: Double, val enabled: Boolean)
internal interface GainEffect {
    fun setTargetGainMb(value: Int)
    fun setEnabled(value: Boolean)
    fun read(): GainEffectState
    fun close()
}
internal data class GainState(
    val lease: Long = 0, val sessionId: Int? = null,
    val available: Boolean = false, val targetGainMb: Double = 0.0,
    val enabled: Boolean = false, val failure: String? = null,
)

/** One effect bound to the existing player's exact audio session, never a player. */
internal class PlaybackGainController(private val factory: (Int) -> GainEffect) {
    private var effect: GainEffect? = null
    private var state = GainState()
    @Synchronized fun bind(lease: Long, sessionId: Int, forceUnsupported: Boolean = false, debuggable: Boolean = false): GainState {
        if (forceUnsupported && !debuggable) return state.copy(failure = "gain_protocol")
        if (lease <= state.lease || sessionId <= 0) return state.copy(failure = "gain_protocol")
        closeEffect()
        state = GainState(lease = lease, sessionId = sessionId)
        return guarded {
            if (forceUnsupported) throw UnsupportedOperationException("Synthetic constructor failure")
            effect = factory(sessionId)
            effect!!.setEnabled(false)
            effect!!.setTargetGainMb(0)
            readCurrent()
        }
    }
    @Synchronized fun setGain(lease: Long, db: Double, sessionId: Int? = state.sessionId): GainState {
        if (lease != state.lease || sessionId != state.sessionId || !db.isFinite() || db < 0 || db > 3) return state.copy(failure = "gain_protocol")
        val current = effect ?: return state
        return guarded {
            if (db == 0.0) current.setEnabled(false)
            // System precision must never round above the track's peak ceiling.
            current.setTargetGainMb(floor(db * 100).toInt())
            if (db > 0) current.setEnabled(true)
            readCurrent()
        }
    }
    @Synchronized fun read(lease: Long, sessionId: Int? = state.sessionId): GainState = if (lease == state.lease && sessionId == state.sessionId) guarded { readCurrent() } else state.copy(failure = "gain_protocol")
    private fun readCurrent(): GainState {
        val value = effect?.read() ?: return state
        state = state.copy(available = true, targetGainMb = value.targetGainMb, enabled = value.enabled, failure = null)
        return state
    }
    @Synchronized fun release(lease: Long, sessionId: Int? = state.sessionId): GainState {
        if (lease != state.lease || sessionId != state.sessionId) return state.copy(failure = "gain_protocol")
        closeEffect()
        state = GainState(lease = state.lease)
        return state
    }
    @Synchronized fun close() { closeEffect(); state = GainState(lease = state.lease) }
    private fun closeEffect() {
        val previous = effect
        effect = null
        try { previous?.setEnabled(false) } catch (_: Exception) { }
        try { previous?.close() } catch (_: Exception) { }
    }
    private inline fun guarded(action: () -> GainState): GainState = try { action() } catch (_: Exception) {
        closeEffect()
        state = state.copy(available = false, enabled = false, targetGainMb = 0.0, failure = "loudness_unavailable")
        state
    }
}
