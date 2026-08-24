import java.net.URI

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp")
}

ksp {
    arg("room.generateKotlin", "true")
}

val hasReleaseSigningConfig =
    providers.gradleProperty("VIBEPUB_RELEASE_STORE_FILE").orNull?.isNotBlank() == true &&
        providers.gradleProperty("VIBEPUB_RELEASE_STORE_PASSWORD").orNull?.isNotBlank() == true &&
        providers.gradleProperty("VIBEPUB_RELEASE_KEY_ALIAS").orNull?.isNotBlank() == true &&
        providers.gradleProperty("VIBEPUB_RELEASE_KEY_PASSWORD").orNull?.isNotBlank() == true

val appEnvironment = providers.gradleProperty("VIBEPUB_ENVIRONMENT")
    .orElse("production")
    .get()
    .trim()
val productionApiBaseUrl = "https://vibepub.litianc.cn"
val allowTestInvalidStagingApi = providers.gradleProperty("VIBEPUB_ALLOW_TEST_INVALID_STAGING_API")
    .orNull == "true"
fun validatedApiBaseUrl(rawValue: String, name: String): String {
    val value = rawValue.trim().trimEnd('/')
    val uri = runCatching { URI(value) }.getOrElse { error("$name must be a valid HTTPS URL") }
    require(
        uri.scheme == "https" && uri.host != null && uri.userInfo == null &&
            uri.query == null && uri.fragment == null && (uri.path.isNullOrEmpty() || uri.path == "/"),
    ) { "$name must be an HTTPS origin without credentials, path, query, or fragment" }
    return value
}

fun canonicalApiHost(apiBaseUrl: String): String =
    URI(apiBaseUrl).host.lowercase().trimEnd('.')

data class AppEnvironment(
    val applicationId: String,
    val appLabel: String,
    val authScheme: String,
    val apiBaseUrl: String,
)

val environment = when (appEnvironment) {
    "production" -> AppEnvironment("cn.litianc.vibepub", "VibePub", "vibepub", productionApiBaseUrl)
    "staging" -> {
        val stagingApiBaseUrl = providers.gradleProperty("VIBEPUB_STAGING_API_BASE_URL")
            .orElse(providers.environmentVariable("STAGING_PUBLIC_BASE_URL"))
            .orNull
            ?.takeIf { it.isNotBlank() }
            ?: error("Staging requires VIBEPUB_STAGING_API_BASE_URL or STAGING_PUBLIC_BASE_URL")
        val validated = validatedApiBaseUrl(stagingApiBaseUrl, "Staging API base URL")
        val stagingApiHost = canonicalApiHost(validated)
        require(stagingApiHost != canonicalApiHost(productionApiBaseUrl)) {
            "Staging API base URL must not be Production"
        }
        require(stagingApiHost != "invalid") {
            "Staging API base URL must not use the exact invalid hostname"
        }
        require(!stagingApiHost.endsWith(".invalid") || allowTestInvalidStagingApi) {
            "Staging .invalid API URLs require VIBEPUB_ALLOW_TEST_INVALID_STAGING_API=true"
        }
        AppEnvironment("cn.litianc.vibepub.staging", "VibePub Staging", "vibepub-staging", validated)
    }
    else -> error("VIBEPUB_ENVIRONMENT must be production or staging")
}

android {
    namespace = "cn.litianc.vibepub"
    compileSdk = 36

    defaultConfig {
        applicationId = environment.applicationId
        minSdk = 26
        targetSdk = 36
        versionCode = 2
        versionName = "0.1.1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        manifestPlaceholders["appLabel"] = environment.appLabel
        manifestPlaceholders["authScheme"] = environment.authScheme
        manifestPlaceholders["defaultApiBaseUrl"] = environment.apiBaseUrl
        buildConfigField("String", "AUTH_SCHEME", "\"${environment.authScheme}\"")
        buildConfigField("String", "DEFAULT_API_BASE_URL", "\"${environment.apiBaseUrl}\"")
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }

    signingConfigs {
        create("release") {
            val storePath = providers.gradleProperty("VIBEPUB_RELEASE_STORE_FILE")
            val storePasswordValue = providers.gradleProperty("VIBEPUB_RELEASE_STORE_PASSWORD")
            val keyAliasValue = providers.gradleProperty("VIBEPUB_RELEASE_KEY_ALIAS")
            val keyPasswordValue = providers.gradleProperty("VIBEPUB_RELEASE_KEY_PASSWORD")

            if (
                storePath.isPresent &&
                storePasswordValue.isPresent &&
                keyAliasValue.isPresent &&
                keyPasswordValue.isPresent
            ) {
                storeFile = file(storePath.get())
                storePassword = storePasswordValue.get()
                keyAlias = keyAliasValue.get()
                keyPassword = keyPasswordValue.get()
            }
        }
    }

    buildTypes {
        debug {
            versionNameSuffix = "-debug"
            if (hasReleaseSigningConfig) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.06.00"))
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.core:core-ktx:1.18.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.4")
    implementation("androidx.work:work-runtime-ktx:2.11.2")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.runtime:runtime-livedata")

    // Navigation Compose
    val nav_version = "2.8.5"
    implementation("androidx.navigation:navigation-compose:$nav_version")

    // Media3 (ExoPlayer)
    val media3_version = "1.5.0"
    implementation("androidx.media3:media3-exoplayer:$media3_version")
    implementation("androidx.media3:media3-ui:$media3_version")
    implementation("androidx.media3:media3-common:$media3_version")

    // Room
    val room_version = "2.6.1"
    implementation("androidx.room:room-runtime:$room_version")
    implementation("androidx.room:room-ktx:$room_version")
    ksp("androidx.room:room-compiler:$room_version")

    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.12.1")
    testImplementation("androidx.test.ext:junit:1.2.1")
    testImplementation("androidx.work:work-testing:2.11.2")
    testImplementation("androidx.test.espresso:espresso-core:3.6.1")
    testImplementation("androidx.compose.ui:ui-test-junit4")
    testImplementation("androidx.test:rules:1.6.1")
    
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test:rules:1.6.1")
}
