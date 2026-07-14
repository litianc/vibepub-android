package cn.litianc.vibepub

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal data class StoredAuthSecrets(
    val accessToken: String = "",
    val refreshToken: String = "",
    val userId: String = "",
    val localSessionId: String = "",
    val serverSessionId: String = "",
    val generation: Int = 0,
    val accessExpiresAt: String = "",
    val idleExpiresAt: String = "",
    val refreshExpiresAt: String = "",
    val contractVersion: Int = 0,
    val pendingRefreshRequestId: String = "",
    val pendingRefreshSessionId: String = "",
    val pendingRefreshTokenDigest: String = "",
    val pendingRefreshGeneration: Int = -1,
)

internal class SecureStorageException : IllegalStateException("secure_storage_unavailable")

internal interface AuthTokenStore {
    fun read(): StoredAuthSecrets
    fun write(value: StoredAuthSecrets)
    fun clear()
}

internal class AndroidKeystoreAuthTokenStore(context: Context) : AuthTokenStore {
    private val prefs = context.getSharedPreferences(SECURE_PREFS_NAME, Context.MODE_PRIVATE)

    override fun read(): StoredAuthSecrets {
        val encoded = prefs.getString(KEY_CIPHERTEXT, "").orEmpty()
        if (encoded.isBlank()) return StoredAuthSecrets()
        return try {
            decode(decrypt(encoded))
        } catch (_: Throwable) {
            throw SecureStorageException()
        }
    }

    override fun write(value: StoredAuthSecrets) {
        if (value == StoredAuthSecrets()) {
            clear()
            return
        }
        if (!prefs.edit().putString(KEY_CIPHERTEXT, encrypt(encode(value))).commit()) {
            throw SecureStorageException()
        }
    }

    override fun clear() {
        if (!prefs.edit().remove(KEY_CIPHERTEXT).commit()) {
            throw SecureStorageException()
        }
    }

    private fun encrypt(plaintext: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, encryptionKey())
        return listOf(
            FORMAT_VERSION,
            Base64.encodeToString(cipher.iv, Base64.NO_WRAP),
            Base64.encodeToString(cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP),
        ).joinToString(":")
    }

    private fun decrypt(encoded: String): String {
        val parts = encoded.split(":", limit = 3)
        require(parts.size == 3 && parts[0] == FORMAT_VERSION) { "Unsupported auth token format" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE,
            encryptionKey(),
            GCMParameterSpec(128, Base64.decode(parts[1], Base64.NO_WRAP)),
        )
        return cipher.doFinal(Base64.decode(parts[2], Base64.NO_WRAP)).toString(Charsets.UTF_8)
    }

    private fun encryptionKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER).run {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            generateKey()
        }
    }

    private fun encode(value: StoredAuthSecrets): String = JSONObject()
        .put("access_token", value.accessToken)
        .put("refresh_token", value.refreshToken)
        .put("user_id", value.userId)
        .put("local_session_id", value.localSessionId)
        .put("server_session_id", value.serverSessionId)
        .put("generation", value.generation)
        .put("access_expires_at", value.accessExpiresAt)
        .put("idle_expires_at", value.idleExpiresAt)
        .put("refresh_expires_at", value.refreshExpiresAt)
        .put("contract_version", value.contractVersion)
        .put("pending_refresh_request_id", value.pendingRefreshRequestId)
        .put("pending_refresh_session_id", value.pendingRefreshSessionId)
        .put("pending_refresh_token_digest", value.pendingRefreshTokenDigest)
        .put("pending_refresh_generation", value.pendingRefreshGeneration)
        .toString()

    private fun decode(value: String): StoredAuthSecrets = JSONObject(value).let { json ->
        StoredAuthSecrets(
            accessToken = json.optString("access_token"),
            refreshToken = json.optString("refresh_token"),
            userId = json.optString("user_id"),
            localSessionId = json.optString("local_session_id"),
            serverSessionId = json.optString("server_session_id"),
            generation = json.optInt("generation", 0),
            accessExpiresAt = json.optString("access_expires_at"),
            idleExpiresAt = json.optString("idle_expires_at"),
            refreshExpiresAt = json.optString("refresh_expires_at"),
            contractVersion = json.optInt("contract_version", 0),
            pendingRefreshRequestId = json.optString("pending_refresh_request_id"),
            pendingRefreshSessionId = json.optString("pending_refresh_session_id"),
            pendingRefreshTokenDigest = json.optString("pending_refresh_token_digest"),
            pendingRefreshGeneration = json.optInt("pending_refresh_generation", -1),
        )
    }

    private companion object {
        const val SECURE_PREFS_NAME = "vibepub_secure_auth"
        const val KEY_CIPHERTEXT = "auth_secrets_ciphertext"
        const val KEYSTORE_PROVIDER = "AndroidKeyStore"
        const val KEY_ALIAS = "vibepub.auth.tokens.v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val FORMAT_VERSION = "v1"
    }
}
