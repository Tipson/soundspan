package ru.agentik007.soundspan.app.updates

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.nio.file.Files

class ApkUpdateVerifierTest {
    private val data = ByteArray(4096) { (it % 251).toByte() }
    private val expected = UpdateExpected("a".repeat(32), "b".repeat(32), 29, "stable", data.size.toLong(),
        MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) })
    private val installed = UpdatePackage(ApkUpdateVerifier.PACKAGE, 28, "stable", listOf(ApkUpdateVerifier.SIGNER))
    private val target = installed.copy(versionCode = 29)
    @Test fun knownSingleCurrentSignerAndHigherVersionAreAccepted() {
        ApkUpdateVerifier.validate(installed, target, expected, 36)
        ApkUpdateVerifier.validate(installed.copy(channel = null), target, expected, 36)
    }
    @Test fun packageSignerChannelDowngradeAndSdkMismatchFailClosed() {
        for (bad in listOf(target.copy(packageName = "other.app"), target.copy(versionCode = 28),
            target.copy(channel = "test"), target.copy(channel = null), target.copy(minSdk = 37),
            target.copy(signers = emptyList()), target.copy(signers = listOf("f".repeat(64))),
            target.copy(signers = listOf(ApkUpdateVerifier.SIGNER, ApkUpdateVerifier.SIGNER)))) {
            try { ApkUpdateVerifier.validate(installed, bad, expected, 36); fail("Unsafe APK accepted") }
            catch (_: IllegalArgumentException) { }
        }
        try { ApkUpdateVerifier.validate(installed.copy(signers = listOf("f".repeat(64))), target, expected, 36); fail() }
        catch (_: IllegalArgumentException) { }
    }
    @Test fun stagedBytesAreHashedRatherThanTrustingPriorVerification() {
        val root = Files.createTempDirectory("update-verifier-").toFile()
        try {
            val file = File(root, "${expected.id}.apk").apply { writeBytes(data) }
            val out = ByteArrayOutputStream()
            ApkUpdateVerifier.stage(file, expected, out) {}
            assertArrayEquals(data, out.toByteArray())
            file.writeBytes(data.copyOf().also { it[0] = 1 })
            try { ApkUpdateVerifier.stage(file, expected, ByteArrayOutputStream()) {}; fail("Tampered staged bytes accepted") }
            catch (_: IllegalArgumentException) { }
        } finally { root.deleteRecursively() }
    }
    @Test fun cancellationDuringCopyNeverFinishesStaging() {
        val root = Files.createTempDirectory("update-cancel-").toFile()
        try {
            val file = File(root, "${expected.id}.apk").apply { writeBytes(data) }
            var checks = 0
            try { ApkUpdateVerifier.stage(file, expected, ByteArrayOutputStream()) {
                if (++checks >= 2) throw IllegalStateException("cancelled")
            }; fail() } catch (_: IllegalStateException) {}
        } finally { root.deleteRecursively() }
    }
    @Test fun arbitraryPathsNeverResolveToInstallableFile() {
        val root = Files.createTempDirectory("update-path-").toFile()
        try {
            val file = File(root, "${expected.id}.apk").apply { writeBytes(data) }
            assertEquals(file.canonicalFile, ApkUpdateVerifier.ownFile(root, expected.id))
            for (id in listOf("../outside", "a.apk", "a".repeat(33))) {
                try { ApkUpdateVerifier.ownFile(root, id); fail() } catch (_: IllegalArgumentException) {}
            }
        } finally { root.deleteRecursively() }
    }
    @Test fun nonCanonicalRootAndMalformedBridgeIdentityAreRejected() {
        val root = Files.createTempDirectory("update-ancestor-").toFile()
        try {
            File(root, "${expected.id}.apk").writeBytes(data)
            val alias = File(root.parentFile, "${root.name}/../${root.name}")
            try { ApkUpdateVerifier.ownFile(alias, expected.id); fail("Non-canonical root accepted") }
            catch (_: IllegalArgumentException) {}
            val args = mapOf("id" to expected.id, "nonce" to expected.nonce,
                "versionCode" to 29, "channel" to "stable", "bytes" to data.size, "sha256" to expected.sha256)
            assertEquals(expected, ApkUpdateVerifier.parse(args))
            for (bad in listOf(args + ("nonce" to "short"), args + ("bytes" to 3.0), args + ("path" to "/outside"))) {
                try { ApkUpdateVerifier.parse(bad); fail("Bad bridge identity accepted") } catch (_: IllegalArgumentException) {}
            }
        } finally { root.deleteRecursively() }
    }
}
