package ru.agentik007.soundspan.app.updates

import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.lang.ref.WeakReference
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** UI engine only. PackageInstaller performs final platform verification/confirmation.
 * https://developer.android.com/reference/android/content/pm/PackageInstaller.Session
 * https://developer.android.com/reference/android/content/pm/SigningInfo
 */
class NativeAppUpdatePlugin : FlutterPlugin, ActivityAware {
    private lateinit var context: Context
    private val main = Handler(Looper.getMainLooper())
    private var activity: Activity? = null
    private var channel: MethodChannel? = null
    private var executor: ThreadPoolExecutor? = null
    private var pending: Operation? = null // Main-thread admission/commit only.
    private class Operation(val expected: UpdateExpected, var result: MethodChannel.Result?) {
        @Volatile var cancelled = false
        @Volatile var sessionId = -1
        @Volatile var gate: UpdateCommitGate? = null
        var target: UpdatePackage? = null
        var timeout: Runnable? = null
        fun check() { check(!cancelled && !Thread.currentThread().isInterrupted) }
    }
    private fun foreground() = activity?.let { !it.isFinishing && !it.isDestroyed && it.hasWindowFocus() } == true
    private fun permission() = Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()
    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        executor = ThreadPoolExecutor(0, 1, 30, TimeUnit.SECONDS, SynchronousQueue(), { task ->
            Thread(task, "soundspan-app-update").apply { isDaemon = true }
        })
        channel = MethodChannel(binding.binaryMessenger, "soundspan/app_update").also { transport ->
            transport.setMethodCallHandler { call, result ->
                try {
                    when (call.method) {
                        "installedInfo" -> { require(call.arguments == null); result.success(installedInfo()) }
                        "installPermission" -> { require(call.arguments == null); result.success(permission()) }
                        "openInstallSettings" -> {
                            require(call.arguments == null && foreground())
                            if (Build.VERSION.SDK_INT >= 26) activity!!.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:${context.packageName}")))
                            result.success(null)
                        }
                        "pendingInstall" -> { require(call.arguments == null); result.success(reconcile()) }
                        "cancelPendingInstall" -> {
                            require(call.arguments == null && foreground()); cancelPersisted(); result.success(null)
                        }
                        "stage" -> stage(call.arguments as? Map<*, *> ?: throw IllegalArgumentException(), result)
                        "commit" -> commit(call.arguments as? Map<*, *> ?: throw IllegalArgumentException(), result)
                        "cancel" -> {
                            val args = call.arguments as? Map<*, *> ?: throw IllegalArgumentException()
                            require(args.keys == setOf("nonce") && args["nonce"] is String)
                            pending?.takeIf { it.expected.nonce == args["nonce"] }?.let { cancel(it) }
                            result.success(null)
                        }
                        else -> result.notImplemented()
                    }
                } catch (_: Exception) { result.error("update_unavailable", "App update unavailable", null) }
            }
        }
    }
    @Suppress("DEPRECATION")
    private fun packageRecord(info: PackageInfo): UpdatePackage {
        val signers = if (Build.VERSION.SDK_INT >= 28) {
            val signing = info.signingInfo ?: throw IllegalArgumentException()
            require(!signing.hasMultipleSigners())
            signing.apkContentsSigners
        } else info.signatures
        return UpdatePackage(info.packageName, if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong(),
            info.applicationInfo?.metaData?.getString("soundspan.release.channel"),
            signers?.map { ApkUpdateVerifier.digest(MessageDigest.getInstance("SHA-256").digest(it.toByteArray())) } ?: emptyList(),
            info.applicationInfo?.minSdkVersion ?: throw IllegalArgumentException())
    }
    @Suppress("DEPRECATION")
    private fun flags() = PackageManager.GET_META_DATA or if (Build.VERSION.SDK_INT >= 28)
        PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
    @Suppress("DEPRECATION")
    private fun installed() = context.packageManager.getPackageInfo(context.packageName, flags())
    private fun installedInfo(): Map<String, Any> {
        val info = installed(); val pkg = packageRecord(info)
        require(pkg.packageName == ApkUpdateVerifier.PACKAGE && pkg.signers == listOf(ApkUpdateVerifier.SIGNER))
        val channel = pkg.channel ?: "stable"; require(channel in setOf("stable", "test"))
        return mapOf("applicationId" to pkg.packageName, "versionCode" to pkg.versionCode,
            "versionName" to (info.versionName ?: ""), "channel" to channel,
            "signerSha256" to pkg.signers.single(), "sdk" to Build.VERSION.SDK_INT,
            "abis" to Build.SUPPORTED_ABIS.toList(), "trusted" to true)
    }
    private fun ownSession(id: Int): PackageInstaller.SessionInfo? {
        val info = context.packageManager.packageInstaller.getSessionInfo(id) ?: return null
        require(info.installerPackageName == context.packageName && info.appPackageName == context.packageName)
        return info
    }
    private fun reconcile(): Boolean {
        val prefs = UpdateInstallReceiver.record(context); val id = prefs.getInt("session", -1)
        if (id <= 0) {
            val sessions = context.packageManager.packageInstaller.mySessions
            require(sessions.size <= 16)
            val recovered = ApkUpdateVerifier.recoverSession(sessions.map {
                UpdateSessionOwner(it.sessionId, it.installerPackageName, it.appPackageName)
            }) ?: return false
            // Crash between createSession and receipt: recover conservatively,
            // with no old callback adoption, automatic recommit or abandonment.
            check(prefs.edit().putInt("session", recovered).putString("phase", "unknown")
                .putString("nonce", UUID.randomUUID().toString().replace("-", "")).commit())
            return true
        }
        val nonce = prefs.getString("nonce", null) ?: throw IllegalStateException()
        val info = ownSession(id)
        if (info == null) { UpdateInstallReceiver.clear(context, nonce, id); return false }
        if (prefs.getString("phase", null) == "staged" && pending?.sessionId != id) {
            context.packageManager.packageInstaller.abandonSession(id)
            UpdateInstallReceiver.clear(context, nonce, id); return false
        }
        return true // Committed/unknown survives process death; no automatic recommit/abandon.
    }
    private fun cancelPersisted() {
        val prefs = UpdateInstallReceiver.record(context); val id = prefs.getInt("session", -1)
        val nonce = prefs.getString("nonce", null) ?: return
        pending?.takeIf { it.sessionId == id }?.let { cancel(it) }
        if (id > 0 && ownSession(id) != null) context.packageManager.packageInstaller.abandonSession(id)
        UpdateInstallReceiver.clear(context, nonce, id)
    }
    private fun stage(args: Map<*, *>, result: MethodChannel.Result) {
        require(foreground() && permission() && pending == null && !reconcile())
        val op = Operation(ApkUpdateVerifier.parse(args), result); pending = op
        op.timeout = Runnable { cancel(op) }.also { main.postDelayed(it, 60_000) }
        try { executor!!.execute { copyToSession(op) } }
        catch (_: Exception) { cancel(op) }
    }
    @Suppress("DEPRECATION")
    private fun copyToSession(op: Operation) {
        var ready = false
        try {
            op.check()
            val file = ApkUpdateVerifier.ownFile(File(context.filesDir.canonicalFile, "app-updates"), op.expected.id)
            val target = packageRecord(context.packageManager.getPackageArchiveInfo(file.path, flags()) ?: throw IllegalArgumentException())
            ApkUpdateVerifier.validate(packageRecord(installed()), target, op.expected, Build.VERSION.SDK_INT)
            require(context.filesDir.usableSpace >= 256L * 1024 * 1024 + op.expected.bytes * 2)
            op.check()
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                setAppPackageName(context.packageName); setSize(op.expected.bytes)
                if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
            }
            val installer = context.packageManager.packageInstaller
            op.sessionId = installer.createSession(params)
            op.gate = UpdateCommitGate(op.expected.nonce, op.sessionId)
            check(UpdateInstallReceiver.record(context).edit().putInt("session", op.sessionId)
                .putString("nonce", op.expected.nonce).putString("phase", "staged")
                .putLong("version", op.expected.versionCode).commit())
            op.check()
            installer.openSession(op.sessionId).use { session ->
                session.openWrite("base.apk", 0, op.expected.bytes).use { out ->
                    ApkUpdateVerifier.stage(file, op.expected, out, op::check)
                    session.fsync(out); op.check()
                }
            }
            op.target = target; op.check(); ready = true
            main.post {
                if (pending === op && !op.cancelled) {
                    op.result?.success(mapOf("sessionId" to op.sessionId)); op.result = null
                } else cleanupUncommitted(op)
            }
        } catch (_: Exception) { main.post { if (pending === op) cancel(op) } }
        finally { if (!ready) cleanupUncommitted(op) }
    }
    private fun cleanupUncommitted(op: Operation) {
        if (op.sessionId <= 0 || op.gate?.committed == true) return
        try {
            context.packageManager.packageInstaller.abandonSession(op.sessionId)
            UpdateInstallReceiver.clear(context, op.expected.nonce, op.sessionId)
        } catch (_: Exception) { /* Record remains: future admission must reconcile this exact own session. */ }
    }
    private fun commit(args: Map<*, *>, result: MethodChannel.Result) {
        require(args.keys == setOf("nonce", "sessionId"))
        val op = pending ?: throw IllegalStateException()
        val nonce = args["nonce"] as? String ?: throw IllegalArgumentException()
        val id = args["sessionId"] as? Number ?: throw IllegalArgumentException()
        require((id is Int || id is Long) && id.toLong() in 1..Int.MAX_VALUE.toLong())
        require(!op.cancelled && op.result == null && permission())
        ApkUpdateVerifier.validate(packageRecord(installed()), op.target ?: throw IllegalStateException(), op.expected, Build.VERSION.SDK_INT)
        op.gate!!.commit(nonce, id.toInt(), foreground()) {
            val intent = Intent(context, UpdateInstallReceiver::class.java).apply {
                action = "${context.packageName}.UPDATE_STATUS"; data = Uri.parse("soundspan-update:$nonce")
                putExtra("nonce", nonce)
            }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
            val callback = PendingIntent.getBroadcast(context, op.sessionId, intent, flags)
            check(UpdateInstallReceiver.record(context).edit().putString("phase", "committed").commit())
            UpdateInstallReceiver.listener = WeakReference(this)
            context.packageManager.packageInstaller.openSession(op.sessionId).use { it.commit(callback.intentSender) }
        }
        op.timeout?.let { main.removeCallbacks(it) }
        result.success("handedToSystem")
    }
    internal fun onInstallStatus(intent: Intent, nonce: String, id: Int, status: Int) {
        val op = pending ?: return
        if (op.gate?.accepts(nonce, id) != true) return
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            if (foreground() && op.gate?.claimConfirmation(nonce, id) == true) {
                @Suppress("DEPRECATION") val confirmation = if (Build.VERSION.SDK_INT >= 33)
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                try { if (confirmation != null) activity!!.startActivity(confirmation) } catch (_: Exception) { }
            }
        } else { pending = null; UpdateInstallReceiver.listener = null }
    }
    private fun cancel(op: Operation) {
        op.cancelled = true; op.gate?.cancel(); op.timeout?.let { main.removeCallbacks(it) }
        if (pending === op) pending = null
        if (UpdateInstallReceiver.listener?.get() === this) UpdateInstallReceiver.listener = null
        op.result?.error("update_cancelled", "App update cancelled", null); op.result = null
        // Worker owns any open stream/session; it observes cancelled before every mutation.
        if (op.gate?.committed != true) executor?.let { worker ->
            try { worker.execute { cleanupUncommitted(op) } } catch (_: Exception) { }
        }
    }
    override fun onAttachedToActivity(binding: ActivityPluginBinding) { activity = binding.activity }
    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) = onAttachedToActivity(binding)
    override fun onDetachedFromActivityForConfigChanges() { pending?.let { cancel(it) }; activity = null }
    override fun onDetachedFromActivity() = onDetachedFromActivityForConfigChanges()
    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        onDetachedFromActivity(); channel?.setMethodCallHandler(null); channel = null
        executor?.shutdownNow(); executor = null
    }
}
