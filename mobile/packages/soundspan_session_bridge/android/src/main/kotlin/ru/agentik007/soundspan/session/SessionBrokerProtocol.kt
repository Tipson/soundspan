package ru.agentik007.soundspan.session

import io.flutter.plugin.common.MethodChannel

/** Installed by Application before any UI/service FlutterEngine exists. */
interface SessionBrokerConnector {
    fun connect(events: (Any?) -> Unit): String
    fun dispatch(clientId: String, request: Any?, result: MethodChannel.Result)
    fun disconnect(clientId: String)
}

object SessionBrokerRegistry {
    var connector: SessionBrokerConnector? = null
}

object SessionBrokerProtocol {
    const val CLIENT_CHANNEL = "soundspan/session_client"
    const val BROKER_CHANNEL = "soundspan/session_broker"
    val methods = setOf("attach", "assertCurrent", "grantAccess", "after401", "config", "login", "restore", "me", "logout")
    val transitions = setOf("login", "restore", "logout")
    val admissions = setOf("assertCurrent", "grantAccess", "after401")
    fun method(request: Any?): String? {
        val map = request as? Map<*, *> ?: return null
        if (map.keys != setOf("v", "method", "args") || map["v"] != 1 || map["args"] !is Map<*, *>) return null
        return (map["method"] as? String)?.takeIf { it in methods }
    }
    fun failure(result: MethodChannel.Result, code: String) = result.error(code, "Session broker unavailable", null)
}
