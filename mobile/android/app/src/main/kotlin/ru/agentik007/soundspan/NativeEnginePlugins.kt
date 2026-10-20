package ru.agentik007.soundspan

import io.flutter.embedding.engine.FlutterEngine
import ru.agentik007.soundspan.downloads.AndroidMediaProbe
import ru.agentik007.soundspan.downloads.DownloadWorkerPlugin
import ru.agentik007.soundspan.playback.PlaybackGainPlugin
import ru.agentik007.soundspan.playback.PlaybackServicePlugin
import ru.agentik007.soundspan.session.SessionBrokerClientPlugin

/** Engine-owned capabilities; repeated UI attachment keeps the same instances. */
internal object NativeEnginePlugins {
    fun install(engine: FlutterEngine) {
        if (!engine.plugins.has(DownloadWorkerPlugin::class.java)) engine.plugins.add(DownloadWorkerPlugin())
        if (!engine.plugins.has(AndroidMediaProbe::class.java)) engine.plugins.add(AndroidMediaProbe())
        if (!engine.plugins.has(PlaybackGainPlugin::class.java)) engine.plugins.add(PlaybackGainPlugin())
        if (!engine.plugins.has(PlaybackServicePlugin::class.java)) engine.plugins.add(PlaybackServicePlugin())
    }

    /** Private download isolate retains its explicit role-specific allowlist. */
    fun installWorker(engine: FlutterEngine) {
        engine.plugins.add(com.tekartik.sqflite.SqflitePlugin())
        engine.plugins.add(com.github.dart_lang.jni.JniPlugin())
        engine.plugins.add(com.github.dart_lang.jni_flutter.JniFlutterPlugin())
        engine.plugins.add(SessionBrokerClientPlugin(hostCapabilities = false))
        engine.plugins.add(AndroidMediaProbe())
    }
}
