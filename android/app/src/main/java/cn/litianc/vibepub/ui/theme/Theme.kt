package cn.litianc.vibepub.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

val BackgroundColor = Color(0xFF000000)
val SurfaceColor = Color(0xFF1C1C1E)
val PrimaryRed = Color(0xFFE53935)
val TextPrimary = Color(0xFFFFFFFF)
val TextSecondary = Color(0xFF8E8E93)

private val MinimalistDarkColors = darkColorScheme(
    primary = PrimaryRed,
    onPrimary = Color.White,
    secondary = Color.White,
    background = BackgroundColor,
    surface = SurfaceColor,
    onSurface = TextPrimary,
    onSurfaceVariant = TextSecondary
)

val ModernTypography = Typography(
    displayLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 32.sp
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
        colorScheme = MinimalistDarkColors,
        typography = ModernTypography,
        content = content,
    )
}
