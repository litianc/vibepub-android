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
import android.content.Context

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AppPreferencesAuthTest {
    private lateinit var preferences: AppPreferences
    private lateinit var tokenStore: TestAuthTokenStore

    @Before
    fun setUp() {
        tokenStore = TestAuthTokenStore()
        preferences = AppPreferences(RuntimeEnvironment.getApplication(), tokenStore)
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

    @Test
    fun tokensNeverRemainInPlainPreferences() {
        preferences.saveAuthSession(testSession())

        val plain = RuntimeEnvironment.getApplication()
            .getSharedPreferences("vibepub", Context.MODE_PRIVATE)
        assertFalse(plain.contains("access_token"))
        assertFalse(plain.contains("refresh_token"))
        assertFalse(plain.contains("files_token"))
        assertEquals("access-token", tokenStore.read().accessToken)
        assertEquals("refresh-token", tokenStore.read().refreshToken)
    }

    @Test
    fun legacyPlainTokensMigrateOnceAndAreDeleted() {
        val context = RuntimeEnvironment.getApplication()
        val plain = context.getSharedPreferences("vibepub", Context.MODE_PRIVATE)
        plain.edit()
            .putString("access_token", "legacy-access")
            .putString("refresh_token", "legacy-refresh")
            .putString("files_token", "legacy-access")
            .apply()

        val migrated = AppPreferences(context, tokenStore)

        assertEquals("legacy-access", migrated.accessToken)
        assertEquals("legacy-refresh", migrated.refreshToken)
        assertFalse(plain.contains("access_token"))
        assertFalse(plain.contains("refresh_token"))
        assertFalse(plain.contains("files_token"))
    }

    @Test
    fun pendingRefreshRequestIdSurvivesRecreationAndClearsWithSuccessfulRotation() {
        val context = RuntimeEnvironment.getApplication()
        preferences.saveAuthSession(testSession())
        val snapshot = preferences.currentAuthSessionSnapshot()
        val requestId = preferences.getOrCreateRefreshRequestId(snapshot)

        val recreated = AppPreferences(context, tokenStore)
        assertEquals(requestId, recreated.getOrCreateRefreshRequestId(recreated.currentAuthSessionSnapshot()))
        assertTrue(recreated.saveRefreshedAuthSession(
            testSession(accessToken = "next-access", refreshToken = "next-refresh"),
            recreated.currentAuthSessionSnapshot(),
        ))
        assertEquals("", tokenStore.read().pendingRefreshRequestId)
        assertEquals(snapshot.sessionId, recreated.currentAuthSessionSnapshot().sessionId)
    }

    @Test
    fun failedSecureMigrationWriteDeletesLegacyTokensAndFailsClosed() {
        val context = RuntimeEnvironment.getApplication()
        val plain = context.getSharedPreferences("vibepub", Context.MODE_PRIVATE)
        plain.edit()
            .putString("access_token", "legacy-access")
            .putString("refresh_token", "legacy-refresh")
            .putString("user_id", "usr_legacy")
            .commit()
        tokenStore.failWrites = true

        val failed = AppPreferences(context, tokenStore)

        assertFalse(plain.contains("access_token"))
        assertFalse(plain.contains("refresh_token"))
        assertFalse(plain.contains("files_token"))
        assertFalse(failed.isAuthenticated)
        assertEquals("secure_storage_unavailable", failed.lastAuthFailureReason)
    }

    @Test
    fun failedSecureMigrationReadDeletesLegacyTokensAndFailsClosed() {
        val context = RuntimeEnvironment.getApplication()
        val plain = context.getSharedPreferences("vibepub", Context.MODE_PRIVATE)
        plain.edit()
            .putString("access_token", "legacy-access")
            .putString("refresh_token", "legacy-refresh")
            .putString("files_token", "legacy-access")
            .putString("user_id", "usr_legacy")
            .commit()
        tokenStore.failReads = true

        val failed = AppPreferences(context, tokenStore)

        assertFalse(plain.contains("access_token"))
        assertFalse(plain.contains("refresh_token"))
        assertFalse(plain.contains("files_token"))
        assertFalse(failed.isAuthenticated)
        assertEquals("secure_storage_unavailable", failed.lastAuthFailureReason)
    }

    @Test
    fun failedLegacyDeletionCommitFailsClosedWithoutPlainTokens() {
        val context = RuntimeEnvironment.getApplication()
        val plain = context.getSharedPreferences("vibepub", Context.MODE_PRIVATE)
        plain.edit()
            .putString("access_token", "legacy-access")
            .putString("refresh_token", "legacy-refresh")
            .putString("files_token", "legacy-access")
            .putString("user_id", "usr_legacy")
            .commit()

        val failed = AppPreferences(context, tokenStore, authMetadataCommit = { false })

        assertFalse(plain.contains("access_token"))
        assertFalse(plain.contains("refresh_token"))
        assertFalse(plain.contains("files_token"))
        assertEquals(StoredAuthSecrets(), tokenStore.read())
        assertFalse(failed.isAuthenticated)
        assertEquals("secure_storage_unavailable", failed.lastAuthFailureReason)
    }

    @Test
    fun secureReadFailureClearsIdentityMetadataWithSanitizedReason() {
        preferences.saveAuthSession(testSession())
        tokenStore.failReads = true

        assertFalse(preferences.isAuthenticated)
        assertEquals("", preferences.userId)
        assertEquals("secure_storage_unavailable", preferences.lastAuthFailureReason)
    }

    @Test
    fun metadataCommitFailureClearsNewTokenBlobInsteadOfMixingAccounts() {
        preferences.saveAuthSession(testSession())
        val failingMetadata = AppPreferences(
            RuntimeEnvironment.getApplication(),
            tokenStore,
            authMetadataCommit = { false },
        )

        assertFalse(failingMetadata.trySaveAuthSession(testSession(
            accessToken = "account-b-access",
            refreshToken = "account-b-refresh",
            userId = "usr_account_b",
        )))
        assertEquals(StoredAuthSecrets(), tokenStore.read())
        assertFalse(failingMetadata.isAuthenticated)
    }

    @Test
    fun secureWriteFailureFailsClosedInsteadOfRetainingThePreviousAccount() {
        preferences.saveAuthSession(testSession())
        tokenStore.failWrites = true

        assertFalse(preferences.trySaveAuthSession(testSession(
            accessToken = "account-b-access",
            refreshToken = "account-b-refresh",
            userId = "usr_account_b",
        )))

        tokenStore.failWrites = false
        assertEquals(StoredAuthSecrets(), tokenStore.read())
        assertFalse(preferences.isAuthenticated)
        assertEquals("secure_storage_unavailable", preferences.lastAuthFailureReason)
    }

    @Test
    fun pendingRequestIdIsBoundToRefreshGenerationAndDigest() {
        preferences.saveAuthSession(testSession())
        val snapshot = preferences.currentAuthSessionSnapshot()
        val oldRequestId = preferences.getOrCreateRefreshRequestId(snapshot)
        val stored = tokenStore.read()
        tokenStore.write(stored.copy(
            refreshToken = "different-refresh",
            generation = stored.generation + 1,
        ))

        val nextSnapshot = preferences.currentAuthSessionSnapshot()
        val nextRequestId = preferences.getOrCreateRefreshRequestId(nextSnapshot)

        assertTrue(nextRequestId.isNotBlank())
        assertFalse(oldRequestId == nextRequestId)
    }

    private fun testSession(
        accessToken: String = "access-token",
        refreshToken: String = "refresh-token",
        userId: String = "usr_current",
    ) = AuthSession(
        user = AuthUser(
            id = userId,
            email = "current@example.test",
            role = "user",
            workspaceId = "ws_current",
            emailVerified = true,
        ),
        accessToken = accessToken,
        refreshToken = refreshToken,
    )
}

internal class TestAuthTokenStore(
    private var value: StoredAuthSecrets = StoredAuthSecrets(),
) : AuthTokenStore {
    var failReads = false
    var failWrites = false
    var failClears = false

    override fun read(): StoredAuthSecrets {
        if (failReads) throw SecureStorageException()
        return value
    }
    override fun write(value: StoredAuthSecrets) {
        if (failWrites) throw SecureStorageException()
        this.value = value
    }
    override fun clear() {
        if (failClears) throw SecureStorageException()
        value = StoredAuthSecrets()
    }
}
