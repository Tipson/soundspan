package ru.agentik007.soundspan.downloads

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.ForegroundInfo
import androidx.work.WorkManager
import androidx.work.WorkInfo
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
    companion object { private val executionPool = DownloadExecutionPool() }
    private var engine: FlutterEngine? = null
    private var channel: MethodChannel? = null
    private val done = CompletableDeferred<DownloadWorkOutcome>()
    private var progressHidden = false
    private val notificationId = id.hashCode()
    private var phase = "attach"
    private var requestKind = "unknown"
    private var recordedOutcome = DownloadWorkOutcome("failed")
    override suspend fun doWork(): Result {
        try { return executeWork() }
        catch (cancelled: kotlinx.coroutines.CancellationException) {
            recordedOutcome = DownloadWorkOutcome("cancelled", diagnostic = DownloadWorkDiagnostic(phase, "cancelled", "unknown"))
            throw cancelled
        } catch (error: Exception) {
            recordedOutcome = DownloadWorkOutcome("failed", diagnostic = DownloadWorkDiagnostic.exception(phase, error))
            throw error
        } finally {
            // One bounded event per work UUID. Never include request fields,
            // origin/owner metadata, exception text or media identifiers.
            runCatching {
                val event = recordedOutcome.event(id, requestKind)
                if (recordedOutcome.outcome in setOf("failed", "retry", "busy")) Log.w("SoundspanWork", event)
                else Log.i("SoundspanWork", event)
            }
        }
    }
    private suspend fun executeWork(): Result {
        val refresh = try { if (inputData.getString("kind") != null) OfflineMixRefreshRequest.fromFlat(inputData.keyValueMap) else null }
            catch (_: Exception) { recordedOutcome = DownloadWorkOutcome("failed", diagnostic = DownloadWorkDiagnostic("attach", "invalid_work_request", "unknown")); return Result.failure() }
        val work = try { if (refresh == null) DownloadWorkRequest.fromFlat(inputData.keyValueMap) else null }
            catch (_: Exception) { recordedOutcome = DownloadWorkOutcome("failed", diagnostic = DownloadWorkDiagnostic("attach", "invalid_work_request", "unknown")); return Result.failure() }
        requestKind = if (refresh != null) "refresh" else "file"
        if (work?.requiresLegacyUpgrade == true) {
            recordedOutcome = DownloadWorkOutcome("retry", diagnostic = DownloadWorkDiagnostic("attach", "legacy_upgrade", "unknown"))
            // Old queued specs may be CONNECTED. updateWork affects the NEXT run,
            // so this run must retry before foreground admission or any Dart/HTTP.
            return try {
                withContext(Dispatchers.IO) {
                    WorkManager.getInstance(applicationContext).updateWork(updatedRequest(work, 60_000)).get(10, TimeUnit.SECONDS)
                }
                Result.retry()
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                recordedOutcome = DownloadWorkOutcome("retry", diagnostic = DownloadWorkDiagnostic.exception(phase, error))
                Result.retry()
            }
        }
        return executionPool.run { try {
            // Foreground admission is subject to Android quotas/start limits.
            setForeground(foreground())
            withContext(Dispatchers.Main) { start(refresh?.wire() ?: work!!.wire()) }
            phase = requestKind
            val outcome = withTimeout(6 * 60 * 60 * 1000L) { done.await() }
            recordedOutcome = outcome.copy(diagnostic = outcome.diagnostic ?: DownloadWorkDiagnostic(phase, "none", "unknown"))
            when (outcome.outcome) {
                "ready", "cancelled" -> Result.success(output(recordedOutcome))
                "busy", "retry" -> {
                    if (outcome.retryAfterMillis > 0 && work != null) {
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
                else -> Result.failure(output(recordedOutcome))
            }
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            recordedOutcome = DownloadWorkOutcome("retry", diagnostic = DownloadWorkDiagnostic.exception(phase, error))
            Result.retry()
        } finally {
            phase = "drain"
            withContext(NonCancellable + Dispatchers.Main) {
                progressHidden = true
                (applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(notificationId)
                // T07 drain must complete before engine/plugin/SQLite disposal.
                // If the engine is unresponsive, bounded destruction is crash
                // recovery, never a successful ready acknowledgement.
                if (engine != null && !done.isCompleted) {
                    val drainDeadline = SystemClock.elapsedRealtime() + 60_000
                    val drained = CompletableDeferred<Unit>()
                    // WorkManager2.12 serializes this public query behind its
                    // cancel transaction (CANCELLED is written before stop).
                    val state = if (isStopped) withContext(Dispatchers.IO) {
                        try { WorkManager.getInstance(applicationContext).getWorkInfoById(id).get(2, TimeUnit.SECONDS)?.state }
                        catch (_: Exception) { null } // Unknown is never retry authority.
                    } else null
                    val reason = if (Build.VERSION.SDK_INT >= 31) stopReason else WorkInfo.STOP_REASON_UNKNOWN
                    val retry = retryableDownloadStop(Build.VERSION.SDK_INT, reason, isStopped, state)
                    // The runtime signal carries no identity or new WorkData.
                    // Missing/finished state and explicit cancellation fail closed.
                    channel?.invokeMethod("cancel", if (retry) mapOf("retryWhenAllowed" to true) else null, object : MethodChannel.Result {
                        override fun success(value: Any?) { drained.complete(Unit) }
                        override fun error(code: String, message: String?, details: Any?) { drained.complete(Unit) }
                        override fun notImplemented() { drained.complete(Unit) }
                    })
                    val remainingDrain = drainDeadline - SystemClock.elapsedRealtime()
                    if (remainingDrain > 0) withTimeoutOrNull(remainingDrain) { drained.await() }
                }
                channel?.setMethodCallHandler(null)
                engine?.destroy()
                engine = null
                channel = null
            }
        } }
    }
    private fun output(outcome: DownloadWorkOutcome): Data {
        val data = Data.Builder().putString("outcome", outcome.outcome)
        outcome.diagnostic?.let {
            data.putString("phase", it.phase).putString("code", it.code).putString("state", it.state)
        }
        return data.build()
    }
    private fun updatedRequest(work: DownloadWorkRequest, backoffMillis: Long) =
        OneTimeWorkRequestBuilder<SoundspanDownloadWorker>()
            .setId(id).setInputData(Data.Builder().putAll(work.flat()).build()).addTag(work.identity.ownerTag)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(work.networkType)
                .setRequiresCharging(work.requiresCharging).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, backoffMillis, TimeUnit.MILLISECONDS).build()

    private fun start(request: Map<String, Any>) {
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
                    transport.invokeMethod("run", request, object : MethodChannel.Result {
                        override fun success(value: Any?) { done.complete(try { DownloadWorkOutcome.parse(value) } catch (_: Exception) { DownloadWorkOutcome("failed", diagnostic = DownloadWorkDiagnostic(phase, "worker_protocol", "unknown")) }) }
                        override fun error(code: String, message: String?, details: Any?) { done.complete(DownloadWorkOutcome("failed", diagnostic = DownloadWorkDiagnostic(phase, "worker_channel_error", "unknown"))) }
                        override fun notImplemented() { done.complete(DownloadWorkOutcome("failed", diagnostic = DownloadWorkDiagnostic(phase, "worker_unimplemented", "unknown"))) }
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
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ if (!ready) done.complete(DownloadWorkOutcome("retry", diagnostic = DownloadWorkDiagnostic("attach", "engine_startup_timeout", "unknown"))) }, 15_000)
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

/** Finished/cancelled work always wins. On pre31, a stopped unfinished spec is
 * still owned by the scheduler; newer APIs additionally require a known cause. */
internal fun retryableDownloadStop(apiLevel: Int, reason: Int,
    stopped: Boolean, state: WorkInfo.State?): Boolean {
    if (!stopped || (state != WorkInfo.State.RUNNING && state != WorkInfo.State.ENQUEUED)) return false
    if (reason == WorkInfo.STOP_REASON_CANCELLED_BY_APP || reason == WorkInfo.STOP_REASON_USER) return false
    return apiLevel < 31 || reason == WorkInfo.STOP_REASON_CONSTRAINT_CHARGING ||
        reason == WorkInfo.STOP_REASON_CONSTRAINT_CONNECTIVITY
}
