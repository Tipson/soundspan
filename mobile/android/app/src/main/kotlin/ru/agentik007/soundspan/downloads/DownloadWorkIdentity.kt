package ru.agentik007.soundspan.downloads

import java.net.URI
import java.security.MessageDigest

/** Closed identity schema. It cannot carry a URL, path, credential or metadata. */
data class DownloadWorkIdentity(val downloadId: String, val origin: String, val userId: String, val epoch: Long, val generation: Long) {
    init {
        require(downloadId.matches(Regex("[a-f0-9]{64}")))
        require(epoch > 0 && generation > 0)
        validateOwner(origin, userId)
    }
    fun wire(): Map<String, Any> = mapOf("downloadId" to downloadId, "fence" to mapOf("owner" to mapOf("origin" to origin, "userId" to userId), "epoch" to epoch), "generation" to generation)
    fun flat(): Map<String, Any> = mapOf("downloadId" to downloadId, "origin" to origin, "userId" to userId, "epoch" to epoch, "generation" to generation)
    val ownerTag: String get() = ownerTag(origin, userId)
    val uniqueName: String get() = "download-" + digest(listOf(origin, userId, downloadId, epoch.toString(), generation.toString()))
    companion object {
        private fun closed(value: Any?, keys: Set<String>): Map<*, *> {
            require(value is Map<*, *> && value.keys == keys)
            return value
        }
        private fun number(value: Any?): Long = when (value) { is Int -> value.toLong(); is Long -> value; else -> throw IllegalArgumentException() }
        fun parse(value: Any?): DownloadWorkIdentity {
            val job = closed(value, setOf("downloadId", "fence", "generation"))
            val fence = closed(job["fence"], setOf("owner", "epoch"))
            val owner = closed(fence["owner"], setOf("origin", "userId"))
            return DownloadWorkIdentity(job["downloadId"] as String, owner["origin"] as String, owner["userId"] as String, number(fence["epoch"]), number(job["generation"]))
        }
        fun fromFlat(value: Map<String, Any?>): DownloadWorkIdentity {
            closed(value, setOf("downloadId", "origin", "userId", "epoch", "generation"))
            return DownloadWorkIdentity(value["downloadId"] as String, value["origin"] as String, value["userId"] as String, number(value["epoch"]), number(value["generation"]))
        }
        fun ownerTag(origin: String, userId: String): String {
            validateOwner(origin, userId)
            return "download-owner-" + digest(listOf(origin, userId))
        }
        private fun validateOwner(origin: String, userId: String) {
            val uri = URI(origin)
            require(uri.scheme == "https" && !uri.host.isNullOrEmpty() && uri.host == uri.host.lowercase())
            require(uri.userInfo == null && uri.rawQuery == null && uri.rawFragment == null && uri.rawPath.isNullOrEmpty())
            require(uri.port == -1 || uri.port in 1..65535 && uri.port != 443)
            require(userId.isNotEmpty() && userId.length <= 1024 && origin.length <= 2048)
        }
        private fun digest(parts: List<String>): String {
            val md = MessageDigest.getInstance("SHA-256")
            // Length prefixes avoid delimiter collisions in opaque user IDs.
            for (part in parts) { val bytes = part.toByteArray(Charsets.UTF_8); md.update("${bytes.size}:".toByteArray()); md.update(bytes) }
            return md.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
