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

// Read-only acknowledgement of the current ExoPlayer, without changing Dart/iOS.
val hostedJustAudio = project(":just_audio").projectDir
mapOf(
    "AudioPlayer.java" to "b4d27bfe9d66a2fe75f13401b9ffb30bbacc2f614470167f3e7d98864c9f9f3c",
    "MainMethodCallHandler.java" to "e94040e14ae05d48e117fa2499935546bd249570684ceeb791eb2eb539f68779",
).forEach { (name, expected) ->
    val source = hostedJustAudio.resolve("src/main/java/com/ryanheise/just_audio/$name")
    check(source.isFile) { "Pinned just_audio Android source is missing" }
    val actual = java.security.MessageDigest.getInstance("SHA-256")
        .digest(source.readBytes()).joinToString("") { "%02x".format(it) }
    check(actual == expected) { "Review the just_audio native-start acknowledgement before updating its dependency" }
}
project(":just_audio").projectDir = file("vendor/just_audio")
