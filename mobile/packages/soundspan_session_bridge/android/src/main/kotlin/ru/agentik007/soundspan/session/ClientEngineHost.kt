package ru.agentik007.soundspan.session

import io.flutter.embedding.engine.FlutterEngine

/** Application-owned capabilities needed by a client engine before any Activity. */
interface ClientEngineHost {
    fun configureClientEngine(engine: FlutterEngine)
}
