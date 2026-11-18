package ru.agentik007.soundspan.downloads

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.ActivityCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry
import java.util.UUID
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit

class DownloadWorkerPlugin : FlutterPlugin, ActivityAware, PluginRegistry.RequestPermissionsResultListener {
    companion object {
        /** Null means a UI permission request may begin; headless never prompts. */
        internal fun notificationPermissionDecision(sdk: Int, granted: Boolean, hasActivity: Boolean, pending: Boolean): Boolean? =
            if (sdk < 33 || granted) true else if (!hasActivity || pending) false else null
    }
    private lateinit var context: Context
    private var channel: MethodChannel? = null
    private var activity: Activity? = null
    private var binding: ActivityPluginBinding? = null
    private var permission: MethodChannel.Result? = null
    private val main = Executor { Handler(Looper.getMainLooper()).post(it) }
    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, "soundspan/downloads").also { transport ->
            transport.setMethodCallHandler { call, result ->
                try {
                    val manager = WorkManager.getInstance(context)
                    when (call.method) {
                        "scheduleRefresh", "retryRefresh", "cancelRefresh" -> {
                            val refresh = OfflineMixRefreshRequest.parse(call.arguments)
                            val operation = if (call.method == "cancelRefresh") {
                                manager.cancelAllWorkByTag(refresh.uniqueName)
                            } else {
                                val constraints = Constraints.Builder().setRequiresCharging(true)
                                    .setRequiredNetworkType(NetworkType.UNMETERED).build()
                                if (call.method == "scheduleRefresh") {
                                    val request = PeriodicWorkRequestBuilder<SoundspanDownloadWorker>(24, TimeUnit.HOURS)
                                        .setInputData(Data.Builder().putAll(refresh.flat()).build())
                                        .addTag(refresh.ownerTag).addTag(refresh.uniqueName).setConstraints(constraints)
                                        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES).build()
                                    manager.enqueueUniquePeriodicWork(refresh.uniqueName, ExistingPeriodicWorkPolicy.UPDATE, request)
                                } else {
                                    val request = OneTimeWorkRequestBuilder<SoundspanDownloadWorker>()
                                        .setInputData(Data.Builder().putAll(refresh.flat()).build())
                                        .addTag(refresh.ownerTag).addTag(refresh.uniqueName).setConstraints(constraints)
                                        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES).build()
                                    manager.enqueueUniqueWork(refresh.uniqueName + "-retry", ExistingWorkPolicy.KEEP, request)
                                }
                            }
                            operation.result.addListener({
                                try { operation.result.get(); result.success(null) }
                                catch (_: Exception) { result.error("worker_unavailable", "Refresh scheduling unavailable", null) }
                            }, main)
                        }
                        "schedule" -> {
                            val envelope = DownloadWorkRequest.parse(call.arguments)
                            val job = envelope.identity
                            val data = Data.Builder().putAll(envelope.flat()).build()
                            val request = OneTimeWorkRequestBuilder<SoundspanDownloadWorker>()
                                .setInputData(data).addTag(job.ownerTag)
                                .setConstraints(Constraints.Builder().setRequiredNetworkType(envelope.networkType)
                                    .setRequiresCharging(envelope.requiresCharging).build())
                                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
                                .build()
                            val operation = manager.enqueueUniqueWork(job.uniqueName, ExistingWorkPolicy.KEEP, request)
                            operation.result.addListener({
                                try {
                                    operation.result.get()
                                    // KEEP may retain an existing UUID. Return that actual work,
                                    // not the newly built request that was never admitted.
                                    val existing = manager.getWorkInfosForUniqueWork(job.uniqueName)
                                    existing.addListener({
                                        try {
                                            val values = existing.get()
                                            val active = values.firstOrNull { !it.state.isFinished }
                                            if (active != null && active.id != request.id) {
                                                // Daily enrollment and manual promotion update coarse policy.
                                                // The running iteration remains fenced in Dart; updateWork
                                                // applies the captured ordinary constraints on its next run.
                                                val updated = OneTimeWorkRequestBuilder<SoundspanDownloadWorker>()
                                                    .setId(active.id).setInputData(data).addTag(job.ownerTag)
                                                    .setConstraints(Constraints.Builder().setRequiredNetworkType(envelope.networkType)
                                                        .setRequiresCharging(envelope.requiresCharging).build())
                                                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES).build()
                                                val update = manager.updateWork(updated)
                                                update.addListener({
                                                    try { update.get(); result.success(active.id.toString()) }
                                                    catch (_: Exception) { result.error("worker_unavailable", "Worker update unavailable", null) }
                                                }, main)
                                            } else result.success(active?.id?.toString() ?: values.lastOrNull()?.id?.toString())
                                        }
                                        catch (_: Exception) { result.error("worker_unavailable", "Worker unavailable", null) }
                                    }, main)
                                } catch (_: Exception) { result.error("worker_unavailable", "Worker unavailable", null) }
                            }, main)
                        }
                        "cancelOwner" -> {
                            val owner = call.arguments as Map<*, *>
                            require(owner.keys == setOf("origin", "userId"))
                            val operation = manager.cancelAllWorkByTag(DownloadWorkIdentity.ownerTag(owner["origin"] as String, owner["userId"] as String))
                            operation.result.addListener({ try { operation.result.get(); result.success(null) } catch (_: Exception) { result.error("worker_unavailable", "Cancellation unavailable", null) } }, main)
                        }
                        "cancelJob" -> {
                            val job = DownloadWorkIdentity.parse(call.arguments)
                            val operation = manager.cancelUniqueWork(job.uniqueName)
                            operation.result.addListener({ try { operation.result.get(); result.success(null) } catch (_: Exception) { result.error("worker_unavailable", "Cancellation unavailable", null) } }, main)
                        }
                        "status" -> {
                            val info = manager.getWorkInfoById(UUID.fromString(call.arguments as String))
                            info.addListener({ try { result.success(info.get()?.state?.name) } catch (_: Exception) { result.error("worker_unavailable", "Worker unavailable", null) } }, main)
                        }
                        "info" -> {
                            val info = manager.getWorkInfoById(UUID.fromString(call.arguments as String))
                            info.addListener({
                                try { val value = info.get(); result.success(value?.let { mapOf("state" to it.state.name, "nextRunMillis" to it.nextScheduleTimeMillis, "attempts" to it.runAttemptCount, "outcome" to it.outputData.getString("outcome")) }) }
                                catch (_: Exception) { result.error("worker_unavailable", "Worker unavailable", null) }
                            }, main)
                        }
                        "requestNotificationPermission" -> {
                            val decision = notificationPermissionDecision(Build.VERSION.SDK_INT,
                                context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED,
                                activity != null, permission != null)
                            if (decision != null) result.success(decision)
                            else { permission = result; ActivityCompat.requestPermissions(activity!!, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 4908) }
                        }
                        else -> result.notImplemented()
                    }
                } catch (_: Exception) { result.error("worker_protocol", "Invalid worker request", null) }
            }
        }
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray): Boolean {
        if (requestCode != 4908) return false
        permission?.success(grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED)
        permission = null
        return true
    }
    override fun onAttachedToActivity(binding: ActivityPluginBinding) { this.binding = binding; activity = binding.activity; binding.addRequestPermissionsResultListener(this) }
    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) = onAttachedToActivity(binding)
    override fun onDetachedFromActivityForConfigChanges() = onDetachedFromActivity()
    override fun onDetachedFromActivity() { binding?.removeRequestPermissionsResultListener(this); binding = null; activity = null; permission?.success(false); permission = null }
    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) { channel?.setMethodCallHandler(null); onDetachedFromActivity() }
}
