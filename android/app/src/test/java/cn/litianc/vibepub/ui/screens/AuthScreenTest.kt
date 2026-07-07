package cn.litianc.vibepub.ui.screens

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import cn.litianc.vibepub.AppPreferences
import com.sun.net.httpserver.HttpServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.net.InetSocketAddress
import java.util.concurrent.atomic.AtomicBoolean

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AuthScreenTest {
    @get:Rule
    val composeTestRule = createAndroidComposeRule<ComponentActivity>()

    private var server: HttpServer? = null

    @After
    fun tearDown() {
        server?.stop(0)
    }

    @Test
    fun loginSubmitButtonSavesSessionAndCallsAuthenticatedCallback() {
        val baseUrl = startLoginServer()
        val preferences = AppPreferences(composeTestRule.activity)
        preferences.clearAuthSession()
        preferences.apiBaseUrl = baseUrl
        val authenticated = AtomicBoolean(false)

        composeTestRule.setContent {
            AuthScreen(
                preferences = preferences,
                onAuthenticated = { authenticated.set(true) },
            )
        }

        composeTestRule.onNodeWithTag("AuthScreen").assertIsDisplayed()
        composeTestRule.onNodeWithTag("AuthEmailField").performTextInput("current@example.test")
        composeTestRule.onNodeWithTag("AuthPasswordField").performTextInput("CodexDogfood1234")
        composeTestRule.onNodeWithTag("AuthSubmitButton").performClick()

        composeTestRule.waitUntil(timeoutMillis = 2_000L) {
            authenticated.get() && preferences.isAuthenticated
        }
        assertEquals("usr_login", preferences.userId)
        assertEquals("current@example.test", preferences.userEmail)
        assertEquals("access-from-test", preferences.accessToken)
        assertTrue(preferences.canUseCloudFeatures)
    }

    private fun startLoginServer(): String {
        val httpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        httpServer.createContext("/api/auth/login") { exchange ->
            val body = """
                {
                  "user": {
                    "id": "usr_login",
                    "email": "current@example.test",
                    "role": "user",
                    "workspace_id": "ws_login",
                    "email_verified": true
                  },
                  "tokens": {
                    "access_token": "access-from-test",
                    "refresh_token": "refresh-from-test"
                  }
                }
            """.trimIndent().toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        httpServer.start()
        server = httpServer
        return "http://127.0.0.1:${httpServer.address.port}"
    }
}
