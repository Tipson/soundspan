package ru.agentik007.soundspan.app.updates

import java.io.File
import java.io.OutputStream
import java.security.MessageDigest

internal data class UpdatePackage(val packageName: String, val versionCode: Long,
    val channel: String?, val signers: List<String>, val minSdk: Int = 24)
internal data class UpdateExpected(val id: String, val nonce: String, val versionCode: Long,
    val channel: String, val bytes: Long, val sha256: String)
internal data class UpdateSessionOwner(val id: Int, val installer: String?, val target: String?)
internal object ApkUpdateVerifier {
    fun recoverSession(sessions: List<UpdateSessionOwner>): Int? {
        require(sessions.size <= 16)
        val own = sessions.filter { it.installer == PACKAGE && it.target == PACKAGE }
        require(own.size <= 1 && own.all { it.id > 0 })
        return own.singleOrNull()?.id
    }
    const val PACKAGE = "ru.agentik007.soundspan"
    const val SIGNER = "9692faedf466e915de5bc02e2f4cbabc2b835c2a3dfd78ba47069820e3430b8c"
    fun parse(args: Map<*, *>): UpdateExpected {
        require(args.keys == setOf("id", "nonce", "versionCode", "channel", "bytes", "sha256"))
        fun number(key: String): Long {
            val n = args[key]; require(n is Int || n is Long); return (n as Number).toLong()
        }
        val id = args["id"] as? String ?: throw IllegalArgumentException()
        val nonce = args["nonce"] as? String ?: throw IllegalArgumentException()
        val code = number("versionCode"); val bytes = number("bytes")
        val channel = args["channel"] as? String ?: throw IllegalArgumentException()
        val hash = args["sha256"] as? String ?: throw IllegalArgumentException()
        require(id.matches(Regex("[A-Za-z0-9_-]{32}")) && nonce.matches(Regex("[A-Za-z0-9_-]{32}")))
        require(code in 1..2100000000L && bytes in 1..268435456L && channel in setOf("stable", "test"))
        require(hash.matches(Regex("[a-f0-9]{64}")))
        return UpdateExpected(id, nonce, code, channel, bytes, hash)
    }
    fun validate(installed: UpdatePackage, target: UpdatePackage, expected: UpdateExpected, sdk: Int) {
        require(installed.packageName == PACKAGE && target.packageName == PACKAGE)
        require(installed.signers == listOf(SIGNER) && target.signers == installed.signers)
        val installedChannel = installed.channel ?: "stable"
        require(installedChannel in setOf("stable", "test") && target.channel == installedChannel && expected.channel == installedChannel)
        require(expected.versionCode == target.versionCode && target.versionCode > installed.versionCode &&
            target.versionCode <= 2100000000L && target.minSdk in 24..sdk)
    }
    fun ownFile(root: File, id: String): File {
        require(id.matches(Regex("[A-Za-z0-9_-]{32}")))
        val parent = root.canonicalFile
        require(root.absoluteFile == parent)
        val file = File(parent, "$id.apk")
        require(file.absoluteFile == file.canonicalFile && file.canonicalFile.parentFile == parent && file.isFile)
        return file.canonicalFile
    }
    fun stage(file: File, expected: UpdateExpected, output: OutputStream, check: () -> Unit) {
        check(); require(file.length() == expected.bytes)
        val hash = MessageDigest.getInstance("SHA-256"); var copied = 0L
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                check(); val n = input.read(buffer); if (n < 0) break
                check(); copied += n; require(copied <= expected.bytes)
                hash.update(buffer, 0, n); output.write(buffer, 0, n); check()
            }
        }
        check(); require(copied == expected.bytes && digest(hash.digest()) == expected.sha256)
    }
    fun digest(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
}
internal class UpdateCommitGate(val nonce: String, val sessionId: Int) {
    private var confirmationClaimed = false
    @Synchronized fun claimConfirmation(nonce: String?, sessionId: Int): Boolean {
        if (confirmationClaimed || !accepts(nonce, sessionId)) return false
        confirmationClaimed = true; return true
    }
    private var cancelled = false
    var committed = false; private set
    @Synchronized fun cancel(): Boolean { cancelled = true; return !committed }
    @Synchronized fun commit(nonce: String, sessionId: Int, foreground: Boolean, action: () -> Unit) {
        check(!cancelled && !committed && nonce == this.nonce && sessionId == this.sessionId && foreground)
        committed = true // An exception after the OS boundary has an unknown outcome.
        action()
    }
    @Synchronized fun accepts(nonce: String?, sessionId: Int): Boolean =
        committed && !cancelled && nonce == this.nonce && sessionId == this.sessionId
}
