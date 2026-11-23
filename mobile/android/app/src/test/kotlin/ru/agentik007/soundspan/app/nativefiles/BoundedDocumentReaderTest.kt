package ru.agentik007.soundspan.app.nativefiles

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.io.InterruptedIOException
import org.junit.Assert.*
import org.junit.Test

class BoundedDocumentReaderTest {
    @Test fun emptyStreamIsReadWithoutAllocatingFromMetadata() {
        assertArrayEquals(byteArrayOf(), BoundedDocumentReader.read(ByteArrayInputStream(byteArrayOf()), 8, null))
    }

    @Test fun exactLimitPreservesEveryByte() {
        val bytes = byteArrayOf(1, 2, 3, 4)
        assertArrayEquals(bytes, BoundedDocumentReader.read(ByteArrayInputStream(bytes), 4, 4L))
    }

    @Test fun unknownAndLyingShortLengthCannotTruncateOrBypassLimit() {
        for (size in listOf(null, -1L, 0L, 1L)) {
            assertArrayEquals(byteArrayOf(1, 2, 3), BoundedDocumentReader.read(ByteArrayInputStream(byteArrayOf(1, 2, 3)), 3, size))
            assertThrows(DocumentTooLargeException::class.java) {
                BoundedDocumentReader.read(ByteArrayInputStream(ByteArray(4)), 3, size)
            }
        }
    }

    @Test fun excessMetadataRejectsBeforeReading() {
        val stream = object : InputStream() {
            override fun read(): Int = throw AssertionError("must not read rejected document")
        }
        assertThrows(DocumentTooLargeException::class.java) { BoundedDocumentReader.read(stream, 8, Long.MAX_VALUE) }
    }

    @Test fun readsAtMostLimitPlusOneFromOversizedProvider() {
        val stream = ByteArrayInputStream(ByteArray(100))
        assertThrows(DocumentTooLargeException::class.java) { BoundedDocumentReader.read(stream, 4, null) }
        assertEquals(95, stream.available())
    }

    @Test fun actualPlaylistAndAvatarLimitsAllowExactAndRejectOneMoreByte() {
        for (limit in listOf(512 * 1024, 5 * 1024 * 1024)) {
            val bytes = ByteArray(limit) { (it % 251).toByte() }
            assertArrayEquals(bytes, BoundedDocumentReader.read(ByteArrayInputStream(bytes), limit, null))
            assertThrows(DocumentTooLargeException::class.java) {
                BoundedDocumentReader.read(ByteArrayInputStream(ByteArray(limit + 1)), limit, 1L)
            }
        }
    }

    @Test fun cancellationDuringProviderReadCannotDeliverItsBytes() {
        var cancelled = false
        val stream = object : ByteArrayInputStream(byteArrayOf(1, 2)) {
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                val count = super.read(b, off, len)
                cancelled = true
                return count
            }
        }
        assertThrows(InterruptedIOException::class.java) { BoundedDocumentReader.read(stream, 8, null) { cancelled } }
    }

    @Test fun cancellationStopsBeforeAnyProviderRead() {
        val stream = object : InputStream() {
            override fun read(): Int = throw AssertionError("cancelled read")
        }
        assertThrows(InterruptedIOException::class.java) { BoundedDocumentReader.read(stream, 8, null) { true } }
    }

    @Test fun zeroLengthReadsDoNotSpinAndBytesAreStillBounded() {
        val stream = object : ByteArrayInputStream(byteArrayOf(7, 8, 9)) {
            override fun read(b: ByteArray, off: Int, len: Int): Int = 0
        }
        assertArrayEquals(byteArrayOf(7, 8, 9), BoundedDocumentReader.read(stream, 3, null))
    }

    @Test fun basenameDropsPathsControlsAndKeepsOriginalExtension() {
        assertEquals("Кино.m3u8", BoundedDocumentReader.safeBasename("C:\\private\\Кино\u0000.m3u8"))
        assertEquals("mix.m3u", BoundedDocumentReader.safeBasename("/private/mix.m3u"))
        assertEquals("document", BoundedDocumentReader.safeBasename("../.."))
        assertEquals("document", BoundedDocumentReader.safeBasename(null))
        assertTrue(BoundedDocumentReader.safeBasename("x".repeat(300) + ".m3u").endsWith(".m3u"))
        assertTrue(BoundedDocumentReader.safeBasename("x".repeat(300) + ".m3u").length <= 200)
    }
}
