package ru.agentik007.soundspan.session

import android.content.Context
import android.os.Handler
import android.os.Looper
import io.flutter.FlutterInjector
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.engine.dart.DartExecutor
import io.flutter.plugin.common.MethodChannel
import java.util.UUID

/** Process-local sole auth engine, independently retained from audio_service. */
class SessionBrokerHost(private val context: Context) : SessionBrokerConnector {
    private val main = Handler(Looper.getMainLooper())
    private val clients = mutableMapOf<String, (Any?) -> Unit>()
    private val ledger = BrokerLeaseLedger()
    private var engine: FlutterEngine? = null
    private var channel: MethodChannel? = null
    private var ready = false
    private var failed = false
    private var transitions = 0
    private var starts = 0
    private val waiting = mutableListOf<() -> Unit>()
    val clientCount: Int get() = ledger.clientCount
    val brokerStartCount: Int get() = starts

    private fun checkMain() { check(Looper.myLooper() == Looper.getMainLooper()) }
    override fun connect(events: (Any?) -> Unit): String {
        checkMain()
        return UUID.randomUUID().toString().also { clients[it] = events }
    }
    override fun dispatch(clientId: String, request: Any?, result: MethodChannel.Result) {
        checkMain()
        val method = SessionBrokerProtocol.method(request)
        if (method == null || clientId !in clients || failed) {
            SessionBrokerProtocol.failure(result, "broker_unavailable"); return
        }
        if (method == "attach") {
            if (ledger.contains(clientId)) { SessionBrokerProtocol.failure(result, "broker_attached"); return }
            ledger.acquire(clientId)
        } else if (!ledger.contains(clientId)) {
            SessionBrokerProtocol.failure(result, "broker_unattached"); return
        }
        if (method in SessionBrokerProtocol.admissions && transitions > 0) {
            SessionBrokerProtocol.failure(result, "session_revoked"); return
        }
        val requestId = ledger.begin(clientId)
        val transition = method in SessionBrokerProtocol.transitions
        if (transition) transitions++
        var answered = false
        var finished = false
        fun reply(action: () -> Unit) { if (!answered) { answered = true; action() } }
        fun finish() {
            if (finished) return
            finished = true
            if (transition) transitions--
            ledger.finish(requestId)
            destroyIfQuiescent()
        }
        val timeout = Runnable {
            // Keep pending RPC/credential barrier until Dart actually completes.
            failClosed()
            reply { SessionBrokerProtocol.failure(result, "broker_timeout") }
        }
        main.postDelayed(timeout, 40_000)
        val forward = {
            if (failed) {
                main.removeCallbacks(timeout)
                reply { SessionBrokerProtocol.failure(result, "broker_unavailable") }
                finish()
            } else {
                channel!!.invokeMethod("dispatch", mapOf("clientId" to clientId, "request" to request), object : MethodChannel.Result {
                    override fun success(value: Any?) {
                        main.removeCallbacks(timeout)
                        reply { if (failed) SessionBrokerProtocol.failure(result, "broker_unavailable") else result.success(value) }
                        if (method == "attach" && (value as? Map<*, *>)?.get("ok") != true) ledger.release(clientId)
                        finish()
                    }
                    override fun error(code: String, message: String?, details: Any?) {
                        main.removeCallbacks(timeout)
                        failClosed()
                        reply { SessionBrokerProtocol.failure(result, "broker_failure") }
                        finish()
                    }
                    override fun notImplemented() = error("broker_unavailable", null, null)
                })
            }
        }
        if (ready) forward() else {
            waiting.add(forward)
            try { ensureEngine() } catch (_: Exception) { failClosed(); drainWaiting() }
        }
    }
    private fun ensureEngine() {
        if (engine != null) return
        val loader = FlutterInjector.instance().flutterLoader()
        loader.startInitialization(context)
        loader.ensureInitializationComplete(context, null)
        val broker = FlutterEngine(context, null, false)
        engine = broker
        starts++
        // Audited allowlist. Never register GeneratedPluginRegistrant/audio here.
        registerStoragePlugins(broker)
        val transport = MethodChannel(broker.dartExecutor.binaryMessenger, SessionBrokerProtocol.BROKER_CHANNEL)
        channel = transport
        transport.setMethodCallHandler { call, result ->
            when (call.method) {
                "ready" -> {
                    if (call.arguments != mapOf("v" to 1) || ready || failed) {
                        result.error("broker_protocol", "Invalid ready", null)
                    } else { ready = true; result.success(null); drainWaiting() }
                }
                "event" -> {
                    if (!failed) clients.filterKeys { ledger.contains(it) }.values.toList().forEach { it(call.arguments) }
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
        broker.dartExecutor.executeDartEntrypoint(DartExecutor.DartEntrypoint(loader.findAppBundlePath(), "sessionBrokerMain"))
        main.postDelayed({ if (engine === broker && !ready) { failClosed(); drainWaiting() } }, 15_000)
    }
    private fun drainWaiting() { val pending = waiting.toList(); waiting.clear(); pending.forEach { it() } }
    private fun failClosed() {
        failed = true
        clients.values.toList().forEach { it(mapOf("v" to 1, "gone" to true)) }
    }
    override fun disconnect(clientId: String) {
        checkMain()
        clients.remove(clientId)
        ledger.release(clientId)
        if (ready) channel?.invokeMethod("detach", clientId)
        destroyIfQuiescent()
    }
    private fun destroyIfQuiescent() {
        if (!ledger.isQuiescent) return
        channel?.setMethodCallHandler(null)
        engine?.destroy()
        engine = null
        channel = null
        ready = false
        failed = false
    }
    companion object {
        /** Shared allowlist for manually-created worker engines. */
        fun registerStoragePlugins(engine: FlutterEngine) {
            engine.plugins.add(com.it_nomads.fluttersecurestorage.FlutterSecureStoragePlugin())
            engine.plugins.add(com.tekartik.sqflite.SqflitePlugin())
            engine.plugins.add(com.github.dart_lang.jni.JniPlugin())
            engine.plugins.add(com.github.dart_lang.jni_flutter.JniFlutterPlugin())
        }
    }
}
