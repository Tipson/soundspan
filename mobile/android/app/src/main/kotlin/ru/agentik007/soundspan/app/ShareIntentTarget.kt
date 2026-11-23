package ru.agentik007.soundspan.app

import java.net.URI

/** Exact same-origin public capability only. Never include input in errors. */
object ShareIntentTarget {
    fun validate(origin: String, target: String): String {
        try {
            require(origin.length <= 2048 && target.length <= 2200)
            val base = URI(origin)
            val url = URI(target)
            require(base.scheme == "https" && !base.host.isNullOrEmpty() && base.rawUserInfo == null)
            require(base.rawPath.isNullOrEmpty() || base.rawPath == "/")
            require(base.rawQuery == null && base.rawFragment == null)
            require(url.scheme == "https" && url.host == base.host && url.port == base.port)
            require(url.rawUserInfo == null && url.rawQuery == null && url.rawFragment == null)
            require(url.rawPath.matches(Regex("/share/[a-f0-9]{64}")))
            return target
        } catch (_: Exception) { throw IllegalArgumentException("Invalid share target") }
    }
}
