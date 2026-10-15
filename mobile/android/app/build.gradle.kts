plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Secrets are process-local. Release never inherits the Android debug identity.
val releaseStore = System.getenv("SOUNDSPAN_KEYSTORE")
val releaseAlias = System.getenv("SOUNDSPAN_KEY_ALIAS")
val releasePassword = System.getenv("SOUNDSPAN_STORE_PASSWORD")
val releaseReady = !releaseStore.isNullOrBlank() &&
    !releaseAlias.isNullOrBlank() && !releasePassword.isNullOrBlank() &&
    file(releaseStore).isFile

gradle.taskGraph.whenReady {
    if (allTasks.any { it.project == project && it.name.contains("Release", ignoreCase = true) }) {
        check(releaseReady) { "Release requires explicit private signing environment; use scripts/mobile/build-release.ps1." }
        check(!gradle.startParameter.isConfigurationCacheRequested) { "Release signing requires configuration cache disabled." }
    }
}

android {
    namespace = "ru.agentik007.soundspan"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "ru.agentik007.soundspan"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        create("release") {
            if (releaseReady) {
                storeFile = file(releaseStore!!)
                storeType = "PKCS12"
                keyAlias = releaseAlias
                storePassword = releasePassword
                keyPassword = releasePassword
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

dependencies {
    implementation("androidx.work:work-runtime:2.12.0")
    testImplementation("junit:junit:4.13.2")
}
