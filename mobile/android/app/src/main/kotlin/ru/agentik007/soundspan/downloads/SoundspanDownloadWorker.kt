package ru.agentik007.soundspan.downloads

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.ForegroundInfo
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import io.flutter.FlutterInjector
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.engine.dart.DartExecutor
import io.flutter.plugin.common.MethodChannel
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import ru.agentik007.soundspan.NativeEnginePlugins
import java.util.concurrent.TimeUnit

class SoundspanDownloadWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    private var engine: FlutterEngine? = null
    private var channel: MethodChannel? = null
    private val done = CompletableDeferred<DownloadWorkOutcome>()
    private var progressHidden = false
    private val notificationId = id.hashCode()
    override suspend fun doWork(): Result {
        val work = try { DownloadWorkRequest.fromFlat(inputData.keyValueMap) } catch (_: Exception) { return Result.failure() }
        val identity = work.identity
        if (work.requiresLegacyUpgrade) {
            // Old queued specs may be CONNECTED. updateWork affects the NEXT run,
            // so this run must retry before foreground admission or any Dart/HTTP.
            return try {
                withContext(Dispatchers.IO) {
                    WorkManager.getInstance(applicationContext).updateWork(updatedRequest(work, 60_000)).get(10, TimeUnit.SECONDS)
                }
                Result.retry()
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                throw cancelled
            } catch (_: Exception) { Result.retry() }
        }
        return try {
            // Foreground admission is subject to Android quotas/start limits.
            setForeground(foreground())
            withContext(Dispatchers.Main) { start(identity) }
            val outcome = withTimeout(6 * 60 * 60 * 1000L) { done.await() }
            when (outcome.outcome) {
                "ready", "cancelled" -> Result.success(Data.Builder().putString("outcome", outcome.outcome).build())
                "busy", "retry" -> {
                    if (outcome.retryAfterMillis > 0) {
                        // Official WorkManager updateWork applies a running
                        // request's new spec to its next retry, retaining UUID,
                        // attempts and the immutable original job identity.
                        val updated = updatedRequest(work, outcome.backoffMillis)
                        withContext(Dispatchers.IO) { WorkManager.getInstance(applicationContext).updateWork(updated).get(10, TimeUnit.SECONDS) }
                        // Android caps backoff at 5h. Longer server holdoff is
                        // still enforced by T07's durable pre-HTTP admission.
                    }
                    Result.retry()
                }
                else -> Result.failure(Data.Builder().putString("outcome", "failed").build())
            }
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            Result.retry()
        } finally {
            withContext(NonCancellable + Dispatchers.Main) {
                progressHidden = true
                (applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(notificationId)
                // T07 drain must complete before engine/plugin/SQLite disposal.
                // If the engine is unresponsive, bounded destruction is crash
                // recovery, never a successful ready acknowledgement.
                if (engine != null && !done.isCompleted) {
                    val drained = CompletableDeferred<Unit>()
                    channel?.invokeMethod("cancel", null, object : MethodChannel.Result {
                        override fun success(value: Any?) { drained.complete(Unit) }
                        override fun error(code: String, message: String?, details: Any?) { drained.complete(Unit) }
                        override fun notImplemented() { drained.complete(Unit) }
                    })
                    withTimeoutOrNull(60_000) { drained.await() }
                }
                channel?.setMethodCallHandler(null)
                engine?.destroy()
                engine = null
                channel = null
            }
        }
    }
    private fun updatedRequest(work: DownloadWorkRequest, backoffMillis: Long) =
        OneTimeWorkRequestBuilder<SoundspanDownloadWorker>()
            .setId(id).setInputData(Data.Builder().putAll(work.flat()).build()).addTag(work.identity.ownerTag)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(work.networkType).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, backoffMillis, TimeUnit.MILLISECONDS).build()

    private fun start(identity: DownloadWorkIdentity) {
        val loader = FlutterInjector.instance().flutterLoader()
        loader.startInitialization(applicationContext)
        loader.ensureInitializationComplete(applicationContext, null)
        val worker = FlutterEngine(applicationContext, null, false)
        engine = worker
        // Role-specific allowlist: no secure store, audio, player or automatic
        // GeneratedPluginRegistrant. The process broker owns all credentials.
        NativeEnginePlugins.installWorker(worker)
        val transport = MethodChannel(worker.dartExecutor.binaryMessenger, "soundspan/download_worker")
        channel = transport
        var ready = false
        transport.setMethodCallHandler { call, result ->
            when (call.method) {
                "ready" -> {
                    if (ready) { result.error("worker_protocol", "Already ready", null); return@setMethodCallHandler }
                    ready = true
                    result.success(null)
                    transport.invokeMethod("run", identity.wire(), object : MethodChannel.Result {
                        override fun success(value: Any?) { done.complete(try { DownloadWorkOutcome.parse(value) } catch (_: Exception) { DownloadWorkOutcome("failed") }) }
                        override fun error(code: String, message: String?, details: Any?) { done.complete(DownloadWorkOutcome("failed")) }
                        override fun notImplemented() { done.complete(DownloadWorkOutcome("failed")) }
                    })
                }
                "hideProgress" -> {
                    progressHidden = true
                    (applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(notificationId)
                    result.success(null)
                }
                "progress" -> {
                    val args = call.arguments as? Map<*, *>
                    val bytes = (args?.get("bytes") as? Number)?.toLong()
                    val total = (args?.get("total") as? Number)?.toLong()
                    if (!progressHidden && !isStopped && bytes != null && bytes >= 0) {
                        setProgressAsync(Data.Builder().putLong("bytes", bytes).putLong("total", total ?: -1).build())
                        // Channel messages are serialized on main. Updating the
                        // already-foreground notification directly avoids a late
                        // async setForeground resurrecting it after revocation.
                        (applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(notificationId, foreground(bytes, total).notification)
                    }
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ if (!ready) done.complete(DownloadWorkOutcome("retry")) }, 15_000)
        worker.dartExecutor.executeDartEntrypoint(DartExecutor.DartEntrypoint(loader.findAppBundlePath(), "downloadWorkerMain"))
    }
    private fun foreground(bytes: Long = 0, total: Long? = null): ForegroundInfo {
        val manager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel("downloads", "Загрузки музыки", NotificationManager.IMPORTANCE_LOW))
        val percent = if (total != null && total > 0) ((bytes.toDouble() / total) * 100).toInt().coerceIn(0, 100) else 0
        val notification = NotificationCompat.Builder(applicationContext, "downloads")
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("Загрузка музыки")
            .setOnlyAlertOnce(true).setOngoing(true)
            .setProgress(100, percent, total == null || total <= 0)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Отменить", WorkManager.getInstance(applicationContext).createCancelPendingIntent(id))
            .build()
        return if (Build.VERSION.SDK_INT >= 29) ForegroundInfo(notificationId, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else ForegroundInfo(notificationId, notification)
    }
}
