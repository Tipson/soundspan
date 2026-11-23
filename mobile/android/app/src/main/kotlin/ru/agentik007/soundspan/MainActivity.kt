package ru.agentik007.soundspan

import com.ryanheise.audioservice.AudioServiceActivity
import io.flutter.embedding.engine.FlutterEngine
import ru.agentik007.soundspan.app.nativefiles.NativeDocumentsPlugin
import ru.agentik007.soundspan.app.NativeSharePlugin
import ru.agentik007.soundspan.app.updates.NativeAppUpdatePlugin

class MainActivity : AudioServiceActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        NativeEnginePlugins.install(flutterEngine)
        if (!flutterEngine.plugins.has(NativeDocumentsPlugin::class.java)) flutterEngine.plugins.add(NativeDocumentsPlugin())
        if (!flutterEngine.plugins.has(NativeSharePlugin::class.java)) flutterEngine.plugins.add(NativeSharePlugin())
        if (!flutterEngine.plugins.has(NativeAppUpdatePlugin::class.java)) flutterEngine.plugins.add(NativeAppUpdatePlugin())
    }
}
