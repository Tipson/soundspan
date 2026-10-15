package ru.agentik007.soundspan.downloads

data class DownloadWorkOutcome(val outcome: String, val retryAfterMillis: Long = 0) {
    val backoffMillis: Long get() = retryAfterMillis.coerceIn(60_000, 5 * 60 * 60 * 1000L)
    companion object {
        fun parse(value: Any?): DownloadWorkOutcome {
            require(value is Map<*, *> && value.keys == setOf("outcome", "retryAfterMillis"))
            val outcome = value["outcome"] as String
            require(outcome in setOf("ready", "cancelled", "busy", "retry", "failed"))
            val raw = value["retryAfterMillis"]
            val millis = when (raw) { is Int -> raw.toLong(); is Long -> raw; else -> throw IllegalArgumentException() }
            require(millis >= 0 && (outcome == "retry" || millis == 0L))
            return DownloadWorkOutcome(outcome, millis)
        }
    }
}
