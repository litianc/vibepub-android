package cn.litianc.vibepub.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.litianc.vibepub.AppPreferences

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBackClick: () -> Unit
) {
    var filesToken by remember { mutableStateOf(AppPreferences.filesToken) }
    var showTokenDialog by remember { mutableStateOf(false) }

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
                    containerColor = MaterialTheme.colorScheme.background
                )
            )
        },
        containerColor = MaterialTheme.colorScheme.background
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp)
        ) {
            item {
                Spacer(modifier = Modifier.height(8.dp))
                SettingsGroup(title = "") {
                    SettingsItem(
                        iconContent = {
                            Box(
                                modifier = Modifier
                                    .size(40.dp)
                                    .clip(RoundedCornerShape(8.dp))
                                    .background(Color(0xFF2C2C2E)),
                                contentAlignment = Alignment.Center
                            ) {
                                // Shield icon mock
                                Box(modifier = Modifier.size(20.dp).background(Color.White, RoundedCornerShape(4.dp)))
                            }
                        },
                        title = "账户",
                        subtitle = "无需登录 · ID 已随 iCloud 钥匙串备份",
                        value = "VD·AE20",
                        onClick = { }
                    )
                }
            }

            item {
                SettingsGroup(title = "发布") {
                    SettingsItem(
                        iconContent = {
                            Box(modifier = Modifier.size(40.dp).clip(RoundedCornerShape(8.dp)).background(Color(0xFFFDECEA)))
                        },
                        title = "微信公众号",
                        subtitle = "成文一键推送到草稿箱",
                        value = "已连接",
                        valueColor = Color(0xFF4CAF50),
                        onClick = { }
                    )
                    Divider(color = MaterialTheme.colorScheme.background, thickness = 1.dp, modifier = Modifier.padding(start = 64.dp))
                    SettingsItem(
                        iconContent = {
                            Box(modifier = Modifier.size(40.dp).clip(RoundedCornerShape(8.dp)).background(Color(0xFFF2F2F7)))
                        },
                        title = "写作风格",
                        subtitle = "名字与文风，决定挖文章的语气",
                        onClick = { }
                    )
                }
            }

            item {
                SettingsGroup(title = "后端连接") {
                    SettingsItem(
                        iconContent = {
                            Box(modifier = Modifier.size(40.dp).clip(RoundedCornerShape(8.dp)).background(Color(0xFFF2F2F7)))
                        },
                        title = "FILES_TOKEN",
                        subtitle = if (filesToken.isNotEmpty()) "已配置" else "未配置",
                        onClick = { showTokenDialog = true }
                    )
                }
            }
        }
    }

    if (showTokenDialog) {
        AlertDialog(
            onDismissRequest = { showTokenDialog = false },
            title = { Text("配置 FILES_TOKEN") },
            text = {
                OutlinedTextField(
                    value = filesToken,
                    onValueChange = { filesToken = it },
                    label = { Text("Token") },
                    singleLine = true
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        AppPreferences.filesToken = filesToken
                        showTokenDialog = false
                    }
                ) {
                    Text("保存")
                }
            },
            dismissButton = {
                TextButton(onClick = { showTokenDialog = false }) {
                    Text("取消")
                }
            }
        )
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
                modifier = Modifier.padding(start = 16.dp, bottom = 8.dp)
            )
        }
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            shape = RoundedCornerShape(12.dp)
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
    onClick: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically
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
        Spacer(modifier = Modifier.width(8.dp))
        Text(">", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
