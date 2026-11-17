package ru.agentik007.soundspan.downloads

import androidx.work.NetworkType

/** Scheduler policy is separate from the closed identity handed to the Dart worker. */
internal class DownloadWorkRequest private constructor(
    val identity: DownloadWorkIdentity,
    private val constraint: String,
    val requiresLegacyUpgrade: Boolean,
) {
    val networkType: NetworkType get() = constraints.getValue(constraint)
    // Extra closed WorkData fields intentionally make older strict workers reject V2.
    fun flat(): Map<String, Any> = identity.flat() + mapOf(
        "workProtocolVersion" to 2, "networkConstraint" to constraint,
    )
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
            require(value is Map<*, *> && (value.keys == wireKeys || value.keys == wireKeys + "networkConstraint"))
            val policy = if (value.containsKey("networkConstraint")) constraint(value["networkConstraint"]) else "unmetered"
            return DownloadWorkRequest(DownloadWorkIdentity.parse(value.filterKeys { it in wireKeys }), policy, false)
        }

        fun fromFlat(value: Map<String, Any?>): DownloadWorkRequest {
            if (value.keys == coreKeys) {
                return DownloadWorkRequest(DownloadWorkIdentity.fromFlat(value), "unmetered", true)
            }
            require(value.keys == coreKeys + setOf("workProtocolVersion", "networkConstraint"))
            require(value["workProtocolVersion"] is Int && value["workProtocolVersion"] == 2)
            val policy = constraint(value["networkConstraint"])
            return DownloadWorkRequest(DownloadWorkIdentity.fromFlat(value.filterKeys { it in coreKeys }), policy, false)
        }
    }
}
