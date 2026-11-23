package ru.agentik007.soundspan.playback

import android.app.ActivityManager
import android.content.Context
import com.ryanheise.audioservice.AudioService
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodChannel

/** Read-only status of this application's media service; no caller-supplied IDs. */
class PlaybackServicePlugin : FlutterPlugin {
    private var channel: MethodChannel? = null
    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        val context = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, "soundspan/playback_service").also { transport ->
            transport.setMethodCallHandler { call, result ->
                if (call.method != "foreground") { result.notImplemented(); return@setMethodCallHandler }
                if (call.arguments != null) { result.error("service_status", "No arguments accepted", null); return@setMethodCallHandler }
                try {
                    val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
                    // Android O+ exposes only this app's services to this caller.
                    @Suppress("DEPRECATION")
                    val services = manager.getRunningServices(128)
                    val own = services.firstOrNull { it.service.packageName == context.packageName && it.service.className == AudioService::class.java.name }
                    result.success(own?.foreground ?: false)
                } catch (_: Exception) { result.error("service_status", "Media service status unavailable", null) }
            }
        }
    }
    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        channel = null
    }
}
