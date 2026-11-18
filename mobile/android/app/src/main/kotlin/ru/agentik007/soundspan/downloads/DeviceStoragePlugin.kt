package ru.agentik007.soundspan.downloads

import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodChannel

/** Read-only capacity of application-private storage. No caller-supplied path. */
class DeviceStoragePlugin : FlutterPlugin {
    private var channel: MethodChannel? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        val context = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, "soundspan/storage").also { transport ->
            transport.setMethodCallHandler { call, result ->
                if (call.method != "freeBytes") {
                    result.notImplemented()
                } else if (call.arguments != null) {
                    result.error("storage_protocol", "Invalid storage request", null)
                } else {
                    try {
                        result.success(context.filesDir.usableSpace)
                    } catch (_: Exception) {
                        result.error("storage_unavailable", "Storage unavailable", null)
                    }
                }
            }
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        channel = null
    }
}
