package ru.agentik007.soundspan.downloads

import java.util.UUID

data class DownloadWorkDiagnostic(val phase: String, val code: String, val state: String) {
    init { require(phase in phases && code in codes && validState(state)) }
    companion object {
        val phases = setOf("attach", "storage", "network", "refresh", "file", "manifest", "drain")
        val codes = setOf(
            "none", "unknown", "app_failure_other", "format", "type", "state", "platform", "io", "timeout", "permission", "cancelled",
            "invalid_work_request", "worker_protocol", "worker_channel_error", "worker_unimplemented", "engine_startup_timeout", "legacy_upgrade",
            "broker_unavailable", "broker_protocol", "stale_session", "session_revoked", "session_unavailable", "offline_mode", "invalid_media", "media_cancelled", "network_cancelled",
            "network_timeout", "network_unavailable", "media_network_error", "media_idle_timeout", "tls_failed", "download_network_restricted", "download_consent_stale",
            "download_storage_full", "download_storage_error", "offline_mix_quota_exceeded", "offline_mix_refresh_waiting", "offline_mix_refresh_stale", "offline_mix_refresh_holdoff",
            "offline_mix_refresh_source_unavailable", "offline_mix_not_saved", "offline_mix_manual_pending", "offline_mix_source_incomplete", "offline_mix_file_unavailable",
            "download_failed", "download_corrupt", "download_cancelled", "offline_mix_refresh_disabled", "media_busy", "recording_unavailable", "invalid_track_shape", "invalid_api_target",
            "api_redirect_rejected", "invalid_http_response", "invalid_json", "invalid_json_type", "response_too_large", "http_error", "unauthorized",
            "http_400", "http_401", "http_403", "http_404", "http_408", "http_409", "http_413", "http_416", "http_425", "http_429", "http_500", "http_502", "http_503", "http_504"
        )
        private val jobStates = setOf("queued", "downloading", "paused", "verifying", "ready", "failed", "removing")
        private val refreshStates = setOf("idle", "waiting", "complete", "manual_pending", "quota", "storage", "failed", "paused", "holdoff", "source_unavailable", "conditions")
        private fun validState(state: String): Boolean {
            if (state == "unknown" || state in jobStates || state in refreshStates) return true
            val parts = state.split('/')
            return parts.size == 2 && parts[0] in refreshStates && parts[1] in jobStates
        }
        fun parse(value: Any?): DownloadWorkDiagnostic {
            require(value is Map<*, *> && value.keys == setOf("phase", "code", "state"))
            return DownloadWorkDiagnostic(value["phase"] as String, value["code"] as String, value["state"] as String)
        }
        fun exception(phase: String, error: Exception) = DownloadWorkDiagnostic(phase, when (error) {
            is SecurityException -> "permission"
            is IllegalArgumentException -> "format"
            is IllegalStateException -> "state"
            is java.io.IOException -> "io"
            is java.util.concurrent.TimeoutException -> "timeout"
            else -> "unknown"
        }, "unknown")
    }
}

data class DownloadWorkOutcome(val outcome: String, val retryAfterMillis: Long = 0, val diagnostic: DownloadWorkDiagnostic? = null) {
    val backoffMillis: Long get() = retryAfterMillis.coerceIn(60_000, 5 * 60 * 60 * 1000L)
    fun event(workId: UUID, kind: String): String {
        require(kind in setOf("file", "refresh", "unknown"))
        val safe = diagnostic ?: DownloadWorkDiagnostic("attach", "none", "unknown")
        val result = if (outcome in setOf("ready", "cancelled", "busy", "retry", "failed")) outcome else "failed"
        return "workId=$workId kind=$kind outcome=$result phase=${safe.phase} code=${safe.code} state=${safe.state}"
    }
    companion object {
        fun parse(value: Any?): DownloadWorkOutcome {
            require(value is Map<*, *> && value.keys == setOf("outcome", "retryAfterMillis") + if (value.containsKey("diagnostic")) setOf("diagnostic") else emptySet())
            val outcome = value["outcome"] as String
            require(outcome in setOf("ready", "cancelled", "busy", "retry", "failed"))
            val raw = value["retryAfterMillis"]
            val millis = when (raw) { is Int -> raw.toLong(); is Long -> raw; else -> throw IllegalArgumentException() }
            require(millis >= 0 && (outcome == "retry" || millis == 0L))
            return DownloadWorkOutcome(outcome, millis, if (value.containsKey("diagnostic")) DownloadWorkDiagnostic.parse(value["diagnostic"]) else null)
        }
    }
}
