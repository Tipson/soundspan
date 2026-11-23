package ru.agentik007.soundspan.downloads

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors

/** Decode without an AudioTrack/player. One bounded probe at a time per engine. */
class AndroidMediaProbe : FlutterPlugin {
    private lateinit var context: Context
    private var channel: MethodChannel? = null
    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var busy = false
    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, "soundspan/media_probe").also { transport ->
            transport.setMethodCallHandler { call, result ->
                if (call.method != "probe") { result.notImplemented(); return@setMethodCallHandler }
                val path = call.arguments as? String
                if (path == null || busy) { result.error("probe_unavailable", "Media probe unavailable", null); return@setMethodCallHandler }
                busy = true
                executor.execute {
                    val duration = try { decode(File(path)) } catch (_: Exception) { 0L }
                    main.post { busy = false; result.success(mapOf("decodable" to (duration > 0), "durationUs" to duration)) }
                }
            }
        }
    }
    private fun decode(file: File): Long {
        val root = File(context.filesDir, "device-media").canonicalFile
        require(file.isFile && file.absolutePath == file.canonicalPath && file.canonicalPath.startsWith(root.path + File.separator))
        val size = file.length()
        require(size > 44)
        val deadline = SystemClock.elapsedRealtime() + 5000
        fun checkDeadline() { check(!Thread.currentThread().isInterrupted && SystemClock.elapsedRealtime() < deadline) }
        FileInputStream(file).use { input ->
            // A truncated RIFF must not pass simply because its first PCM frame
            // decodes; check the declared container extent against actual bytes.
            val header = ByteArray(12)
            require(input.read(header) == 12)
            if (String(header, 0, 4, Charsets.US_ASCII) == "RIFF") {
                val declared = ByteBuffer.wrap(header, 4, 4).order(ByteOrder.LITTLE_ENDIAN).int.toLong() and 0xffffffffL
                require(declared + 8 == size && String(header, 8, 4, Charsets.US_ASCII) == "WAVE")
            }
            val extractor = MediaExtractor()
            var codec: MediaCodec? = null
            try {
                extractor.setDataSource(input.fd, 0, size)
                checkDeadline()
                val track = (0 until extractor.trackCount).firstOrNull { extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true } ?: return 0
                val format = extractor.getTrackFormat(track)
                val mime = format.getString(MediaFormat.KEY_MIME) ?: return 0
                val duration = if (format.containsKey(MediaFormat.KEY_DURATION)) format.getLong(MediaFormat.KEY_DURATION) else 0
                require(duration > 0)
                extractor.selectTrack(track)
                codec = MediaCodec.createDecoderByType(mime)
                codec.configure(format, null, null, 0)
                codec.start()
                val info = MediaCodec.BufferInfo()
                var supplied = 0L
                var decoded = 0L
                var eos = false
                while (decoded < 8192) {
                    checkDeadline()
                    if (!eos) {
                        val index = codec.dequeueInputBuffer(1000)
                        if (index >= 0) {
                            val buffer = codec.getInputBuffer(index) ?: return 0
                            val bytes = extractor.readSampleData(buffer, 0)
                            if (bytes < 0) { codec.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); eos = true }
                            else {
                                supplied += bytes
                                require(supplied <= 2 * 1024 * 1024)
                                codec.queueInputBuffer(index, 0, bytes, extractor.sampleTime, 0)
                                extractor.advance()
                            }
                        }
                    }
                    val output = codec.dequeueOutputBuffer(info, 1000)
                    if (output >= 0) {
                        if (info.size > 0) {
                            val pcm = codec.getOutputBuffer(output) ?: return 0
                            require(pcm.limit() >= info.offset + info.size)
                            // Consume the decoded sample, not just an output-format event.
                            pcm.get(info.offset)
                            decoded += info.size
                        }
                        codec.releaseOutputBuffer(output, false)
                        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
                    }
                }
                require(decoded > 0 && file.length() == size)
                return duration
            } finally {
                try { codec?.stop() } catch (_: Exception) { }
                codec?.release()
                extractor.release()
            }
        }
    }
    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        executor.shutdownNow()
    }
}
