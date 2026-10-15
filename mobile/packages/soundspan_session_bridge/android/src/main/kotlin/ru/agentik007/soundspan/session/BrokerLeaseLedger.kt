package ru.agentik007.soundspan.session

/** Main-thread-only ownership. A timed-out caller does not cancel a vault write. */
class BrokerLeaseLedger {
    private val clients = mutableSetOf<String>()
    private val pending = mutableSetOf<Long>()
    private var sequence = 0L
    val isQuiescent: Boolean get() = clients.isEmpty() && pending.isEmpty()
    val clientCount: Int get() = clients.size
    val pendingCount: Int get() = pending.size
    fun acquire(client: String) { check(clients.add(client)) }
    fun release(client: String) { clients.remove(client) }
    fun contains(client: String): Boolean = clients.contains(client)
    fun begin(client: String): Long {
        check(clients.contains(client))
        return (++sequence).also { pending.add(it) }
    }
    fun finish(request: Long) { pending.remove(request) }
}
