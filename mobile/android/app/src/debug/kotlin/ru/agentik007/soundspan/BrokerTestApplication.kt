package ru.agentik007.soundspan

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import io.flutter.FlutterInjector
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.engine.dart.DartExecutor
import io.flutter.plugin.common.MethodChannel
import ru.agentik007.soundspan.session.SessionBrokerClientPlugin
import ru.agentik007.soundspan.session.SessionBrokerHost
import ru.agentik007.soundspan.session.SessionBrokerRegistry

/** Debug source set only: no probe channel, entrypoint or seed in release APK. */
class BrokerTestApplication : SoundspanApplication(), Application.ActivityLifecycleCallbacks {
    private var probe: FlutterEngine? = null
    private var probeChannel: MethodChannel? = null
    private val main = Handler(Looper.getMainLooper())
    override fun onCreate() { super.onCreate(); registerActivityLifecycleCallbacks(this) }
    override fun onActivityResumed(activity: Activity) {
        if (activity !is FlutterActivity) return
        // FlutterActivity keeps this accessor protected. Debug-only harness
        // inspects it without adding test APIs to the production Activity.
        val accessor = FlutterActivity::class.java.getDeclaredMethod("getFlutterEngine")
        accessor.isAccessible = true
        val engine = accessor.invoke(activity) as? FlutterEngine ?: return
        MethodChannel(engine.dartExecutor.binaryMessenger, "soundspan/session_probe_harness").setMethodCallHandler { call, result ->
            when (call.method) {
                "privateCapabilities" -> {
                    val cold = FlutterEngine(this, null, false)
                    try {
                        NativeEnginePlugins.installWorker(cold)
                        result.success(mapOf(
                            "sessionBroker" to cold.plugins.has(SessionBrokerClientPlugin::class.java),
                            "mediaProbe" to cold.plugins.has(ru.agentik007.soundspan.downloads.AndroidMediaProbe::class.java),
                            "downloads" to cold.plugins.has(ru.agentik007.soundspan.downloads.DownloadWorkerPlugin::class.java),
                            "gain" to cold.plugins.has(ru.agentik007.soundspan.playback.PlaybackGainPlugin::class.java),
                            "audio" to cold.plugins.has(com.ryanheise.audioservice.AudioServicePlugin::class.java),
                            "secureStorage" to cold.plugins.has(com.it_nomads.fluttersecurestorage.FlutterSecureStoragePlugin::class.java)
                        ))
                    } finally { cold.destroy() }
                }
                "coldCapabilities" -> {
                    // Match audio_service's application-context construction;
                    // this engine is never attached to an Activity or runs Dart.
                    val cold = FlutterEngine(this)
                    try {
                        result.success(mapOf(
                            "activityAttached" to false,
                            "sessionBroker" to cold.plugins.has(SessionBrokerClientPlugin::class.java),
                            "downloads" to cold.plugins.has(ru.agentik007.soundspan.downloads.DownloadWorkerPlugin::class.java),
                            "mediaProbe" to cold.plugins.has(ru.agentik007.soundspan.downloads.AndroidMediaProbe::class.java),
                            "gain" to cold.plugins.has(ru.agentik007.soundspan.playback.PlaybackGainPlugin::class.java)
                        ))
                    } finally { cold.destroy() }
                }
                "start" -> {
                    if (probe != null) { result.error("already_started", "Probe exists", null); return@setMethodCallHandler }
                    val worker = FlutterEngine(this, null, false)
                    probe = worker
                    worker.plugins.add(com.tekartik.sqflite.SqflitePlugin())
                    worker.plugins.add(com.github.dart_lang.jni.JniPlugin())
                    worker.plugins.add(com.github.dart_lang.jni_flutter.JniFlutterPlugin())
                    worker.plugins.add(SessionBrokerClientPlugin(hostCapabilities = false))
                    val channel = MethodChannel(worker.dartExecutor.binaryMessenger, "soundspan/session_probe")
                    probeChannel = channel
                    var completed = false
                    val timeout = Runnable { if (!completed) { completed = true; result.error("probe_timeout", "No probe ready", null) } }
                    channel.setMethodCallHandler { probeCall, reply ->
                        if (probeCall.method == "ready") {
                            reply.success(null)
                            if (!completed) { completed = true; main.removeCallbacks(timeout); result.success(null) }
                        } else reply.notImplemented()
                    }
                    main.postDelayed(timeout, 15_000)
                    worker.dartExecutor.executeDartEntrypoint(DartExecutor.DartEntrypoint(FlutterInjector.instance().flutterLoader().findAppBundlePath(), "sessionProbeMain"))
                }
                "command" -> {
                    val args = call.arguments as Map<*, *>
                    val channel = probeChannel
                    if (channel == null) result.error("no_probe", "Probe absent", null)
                    else channel.invokeMethod(args["method"] as String, args["args"], result)
                }
                "stats" -> {
                    val host = SessionBrokerRegistry.connector as SessionBrokerHost
                    result.success(mapOf("clients" to host.clientCount, "brokerStarts" to host.brokerStartCount))
                }
                "stop" -> {
                    probeChannel?.invokeMethod("close", null, object : MethodChannel.Result {
                        private fun finish() { probe?.destroy(); probe = null; probeChannel = null; result.success(null) }
                        override fun success(value: Any?) = finish()
                        override fun error(code: String, message: String?, details: Any?) = finish()
                        override fun notImplemented() = finish()
                    }) ?: result.success(null)
                }
                else -> result.notImplemented()
            }
        }
    }
    override fun onActivityStarted(activity: Activity) {}
    override fun onActivityCreated(activity: Activity, state: Bundle?) {}
    override fun onActivityPaused(activity: Activity) {}
    override fun onActivityStopped(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    override fun onActivityDestroyed(activity: Activity) { probe?.destroy(); probe = null; probeChannel = null }
}
