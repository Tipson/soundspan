package ru.agentik007.soundspan

import android.app.Application
import io.flutter.embedding.engine.FlutterEngine
import ru.agentik007.soundspan.session.ClientEngineHost
import ru.agentik007.soundspan.session.SessionBrokerHost
import ru.agentik007.soundspan.session.SessionBrokerRegistry

open class SoundspanApplication : Application(), ClientEngineHost {
    override fun onCreate() {
        super.onCreate()
        SessionBrokerRegistry.connector = SessionBrokerHost(this)
    }

    override fun configureClientEngine(engine: FlutterEngine) {
        NativeEnginePlugins.install(engine)
    }
}
