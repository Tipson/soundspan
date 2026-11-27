package ru.agentik007.soundspan.app.nativefiles

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.InterruptedIOException

class DocumentTooLargeException : IOException("Document exceeds allowed size")

/** Metadata can reject a document early, but never sizes an allocation or bounds a read. */
object BoundedDocumentReader {
    const val MAX_AUDIO_BYTES = 16 * 1024 * 1024

    fun read(input: InputStream, limit: Int, reportedSize: Long?, cancelled: () -> Boolean = { false }): ByteArray {
        require(limit in 1..MAX_AUDIO_BYTES)
        if (reportedSize != null && reportedSize > limit) throw DocumentTooLargeException()
        val output = ByteArrayOutputStream(minOf(8192, limit))
        val buffer = ByteArray(minOf(8192, limit + 1))
        while (true) {
            if (cancelled() || Thread.currentThread().isInterrupted) throw InterruptedIOException()
            val count = input.read(buffer, 0, minOf(buffer.size, limit - output.size() + 1))
            if (cancelled() || Thread.currentThread().isInterrupted) throw InterruptedIOException()
            if (count < 0) break
            if (count == 0) {
                val next = input.read()
                if (cancelled() || Thread.currentThread().isInterrupted) throw InterruptedIOException()
                if (next < 0) break
                if (output.size() == limit) throw DocumentTooLargeException()
                output.write(next)
            } else {
                if (count > limit - output.size()) throw DocumentTooLargeException()
                output.write(buffer, 0, count)
            }
        }
        return output.toByteArray()
    }

    fun safeBasename(original: String?): String {
        // A filename is never a path and never derives its extension from MIME.
        if (original == null || original.length > 4096) return "document"
        val name = original.replace('\\', '/').substringAfterLast('/').filter {
            !it.isISOControl() && it !in '\u202a'..'\u202e' && it !in '\u2066'..'\u2069'
        }.trim()
        if (name.isEmpty() || name == "." || name == "..") return "document"
        if (name.length <= 200) return name
        val extension = name.substringAfterLast('.', "").takeIf { it.length in 1..10 }
        return if (extension == null) name.take(200) else name.take(199 - extension.length) + "." + extension
    }
}
