package cn.litianc.vibepub.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.litianc.vibepub.MIN_TEXT_SUBMISSION_CHARS
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TextInputScreen(
    onBackClick: () -> Unit,
    onSubmitText: suspend (text: String, titleHint: String?) -> Boolean,
) {
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf("") }
    var titleHint by remember { mutableStateOf("") }
    var isSubmitting by remember { mutableStateOf(false) }
    val trimmedText = text.trim()
    val canSubmit = trimmedText.length >= MIN_TEXT_SUBMISSION_CHARS && !isSubmitting

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("输入文字", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = onBackClick, enabled = !isSubmitting) {
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
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            OutlinedTextField(
                value = titleHint,
                onValueChange = { titleHint = it },
                enabled = !isSubmitting,
                label = { Text("标题提示（可选）") },
                singleLine = true,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("TextSubmissionTitleField"),
            )
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                enabled = !isSubmitting,
                label = { Text("想表达的文字") },
                placeholder = { Text("把想法写在这里，或从其他地方粘贴进来") },
                minLines = 12,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("TextSubmissionBodyField"),
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = "${trimmedText.length} 字",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = if (canSubmit) "可以提交" else "至少 $MIN_TEXT_SUBMISSION_CHARS 字",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(modifier = Modifier.height(4.dp))
            Button(
                onClick = {
                    if (!canSubmit) return@Button
                    isSubmitting = true
                    scope.launch {
                        val submitted = onSubmitText(trimmedText, titleHint.trim().ifBlank { null })
                        isSubmitting = false
                        if (submitted) {
                            onBackClick()
                        }
                    }
                },
                enabled = canSubmit,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(52.dp)
                    .testTag("SubmitTextButton"),
            ) {
                if (isSubmitting) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                } else {
                    Icon(Icons.Default.Send, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(modifier = Modifier.size(8.dp))
                    Text("生成公众号草稿")
                }
            }
        }
    }
}
