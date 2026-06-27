package cn.litianc.vibepub.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

private val VoiceDropLightColors = lightColorScheme(
    primary = PrimaryRed,
    onPrimary = Color.White,
    secondary = Color.White,
    background = CreamBackground,
    surface = CardWhite,
    onBackground = TextDarkGray,
    onSurface = TextDarkGray,
    onSurfaceVariant = TextSecondaryGray
)

val ModernTypography = Typography(
    displayLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Thin,
        fontSize = 80.sp
    ),
    titleLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 22.sp
    ),
    bodyLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 16.sp
    )
)

@Composable
fun VibePubTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = VoiceDropLightColors,
        typography = ModernTypography,
        content = content,
    )
}
