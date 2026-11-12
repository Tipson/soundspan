pluginManagement {
    val flutterSdkPath =
        run {
            val properties = java.util.Properties()
            file("local.properties").inputStream().use { properties.load(it) }
            val flutterSdkPath = properties.getProperty("flutter.sdk")
            require(flutterSdkPath != null) { "flutter.sdk not set in local.properties" }
            flutterSdkPath
        }

    includeBuild("$flutterSdkPath/packages/flutter_tools/gradle")

    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "9.1.0" apply false
    id("org.jetbrains.kotlin.android") version "2.4.0" apply false
}

include(":app")

// Keep the hosted Dart/iOS API pinned while applying the Android power-policy
// correction locally. Fail closed when the upstream native implementation moves.
val hostedAudioService = project(":audio_service").projectDir
val hostedAudioSource = hostedAudioService.resolve(
    "src/main/java/com/ryanheise/audioservice/AudioService.java",
)
check(hostedAudioSource.isFile) { "Pinned audio_service Android source is missing" }
val hostedAudioSha256 = java.security.MessageDigest.getInstance("SHA-256")
    .digest(hostedAudioSource.readBytes()).joinToString("") { "%02x".format(it) }
check(hostedAudioSha256 == "538dc027311ea070eea883f6dbf6b0e339c6c609cf6b395d018e359caea36938") {
    "Review the audio_service Android power-policy correction before updating its dependency"
}
project(":audio_service").projectDir = file("vendor/audio_service")
