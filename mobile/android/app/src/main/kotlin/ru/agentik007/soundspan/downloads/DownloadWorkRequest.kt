package ru.agentik007.soundspan.downloads

import androidx.work.NetworkType

/** Scheduler policy is separate from the closed identity handed to the Dart worker. */
internal class DownloadWorkRequest private constructor(
    val identity: DownloadWorkIdentity,
    private val constraint: String,
    val requiresLegacyUpgrade: Boolean,
    val refreshRevision: Long? = null,
) {
    val networkType: NetworkType get() = constraints.getValue(constraint)
    val requiresCharging: Boolean get() = refreshRevision != null
    fun wire(): Map<String, Any> = identity.wire() +
        (refreshRevision?.let { mapOf("refreshRevision" to it) } ?: emptyMap())
    // Extra closed WorkData fields intentionally make older strict workers reject V2.
    fun flat(): Map<String, Any> = identity.flat() + mapOf(
        "workProtocolVersion" to if (requiresCharging) 3 else 2, "networkConstraint" to constraint,
    ) + (refreshRevision?.let { mapOf("refreshRevision" to it) } ?: emptyMap())
    companion object {
        private val wireKeys = setOf("downloadId", "fence", "generation")
        private val coreKeys = setOf("downloadId", "origin", "userId", "epoch", "generation")
        private val constraints = mapOf("unmetered" to NetworkType.UNMETERED,
            "notRoaming" to NetworkType.NOT_ROAMING, "connected" to NetworkType.CONNECTED)

        private fun constraint(value: Any?): String {
            require(value is String && value in constraints)
            return value
        }

        fun parse(value: Any?): DownloadWorkRequest {
            require(value is Map<*, *> && (value.keys == wireKeys || value.keys == wireKeys + "networkConstraint" ||
                value.keys == wireKeys + "refreshRevision" || value.keys == wireKeys + setOf("networkConstraint", "refreshRevision")))
            val policy = if (value.containsKey("networkConstraint")) constraint(value["networkConstraint"]) else "unmetered"
            val revision = if (value.containsKey("refreshRevision")) revision(value["refreshRevision"]) else null
            require(revision == null || policy == "unmetered")
            return DownloadWorkRequest(DownloadWorkIdentity.parse(value.filterKeys { it in wireKeys }), policy, false, revision)
        }

        fun fromFlat(value: Map<String, Any?>): DownloadWorkRequest {
            if (value.keys == coreKeys) {
                return DownloadWorkRequest(DownloadWorkIdentity.fromFlat(value), "unmetered", true)
            }
            val daily = value.containsKey("refreshRevision")
            require(value.keys == coreKeys + setOf("workProtocolVersion", "networkConstraint") + if (daily) setOf("refreshRevision") else emptySet())
            require(value["workProtocolVersion"] is Int && value["workProtocolVersion"] == if (daily) 3 else 2)
            val policy = constraint(value["networkConstraint"])
            val revision = if (daily) revision(value["refreshRevision"]) else null
            require(revision == null || policy == "unmetered")
            return DownloadWorkRequest(DownloadWorkIdentity.fromFlat(value.filterKeys { it in coreKeys }), policy, false, revision)
        }

        private fun revision(value: Any?): Long {
            val result = when (value) { is Int -> value.toLong(); is Long -> value; else -> throw IllegalArgumentException() }
            require(result in 1..9007199254740991L)
            return result
        }
    }
}
