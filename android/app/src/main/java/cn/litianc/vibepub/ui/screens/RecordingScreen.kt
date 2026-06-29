package cn.litianc.vibepub.ui.screens

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.litianc.vibepub.ui.theme.PrimaryRed
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.ln
import kotlin.math.roundToInt

@Composable
fun RecordingScreen(
    amplitudeProvider: () -> Int = { 0 },
    onStopClick: suspend () -> Boolean,
) {
    val scope = rememberCoroutineScope()
    var secondsElapsed by remember { mutableIntStateOf(0) }
    var isStopping by remember { mutableStateOf(false) }
    var amplitudeLevel by remember { mutableStateOf(0f) }
    val minSeconds = 2

    LaunchedEffect(Unit) {
        while (true) {
            delay(1000)
            secondsElapsed++
        }
    }

    LaunchedEffect(amplitudeProvider) {
        while (true) {
            amplitudeLevel = normalizeAmplitude(amplitudeProvider())
            delay(100)
        }
    }

    val minutes = secondsElapsed / 60
    val seconds = secondsElapsed % 60
    val timeString = "%02d:%02d".format(minutes, seconds)
    val canStop = canStopRecording(secondsElapsed, minSeconds, isStopping)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(modifier = Modifier.height(86.dp))

        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center,
        ) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(PrimaryRed),
            )
            Spacer(modifier = Modifier.width(8.dp))
            Text(
                text = if (isStopping) "正在保存录音" else "正在录音",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
        }

        Spacer(modifier = Modifier.weight(1f))

        Text(
            text = timeString,
            style = MaterialTheme.typography.displayLarge,
            color = MaterialTheme.colorScheme.onSurface,
        )

        Spacer(modifier = Modifier.height(28.dp))

        RecordingWave(
            secondsElapsed = secondsElapsed,
            amplitudeLevel = amplitudeLevel,
        )

        Spacer(modifier = Modifier.height(16.dp))
        LinearProgressIndicator(
            progress = { amplitudeLevel.coerceIn(0f, 1f) },
            modifier = Modifier
                .fillMaxWidth(0.58f)
                .height(4.dp)
                .testTag("RecordingAmplitudeMeter"),
            color = PrimaryRed,
            trackColor = MaterialTheme.colorScheme.surfaceVariant,
        )
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            text = recordingHint(secondsElapsed, minSeconds, amplitudeLevel),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall,
        )

        Spacer(modifier = Modifier.weight(1f))

        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Button(
                onClick = {
                    if (!canStop) return@Button
                    isStopping = true
                    scope.launch {
                        val shouldLeave = onStopClick()
                        if (!shouldLeave) {
                            isStopping = false
                        }
                    }
                },
                enabled = canStop,
                modifier = Modifier
                    .size(76.dp)
                    .testTag("StopRecordingButton"),
                shape = CircleShape,
                colors = ButtonDefaults.buttonColors(
                    containerColor = Color.White,
                    contentColor = PrimaryRed,
                    disabledContainerColor = Color.White.copy(alpha = 0.7f),
                    disabledContentColor = PrimaryRed.copy(alpha = 0.35f),
                ),
                elevation = ButtonDefaults.buttonElevation(defaultElevation = 2.dp),
            ) {
                if (isStopping) {
                    CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp, color = PrimaryRed)
                } else {
                    Box(
                        modifier = Modifier
                            .size(24.dp)
                            .clip(RoundedCornerShape(4.dp))
                            .background(PrimaryRed.copy(alpha = if (canStop) 1f else 0.35f)),
                    )
                }
            }
            Spacer(modifier = Modifier.height(10.dp))
            Text(
                text = if (isStopping) "保存中" else "点击停止",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.Medium,
            )
        }

        Spacer(modifier = Modifier.height(48.dp))
    }
}

@Composable
private fun RecordingWave(
    secondsElapsed: Int,
    amplitudeLevel: Float,
) {
    val transition = rememberInfiniteTransition(label = "recording-wave")
    val pulse by transition.animateFloat(
        initialValue = 0.3f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 720),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "pulse",
    )

    Row(
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        repeat(17) { index ->
            val base = 8 + ((index * 7 + secondsElapsed * 3) % 26)
            val reactiveLift = 1f + amplitudeLevel.coerceIn(0f, 1f) * (0.45f + (index % 5) * 0.08f)
            val animated = if (index % 2 == 0) pulse else 1f - (pulse * 0.35f)
            Box(
                modifier = Modifier
                    .width(4.dp)
                    .height((base * reactiveLift * (0.65f + animated * 0.45f)).roundToInt().dp)
                    .clip(CircleShape)
                    .background(PrimaryRed.copy(alpha = 0.24f + animated * 0.28f + amplitudeLevel * 0.26f)),
            )
        }
    }
}

internal fun normalizeAmplitude(amplitude: Int): Float {
    if (amplitude <= 0) return 0f
    val normalized = ln(1.0 + amplitude.coerceAtMost(32_767).toDouble()) / ln(1.0 + 32_767.0)
    return normalized.toFloat().coerceIn(0f, 1f)
}

internal fun recordingHint(secondsElapsed: Int, minSeconds: Int, amplitudeLevel: Float): String {
    return when {
        secondsElapsed < minSeconds -> "再说一小会儿就可以保存"
        amplitudeLevel < 0.08f -> "音量偏低，可以靠近麦克风一点"
        else -> "停止后会自动上传并同步成文"
    }
}

internal fun canStopRecording(secondsElapsed: Int, minSeconds: Int, isStopping: Boolean): Boolean {
    return secondsElapsed >= minSeconds && !isStopping
}
