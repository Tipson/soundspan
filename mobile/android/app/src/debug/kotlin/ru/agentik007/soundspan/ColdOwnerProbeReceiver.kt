package ru.agentik007.soundspan

import android.app.Activity
import android.app.Application
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.media.browse.MediaBrowser
import android.media.session.MediaController
import com.ryanheise.audioservice.AudioService
import com.ryanheise.audioservice.AudioServicePlugin
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import ru.agentik007.soundspan.session.SessionBrokerHost
import ru.agentik007.soundspan.session.SessionBrokerRegistry

/** Debug-only launcher for integration_test/cold_owner_entrypoint.dart. */
class ColdOwnerProbeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val application = context.applicationContext as Application
        when (val operation = intent.getStringExtra("operation")) {
            "seed", "cold", "queued" -> start(application, operation)
            "play", "pause", "next", "seek" -> media(application, operation)
            "inspect" -> channel?.invokeMethod("inspect", null, logger("INSPECT"))
            else -> Log.e(TAG, "Unknown probe operation")
        }
    }

    companion object {
        private const val TAG = "ColdOwnerProbe"
        private var engine: FlutterEngine? = null
        private var channel: MethodChannel? = null
        private var activityCount = 0
        private var attachedCount = 0
        private val browsers = mutableSetOf<MediaBrowser>()

        private fun start(application: Application, mode: String) {
            check(engine == null) { "Force-stop between probe phases" }
            application.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
                override fun onActivityCreated(activity: Activity, state: Bundle?) { activityCount++ }
                override fun onActivityResumed(activity: Activity) {
                    if (activity !is FlutterActivity) return
                    val accessor = FlutterActivity::class.java.getDeclaredMethod("getFlutterEngine")
                    accessor.isAccessible = true
                    val attached = accessor.invoke(activity) as? FlutterEngine
                    attachedCount++
                    val same = attached === engine
                    Log.i(TAG, "ACTIVITY sameEngine=$same activityCount=$activityCount attachments=$attachedCount")
                    channel?.invokeMethod("activityAttached", mapOf("sameEngine" to same, "activityCount" to activityCount), logger("ATTACH"))
                }
                override fun onActivityStarted(activity: Activity) {}
                override fun onActivityPaused(activity: Activity) {}
                override fun onActivityStopped(activity: Activity) {}
                override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
                override fun onActivityDestroyed(activity: Activity) {}
            })
            // Exact pinned audio_service production constructor/cache/default-main path.
            val created = AudioServicePlugin.getFlutterEngine(application)
            engine = created
            val bridge = MethodChannel(created.dartExecutor.binaryMessenger, "soundspan/cold_owner_probe")
            channel = bridge
            bridge.setMethodCallHandler { call, result ->
                when (call.method) {
                    "configuration" -> result.success(mapOf("mode" to mode, "activityCount" to activityCount, "engineId" to System.identityHashCode(created)))
                    "nativeState" -> {
                        val host = SessionBrokerRegistry.connector as SessionBrokerHost
                        // Exact pinned audio_service 0.18.19 fields, read only.
                        val handlerField = AudioServicePlugin::class.java.getDeclaredField("audioHandlerInterface").also { it.isAccessible = true }
                        val handler = handlerField.get(null)
                        val pending = if (handler == null) emptyList<String>() else {
                            val queueField = handler.javaClass.getDeclaredField("methodInvocationQueue").also { it.isAccessible = true }
                            (queueField.get(handler) as List<*>).map { invocation ->
                                val method = invocation!!.javaClass.getDeclaredField("method").also { it.isAccessible = true }
                                method.get(invocation) as String
                            }
                        }
                        result.success(mapOf("activityCount" to activityCount, "attachments" to attachedCount, "engineId" to System.identityHashCode(created), "brokerStarts" to host.brokerStartCount, "clients" to host.clientCount, "pendingMethods" to pending))
                    }
                    "report" -> { Log.i(TAG, "DART ${call.arguments}"); result.success(null) }
                    else -> result.notImplemented()
                }
            }
            Log.i(TAG, "START mode=$mode activityCount=$activityCount engineId=${System.identityHashCode(created)}")
            if (mode == "queued") media(application, "play")
        }

        private fun media(context: Context, operation: String) {
            lateinit var browser: MediaBrowser
            browser = MediaBrowser(context, ComponentName(context, AudioService::class.java), object : MediaBrowser.ConnectionCallback() {
                override fun onConnected() {
                    try {
                        val controller = MediaController(context, browser.sessionToken)
                        // Read-only evidence of the pinned plugin's dispatch queue. No mutation.
                        val readyField = AudioServicePlugin::class.java.getDeclaredField("flutterReady").also { it.isAccessible = true }
                        val flutterReady = readyField.getBoolean(null)
                        Log.i(TAG, "MEDIA operation=$operation flutterReady=$flutterReady activityCount=$activityCount")
                        when (operation) {
                            "play" -> controller.transportControls.play()
                            "pause" -> controller.transportControls.pause()
                            "next" -> controller.transportControls.skipToNext()
                            "seek" -> controller.transportControls.seekTo(6000)
                        }
                    } catch (error: Throwable) {
                        Log.e(TAG, "MEDIA_FAILURE operation=$operation", error)
                    } finally { browser.disconnect(); browsers.remove(browser) }
                }
                override fun onConnectionFailed() { Log.e(TAG, "MEDIA_CONNECTION_FAILURE"); browsers.remove(browser) }
            }, null)
            browsers.add(browser)
            browser.connect()
        }

        private fun logger(label: String) = object : MethodChannel.Result {
            override fun success(value: Any?) { Log.i(TAG, "$label $value") }
            override fun error(code: String, message: String?, details: Any?) { Log.e(TAG, "$label FAILURE $code $message $details") }
            override fun notImplemented() { Log.e(TAG, "$label NOT_IMPLEMENTED") }
        }
    }
}
