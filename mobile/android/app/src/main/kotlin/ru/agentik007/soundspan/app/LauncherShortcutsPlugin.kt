package ru.agentik007.soundspan.app

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.os.Build
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.PluginRegistry
import ru.agentik007.soundspan.MainActivity
import ru.agentik007.soundspan.R

/** Publishes Android launcher actions and delivers each launch to the UI engine. */
class LauncherShortcutsPlugin : FlutterPlugin, ActivityAware, EventChannel.StreamHandler {
    private enum class Action(val id: String, val label: Int, val icon: Int) {
        PLAY_WAVE("playWave", R.string.shortcut_play_wave, R.drawable.ic_shortcut_wave),
        RESUME("resume", R.string.shortcut_resume, R.drawable.ic_shortcut_resume),
        DOWNLOADS("downloads", R.string.shortcut_downloads, R.drawable.ic_shortcut_downloads);

        val intentAction get() = "ru.agentik007.soundspan.shortcut.$id"
    }

    private var channel: EventChannel? = null
    private var binding: ActivityPluginBinding? = null
    private var sink: EventChannel.EventSink? = null
    private var pending: Action? = null
    private val incoming = PluginRegistry.NewIntentListener(::accept)

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel = EventChannel(binding.binaryMessenger, "soundspan/launcher_shortcuts").also {
            it.setStreamHandler(this)
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setStreamHandler(null)
        channel = null
        sink = null
        pending = null
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        attach(binding)
        accept(binding.activity.intent)
        publish(binding.activity)
    }

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) {
        attach(binding)
    }

    override fun onDetachedFromActivityForConfigChanges() {
        detach()
    }

    override fun onDetachedFromActivity() {
        detach()
        pending = null
    }

    private fun attach(binding: ActivityPluginBinding) {
        this.binding = binding
        binding.addOnNewIntentListener(incoming)
    }

    private fun detach() {
        binding?.removeOnNewIntentListener(incoming)
        binding = null
    }

    override fun onListen(arguments: Any?, events: EventChannel.EventSink) {
        sink = events
        pending?.let { events.success(it.id) }
        pending = null
    }

    override fun onCancel(arguments: Any?) {
        sink = null
    }

    private fun accept(intent: Intent): Boolean {
        val activity = binding?.activity ?: return false
        if (intent.component != shortcutTarget(activity)) return false
        if ((intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return false
        val action = Action.entries.firstOrNull { it.intentAction == intent.action } ?: return false
        intent.action = Intent.ACTION_MAIN
        val listener = sink
        if (listener == null) pending = action else listener.success(action.id)
        return true
    }

    private fun shortcutTarget(activity: Activity) =
        ComponentName(activity, "ru.agentik007.soundspan.LauncherShortcutActivity")

    private fun publish(activity: Activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) return
        val manager = activity.getSystemService(ShortcutManager::class.java) ?: return
        val actions = Action.entries.take(manager.maxShortcutCountPerActivity)
        if (manager.dynamicShortcuts.sortedBy { it.rank }.map { it.id } == actions.map { it.id }) return
        // Dynamic shortcuts reuse the existing task and its playback engine.
        manager.setDynamicShortcuts(actions.mapIndexed { rank, action ->
            ShortcutInfo.Builder(activity, action.id)
                .setActivity(ComponentName(activity, MainActivity::class.java))
                .setShortLabel(activity.getString(action.label))
                .setIcon(Icon.createWithResource(activity, action.icon))
                .setRank(rank)
                .setIntent(
                    Intent(action.intentAction)
                        .setComponent(shortcutTarget(activity))
                        .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                )
                .build()
        })
    }
}
