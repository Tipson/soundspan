package ru.agentik007.soundspan.downloads

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Handler
import android.os.Looper
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel

/** Engine-owned read-only route facts. No Activity, permission dialog, identity or storage. */
class DownloadNetworkStatePlugin : FlutterPlugin, EventChannel.StreamHandler {
    private var methods: MethodChannel? = null
    private var events: EventChannel? = null
    private var monitor: DownloadNetworkStateMonitor? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        val main = Handler(Looper.getMainLooper())
        val current = DownloadNetworkStateMonitor(AndroidDownloadNetworkStateSource(binding.applicationContext)) { task ->
            main.post { task() }
        }
        monitor = current
        methods = MethodChannel(binding.binaryMessenger, "soundspan/download_network").also { channel ->
            channel.setMethodCallHandler { call, result ->
                if (call.method != "snapshot") { result.notImplemented(); return@setMethodCallHandler }
                if (call.arguments != null) {
                    result.error("network_state_protocol", "No arguments accepted", null)
                    return@setMethodCallHandler
                }
                result.success(current.snapshot())
            }
        }
        events = EventChannel(binding.binaryMessenger, "soundspan/download_network_events").also {
            it.setStreamHandler(this)
        }
    }

    override fun onListen(arguments: Any?, sink: EventChannel.EventSink) {
        if (arguments != null) {
            monitor?.cancel()
            sink.error("network_state_protocol", "No arguments accepted", null)
            return
        }
        val current = monitor
        if (current == null) sink.success(DownloadNetworkStateMonitor.unknown())
        else current.listen { sink.success(it) }
    }

    override fun onCancel(arguments: Any?) { monitor?.cancel() }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        monitor?.close()
        monitor = null
        methods?.setMethodCallHandler(null)
        methods = null
        events?.setStreamHandler(null)
        events = null
    }
}

/** Only capabilities of the current default route cross the platform seam. */
internal data class DownloadNetworkCapabilities(
    val internet: Boolean,
    val wifi: Boolean,
    val notMetered: Boolean,
    val notRoaming: Boolean?,
    val legacyRoaming: Boolean? = null,
    val vpn: Boolean = false,
)
internal interface DownloadNetworkStateSource {
    fun activeNetwork(): Any?
    fun capabilities(network: Any): DownloadNetworkCapabilities?
    fun watch(changed: () -> Unit): AutoCloseable
}

/** State and sink lifecycle are main-thread owned; platform callbacks only enqueue reads. */
internal class DownloadNetworkStateMonitor(
    private val source: DownloadNetworkStateSource,
    private val post: (() -> Unit) -> Unit,
) {
    private var registration: AutoCloseable? = null
    private var sink: ((Map<String, Any?>) -> Unit)? = null
    private var generation = 0L
    private var closed = false
    private var unavailable = false

    fun snapshot(): Map<String, Any?> {
        if (closed || unavailable) return unknown()
        return try {
            val before = source.activeNetwork() ?: return unknown()
            val facts = source.capabilities(before)
            val after = source.activeNetwork()
            if (before != after || facts == null || !facts.internet) return unknown()
            mapOf("v" to 1, "connected" to true, "wifi" to facts.wifi,
                "metered" to !facts.notMetered,
                "roaming" to (facts.notRoaming?.not() ?: if (facts.vpn) null else facts.legacyRoaming))
        } catch (_: Exception) { unknown() }
    }

    fun listen(next: (Map<String, Any?>) -> Unit) {
        cancel()
        if (closed) return
        sink = next
        val lease = ++generation
        fun emit() {
            post {
                if (!closed && generation == lease && sink === next) next(snapshot())
            }
        }
        if (registration == null) {
            try { registration = source.watch { emit() } }
            catch (_: Exception) { unavailable = true }
        }
        // Failed unregister retains its handle and blocks another registration/allow.
        emit()
    }

    fun cancel() {
        generation++
        sink = null
        val previous = registration
        if (previous == null) { unavailable = false; return }
        try { previous.close(); registration = null; unavailable = false }
        catch (_: Exception) { unavailable = true }
    }

    fun close() { closed = true; cancel() }

    companion object {
        fun unknown(): Map<String, Any?> = mapOf("v" to 1, "connected" to false,
            "wifi" to null, "metered" to null, "roaming" to null)
    }
}

private class AndroidDownloadNetworkStateSource(context: Context) : DownloadNetworkStateSource {
    private val manager = try {
        context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    } catch (_: Exception) { null }

    override fun activeNetwork(): Any? = manager?.activeNetwork

    @Suppress("DEPRECATION")
    override fun capabilities(network: Any): DownloadNetworkCapabilities? {
        val service = manager ?: return null
        val route = network as Network
        val caps = service.getNetworkCapabilities(route) ?: return null
        val vpn = caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
        val modern = Build.VERSION.SDK_INT >= 28
        val legacyRoaming = if (!modern && !vpn) {
            service.getNetworkInfo(route)?.takeIf {
                it.isConnected && it.type != ConnectivityManager.TYPE_VPN
            }?.isRoaming
        } else null
        return DownloadNetworkCapabilities(
            internet = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
            wifi = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
            notMetered = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED),
            notRoaming = if (modern) caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_ROAMING) else null,
            legacyRoaming = legacyRoaming,
            vpn = vpn,
        )
    }

    override fun watch(changed: () -> Unit): AutoCloseable {
        val service = requireNotNull(manager)
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { changed() }
            override fun onLost(network: Network) { changed() }
            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) { changed() }
            override fun onUnavailable() { changed() }
        }
        service.registerDefaultNetworkCallback(callback)
        return AutoCloseable { service.unregisterNetworkCallback(callback) }
    }
}
