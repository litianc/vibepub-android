package cn.litianc.vibepub

import android.net.Uri
import android.content.Context
import cn.litianc.vibepub.ui.screens.AuthPrefillMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.net.URI

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AuthDeepLinkIdentityTest {
    @Test
    fun appPreferencesUseTheEnvironmentApiDefault() {
        val defaultApi = BuildConfig.DEFAULT_API_BASE_URL
        val parsed = URI(defaultApi)

        assertEquals("https", parsed.scheme)
        when (BuildConfig.APPLICATION_ID) {
            "cn.litianc.vibepub" -> assertEquals("https://vibepub.litianc.cn", defaultApi)
            "cn.litianc.vibepub.staging" -> {
                assertNotEquals("https://vibepub.litianc.cn", defaultApi)
            }
            else -> error("Unexpected application ID: ${BuildConfig.APPLICATION_ID}")
        }

        val context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("vibepub", Context.MODE_PRIVATE)
            .edit()
            .remove("api_base_url")
            .commit()

        assertEquals(defaultApi, AppPreferences(context).apiBaseUrl)
    }

    @Test
    fun appAcceptsOnlyItsEnvironmentAuthScheme() {
        val otherScheme = when (BuildConfig.AUTH_SCHEME) {
            "vibepub" -> "vibepub-staging"
            "vibepub-staging" -> "vibepub"
            else -> error("Unexpected auth scheme: ${BuildConfig.AUTH_SCHEME}")
        }

        val accepted = authTokenPrefillFromUri(
            Uri.parse("${BuildConfig.AUTH_SCHEME}://auth/accept-invite?token=environment-token"),
        )
        val rejected = authTokenPrefillFromUri(
            Uri.parse("$otherScheme://auth/accept-invite?token=environment-token"),
        )

        assertEquals(AuthPrefillMode.ACCEPT_INVITE, accepted?.mode)
        assertEquals("environment-token", accepted?.token)
        assertNull(rejected)
    }
}
