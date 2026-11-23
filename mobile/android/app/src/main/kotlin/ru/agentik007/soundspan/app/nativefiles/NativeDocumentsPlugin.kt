package ru.agentik007.soundspan.app.nativefiles

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry
import java.io.InputStream
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Only a user-picked image or M3U; no caller-provided path, URI, MIME, or size. */
class NativeDocumentsPlugin : FlutterPlugin, ActivityAware, PluginRegistry.ActivityResultListener {
    private lateinit var context: Context
    private val main = Handler(Looper.getMainLooper())
    private var binding: ActivityPluginBinding? = null
    private var channel: MethodChannel? = null
    private var pending: Selection? = null
    private var nextRequestCode = 0x6100
    // No queued reads: a provider ignoring cancellation cannot accumulate workers.
    private var reader: ThreadPoolExecutor? = null

    private class Selection(val kind: String, val result: MethodChannel.Result, val requestCode: Int) {
        val signal = CancellationSignal()
        val stream = AtomicReference<InputStream?>()
        @Volatile var cancelled = false
        var reading = false
        var timeout: Runnable? = null
        val limit get() = if (kind == "image") 5 * 1024 * 1024 else 512 * 1024

        fun cancel() {
            cancelled = true
            // Provider IPC/descriptor close must not block the UI or audio thread.
            Thread({
                try { stream.getAndSet(null)?.close() } catch (_: Exception) { }
                try { signal.cancel() } catch (_: Exception) { }
            }, "soundspan-document-close").apply { isDaemon = true }.start()
        }
    }

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        reader = ThreadPoolExecutor(0, 1, 30, TimeUnit.SECONDS, SynchronousQueue(), { task ->
            Thread(task, "soundspan-document-read").apply { isDaemon = true }
        })
        channel = MethodChannel(binding.binaryMessenger, "soundspan/documents").also { channel ->
            channel.setMethodCallHandler { call, result ->
                if (call.method != "pick") { result.notImplemented(); return@setMethodCallHandler }
                val args = call.arguments as? Map<*, *>
                val kind = args?.get("kind") as? String
                if (args?.keys != setOf("kind") || kind !in setOf("image", "playlist", "export")) {
                    result.error("document_protocol", "Invalid document request", null)
                    return@setMethodCallHandler
                }
                if (pending != null) {
                    result.error("document_busy", "Document picker already open", null)
                    return@setMethodCallHandler
                }
                val activity = this.binding?.activity
                if (activity == null) {
                    result.error("document_unavailable", "Document picker unavailable", null)
                    return@setMethodCallHandler
                }
                if (nextRequestCode > 0x7fff) {
                    result.error("document_unavailable", "Document picker unavailable", null)
                    return@setMethodCallHandler
                }
                val selection = Selection(kind!!, result, nextRequestCode++)
                pending = selection
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = if (kind == "image") "image/*" else "*/*"
                    putExtra(Intent.EXTRA_MIME_TYPES, if (kind == "image") arrayOf("image/jpeg", "image/png", "image/webp") else if (kind == "export") arrayOf("text/plain", "application/json", "application/octet-stream") else arrayOf(
                        "audio/x-mpegurl", "audio/mpegurl", "application/vnd.apple.mpegurl", "application/x-mpegurl", "text/plain", "application/octet-stream"
                    ))
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                try { activity.startActivityForResult(intent, selection.requestCode) }
                catch (_: Exception) { finish(selection, error = "document_unavailable") }
            }
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode !in 0x6100..0x7fff) return false
        val selection = pending ?: return true
        if (requestCode != selection.requestCode) return true
        if (selection.reading) return true
        if (resultCode != Activity.RESULT_OK) { finish(selection); return true }
        val uri = data?.data
        if (uri == null || uri.scheme != "content") {
            finish(selection, error = "document_unavailable")
            return true
        }
        selection.reading = true
        selection.timeout = Runnable { finish(selection, error = "document_timeout") }.also {
            main.postDelayed(it, 30_000)
        }
        try {
            val executor = reader ?: throw IllegalStateException()
            executor.execute { read(selection, uri) }
        } catch (_: Exception) { finish(selection, error = "document_unavailable") }
        return true
    }

    private fun read(selection: Selection, uri: Uri) {
        try {
            val resolver = context.contentResolver
            var name: String? = null
            var size: Long? = null
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null, selection.signal)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex)
                    if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
                }
            }
            if (selection.cancelled) return
            if (size != null && size > selection.limit) throw DocumentTooLargeException()
            val descriptor = resolver.openFileDescriptor(uri, "r", selection.signal) ?: throw IllegalStateException()
            val input = ParcelFileDescriptor.AutoCloseInputStream(descriptor)
            selection.stream.set(input)
            input.use {
                if (selection.cancelled) return
                val bytes = BoundedDocumentReader.read(it, selection.limit, size) { selection.cancelled }
                if (bytes.isEmpty()) throw IllegalArgumentException()
                val safeName = BoundedDocumentReader.safeBasename(name)
                main.post { finish(selection, value = mapOf("name" to safeName, "bytes" to bytes)) }
            }
        } catch (_: Exception) {
            main.post { finish(selection, error = "document_unavailable") }
        } finally {
            selection.stream.getAndSet(null)?.let { try { it.close() } catch (_: Exception) { } }
        }
    }

    // Every result and pending transition runs on the main thread. Late callbacks
    // cannot complete a replacement request or deliver after detach/timeout.
    private fun finish(selection: Selection, value: Any? = null, error: String? = null) {
        if (pending !== selection) return
        pending = null
        selection.timeout?.let { main.removeCallbacks(it) }
        selection.cancel()
        if (error == null) selection.result.success(value)
        else selection.result.error(error, "Unable to read selected document", null)
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        this.binding = binding
        binding.addActivityResultListener(this)
    }
    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) = onAttachedToActivity(binding)
    override fun onDetachedFromActivityForConfigChanges() = detachActivity()
    private fun detachActivity() {
        binding?.removeActivityResultListener(this)
        binding = null
    }
    override fun onDetachedFromActivity() {
        detachActivity()
        pending?.let { finish(it) }
    }
    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        onDetachedFromActivity()
        channel?.setMethodCallHandler(null)
        channel = null
        reader?.shutdownNow()
        reader = null
    }

}
