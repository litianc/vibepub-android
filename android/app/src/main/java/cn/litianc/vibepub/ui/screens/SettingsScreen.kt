package cn.litianc.vibepub.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.app.Activity
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.speech.RecognizerIntent
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.BugReport
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.CloudDone
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.AdminPanelSettings
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.MarkEmailRead
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Divider
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import cn.litianc.vibepub.AppPreferences
import cn.litianc.vibepub.AdminInviteResult
import cn.litianc.vibepub.AdminUsersResult
import cn.litianc.vibepub.AuthApi
import cn.litianc.vibepub.BuildConfig
import cn.litianc.vibepub.PublishingAccount
import cn.litianc.vibepub.StyleSourceImportSummary
import cn.litianc.vibepub.WritingStyleApi
import cn.litianc.vibepub.WritingStyleProfileOption
import cn.litianc.vibepub.WritingStyleProfiles
import cn.litianc.vibepub.data.AppDatabase
import cn.litianc.vibepub.data.RecordingEntity
import cn.litianc.vibepub.data.currentWorkflowStep
import cn.litianc.vibepub.data.displayTitle
import cn.litianc.vibepub.data.listDurationLabel
import cn.litianc.vibepub.data.statusDetail
import cn.litianc.vibepub.data.statusLabel
import cn.litianc.vibepub.data.workflowCurrentNodeLabel
import cn.litianc.vibepub.data.workflowFreshnessLabel
import cn.litianc.vibepub.data.workflowNextActionLabel
import cn.litianc.vibepub.data.workflowProgressLabel
import cn.litianc.vibepub.data.wechatDraftReferenceOrNull
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

internal enum class ConnectionCheckState {
    PASSED,
    FAILED,
    SKIPPED,
}

internal data class ConnectionCheckItem(
    val label: String,
    val state: ConnectionCheckState,
    val detail: String,
)

internal data class ConnectionTestResult(
    val success: Boolean,
    val summary: String,
    val nextAction: String,
    val checks: List<ConnectionCheckItem>,
)

internal data class SettingsConnectionConfig(
    val apiBaseUrl: String,
    val filesToken: String,
) {
    val accessToken: String
        get() = filesToken

    fun normalized(): SettingsConnectionConfig {
        return SettingsConnectionConfig(
            apiBaseUrl = apiBaseUrl.trim(),
            filesToken = filesToken.trim(),
        )
    }
}

private const val SETTINGS_AUTO_CONNECTION_TEST_DELAY_MS = 900L

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBackClick: () -> Unit,
) {
    val context = LocalContext.current
    val preferences = remember { AppPreferences(context) }
    val scope = rememberCoroutineScope()
    var apiBaseUrl by remember { mutableStateOf(preferences.apiBaseUrl) }
    var accessToken by remember { mutableStateOf(preferences.accessToken) }
    var accountEmail by remember { mutableStateOf(preferences.userEmail) }
    var accountRole by remember { mutableStateOf(preferences.userRole) }
    var accountEmailVerified by remember { mutableStateOf(preferences.emailVerified) }
    var isTesting by remember { mutableStateOf(false) }
    var connectionResult by remember { mutableStateOf<ConnectionTestResult?>(null) }
    var showDiagnostics by remember { mutableStateOf(false) }
    var diagnostics by remember { mutableStateOf("") }
    var publishingAccount by remember { mutableStateOf<PublishingAccount?>(null) }
    var isLoadingPublishingAccount by remember { mutableStateOf(false) }
    var publishingError by remember { mutableStateOf<String?>(null) }
    var showPublishingDialog by remember { mutableStateOf(false) }
    var adminUsersResult by remember { mutableStateOf<AdminUsersResult?>(null) }
    var isLoadingAdminUsers by remember { mutableStateOf(false) }
    var adminError by remember { mutableStateOf<String?>(null) }
    var showAdminInviteDialog by remember { mutableStateOf(false) }
    var adminInviteResult by remember { mutableStateOf<AdminInviteResult?>(null) }
    val lastSyncAtMs by remember(preferences) {
        preferences.lastSyncAtMsFlow()
    }.collectAsState(initial = preferences.lastSyncAtMs)
    var lastTestedConfig by remember {
        mutableStateOf(SettingsConnectionConfig(apiBaseUrl, accessToken).normalized())
    }
    var customStyleProfiles by remember { mutableStateOf(preferences.customWritingStyleProfiles) }
    var remoteStyleProfiles by remember { mutableStateOf(preferences.remoteWritingStyleProfiles) }
    var styleSourceImports by remember { mutableStateOf<List<StyleSourceImportSummary>>(emptyList()) }
    var isLoadingStyleSources by remember { mutableStateOf(false) }
    var isDistillingStyleProfile by remember { mutableStateOf(false) }
    var isDistillingStyleLink by remember { mutableStateOf(false) }
    var styleDistillationError by remember { mutableStateOf<String?>(null) }
    var styleLinkDistillationError by remember { mutableStateOf<String?>(null) }
    var selectedStyleProfileId by remember { mutableStateOf(preferences.selectedStyleProfileId) }
    var showWritingStyleDialog by remember { mutableStateOf(false) }
    var showWritingStylePromptDialog by remember { mutableStateOf(false) }
    var isLoadingWritingStylePrompt by remember { mutableStateOf(false) }
    var writingStylePromptError by remember { mutableStateOf<String?>(null) }
    var showCustomStyleDialog by remember { mutableStateOf(false) }
    var showStyleDistillationDialog by remember { mutableStateOf(false) }
    var showStyleLinkDistillationDialog by remember { mutableStateOf(false) }
    var editingCustomStyleProfile by remember { mutableStateOf<WritingStyleProfileOption?>(null) }
    var voiceStyleTurnText by remember { mutableStateOf("") }
    val visibleRemoteStyleProfiles = remoteStyleProfiles.filter { remoteProfile ->
        WritingStyleProfiles.findById(remoteProfile.id, customStyleProfiles) == null
    }
    val selectedStyleProfile = WritingStyleProfiles.optionFor(
        selectedStyleProfileId,
        customStyleProfiles,
        remoteStyleProfiles,
    )
    val speechInputLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val recognizedText = extractSpeechRecognitionText(result.resultCode, result.data)
        if (recognizedText.isNotBlank()) {
            voiceStyleTurnText = recognizedText
        } else {
            Toast.makeText(context, "没有识别到风格偏好", Toast.LENGTH_SHORT).show()
        }
    }
    fun selectRemoteStyleProfile(profile: WritingStyleProfileOption) {
        preferences.upsertAndSelectRemoteWritingStyleProfile(profile)
        remoteStyleProfiles = preferences.remoteWritingStyleProfiles
        selectedStyleProfileId = profile.id
    }
    fun showPromptForCurrentStyle() {
        writingStylePromptError = null
        showWritingStylePromptDialog = true
        val profile = selectedStyleProfile
        if (!shouldFetchStylePrompt(profile, accessToken) || isLoadingWritingStylePrompt) {
            return
        }
        isLoadingWritingStylePrompt = true
        scope.launch {
            runCatching {
                WritingStyleApi.getStyleProfile(
                    apiBaseUrl = apiBaseUrl,
                    filesToken = accessToken,
                    profileId = profile.id,
                    includeBody = true,
                )
            }.onSuccess { loadedProfile ->
                preferences.upsertRemoteWritingStyleProfile(loadedProfile)
                remoteStyleProfiles = preferences.remoteWritingStyleProfiles
            }.onFailure { error ->
                writingStylePromptError = error.message ?: "提示词加载失败"
            }
            isLoadingWritingStylePrompt = false
        }
    }

    LaunchedEffect(apiBaseUrl, accessToken) {
        val currentConfig = SettingsConnectionConfig(apiBaseUrl, accessToken).normalized()
        if (!shouldAutoTestSettingsConnection(lastTestedConfig, currentConfig)) {
            return@LaunchedEffect
        }
        delay(SETTINGS_AUTO_CONNECTION_TEST_DELAY_MS)
        isTesting = true
        connectionResult = null
        try {
            connectionResult = testBackendConnection(currentConfig.apiBaseUrl, currentConfig.accessToken)
            lastTestedConfig = currentConfig
        } finally {
            isTesting = false
        }
    }

    LaunchedEffect(apiBaseUrl, accessToken) {
        if (accessToken.isBlank()) {
            styleSourceImports = emptyList()
            return@LaunchedEffect
        }
        runCatching {
            WritingStyleApi.listStyleProfiles(apiBaseUrl, accessToken)
        }.onSuccess { profiles ->
            remoteStyleProfiles = profiles
            preferences.remoteWritingStyleProfiles = profiles
        }
        runCatching {
            WritingStyleApi.listStyleSources(apiBaseUrl, accessToken)
        }.onSuccess { sources ->
            styleSourceImports = sources
        }
    }

    LaunchedEffect(apiBaseUrl, accessToken) {
        if (accessToken.isBlank()) return@LaunchedEffect
        runCatching {
            AuthApi.me(apiBaseUrl, accessToken)
        }.onSuccess { user ->
            preferences.updateCurrentUser(user)
            accountEmail = user.email
            accountRole = user.role
            accountEmailVerified = user.emailVerified
        }
        isLoadingPublishingAccount = true
        publishingError = null
        runCatching {
            AuthApi.getPublishingAccount(apiBaseUrl, accessToken)
        }.onSuccess { account ->
            publishingAccount = account
        }.onFailure { error ->
            publishingError = error.message ?: "公众号配置读取失败"
        }
        isLoadingPublishingAccount = false
    }

    LaunchedEffect(apiBaseUrl, accessToken, accountRole) {
        if (accessToken.isBlank() || accountRole != "admin") return@LaunchedEffect
        isLoadingAdminUsers = true
        adminError = null
        runCatching {
            AuthApi.listAdminUsers(apiBaseUrl, accessToken)
        }.onSuccess { result ->
            adminUsersResult = result
        }.onFailure { error ->
            adminError = error.message ?: "用户列表读取失败"
        }
        isLoadingAdminUsers = false
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("设置", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = onBackClick) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background,
                ),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            item {
                Spacer(modifier = Modifier.height(4.dp))
                SettingsGroup(title = "账号与安全") {
                    SettingsItem(
                        iconContent = { SettingsIcon(Color(0xFFEAF2FF)) { Icon(Icons.Default.AccountCircle, contentDescription = null, tint = Color(0xFF2762C7)) } },
                        title = accountEmail.ifBlank { "未登录账号" },
                        subtitle = "角色：${accountRoleLabel(accountRole)}",
                        value = if (accountEmailVerified) "已验证" else "未验证",
                        valueColor = if (accountEmailVerified) Color(0xFF2E7D32) else Color(0xFFC62828),
                        modifier = Modifier.testTag("AccountSummaryItem"),
                        onClick = {},
                    )
                    Divider(color = MaterialTheme.colorScheme.background, thickness = 1.dp, modifier = Modifier.padding(start = 64.dp))
                    SettingsItem(
                        iconContent = { SettingsIcon(Color(0xFFEAF7EF)) { Icon(Icons.Default.MarkEmailRead, contentDescription = null, tint = Color(0xFF188A4B)) } },
                        title = "邮箱认证",
                        subtitle = if (accountEmailVerified) "可以上传录音、生成风格和发布草稿" else "完成认证前不能上传或发布",
                        value = if (accountEmailVerified) "可用" else "受限",
                        valueColor = if (accountEmailVerified) Color(0xFF2E7D32) else Color(0xFFC62828),
                        onClick = {},
                    )
                    Divider(color = MaterialTheme.colorScheme.background, thickness = 1.dp, modifier = Modifier.padding(start = 64.dp))
                    SettingsItem(
                        iconContent = { SettingsIcon(Color(0xFFFDECEA)) { Icon(Icons.Default.Logout, contentDescription = null, tint = Color(0xFFC62828)) } },
                        title = "退出登录",
                        subtitle = "本机保留各账号本地记录，切换后只显示当前账号内容",
                        value = null,
                        onClick = {
                            val oldAccessToken = accessToken
                            val oldRefreshToken = preferences.refreshToken
                            preferences.clearAuthSession()
                            accessToken = ""
                            accountEmail = ""
                            accountRole = "user"
                            accountEmailVerified = false
                            scope.launch {
                                runCatching {
                                    AuthApi.logout(apiBaseUrl, oldAccessToken, oldRefreshToken)
                                }
                            }
                        },
                    )
                }
            }

            item {
                SettingsGroup(title = "连接诊断") {
                    OutlinedTextField(
                        value = apiBaseUrl,
                        onValueChange = {
                            apiBaseUrl = it
                            preferences.apiBaseUrl = it
                            connectionResult = null
                        },
                        label = { Text("API Base URL") },
                        singleLine = true,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp)
                            .testTag("ApiBaseUrlField"),
                        leadingIcon = { Icon(Icons.Default.Link, contentDescription = null) },
                    )
                    Divider(color = MaterialTheme.colorScheme.background, thickness = 1.dp)
                    Column(modifier = Modifier.padding(16.dp)) {
                        Button(
                            onClick = {
                                isTesting = true
                                connectionResult = null
                                val currentConfig = SettingsConnectionConfig(apiBaseUrl, accessToken).normalized()
                                scope.launch {
                                    connectionResult = testBackendConnection(currentConfig.apiBaseUrl, currentConfig.accessToken)
                                    lastTestedConfig = currentConfig
                                    isTesting = false
                                }
                            },
                            modifier = Modifier.testTag("TestBackendButton"),
                        ) {
                            Icon(Icons.Default.CloudDone, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("测试后端连接")
                        }
                        if (isTesting) {
                            Spacer(modifier = Modifier.height(10.dp))
                            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                        }
                        connectionResult?.let { result ->
                            Spacer(modifier = Modifier.height(10.dp))
                            ConnectionResultCard(result = result)
                        }
                    }
                }
            }

            item {
                SettingsGroup(title = "写作风格") {
                    CurrentStyleTemplateItem(
                        profile = selectedStyleProfile,
                        modifier = Modifier.testTag("WritingStyleProfileItem"),
                        onClick = { showWritingStyleDialog = true },
                        onLongClick = { showPromptForCurrentStyle() },
                    )
                    Divider(color = MaterialTheme.colorScheme.background, thickness = 1.dp, modifier = Modifier.padding(start = 64.dp))
                    Text(
                        "创建模板",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.padding(start = 16.dp, top = 14.dp, bottom = 2.dp),
                    )
                    SettingsItem(
                        iconContent = { SettingsIcon(Color(0xFFEAF7EF)) { Icon(Icons.Default.Link, contentDescription = null, tint = Color(0xFF188A4B)) } },
                        title = "微信文章链接",
                        subtitle = "单篇公众号文章",
                        value = styleLinkDistillationValue(isDistillingStyleLink),
                        valueColor = Color(0xFF188A4B),
                        modifier = Modifier.testTag("StyleLinkDistillationItem"),
                        onClick = {
                            if (!preferences.canUseCloudFeatures) {
                                Toast.makeText(context, "请先登录并完成邮箱验证", Toast.LENGTH_SHORT).show()
                            } else {
                                styleLinkDistillationError = null
                                showStyleLinkDistillationDialog = true
                            }
                        },
                    )
                    Divider(color = MaterialTheme.colorScheme.background, thickness = 1.dp, modifier = Modifier.padding(start = 64.dp))
                    SettingsItem(
                        iconContent = { SettingsIcon(Color(0xFFFFF4E5)) { Icon(Icons.Default.Edit, contentDescription = null, tint = Color(0xFFB15F00)) } },
                        title = "手写提示词",
                        subtitle = "自定义规则",
                        value = manualStyleTemplateValue(customStyleProfiles.size),
                        onClick = {
                            editingCustomStyleProfile = customStyleProfiles.firstOrNull()
                            voiceStyleTurnText = ""
                            showCustomStyleDialog = true
                        },
                    )
                    Divider(color = MaterialTheme.colorScheme.background, thickness = 1.dp, modifier = Modifier.padding(start = 64.dp))
                    SettingsItem(
                        iconContent = { SettingsIcon(Color(0xFFEAF2FF)) { Icon(Icons.Default.Sync, contentDescription = null, tint = Color(0xFF2762C7)) } },
                        title = "多素材蒸馏",
                        subtitle = sourceDistillationSubtitle(styleSourceImports.size),
                        value = sourceDistillationValue(
                            sourceCount = styleSourceImports.size,
                            isLoading = isLoadingStyleSources,
                            isSubmitting = isDistillingStyleProfile,
                        ),
                        valueColor = Color(0xFF2762C7),
                        modifier = Modifier.testTag("StyleDistillationItem"),
                        onClick = {
                            if (!preferences.canUseCloudFeatures) {
                                Toast.makeText(context, "请先登录并完成邮箱验证", Toast.LENGTH_SHORT).show()
                            } else if (styleSourceImports.isEmpty()) {
                                isLoadingStyleSources = true
                                scope.launch {
                                    runCatching {
                                        WritingStyleApi.listStyleSources(apiBaseUrl, accessToken)
                                    }.onSuccess { sources ->
                                        styleSourceImports = sources
                                        if (sources.isEmpty()) {
                                            Toast.makeText(context, "先把参考文章或文本分享给 VibePub", Toast.LENGTH_SHORT).show()
                                        } else {
                                            showStyleDistillationDialog = true
                                        }
                                    }.onFailure { error ->
                                        Toast.makeText(context, error.message ?: "风格素材同步失败", Toast.LENGTH_SHORT).show()
                                    }
                                    isLoadingStyleSources = false
                                }
                            } else {
                                styleDistillationError = null
                                showStyleDistillationDialog = true
                            }
                        },
                    )
                    if (isLoadingStyleSources || isDistillingStyleProfile || isDistillingStyleLink) {
                        LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    }
                }
            }

            item {
                SettingsGroup(title = "公众号发布") {
                    SettingsItem(
                        iconContent = { SettingsIcon(Color(0xFFEAF7EF)) { Icon(Icons.Default.CheckCircle, contentDescription = null, tint = Color(0xFF2E7D32)) } },
                        title = "微信公众号草稿",
                        subtitle = publishingAccountSubtitle(publishingAccount, publishingError, isLoadingPublishingAccount),
                        value = publishingAccountValue(publishingAccount, isLoadingPublishingAccount),
                        valueColor = if (publishingAccount?.connected == true) Color(0xFF2E7D32) else Color(0xFFB15F00),
                        modifier = Modifier.testTag("PublishingAccountItem"),
                        onClick = {
                            if (!preferences.canUseCloudFeatures) {
                                Toast.makeText(context, "请先登录并完成邮箱验证", Toast.LENGTH_SHORT).show()
                            } else {
                                showPublishingDialog = true
                            }
                        },
                    )
                }
            }

            if (accountRole == "admin") {
                item {
                    SettingsGroup(title = "用户管理") {
                        SettingsItem(
                            iconContent = { SettingsIcon(Color(0xFFEAF2FF)) { Icon(Icons.Default.AdminPanelSettings, contentDescription = null, tint = Color(0xFF2762C7)) } },
                            title = "邀请用户",
                            subtitle = adminUsersSubtitle(adminUsersResult, adminError, isLoadingAdminUsers),
                            value = adminUsersValue(adminUsersResult, isLoadingAdminUsers),
                            modifier = Modifier.testTag("AdminUsersItem"),
                            onClick = { showAdminInviteDialog = true },
                        )
                        adminInviteResult?.let { invite ->
                            Divider(color = MaterialTheme.colorScheme.background, thickness = 1.dp, modifier = Modifier.padding(start = 64.dp))
                            SettingsItem(
                                iconContent = { SettingsIcon(Color(0xFFEAF7EF)) { Icon(Icons.Default.Send, contentDescription = null, tint = Color(0xFF188A4B)) } },
                                title = invite.email,
                                subtitle = invite.inviteUrl ?: invite.token ?: "邀请已发送",
                                value = accountRoleLabel(invite.role),
                                onClick = {
                                    val inviteText = invite.inviteUrl ?: invite.token.orEmpty()
                                    if (inviteText.isNotBlank()) {
                                        copyPlainText(context, "VibePub 邀请", inviteText)
                                    }
                                },
                            )
                        }
                    }
                }
            }

            item {
                SettingsGroup(title = "同步") {
                    SettingsItem(
                        iconContent = { SettingsIcon(Color(0xFFEAF2FF)) { Icon(Icons.Default.Sync, contentDescription = null, tint = Color(0xFF2762C7)) } },
                        title = "最近同步",
                        subtitle = settingsLastSyncDetail(lastSyncAtMs),
                        value = settingsLastSyncValue(lastSyncAtMs),
                        modifier = Modifier.testTag("SettingsLastSyncItem"),
                        onClick = {},
                    )
                }
            }

            item {
                SettingsGroup(title = "诊断") {
                    SettingsItem(
                        iconContent = { SettingsIcon(Color(0xFFF2F2F7)) { Icon(Icons.Default.BugReport, contentDescription = null) } },
                        title = "诊断信息",
                        subtitle = "设备、版本、最近同步和最近录音",
                        modifier = Modifier.testTag("DiagnosticsItem"),
                        onClick = {
                            scope.launch {
                                diagnostics = buildDiagnostics(context, preferences)
                                showDiagnostics = true
                            }
                        },
                    )
                    Divider(color = MaterialTheme.colorScheme.background, thickness = 1.dp, modifier = Modifier.padding(start = 64.dp))
                    SettingsItem(
                        iconContent = { SettingsIcon(Color(0xFFF2F2F7)) { Icon(Icons.Default.ContentCopy, contentDescription = null) } },
                        title = "版本",
                        subtitle = "VibePub ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
                        value = "Android",
                        onClick = {},
                    )
                }
            }
        }
    }

    if (showDiagnostics) {
        DiagnosticsDialog(
            diagnostics = diagnostics,
            onDismiss = { showDiagnostics = false },
            onCopy = { copyDiagnostics(context, diagnostics) },
        )
    }

    if (showWritingStylePromptDialog) {
        WritingStylePromptDialog(
            profile = selectedStyleProfile,
            isLoading = isLoadingWritingStylePrompt,
            errorMessage = writingStylePromptError,
            onDismiss = { showWritingStylePromptDialog = false },
            onCopy = { copyWritingStylePrompt(context, selectedStyleProfile) },
        )
    }

    if (showWritingStyleDialog) {
        WritingStyleProfileDialog(
            selectedProfileId = selectedStyleProfile.id,
            profiles = WritingStyleProfiles.builtIn + customStyleProfiles + visibleRemoteStyleProfiles,
            onSelect = { profile ->
                selectedStyleProfileId = profile.id
                preferences.selectedStyleProfileId = profile.id
                preferences.selectedStyleProfileVersion = profile.version
                preferences.selectedLayoutProfileId = WritingStyleProfiles.DEFAULT_LAYOUT_PROFILE_ID
                preferences.selectedLayoutProfileVersion = WritingStyleProfiles.DEFAULT_LAYOUT_PROFILE_VERSION
                showWritingStyleDialog = false
            },
            onDismiss = { showWritingStyleDialog = false },
        )
    }

    if (showCustomStyleDialog) {
        CustomWritingStyleDialog(
            profile = editingCustomStyleProfile,
            voiceTurnText = voiceStyleTurnText,
            onVoiceTurnConsumed = { voiceStyleTurnText = "" },
            onStartVoiceTurn = {
                runCatching {
                    speechInputLauncher.launch(styleProfileSpeechIntent())
                }.onFailure {
                    Toast.makeText(context, "当前设备没有可用的语音识别服务", Toast.LENGTH_SHORT).show()
                }
            },
            onDismiss = { showCustomStyleDialog = false },
            onSave = { profile ->
                preferences.upsertCustomWritingStyleProfile(profile)
                customStyleProfiles = preferences.customWritingStyleProfiles
                selectedStyleProfileId = profile.id
                preferences.selectedStyleProfileId = profile.id
                preferences.selectedStyleProfileVersion = profile.version
                preferences.selectedLayoutProfileId = WritingStyleProfiles.DEFAULT_LAYOUT_PROFILE_ID
                preferences.selectedLayoutProfileVersion = WritingStyleProfiles.DEFAULT_LAYOUT_PROFILE_VERSION
                showCustomStyleDialog = false
            },
        )
    }

    if (showPublishingDialog) {
        PublishingAccountDialog(
            account = publishingAccount,
            isSubmitting = isLoadingPublishingAccount,
            errorMessage = publishingError,
            onDismiss = {
                if (!isLoadingPublishingAccount) showPublishingDialog = false
            },
            onSave = { appId, appSecret, proxyUrl ->
                isLoadingPublishingAccount = true
                publishingError = null
                scope.launch {
                    runCatching {
                        AuthApi.updatePublishingAccount(
                            apiBaseUrl = apiBaseUrl,
                            accessToken = accessToken,
                            appId = appId,
                            appSecret = appSecret,
                            proxyUrl = proxyUrl,
                        )
                    }.onSuccess { account ->
                        publishingAccount = account
                        showPublishingDialog = false
                        Toast.makeText(context, "公众号配置已保存", Toast.LENGTH_SHORT).show()
                    }.onFailure { error ->
                        publishingError = error.message ?: "公众号配置保存失败"
                    }
                    isLoadingPublishingAccount = false
                }
            },
        )
    }

    if (showAdminInviteDialog) {
        AdminInviteDialog(
            isSubmitting = isLoadingAdminUsers,
            errorMessage = adminError,
            onDismiss = {
                if (!isLoadingAdminUsers) showAdminInviteDialog = false
            },
            onInvite = { email, role ->
                isLoadingAdminUsers = true
                adminError = null
                scope.launch {
                    runCatching {
                        AuthApi.inviteUser(
                            apiBaseUrl = apiBaseUrl,
                            accessToken = accessToken,
                            email = email,
                            role = role,
                        )
                    }.onSuccess { invite ->
                        adminInviteResult = invite
                        adminUsersResult = runCatching {
                            AuthApi.listAdminUsers(apiBaseUrl, accessToken)
                        }.getOrNull() ?: adminUsersResult
                        showAdminInviteDialog = false
                        Toast.makeText(context, "邀请已创建", Toast.LENGTH_SHORT).show()
                    }.onFailure { error ->
                        adminError = error.message ?: "邀请用户失败"
                    }
                    isLoadingAdminUsers = false
                }
            },
        )
    }

    if (showStyleDistillationDialog) {
        StyleDistillationDialog(
            sources = styleSourceImports,
            isSubmitting = isDistillingStyleProfile,
            errorMessage = styleDistillationError,
            onDismiss = {
                if (!isDistillingStyleProfile) showStyleDistillationDialog = false
            },
            onDistill = { name, description ->
                isDistillingStyleProfile = true
                styleDistillationError = null
                scope.launch {
                    runCatching {
	                        WritingStyleApi.distillStyleProfile(
	                            apiBaseUrl = apiBaseUrl,
	                            filesToken = accessToken,
                            sourceImportIds = styleSourceImports.map { it.id },
                            profileId = null,
                            name = name,
                            description = description,
                        )
                    }.onSuccess { result ->
                        selectRemoteStyleProfile(result.profile)
                        showStyleDistillationDialog = false
                        Toast.makeText(context, "已生成并选中云端风格画像", Toast.LENGTH_SHORT).show()
                    }.onFailure { error ->
                        styleDistillationError = error.message ?: "风格画像生成失败"
                    }
                    isDistillingStyleProfile = false
                }
            },
        )
    }

    if (showStyleLinkDistillationDialog) {
        StyleLinkDistillationDialog(
            isSubmitting = isDistillingStyleLink,
            errorMessage = styleLinkDistillationError,
            onDismiss = {
                if (!isDistillingStyleLink) showStyleLinkDistillationDialog = false
            },
            onSubmit = { link, name, description ->
                isDistillingStyleLink = true
                styleLinkDistillationError = null
                scope.launch {
                    runCatching {
                        val sourceType = if (link.contains("mp.weixin.qq.com")) "wechat_article" else "url"
	                        val imported = WritingStyleApi.importStyleSource(
	                            apiBaseUrl = apiBaseUrl,
	                            filesToken = accessToken,
                            sourceType = sourceType,
                            title = null,
                            url = link,
                            text = null,
                        )
	                        WritingStyleApi.distillStyleProfile(
	                            apiBaseUrl = apiBaseUrl,
	                            filesToken = accessToken,
                            sourceImportIds = listOf(imported.id),
                            profileId = null,
                            name = name.takeIf { it.isNotBlank() },
                            description = description.takeIf { it.isNotBlank() },
                        )
                    }.onSuccess { result ->
                        selectRemoteStyleProfile(result.profile)
	                        runCatching {
	                            WritingStyleApi.listStyleSources(apiBaseUrl, accessToken)
                        }.onSuccess { sources ->
                            styleSourceImports = sources
                        }
                        showStyleLinkDistillationDialog = false
                        Toast.makeText(context, "已生成并选中风格模板：${result.profile.name}", Toast.LENGTH_LONG).show()
                    }.onFailure { error ->
                        styleLinkDistillationError = error.message ?: "微信链接风格生成失败"
                    }
                    isDistillingStyleLink = false
                }
            },
        )
    }
}

@Composable
internal fun WritingStylePromptDialog(
    profile: WritingStyleProfileOption,
    isLoading: Boolean,
    errorMessage: String?,
    onDismiss: () -> Unit,
    onCopy: () -> Unit,
) {
    val promptText = if (isLoading && profile.body.isNullOrBlank()) {
        "正在加载完整提示词…"
    } else {
        stylePromptDisplayText(profile)
    }
    AlertDialog(
        modifier = Modifier.testTag("WritingStylePromptDialog"),
        onDismissRequest = onDismiss,
        title = { Text("写作风格提示词") },
        text = {
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    profile.name,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.SemiBold,
                )
                if (profile.description.isNotBlank()) {
                    Text(
                        profile.description,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (isLoading) {
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                }
                errorMessage?.let {
                    Text(
                        it,
                        color = Color(0xFFC62828),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                SelectionContainer {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(max = 420.dp)
                            .verticalScroll(rememberScrollState())
                            .testTag("WritingStylePromptText"),
                    ) {
                        Text(
                            promptText,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text("关闭")
            }
        },
        dismissButton = {
            TextButton(onClick = onCopy) {
                Text("复制")
            }
        },
    )
}

@Composable
internal fun WritingStyleProfileDialog(
    selectedProfileId: String,
    profiles: List<WritingStyleProfileOption>,
    onSelect: (WritingStyleProfileOption) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        modifier = Modifier.testTag("WritingStyleProfileDialog"),
        onDismissRequest = onDismiss,
        title = { Text("选择写作风格") },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 420.dp)
                    .verticalScroll(rememberScrollState()),
            ) {
                profiles.forEach { profile ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onSelect(profile) }
                            .padding(vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(
                            selected = profile.id == selectedProfileId,
                            onClick = { onSelect(profile) },
                        )
                        Spacer(modifier = Modifier.width(10.dp))
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                profile.name,
                                style = MaterialTheme.typography.bodyLarge,
                                fontWeight = FontWeight.SemiBold,
                            )
                            Spacer(modifier = Modifier.height(2.dp))
                            Text(
                                profile.description,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text("关闭")
            }
        },
    )
}

@Composable
internal fun StyleDistillationDialog(
    sources: List<StyleSourceImportSummary>,
    isSubmitting: Boolean,
    errorMessage: String?,
    onDismiss: () -> Unit,
    onDistill: (String, String) -> Unit,
) {
    var name by remember { mutableStateOf("我的旧文风格") }
    var description by remember { mutableStateOf("从分享给 VibePub 的参考素材提取。") }
    AlertDialog(
        modifier = Modifier.testTag("StyleDistillationDialog"),
        onDismissRequest = onDismiss,
        title = { Text("生成云端风格画像") },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 460.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("画像名称") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = description,
                    onValueChange = { description = it },
                    label = { Text("一句话说明") },
                    minLines = 2,
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    "素材 ${sources.size} 条",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                sources.take(8).forEach { source ->
                    Column(modifier = Modifier.fillMaxWidth()) {
                        Text(
                            styleSourceDisplayTitle(source),
                            style = MaterialTheme.typography.bodySmall,
                            fontWeight = FontWeight.Medium,
                        )
                        Text(
                            styleSourceTypeLabel(source.sourceType),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                if (sources.size > 8) {
                    Text(
                        "另有 ${sources.size - 8} 条素材",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                errorMessage?.let {
                    Text(
                        it,
                        color = Color(0xFFC62828),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !isSubmitting && sources.isNotEmpty(),
                onClick = { onDistill(name, description) },
            ) {
                Text(if (isSubmitting) "生成中" else "生成并使用")
            }
        },
        dismissButton = {
            TextButton(
                enabled = !isSubmitting,
                onClick = onDismiss,
            ) {
                Text("取消")
            }
        },
    )
}

internal fun styleSourceDisplayTitle(source: StyleSourceImportSummary): String {
    return source.title.cleanStyleSourceValue()
        ?: source.textPreview.cleanStyleSourceValue()
        ?: when (source.sourceType.trim().lowercase()) {
            "wechat_article" -> "微信文章素材"
            "url", "webpage", "html" -> "网页素材"
            "text" -> "文本素材"
            else -> "风格素材"
        }
}

internal fun styleSourceTypeLabel(sourceType: String): String {
    return when (sourceType.trim().lowercase()) {
        "wechat_article" -> "微信文章"
        "url", "webpage", "html" -> "网页"
        "text" -> "文本"
        else -> sourceType.trim().ifBlank { "素材" }
    }
}

private fun String?.cleanStyleSourceValue(): String? {
    val normalized = this
        ?.lineSequence()
        ?.map { it.trim() }
        ?.firstOrNull { it.isNotBlank() }
        .orEmpty()
    if (normalized.isBlank()) return null
    val lower = normalized.lowercase()
    if (lower == "null" || lower == "(null)" || lower == "undefined") return null
    if (lower.startsWith("http://") || lower.startsWith("https://")) return null
    if (lower.startsWith("来源 url：") || lower.startsWith("来源 url:")) return null
    if (lower.startsWith("标题：null") || lower.startsWith("标题:null")) return null
    return normalized
}

@Composable
internal fun StyleLinkDistillationDialog(
    isSubmitting: Boolean,
    errorMessage: String?,
    onDismiss: () -> Unit,
    onSubmit: (String, String, String) -> Unit,
) {
    var link by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    val normalizedLink = link.trim()
    AlertDialog(
        modifier = Modifier.testTag("StyleLinkDistillationDialog"),
        onDismissRequest = onDismiss,
        title = { Text("微信链接生成风格") },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 420.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                OutlinedTextField(
                    value = link,
                    onValueChange = { link = it },
                    label = { Text("微信文章链接") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("模板名称") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = description,
                    onValueChange = { description = it },
                    label = { Text("一句话说明") },
                    minLines = 2,
                    modifier = Modifier.fillMaxWidth(),
                )
                errorMessage?.let {
                    Text(
                        it,
                        color = Color(0xFFC62828),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !isSubmitting && isSupportedStyleLink(normalizedLink),
                onClick = { onSubmit(normalizedLink, name.trim(), description.trim()) },
            ) {
                Text(if (isSubmitting) "生成中" else "生成")
            }
        },
        dismissButton = {
            TextButton(enabled = !isSubmitting, onClick = onDismiss) {
                Text("取消")
            }
        },
    )
}

internal fun isSupportedStyleLink(value: String): Boolean {
    val normalized = value.trim()
    return normalized.startsWith("https://") || normalized.startsWith("http://")
}

@Composable
internal fun CustomWritingStyleDialog(
    profile: WritingStyleProfileOption?,
    voiceTurnText: String,
    onVoiceTurnConsumed: () -> Unit,
    onStartVoiceTurn: () -> Unit,
    onDismiss: () -> Unit,
    onSave: (WritingStyleProfileOption) -> Unit,
) {
    var name by remember(profile?.id) { mutableStateOf(profile?.name.orEmpty().ifBlank { "我的写作风格" }) }
    var description by remember(profile?.id) { mutableStateOf(profile?.description.orEmpty()) }
    var body by remember(profile?.id) { mutableStateOf(profile?.body.orEmpty()) }
    var turnText by remember(profile?.id) { mutableStateOf("") }

    LaunchedEffect(voiceTurnText) {
        if (voiceTurnText.isNotBlank()) {
            turnText = voiceTurnText
            body = WritingStyleProfiles.mergeStylePromptTurn(body, voiceTurnText)
            onVoiceTurnConsumed()
        }
    }

    AlertDialog(
        modifier = Modifier.testTag("CustomWritingStyleDialog"),
        onDismissRequest = onDismiss,
        title = { Text(if (profile == null) "新增提示词模板" else "编辑提示词模板") },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 520.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("模板名称") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = description,
                    onValueChange = { description = it },
                    label = { Text("一句话说明") },
                    minLines = 2,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = turnText,
                    onValueChange = { turnText = it },
                    label = { Text("这一轮偏好") },
                    minLines = 2,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedButton(onClick = onStartVoiceTurn) {
                        Icon(Icons.Default.Mic, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("说一轮")
                    }
                    Button(
                        onClick = {
                            body = WritingStyleProfiles.mergeStylePromptTurn(body, turnText)
                            turnText = ""
                        },
                    ) {
                        Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("更新提示词")
                    }
                }
                OutlinedTextField(
                    value = body,
                    onValueChange = { body = WritingStyleProfiles.trimCustomProfileBody(it) },
                    label = { Text("完整写作风格提示词") },
                    minLines = 8,
                    supportingText = {
                        Text("${body.length}/${WritingStyleProfiles.MAX_CUSTOM_PROFILE_BODY_CHARS}")
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    val normalizedBody = WritingStyleProfiles.trimCustomProfileBody(body)
                    onSave(
                        WritingStyleProfileOption(
                            id = profile?.id ?: "custom_style_${System.currentTimeMillis()}",
                            version = WritingStyleProfiles.customProfileVersion(),
                            name = name.trim().ifBlank { "我的写作风格" },
                            description = description.trim(),
                            body = normalizedBody,
                            custom = true,
                        ),
                    )
                },
                enabled = body.trim().isNotBlank(),
            ) {
                Text("保存并使用")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("取消")
            }
        },
    )
}

@Composable
internal fun PublishingAccountDialog(
    account: PublishingAccount?,
    isSubmitting: Boolean,
    errorMessage: String?,
    onDismiss: () -> Unit,
    onSave: (String, String, String) -> Unit,
) {
    var appId by remember(account?.appId) { mutableStateOf(account?.appId.orEmpty()) }
    var appSecret by remember { mutableStateOf("") }
    var proxyUrl by remember(account?.proxyUrl) { mutableStateOf(account?.proxyUrl.orEmpty()) }
    val requiresSecret = account?.connected != true
    AlertDialog(
        modifier = Modifier.testTag("PublishingAccountDialog"),
        onDismissRequest = onDismiss,
        title = { Text("公众号发布配置") },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 420.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                OutlinedTextField(
                    value = appId,
                    onValueChange = { appId = it },
                    label = { Text("App ID") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = appSecret,
                    onValueChange = { appSecret = it },
                    label = { Text(if (requiresSecret) "App Secret" else "App Secret（留空则沿用云端密钥）") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = proxyUrl,
                    onValueChange = { proxyUrl = it },
                    label = { Text("Proxy URL") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                errorMessage?.let {
                    Text(
                        it,
                        color = Color(0xFFC62828),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !isSubmitting && appId.trim().isNotBlank() && (!requiresSecret || appSecret.trim().isNotBlank()),
                onClick = { onSave(appId.trim(), appSecret.trim(), proxyUrl.trim()) },
            ) {
                Text(if (isSubmitting) "保存中" else "保存")
            }
        },
        dismissButton = {
            TextButton(enabled = !isSubmitting, onClick = onDismiss) {
                Text("取消")
            }
        },
    )
}

@Composable
internal fun AdminInviteDialog(
    isSubmitting: Boolean,
    errorMessage: String?,
    onDismiss: () -> Unit,
    onInvite: (String, String) -> Unit,
) {
    var email by remember { mutableStateOf("") }
    var role by remember { mutableStateOf("user") }
    AlertDialog(
        modifier = Modifier.testTag("AdminInviteDialog"),
        onDismissRequest = onDismiss,
        title = { Text("邀请用户") },
        text = {
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    label = { Text("邮箱") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(
                        selected = role == "user",
                        onClick = { role = "user" },
                    )
                    Text("普通用户")
                    Spacer(modifier = Modifier.width(16.dp))
                    RadioButton(
                        selected = role == "admin",
                        onClick = { role = "admin" },
                    )
                    Text("管理员")
                }
                errorMessage?.let {
                    Text(
                        it,
                        color = Color(0xFFC62828),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !isSubmitting && email.trim().contains("@"),
                onClick = { onInvite(email.trim(), role) },
            ) {
                Text(if (isSubmitting) "邀请中" else "发送邀请")
            }
        },
        dismissButton = {
            TextButton(enabled = !isSubmitting, onClick = onDismiss) {
                Text("取消")
            }
        },
    )
}

@Composable
internal fun DiagnosticsDialog(
    diagnostics: String,
    onDismiss: () -> Unit,
    onCopy: () -> Unit,
) {
    AlertDialog(
        modifier = Modifier.testTag("DiagnosticsDialog"),
        onDismissRequest = onDismiss,
        title = { Text("诊断信息") },
        text = {
            Text(
                diagnostics,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 420.dp)
                    .verticalScroll(rememberScrollState())
                    .testTag("DiagnosticsDialogText"),
            )
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text("关闭")
            }
        },
        dismissButton = {
            TextButton(onClick = onCopy) {
                Text("复制诊断")
            }
        },
    )
}

@Composable
private fun ConnectionResultCard(result: ConnectionTestResult) {
    val accent = if (result.success) Color(0xFF2E7D32) else Color(0xFFC62828)
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .testTag("ConnectionResultCard"),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.background),
        shape = RoundedCornerShape(10.dp),
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    imageVector = if (result.success) Icons.Default.CheckCircle else Icons.Default.Error,
                    contentDescription = null,
                    tint = accent,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    result.summary,
                    color = accent,
                    fontWeight = FontWeight.SemiBold,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            Spacer(modifier = Modifier.height(8.dp))
            result.checks.forEach { item ->
                ConnectionCheckRow(item = item)
            }
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                result.nextAction,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
private fun ConnectionCheckRow(item: ConnectionCheckItem) {
    val color = when (item.state) {
        ConnectionCheckState.PASSED -> Color(0xFF2E7D32)
        ConnectionCheckState.FAILED -> Color(0xFFC62828)
        ConnectionCheckState.SKIPPED -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 3.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            text = when (item.state) {
                ConnectionCheckState.PASSED -> "通过"
                ConnectionCheckState.FAILED -> "失败"
                ConnectionCheckState.SKIPPED -> "跳过"
            },
            color = color,
            style = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.width(44.dp),
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(item.label, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
            Text(item.detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
fun SettingsGroup(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column {
        if (title.isNotEmpty()) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 16.dp, bottom = 8.dp),
            )
        }
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            shape = RoundedCornerShape(12.dp),
        ) {
            Column(content = content)
        }
    }
}

@Composable
fun SettingsItem(
    iconContent: @Composable () -> Unit,
    title: String,
    subtitle: String? = null,
    value: String? = null,
    valueColor: Color = MaterialTheme.colorScheme.onSurfaceVariant,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .semantics(mergeDescendants = true) {}
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        iconContent()
        Spacer(modifier = Modifier.width(16.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface)
            if (subtitle != null) {
                Spacer(modifier = Modifier.height(2.dp))
                Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (value != null) {
            Spacer(modifier = Modifier.width(8.dp))
            Text(value, style = MaterialTheme.typography.bodyMedium, color = valueColor)
        }
    }
}

@Composable
@OptIn(ExperimentalFoundationApi::class)
private fun CurrentStyleTemplateItem(
    profile: WritingStyleProfileOption,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .combinedClickable(
                onClick = onClick,
                onLongClick = onLongClick,
            )
            .semantics(mergeDescendants = true) {}
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SettingsIcon(Color(0xFFEAF7EF)) {
            Icon(Icons.Default.Palette, contentDescription = null, tint = Color(0xFF188A4B))
        }
        Spacer(modifier = Modifier.width(16.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                "当前风格",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(modifier = Modifier.height(3.dp))
            Text(
                profile.name,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface,
                fontWeight = FontWeight.SemiBold,
            )
            if (profile.description.isNotBlank()) {
                Spacer(modifier = Modifier.height(2.dp))
                Text(
                    profile.description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Spacer(modifier = Modifier.width(12.dp))
        Text(styleSwitchValue(), style = MaterialTheme.typography.bodyMedium, color = Color(0xFF188A4B))
    }
}

@Composable
private fun SettingsIcon(color: Color, content: @Composable () -> Unit) {
    Box(
        modifier = Modifier
            .size(40.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(color),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}

internal fun manualStyleTemplateValue(count: Int): String {
    return if (count <= 0) "新增" else "${count} 个"
}

internal fun styleLinkDistillationValue(isSubmitting: Boolean): String {
    return if (isSubmitting) "生成中" else "生成"
}

internal fun sourceDistillationSubtitle(sourceCount: Int): String {
    return if (sourceCount <= 0) "暂无导入素材" else "最近 ${sourceCount} 条素材"
}

internal fun sourceDistillationValue(
    sourceCount: Int,
    isLoading: Boolean,
    isSubmitting: Boolean,
): String {
    return when {
        isLoading -> "同步中"
        isSubmitting -> "生成中"
        sourceCount <= 0 -> "同步"
        else -> "生成"
    }
}

internal fun styleSwitchValue(): String = "切换 ▾"

internal fun stylePromptDisplayText(profile: WritingStyleProfileOption): String {
    val body = profile.body.orEmpty().trim()
    if (body.isNotBlank()) return body
    val description = profile.description.trim()
    if (description.isNotBlank()) {
        return "这个模板暂时没有完整提示词正文。\n\n$description"
    }
    return "这个模板暂时没有可查看的提示词。"
}

internal fun accountRoleLabel(role: String): String {
    return if (role.trim() == "admin") "管理员" else "普通用户"
}

internal fun publishingAccountValue(account: PublishingAccount?, isLoading: Boolean): String {
    return when {
        isLoading -> "读取中"
        account?.connected == true -> "已绑定"
        else -> "未绑定"
    }
}

internal fun publishingAccountSubtitle(
    account: PublishingAccount?,
    errorMessage: String?,
    isLoading: Boolean,
): String {
    return when {
        isLoading -> "正在读取当前账号的公众号配置"
        errorMessage != null -> errorMessage
        account?.connected == true -> "App ID：${account.appId.orEmpty().ifBlank { "已配置" }}"
        else -> "当前账号尚未绑定公众号，文章生成后会保留在录音详情中"
    }
}

internal fun adminUsersValue(result: AdminUsersResult?, isLoading: Boolean): String {
    return if (isLoading) "读取中" else "${result?.users?.size ?: 0} 人"
}

internal fun adminUsersSubtitle(
    result: AdminUsersResult?,
    errorMessage: String?,
    isLoading: Boolean,
): String {
    return when {
        isLoading -> "正在读取用户和邀请状态"
        errorMessage != null -> errorMessage
        result != null -> "待接受邀请 ${result.invitations.size} 个"
        else -> "邀请用户、查看状态和补发邀请"
    }
}

internal fun shouldFetchStylePrompt(profile: WritingStyleProfileOption, filesToken: String): Boolean {
    return profile.remote && profile.body.isNullOrBlank() && filesToken.isNotBlank()
}

internal fun shouldAutoTestSettingsConnection(
    lastTestedConfig: SettingsConnectionConfig,
    currentConfig: SettingsConnectionConfig,
): Boolean {
    return lastTestedConfig.normalized() != currentConfig.normalized()
}

internal fun settingsLastSyncValue(
    lastSyncAtMs: Long,
    locale: Locale = Locale.getDefault(),
    timeZone: TimeZone = TimeZone.getDefault(),
): String {
    if (lastSyncAtMs <= 0L) return "尚未同步"
    return SimpleDateFormat("MM-dd HH:mm", locale).apply {
        this.timeZone = timeZone
    }.format(Date(lastSyncAtMs))
}

internal fun settingsLastSyncDetail(
    lastSyncAtMs: Long,
    locale: Locale = Locale.getDefault(),
    timeZone: TimeZone = TimeZone.getDefault(),
): String {
    if (lastSyncAtMs <= 0L) return "还没有从云端同步过录音状态"
    val formatted = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", locale).apply {
        this.timeZone = timeZone
    }.format(Date(lastSyncAtMs))
    return "上次从云端同步录音和成文状态：$formatted"
}

private suspend fun testBackendConnection(apiBaseUrl: String, accessToken: String): ConnectionTestResult =
    withContext(Dispatchers.IO) {
        val base = apiBaseUrl.trimEnd('/')
        if (base.isBlank()) {
            return@withContext connectionInputError("API Base URL 为空", tokenProvided = accessToken.isNotBlank())
        }
        try {
            val health = (URL("$base/health").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 8_000
                readTimeout = 8_000
            }
            if (health.responseCode !in 200..299) {
                return@withContext buildConnectionResult(
                    healthStatusCode = health.responseCode,
                    tokenProvided = accessToken.isNotBlank(),
                    recordingsStatusCode = null,
                    recordingCount = null,
                    errorMessage = null,
                )
            }
            if (accessToken.isBlank()) {
                return@withContext buildConnectionResult(
                    healthStatusCode = health.responseCode,
                    tokenProvided = false,
                    recordingsStatusCode = null,
                    recordingCount = null,
                    errorMessage = null,
                )
            }

            runCatching {
                val recordings = (URL("$base/api/recordings").openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = 8_000
                    readTimeout = 8_000
                    setRequestProperty("Authorization", "Bearer $accessToken")
                }
                if (recordings.responseCode in 200..299) {
                    val count = JSONObject(recordings.inputStream.bufferedReader().use { it.readText() })
                        .optJSONArray("recordings")
                        ?.length()
                        ?: 0
                    buildConnectionResult(
                        healthStatusCode = health.responseCode,
                        tokenProvided = true,
                        recordingsStatusCode = recordings.responseCode,
                        recordingCount = count,
                        errorMessage = null,
                    )
                } else {
                    buildConnectionResult(
                        healthStatusCode = health.responseCode,
                        tokenProvided = true,
                        recordingsStatusCode = recordings.responseCode,
                        recordingCount = null,
                        errorMessage = null,
                    )
                }
            }.getOrElse { error ->
                buildConnectionResult(
                    healthStatusCode = health.responseCode,
                    tokenProvided = true,
                    recordingsStatusCode = null,
                    recordingCount = null,
                    errorMessage = null,
                    recordingsErrorMessage = error.message ?: error.javaClass.simpleName,
                )
            }
        } catch (error: Exception) {
            buildConnectionResult(
                healthStatusCode = null,
                tokenProvided = accessToken.isNotBlank(),
                recordingsStatusCode = null,
                recordingCount = null,
                errorMessage = error.message ?: error.javaClass.simpleName,
            )
        }
    }

internal fun buildConnectionResult(
    healthStatusCode: Int?,
    tokenProvided: Boolean,
    recordingsStatusCode: Int?,
    recordingCount: Int?,
    errorMessage: String?,
    recordingsErrorMessage: String? = null,
): ConnectionTestResult {
    val healthPassed = healthStatusCode != null && healthStatusCode in 200..299
    val recordingsPassed = recordingsStatusCode != null && recordingsStatusCode in 200..299
    val authFailed = recordingsStatusCode == 401 || recordingsStatusCode == 403

    val checks = listOf(
        ConnectionCheckItem(
            label = "后端网络",
            state = if (healthPassed) ConnectionCheckState.PASSED else ConnectionCheckState.FAILED,
            detail = when {
                healthPassed -> "/health HTTP $healthStatusCode"
                healthStatusCode != null -> "/health HTTP $healthStatusCode"
                errorMessage != null -> errorMessage
                else -> "无法访问 /health"
            },
        ),
        ConnectionCheckItem(
            label = "登录会话",
            state = when {
                !tokenProvided -> ConnectionCheckState.FAILED
                authFailed -> ConnectionCheckState.FAILED
                recordingsPassed -> ConnectionCheckState.PASSED
                healthPassed -> ConnectionCheckState.SKIPPED
                else -> ConnectionCheckState.SKIPPED
            },
            detail = when {
                !tokenProvided -> "未登录，无法读取云端录音"
                authFailed -> "登录已失效或没有权限，/api/recordings HTTP $recordingsStatusCode"
                recordingsPassed -> "已通过授权接口校验"
                healthPassed -> "已有登录会话，但录音列表未通过，暂未确认权限"
                else -> "后端未连通，暂未校验"
            },
        ),
        ConnectionCheckItem(
            label = "录音列表接口",
            state = when {
                recordingsPassed -> ConnectionCheckState.PASSED
                !healthPassed || !tokenProvided -> ConnectionCheckState.SKIPPED
                else -> ConnectionCheckState.FAILED
            },
            detail = when {
                recordingsPassed -> "/api/recordings HTTP $recordingsStatusCode，云端 $recordingCount 条录音"
                recordingsStatusCode != null -> "/api/recordings HTTP $recordingsStatusCode"
                recordingsErrorMessage != null -> recordingsErrorMessage
                !healthPassed -> "后端未连通，暂未请求"
                !tokenProvided -> "需要登录"
                else -> "没有拿到接口响应"
            },
        ),
    )

    return ConnectionTestResult(
        success = healthPassed && tokenProvided && recordingsPassed,
        summary = when {
            healthPassed && tokenProvided && recordingsPassed -> "连接正常"
            !healthPassed -> "后端不可达"
            !tokenProvided -> "尚未登录"
            authFailed -> "登录已失效"
            else -> "录音列表接口异常"
        },
        nextAction = when {
            healthPassed && tokenProvided && recordingsPassed -> "可以继续录音、上传并等待成文。"
            !healthPassed -> "检查 API Base URL、网络或后端部署状态。"
            !tokenProvided -> "返回登录页完成账号登录后重新测试连接。"
            authFailed -> "退出后重新登录，或请管理员确认账号状态。"
            else -> "稍后重试；如果持续失败，复制诊断信息反馈。"
        },
        checks = checks,
    )
}

private fun connectionInputError(message: String, tokenProvided: Boolean): ConnectionTestResult {
    return buildConnectionResult(
        healthStatusCode = null,
        tokenProvided = tokenProvided,
        recordingsStatusCode = null,
        recordingCount = null,
        errorMessage = message,
    ).copy(
        summary = "配置不完整",
        nextAction = "填写 API Base URL 后重新测试连接。",
    )
}

private fun copyDiagnostics(context: Context, diagnostics: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("VibePub 诊断信息", diagnostics))
    Toast.makeText(context, "诊断信息已复制", Toast.LENGTH_SHORT).show()
}

private fun copyWritingStylePrompt(context: Context, profile: WritingStyleProfileOption) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("VibePub 写作风格提示词", stylePromptDisplayText(profile)))
    Toast.makeText(context, "提示词已复制", Toast.LENGTH_SHORT).show()
}

private fun copyPlainText(context: Context, label: String, value: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText(label, value))
    Toast.makeText(context, "已复制", Toast.LENGTH_SHORT).show()
}

private suspend fun buildDiagnostics(context: android.content.Context, preferences: AppPreferences): String =
    withContext(Dispatchers.IO) {
        val recordings = AppDatabase.getDatabase(context).recordingDao().getAllRecordings(preferences.effectiveUserId)
        val latest = recordings.firstOrNull()
        val syncText = if (preferences.lastSyncAtMs > 0) {
            SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date(preferences.lastSyncAtMs))
        } else {
            "尚未同步"
        }
        formatDiagnostics(
            appVersion = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
            deviceId = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID).orEmpty()
                .ifBlank { "unknown" },
            deviceName = "${Build.MANUFACTURER} ${Build.MODEL}",
            androidVersion = "${Build.VERSION.RELEASE} / SDK ${Build.VERSION.SDK_INT}",
            apiBaseUrl = preferences.apiBaseUrl,
            tokenConfigured = preferences.accessToken.isNotBlank(),
            userId = preferences.effectiveUserId,
            userEmail = preferences.userEmail,
            lastSyncText = syncText,
            recordingCount = recordings.size,
            latest = latest,
            recentRecordings = recordings.take(5),
            latestLocalAudioExists = latest?.localAudioPath
                ?.takeIf { it.isNotBlank() }
                ?.let { File(it).exists() },
        )
    }

internal fun formatDiagnostics(
    appVersion: String,
    deviceId: String,
    deviceName: String,
    androidVersion: String,
    apiBaseUrl: String,
    tokenConfigured: Boolean,
    userId: String = AppPreferences.DEFAULT_USER_ID,
    userEmail: String = "",
    lastSyncText: String,
    recordingCount: Int,
    latest: RecordingEntity?,
    recentRecordings: List<RecordingEntity> = latest?.let { listOf(it) } ?: emptyList(),
    latestLocalAudioExists: Boolean? = latest?.localAudioPath
        ?.takeIf { it.isNotBlank() }
        ?.let { File(it).exists() },
): String {
    val latestStep = latest?.currentWorkflowStep()
    val latestDraftReference = latest
        ?.let { recording -> wechatDraftReferenceOrNull(recording.wechatDraftId, recording.wechatUrl) }
        ?: "无"
    val recentRecordingsText = formatRecentRecordingDiagnostics(recentRecordings)
    return """
    App: VibePub $appVersion
    Device ID: $deviceId
    Device: $deviceName
    Android: $androidVersion
    API host: ${apiBaseUrl.ifBlank { "未配置" }}
    Login: ${if (tokenConfigured) "已登录" else "未登录"}
    User ID: $userId
    User email: ${userEmail.ifBlank { "无" }}
    Last sync: $lastSyncText
    Recording count: $recordingCount
    $recentRecordingsText
    Latest recording: ${latest?.filename ?: "无"}
    Latest title: ${latest?.displayTitle() ?: "无"}
    Latest status: ${latest?.status ?: "无"}
    Latest status label: ${latest?.statusLabel() ?: "无"}
    Latest status detail: ${latest?.statusDetail() ?: "无"}
    Latest processing stage: ${latest?.processingStage ?: "无"}
    Latest workflow: ${latest?.workflowCurrentNodeLabel() ?: "无"}
    Latest workflow progress: ${latest?.workflowProgressLabel() ?: "无"}
    Latest workflow freshness: ${latest?.workflowFreshnessLabel() ?: "无"}
    Latest workflow detail: ${latestStep?.detail ?: "无"}
    Latest next action: ${latest?.workflowNextActionLabel() ?: "无"}
    Latest remote update: ${latest?.remoteStatusUpdatedAt ?: "无"}
    Latest local audio path: ${latest?.localAudioPath ?: "无"}
    Latest local audio exists: ${latestLocalAudioExists?.let { if (it) "是" else "否" } ?: "未知"}
    Latest article title: ${latest?.articleTitle ?: "无"}
    Latest raw text: ${if (latest?.rawTextPreview.isNullOrBlank()) "无" else "已同步"}
    Latest WeChat draft: $latestDraftReference
    Latest error: ${latest?.lastError ?: "无"}
    """.trimIndent()
}

internal fun formatRecentRecordingDiagnostics(
    recordings: List<RecordingEntity>,
    limit: Int = 5,
): String {
    if (recordings.isEmpty()) return "Recent recordings: 无"

    val rows = recordings.take(limit.coerceAtLeast(0)).mapIndexed { index, recording ->
        "${index + 1}. ${compactDiagnosticValue(recording.filename)}" +
            " | ${recording.listDurationLabel()}" +
            " | ${recording.status}" +
            " | ${recording.statusLabel()}" +
            " | created=${diagnosticTimeLabel(recording.timestamp)}" +
            " | stage=${compactDiagnosticValue(recording.processingStage)}" +
            " | error=${compactDiagnosticValue(recording.lastError)}"
    }
    return buildString {
        appendLine("Recent recordings:")
        rows.forEach { appendLine(it) }
    }.trimEnd()
}

private fun compactDiagnosticValue(value: String?, fallback: String = "无", maxLength: Int = 80): String {
    val cleaned = value.orEmpty().replace(Regex("\\s+"), " ").trim()
    if (cleaned.isBlank()) return fallback
    return if (cleaned.length <= maxLength) cleaned else cleaned.take(maxLength - 3) + "..."
}

private fun diagnosticTimeLabel(timestampMs: Long): String {
    if (timestampMs <= 0L) return "未知"
    return SimpleDateFormat("MM-dd HH:mm:ss", Locale.getDefault()).format(Date(timestampMs))
}

internal fun styleProfileSpeechIntent(): Intent {
    return Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.CHINESE.toLanguageTag())
        putExtra(RecognizerIntent.EXTRA_PROMPT, "说说你希望文章呈现出的写作风格")
    }
}

internal fun extractSpeechRecognitionText(resultCode: Int, data: Intent?): String {
    if (resultCode != Activity.RESULT_OK || data == null) return ""
    return data
        .getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
        ?.firstOrNull()
        ?.trim()
        .orEmpty()
}
