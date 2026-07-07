package cn.litianc.vibepub

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AppPreferencesAuthTest {
    private lateinit var preferences: AppPreferences

    @Before
    fun setUp() {
        preferences = AppPreferences(RuntimeEnvironment.getApplication())
        preferences.clearAuthSession()
    }

    @After
    fun tearDown() {
        preferences.clearAuthSession()
    }

    @Test
    fun saveAuthSessionMakesCurrentUserActive() {
        preferences.saveAuthSession(testSession())

        assertTrue(preferences.isAuthenticated)
        assertTrue(preferences.canUseCloudFeatures)
        assertEquals("access-token", preferences.accessToken)
        assertEquals("refresh-token", preferences.refreshToken)
        assertEquals("usr_current", preferences.userId)
        assertEquals("usr_current", preferences.effectiveUserId)
        assertEquals("current@example.test", preferences.userEmail)
        assertEquals("user", preferences.userRole)
        assertTrue(preferences.emailVerified)
    }

    @Test
    fun clearAuthSessionReturnsToLoggedOutDefaultUserState() {
        preferences.saveAuthSession(testSession())

        preferences.clearAuthSession()

        assertFalse(preferences.isAuthenticated)
        assertFalse(preferences.canUseCloudFeatures)
        assertEquals("", preferences.accessToken)
        assertEquals("", preferences.refreshToken)
        assertEquals("", preferences.userId)
        assertEquals(AppPreferences.DEFAULT_USER_ID, preferences.effectiveUserId)
        assertEquals("", preferences.userEmail)
        assertEquals("user", preferences.userRole)
        assertFalse(preferences.emailVerified)
    }

    @Test
    fun authStateFlowEmitsWhenLoggingOut() = runBlocking {
        preferences.saveAuthSession(testSession())

        val update = async(start = CoroutineStart.UNDISPATCHED) {
            preferences.authStateFlow().drop(1).first()
        }

        preferences.clearAuthSession()

        assertEquals(preferences.authStateVersion, withTimeout(2_000L) { update.await() })
    }

    private fun testSession() = AuthSession(
        user = AuthUser(
            id = "usr_current",
            email = "current@example.test",
            role = "user",
            workspaceId = "ws_current",
            emailVerified = true,
        ),
        accessToken = "access-token",
        refreshToken = "refresh-token",
    )
}
