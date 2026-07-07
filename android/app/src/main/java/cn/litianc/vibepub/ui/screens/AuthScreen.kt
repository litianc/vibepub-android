package cn.litianc.vibepub.ui.screens

import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import cn.litianc.vibepub.AppPreferences
import cn.litianc.vibepub.AuthApi
import kotlinx.coroutines.launch

private enum class AuthMode {
    LOGIN,
    ACCEPT_INVITE,
    RESET_PASSWORD,
}

enum class AuthPrefillMode {
    ACCEPT_INVITE,
    RESET_PASSWORD,
}

data class AuthTokenPrefill(
    val mode: AuthPrefillMode,
    val token: String,
)

@Composable
fun AuthScreen(
    preferences: AppPreferences,
    onAuthenticated: () -> Unit,
    tokenPrefill: AuthTokenPrefill? = null,
    onTokenPrefillConsumed: () -> Unit = {},
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var mode by remember { mutableStateOf(AuthMode.LOGIN) }
    var apiBaseUrl by remember { mutableStateOf(preferences.apiBaseUrl) }
    var email by remember { mutableStateOf(preferences.userEmail) }
    var password by remember { mutableStateOf("") }
    var inviteToken by remember { mutableStateOf("") }
    var resetToken by remember { mutableStateOf("") }
    var isSubmitting by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(tokenPrefill) {
        val prefill = tokenPrefill ?: return@LaunchedEffect
        when (prefill.mode) {
            AuthPrefillMode.ACCEPT_INVITE -> {
                mode = AuthMode.ACCEPT_INVITE
                inviteToken = prefill.token
            }
            AuthPrefillMode.RESET_PASSWORD -> {
                mode = AuthMode.RESET_PASSWORD
                resetToken = prefill.token
            }
        }
        errorMessage = null
        onTokenPrefillConsumed()
    }

    fun submit(block: suspend () -> Unit) {
        isSubmitting = true
        errorMessage = null
        preferences.apiBaseUrl = apiBaseUrl
        scope.launch {
            runCatching { block() }
                .onFailure { error -> errorMessage = error.message ?: "账号请求失败" }
            isSubmitting = false
        }
    }

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 24.dp, vertical = 32.dp)
                .testTag("AuthScreen"),
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                "VibePub",
                style = MaterialTheme.typography.headlineLarge,
                fontWeight = FontWeight.Bold,
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                when (mode) {
                    AuthMode.LOGIN -> "登录后同步录音、风格模板和公众号发布配置"
                    AuthMode.ACCEPT_INVITE -> "输入邀请 token 并设置密码"
                    AuthMode.RESET_PASSWORD -> "通过邮箱或重置 token 找回账号"
                },
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(modifier = Modifier.height(24.dp))

            OutlinedTextField(
                value = apiBaseUrl,
                onValueChange = {
                    apiBaseUrl = it
                    preferences.apiBaseUrl = it
                },
                label = { Text("API Base URL") },
                leadingIcon = { androidx.compose.material3.Icon(Icons.Default.Link, contentDescription = null) },
                singleLine = true,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("AuthApiBaseUrlField"),
            )
            Spacer(modifier = Modifier.height(12.dp))

            if (mode != AuthMode.ACCEPT_INVITE) {
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    label = { Text("邮箱") },
                    leadingIcon = { androidx.compose.material3.Icon(Icons.Default.Email, contentDescription = null) },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("AuthEmailField"),
                )
                Spacer(modifier = Modifier.height(12.dp))
            }

            if (mode == AuthMode.ACCEPT_INVITE) {
                OutlinedTextField(
                    value = inviteToken,
                    onValueChange = { inviteToken = it },
                    label = { Text("邀请 token") },
                    leadingIcon = { androidx.compose.material3.Icon(Icons.Default.Link, contentDescription = null) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(modifier = Modifier.height(12.dp))
            }

            if (mode == AuthMode.RESET_PASSWORD) {
                OutlinedTextField(
                    value = resetToken,
                    onValueChange = { resetToken = it },
                    label = { Text("重置 token") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(modifier = Modifier.height(12.dp))
            }

            if (mode != AuthMode.RESET_PASSWORD || resetToken.isNotBlank()) {
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text(if (mode == AuthMode.LOGIN) "密码" else "新密码") },
                    leadingIcon = { androidx.compose.material3.Icon(Icons.Default.Lock, contentDescription = null) },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("AuthPasswordField"),
                )
                Spacer(modifier = Modifier.height(16.dp))
            }

            errorMessage?.let {
                Text(
                    it,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(modifier = Modifier.height(12.dp))
            }

            Button(
                enabled = !isSubmitting,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("AuthSubmitButton"),
                onClick = {
                    when (mode) {
                        AuthMode.LOGIN -> submit {
                            val session = AuthApi.login(apiBaseUrl, email, password)
                            preferences.saveAuthSession(session)
                            onAuthenticated()
                        }
                        AuthMode.ACCEPT_INVITE -> submit {
                            val session = AuthApi.acceptInvite(apiBaseUrl, inviteToken, password)
                            preferences.saveAuthSession(session)
                            onAuthenticated()
                        }
                        AuthMode.RESET_PASSWORD -> submit {
                            if (resetToken.isBlank()) {
                                AuthApi.requestPasswordReset(apiBaseUrl, email)
                                Toast.makeText(context, "如果邮箱存在，重置邮件会发送过去", Toast.LENGTH_LONG).show()
                            } else {
                                AuthApi.resetPassword(apiBaseUrl, resetToken, password)
                                Toast.makeText(context, "密码已更新，请登录", Toast.LENGTH_SHORT).show()
                                mode = AuthMode.LOGIN
                                password = ""
                                resetToken = ""
                            }
                        }
                    }
                },
            ) {
                Text(
                    when (mode) {
                        AuthMode.LOGIN -> "登录"
                        AuthMode.ACCEPT_INVITE -> "接受邀请"
                        AuthMode.RESET_PASSWORD -> if (resetToken.isBlank()) "发送重置邮件" else "重设密码"
                    },
                )
            }

            if (isSubmitting) {
                Spacer(modifier = Modifier.height(12.dp))
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            }

            Spacer(modifier = Modifier.height(20.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedButton(
                    enabled = !isSubmitting,
                    onClick = {
                        errorMessage = null
                        mode = if (mode == AuthMode.ACCEPT_INVITE) AuthMode.LOGIN else AuthMode.ACCEPT_INVITE
                    },
                ) {
                    Text(if (mode == AuthMode.ACCEPT_INVITE) "返回登录" else "接受邀请")
                }
                Spacer(modifier = Modifier.width(10.dp))
                OutlinedButton(
                    enabled = !isSubmitting,
                    onClick = {
                        errorMessage = null
                        mode = if (mode == AuthMode.RESET_PASSWORD) AuthMode.LOGIN else AuthMode.RESET_PASSWORD
                    },
                ) {
                    Text(if (mode == AuthMode.RESET_PASSWORD) "返回登录" else "忘记密码")
                }
            }
        }
    }
}
