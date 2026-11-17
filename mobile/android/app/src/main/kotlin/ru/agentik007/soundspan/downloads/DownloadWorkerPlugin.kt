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
                        "schedule" -> {
                            val envelope = DownloadWorkRequest.parse(call.arguments)
                            val job = envelope.identity
                            val data = Data.Builder().putAll(envelope.flat()).build()
                            val request = OneTimeWorkRequestBuilder<SoundspanDownloadWorker>()
                                .setInputData(data).addTag(job.ownerTag)
                                .setConstraints(Constraints.Builder().setRequiredNetworkType(envelope.networkType).build())
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
                                        try { result.success(existing.get().firstOrNull { !it.state.isFinished }?.id?.toString() ?: existing.get().lastOrNull()?.id?.toString()) }
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
                            if (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) result.success(true)
                            else if (activity == null || permission != null) result.success(false)
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
