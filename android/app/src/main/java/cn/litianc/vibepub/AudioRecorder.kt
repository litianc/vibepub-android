package cn.litianc.vibepub

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Geocoder
import android.location.LocationManager
import android.media.MediaRecorder
import android.os.Build
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

class AudioRecorder(private val context: Context) {
    private var recorder: MediaRecorder? = null
    private var outputFile: File? = null
    private var startTime: Instant? = null

    fun start(): File {
        check(recorder == null) { "Recorder is already running" }

        val recordingsDir = File(context.filesDir, "recordings").apply { mkdirs() }
        startTime = Instant.now()
        val timestamp = DateTimeFormatter
            .ofPattern("yyyyMMdd-HHmmss")
            .withZone(ZoneId.systemDefault())
            .format(startTime)
        val file = File(recordingsDir, "vibepub-tmp-$timestamp.m4a")

        val nextRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(context)
        } else {
            @Suppress("DEPRECATION")
            MediaRecorder()
        }

        nextRecorder.setAudioSource(MediaRecorder.AudioSource.MIC)
        nextRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        nextRecorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        nextRecorder.setAudioEncodingBitRate(128_000)
        nextRecorder.setAudioSamplingRate(44_100)
        nextRecorder.setOutputFile(file.absolutePath)
        nextRecorder.prepare()
        nextRecorder.start()

        recorder = nextRecorder
        outputFile = file
        return file
    }

    suspend fun stop(): Pair<File, Long> = withContext(Dispatchers.IO) {
        val file = checkNotNull(outputFile) { "No recording is active" }
        val activeRecorder = checkNotNull(recorder) { "No recording is active" }
        val startInst = checkNotNull(startTime)

        try {
            activeRecorder.stop()
        } catch (error: RuntimeException) {
            file.delete()
            throw error
        } finally {
            activeRecorder.release()
            recorder = null
            outputFile = null
            startTime = null
        }

        val durationSecs = java.time.Duration.between(startInst, Instant.now()).seconds
        val mins = durationSecs / 60
        val secs = durationSecs % 60
        val durationStr = "${mins}m${secs}s"

        val zdt = startInst.atZone(ZoneId.systemDefault())
        val dateStr = DateTimeFormatter.ofPattern("yyyy-MM-dd-HHmmss").format(zdt)
        val dayStr = DateTimeFormatter.ofPattern("EEE", Locale.US).format(zdt)
        val hour = zdt.hour
        val timeOfDay = when (hour) {
            in 5..11 -> "Morning"
            in 12..17 -> "Afternoon"
            in 18..21 -> "Evening"
            else -> "Night"
        }

        var locationStr = ""
        val hasPermission = ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        
        if (hasPermission) {
            val loc = withTimeoutOrNull(3000) {
                getLocation()
            }
            if (loc != null) {
                try {
                    val geocoder = Geocoder(context, Locale.US)
                    val addresses = geocoder.getFromLocation(loc.first, loc.second, 1)
                    if (!addresses.isNullOrEmpty()) {
                        val addr = addresses[0]
                        val city = addr.locality?.replace("[^a-zA-Z]".toRegex(), "") ?: ""
                        val subLocality = addr.subLocality?.replace("[^a-zA-Z]".toRegex(), "") ?: ""
                        if (city.isNotEmpty() || subLocality.isNotEmpty()) {
                            locationStr = "-$city-$subLocality"
                        }
                    }
                } catch (e: Exception) {
                    // Ignore geocoder errors
                }
            }
        }

        // VibePub-YYYY-MM-DD-HHmmss-XmYYs-Day-TimeOfDay-City-District.m4a
        val finalName = "VibePub-$dateStr-$durationStr-$dayStr-$timeOfDay$locationStr.m4a"
            .replace("--", "-") // Clean up empty locations if any
        val finalFile = File(file.parent, finalName)
        file.renameTo(finalFile)
        
        Pair(finalFile, durationSecs * 1000L)
    }

    @SuppressLint("MissingPermission")
    private suspend fun getLocation(): Pair<Double, Double>? = suspendCancellableCoroutine { cont ->
        val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val provider = LocationManager.NETWORK_PROVIDER
        
        if (!locationManager.isProviderEnabled(provider)) {
            cont.resume(null)
            return@suspendCancellableCoroutine
        }
        
        val location = locationManager.getLastKnownLocation(provider)
        if (location != null) {
            cont.resume(Pair(location.latitude, location.longitude))
        } else {
            cont.resume(null)
        }
    }
}
