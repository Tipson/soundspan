package ru.agentik007.soundspan.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodChannel

/** Text-only user chooser/browser. No recipients, grants, files or delivery claim. */
class NativeSharePlugin : FlutterPlugin, ActivityAware {
    private var channel: MethodChannel? = null
    private var activity: Activity? = null
    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel = MethodChannel(binding.binaryMessenger, "soundspan/share").also { channel ->
            channel.setMethodCallHandler { call, result ->
                if (call.method !in setOf("share", "open")) { result.notImplemented(); return@setMethodCallHandler }
                try {
                    val args = call.arguments as? Map<*, *> ?: throw IllegalArgumentException()
                    require(args.keys == setOf("origin", "url"))
                    val origin = args["origin"] as? String ?: throw IllegalArgumentException()
                    val url = ShareIntentTarget.validate(origin, args["url"] as? String ?: throw IllegalArgumentException())
                    val host = activity ?: throw IllegalStateException()
                    val intent = if (call.method == "share") {
                        Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                            type = "text/plain"
                            putExtra(Intent.EXTRA_TEXT, url)
                        }, "Поделиться ссылкой")
                    } else {
                        Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply { addCategory(Intent.CATEGORY_BROWSABLE) }
                    }
                    host.startActivity(intent)
                    result.success("opened")
                } catch (_: Exception) {
                    result.error("share_unavailable", "Unable to open link action", null)
                }
            }
        }
    }
    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) { channel?.setMethodCallHandler(null); channel = null; activity = null }
    override fun onAttachedToActivity(binding: ActivityPluginBinding) { activity = binding.activity }
    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) = onAttachedToActivity(binding)
    override fun onDetachedFromActivityForConfigChanges() { activity = null }
    override fun onDetachedFromActivity() { activity = null }
}
