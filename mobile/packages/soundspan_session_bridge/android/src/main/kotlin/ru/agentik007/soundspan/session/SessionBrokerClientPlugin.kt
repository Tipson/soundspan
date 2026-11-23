package ru.agentik007.soundspan.session

import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodChannel

/** Engine-scoped attachment, including cold audio_service without an Activity. */
class SessionBrokerClientPlugin(private val hostCapabilities: Boolean = true) : FlutterPlugin {
    private var channel: MethodChannel? = null
    private var connector: SessionBrokerConnector? = null
    private var clientId: String? = null
    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        val transport = MethodChannel(binding.binaryMessenger, SessionBrokerProtocol.CLIENT_CHANNEL)
        channel = transport
        connector = SessionBrokerRegistry.connector
        clientId = connector?.connect { event -> transport.invokeMethod("event", event) }
        transport.setMethodCallHandler { call, result ->
            val host = connector
            // A released Dart composition may reconnect in the same engine.
            // Only attach creates a fresh host identity; other RPCs stay closed.
            if (host != null && clientId == null && call.method == "rpc" &&
                SessionBrokerProtocol.method(call.arguments) == "attach") {
                clientId = host.connect { event -> transport.invokeMethod("event", event) }
            }
            val id = clientId
            if (host == null || id == null) {
                SessionBrokerProtocol.failure(result, "broker_unavailable")
            } else when (call.method) {
                "rpc" -> host.dispatch(id, call.arguments, result)
                "release" -> {
                    host.disconnect(id)
                    clientId = null
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
        if (hostCapabilities) configureHostCapabilities(binding)
    }

    // The generated registrant runs for audio_service's cold engine too.
    // This pinned Flutter binding exposes the engine before Activity attachment.
    @Suppress("DEPRECATION")
    private fun configureHostCapabilities(binding: FlutterPlugin.FlutterPluginBinding) {
        (binding.applicationContext as? ClientEngineHost)?.configureClientEngine(binding.flutterEngine)
    }
    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        clientId?.let { connector?.disconnect(it) }
        clientId = null
        connector = null
        channel?.setMethodCallHandler(null)
        channel = null
    }
}
