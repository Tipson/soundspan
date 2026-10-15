package ru.agentik007.soundspan.playback

import android.content.pm.ApplicationInfo
import android.media.audiofx.AudioEffect
import android.media.audiofx.LoudnessEnhancer
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodChannel

/** Flutter-engine lifetime; no Activity, player, queue, credentials or storage. */
class PlaybackGainPlugin : FlutterPlugin {
    private var channel: MethodChannel? = null
    private val controller = PlaybackGainController { sessionId -> AndroidGainEffect(sessionId) }
    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        val debuggable = binding.applicationContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        channel = MethodChannel(binding.binaryMessenger, "soundspan/playback_gain").also { transport ->
            transport.setMethodCallHandler { call, result ->
                try {
                    val args = call.arguments as? Map<*, *> ?: throw IllegalArgumentException()
                    val lease = (args["lease"] as? Number)?.toLong() ?: throw IllegalArgumentException()
                    val session = args["sessionId"] as? Int ?: throw IllegalArgumentException()
                    val state = when (call.method) {
                        "bind" -> {
                            require(args.keys == setOf("lease", "sessionId") || args.keys == setOf("lease", "sessionId", "forceUnsupported"))
                            val fault = if (args.containsKey("forceUnsupported")) args["forceUnsupported"] as? Boolean ?: throw IllegalArgumentException() else false
                            controller.bind(lease, session, fault, debuggable)
                        }
                        "gain" -> {
                            require(args.keys == setOf("lease", "sessionId", "db"))
                            controller.setGain(lease, (args["db"] as? Number)?.toDouble() ?: throw IllegalArgumentException(), session)
                        }
                        "release" -> { require(args.keys == setOf("lease", "sessionId")); controller.release(lease, session) }
                        "read" -> { require(args.keys == setOf("lease", "sessionId")); controller.read(lease, session) }
                        else -> { result.notImplemented(); return@setMethodCallHandler }
                    }
                    result.success(mapOf("lease" to state.lease, "sessionId" to state.sessionId, "available" to state.available,
                        "targetGainMb" to state.targetGainMb, "enabled" to state.enabled, "failure" to state.failure))
                } catch (_: Exception) { result.error("gain_protocol", "Invalid gain operation", null) }
            }
        }
    }
    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        channel = null
        controller.close()
    }
}

private class AndroidGainEffect(sessionId: Int) : GainEffect {
    private val effect = LoudnessEnhancer(sessionId)
    override fun setTargetGainMb(value: Int) = effect.setTargetGain(value)
    override fun setEnabled(value: Boolean) { check(effect.setEnabled(value) == AudioEffect.SUCCESS) }
    override fun read() = GainEffectState(effect.targetGain.toDouble(), effect.enabled)
    override fun close() = effect.release()
}
