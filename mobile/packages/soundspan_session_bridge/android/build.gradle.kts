group = "ru.agentik007.soundspan.session"
version = "0.1.0"

plugins {
    id("com.android.library")
}

android {
    namespace = "ru.agentik007.soundspan.session"
    compileSdk = 36
    defaultConfig { minSdk = 24 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
kotlin { compilerOptions { jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17 } }
dependencies { testImplementation("junit:junit:4.13.2") }
