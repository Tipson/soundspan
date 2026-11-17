package ru.agentik007.soundspan.downloads

import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

/** Bound expensive headless engines across the process, including greedy work. */
internal class DownloadExecutionPool {
    private val permits = Semaphore(2)

    suspend fun <T> run(block: suspend () -> T): T = permits.withPermit { block() }
}
