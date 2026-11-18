package ru.agentik007.soundspan.downloads

/** A trigger carries only immutable owner/epoch and the scheduled policy revision. */
internal class OfflineMixRefreshRequest private constructor(
    private val ownerIdentity: DownloadWorkIdentity, val revision: Long,
) {
    val ownerTag: String get() = ownerIdentity.ownerTag
    val uniqueName: String get() = "offline-mix-refresh-$ownerTag-${ownerIdentity.epoch}-$revision"
    fun wire(): Map<String, Any> = mapOf("kind" to "offlineMixRefresh",
        "fence" to ownerIdentity.wire().getValue("fence"), "revision" to revision)
    fun flat(): Map<String, Any> = mapOf("kind" to "offlineMixRefresh", "workProtocolVersion" to 1,
        "origin" to ownerIdentity.origin, "userId" to ownerIdentity.userId,
        "epoch" to ownerIdentity.epoch, "revision" to revision)
    companion object {
        fun parse(value: Any?): OfflineMixRefreshRequest {
            require(value is Map<*, *> && value.keys == setOf("fence", "revision"))
            val revision = when (val r = value["revision"]) { is Int -> r.toLong(); is Long -> r; else -> throw IllegalArgumentException() }
            require(revision in 1..9007199254740991L)
            val owner = DownloadWorkIdentity.parse(mapOf("downloadId" to "0".repeat(64),
                "fence" to value["fence"], "generation" to 1))
            return OfflineMixRefreshRequest(owner, revision)
        }
        fun fromFlat(value: Map<String, Any?>): OfflineMixRefreshRequest {
            require(value.keys == setOf("kind", "workProtocolVersion", "origin", "userId", "epoch", "revision"))
            require(value["kind"] == "offlineMixRefresh" && value["workProtocolVersion"] is Int && value["workProtocolVersion"] == 1)
            return parse(mapOf("fence" to mapOf("owner" to mapOf("origin" to value["origin"], "userId" to value["userId"]),
                "epoch" to value["epoch"]), "revision" to value["revision"]))
        }
    }
}
