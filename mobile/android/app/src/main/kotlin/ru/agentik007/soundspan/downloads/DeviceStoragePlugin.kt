package ru.agentik007.soundspan.downloads

import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodChannel
import java.util.UUID

/** Read-only capacity of application-private storage. No caller-supplied path. */
class DeviceStoragePlugin : FlutterPlugin {
    companion object {
        private val PROCESS_INSTANCE = UUID.randomUUID().toString()
    }

    /** Class-loader static identity, shared by UI and headless engines. */
    internal fun processInstance(): String = PROCESS_INSTANCE
    internal fun chargingStatus(status: Int): Boolean =
        status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
    private var channel: MethodChannel? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        val context = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, "soundspan/storage").also { transport ->
            transport.setMethodCallHandler { call, result ->
                if (call.method != "freeBytes" && call.method != "processInstance" && call.method != "charging") {
                    result.notImplemented()
                } else if (call.arguments != null) {
                    result.error("storage_protocol", "Invalid storage request", null)
                } else {
                    try {
                        if (call.method == "processInstance") {
                            result.success(processInstance())
                        } else if (call.method == "charging") {
                            val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
                            result.success(chargingStatus(battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1))
                        } else {
                            result.success(context.filesDir.usableSpace)
                        }
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
