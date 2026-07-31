package com.example.inventoryscanner

import android.Manifest
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.Barcode
import com.google.mlkit.vision.common.InputImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.URI
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class MainActivity : AppCompatActivity() {
    private lateinit var previewView: PreviewView
    private lateinit var statusText: android.widget.TextView
    private lateinit var sessionText: android.widget.TextView
    private lateinit var promptText: android.widget.TextView
    private lateinit var countText: android.widget.TextView
    private lateinit var lastItemText: android.widget.TextView
    private lateinit var manualInput: android.widget.EditText
    private lateinit var manualButton: android.widget.Button
    private lateinit var skipButton: android.widget.Button
    private lateinit var pairingView: View
    private lateinit var scanView: View
    private lateinit var flashView: View

    private val cameraExecutor = Executors.newSingleThreadExecutor()
    private val client = OkHttpClient.Builder().readTimeout(10, TimeUnit.SECONDS).build()
    private var webSocket: WebSocket? = null
    private var currentStep = Step.ASSET
    private var sessionId: String? = null
    private var baseUrl: String? = null
    private var isProcessing = false
    private var reconnectJob: Job? = null
    private var heartbeatJob: Job? = null
    private var cameraProvider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    private var barcodeScanner: BarcodeScanner? = null
    private var pendingAsset: JSONObject? = null

    private val requestCameraPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            startCamera()
        } else {
            showToast("Camera permission is required")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        previewView = findViewById(R.id.previewView)
        statusText = findViewById(R.id.statusText)
        sessionText = findViewById(R.id.sessionText)
        promptText = findViewById(R.id.promptText)
        countText = findViewById(R.id.countText)
        lastItemText = findViewById(R.id.lastItemText)
        manualInput = findViewById(R.id.manualInput)
        manualButton = findViewById(R.id.manualButton)
        skipButton = findViewById(R.id.skipButton)
        pairingView = findViewById(R.id.pairingView)
        scanView = findViewById(R.id.scanView)
        flashView = findViewById(R.id.flashView)

        manualButton.setOnClickListener { submitManualInput() }
        skipButton.setOnClickListener { skipSerial() }
        previewView.setOnClickListener { showToast("Tap-to-focus is ready for the next camera update") }

        updateUiForStep()
        requestCameraPermission.launch(Manifest.permission.CAMERA)
    }

    override fun onDestroy() {
        super.onDestroy()
        cameraExecutor.shutdown()
        heartbeatJob?.cancel()
        webSocket?.close(1000, null)
    }

    private fun updateUiForStep() {
        if (sessionId == null) {
            promptText.text = "Scan the pairing QR code on the laptop dashboard"
            skipButton.visibility = View.GONE
            statusText.text = "Waiting for pairing"
            sessionText.text = "Session: --"
            return
        }

        when (currentStep) {
            Step.ASSET -> {
                promptText.text = "Step 1: Scan the asset QR tag"
                skipButton.visibility = View.GONE
                statusText.text = "Ready to scan"
                barcodeScanner = buildScanner(isSerialStep = false)
            }
            Step.SERIAL -> {
                promptText.text = "Step 2: Scan the serial barcode"
                skipButton.visibility = View.VISIBLE
                statusText.text = "Serial scan"
                barcodeScanner = buildScanner(isSerialStep = true)
            }
        }
    }

    private fun buildScanner(isSerialStep: Boolean): BarcodeScanner {
        val formats = if (isSerialStep) {
            listOf(
                Barcode.FORMAT_CODE_128,
                Barcode.FORMAT_CODE_39,
                Barcode.FORMAT_EAN_13,
                Barcode.FORMAT_EAN_8,
                Barcode.FORMAT_UPC_A,
                Barcode.FORMAT_UPC_E,
                Barcode.FORMAT_ITF,
                Barcode.FORMAT_CODABAR
            )
        } else {
            listOf(Barcode.FORMAT_QR_CODE)
        }

        val options = BarcodeScannerOptions.Builder()
            .setBarcodeFormats(formats.first(), *formats.drop(1).toIntArray())
            .build()
        return BarcodeScanning.getClient(options)
    }

    private fun startCamera() {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(this)
        cameraProviderFuture.addListener({
            cameraProvider = cameraProviderFuture.get()
            val preview = Preview.Builder().build().also {
                it.setSurfaceProvider(previewView.surfaceProvider)
            }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
                .also {
                    it.setAnalyzer(cameraExecutor) { imageProxy ->
                        processImage(imageProxy)
                    }
                }
            cameraProvider?.unbindAll()
            camera = cameraProvider?.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            barcodeScanner = buildScanner(isSerialStep = currentStep == Step.SERIAL)
        }, ContextCompat.getMainExecutor(this))
    }

    private fun processImage(imageProxy: ImageProxy) {
        if (isProcessing || sessionId == null || barcodeScanner == null) {
            imageProxy.close()
            return
        }

        isProcessing = true
        val mediaImage = imageProxy.image
        if (mediaImage != null) {
            val inputImage = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
            barcodeScanner?.process(inputImage)
                ?.addOnSuccessListener { barcodes ->
                    imageProxy.close()
                    val barcode = barcodes.firstOrNull()
                    if (barcode != null) {
                        handleDecoded(barcode)
                    }
                    isProcessing = false
                }
                ?.addOnFailureListener {
                    imageProxy.close()
                    isProcessing = false
                }
        } else {
            imageProxy.close()
            isProcessing = false
        }
    }

    private fun handleDecoded(barcode: Barcode) {
        val value = barcode.rawValue?.trim().orEmpty()
        if (value.isBlank()) return

        if (sessionId == null) {
            val parsedSession = parseSessionFromUrl(value)
            if (parsedSession != null) {
                pairWithSession(parsedSession.first, parsedSession.second)
            }
            return
        }

        if (currentStep == Step.ASSET) {
            lifecycleScope.launch { submitAssetScan(value) }
        } else {
            lifecycleScope.launch { submitSerialScan(value) }
        }
    }

    private fun parseSessionFromUrl(url: String): Pair<String, String>? {
        return try {
            val uri = URI(url)
            val session = uri.query?.split("&")?.firstOrNull { it.startsWith("session=") }?.substringAfter("=")
            if (!session.isNullOrBlank()) {
                Pair(session.uppercase(), "${uri.scheme}://${uri.host}${if (uri.port != -1) ":${uri.port}" else ""}")
            } else null
        } catch (_: Exception) {
            null
        }
    }

    private fun pairWithSession(newSessionId: String, newBaseUrl: String) {
        sessionId = newSessionId
        baseUrl = newBaseUrl
        pairingView.visibility = View.GONE
        scanView.visibility = View.VISIBLE
        sessionText.text = "Connected to session $sessionId"
        statusText.text = "Connected"
        updateUiForStep()
        connectWebSocket()
        showToast("Connected to session $sessionId")
    }

    private fun connectWebSocket() {
        heartbeatJob?.cancel()
        val socketUrl = "${baseUrl?.replace("http", "ws")}/ws/${sessionId}"
        val request = Request.Builder().url(socketUrl).build()
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                statusText.text = "Connected"
                sendHelloMobile(webSocket)
                startHeartbeat()
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                heartbeatJob?.cancel()
                scheduleReconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
                heartbeatJob?.cancel()
                scheduleReconnect()
            }
        })
    }

    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = lifecycleScope.launch {
            while (true) {
                delay(10_000L)
                val socket = webSocket ?: break
                sendHelloMobile(socket)
            }
        }
    }

    private fun sendHelloMobile(socket: WebSocket) {
        socket.send(
            "{\"type\":\"hello_mobile\",\"session_id\":\"${sessionId}\",\"source\":\"mobile\",\"timestamp\":\"${System.currentTimeMillis()}\"}"
        )
    }

    private fun broadcastCompletedRecord(record: JSONObject) {
        webSocket?.send(
            JSONObject().apply {
                put("type", "scan_completed")
                put("source", "mobile")
                put("session_id", sessionId)
                put("timestamp", System.currentTimeMillis().toString())
                put("record", record)
            }.toString()
        )
    }

    private fun scheduleReconnect() {
        reconnectJob?.cancel()
        reconnectJob = lifecycleScope.launch {
            statusText.text = "Reconnecting..."
            delay(2000L)
            connectWebSocket()
        }
    }

    private suspend fun submitAssetScan(value: String) = withContext(Dispatchers.IO) {
        val body = JSONObject().apply { put("qr_code", value) }
        val request = Request.Builder()
            .url("${baseUrl}/api/scan?session_id=${sessionId}")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()
        client.newCall(request).execute().use { response ->
            val payload = JSONObject(response.body?.string() ?: "{}")
            if (!response.isSuccessful) {
                lifecycleScope.launch { showToast(payload.optString("detail", "Invalid scan")) }
                return@withContext
            }
            if (payload.optBoolean("requires_serial_number")) {
                pendingAsset = payload.optJSONObject("asset")
                currentStep = Step.SERIAL
                lifecycleScope.launch {
                    updateUiForStep()
                    showToast("Asset tag captured. Now scan serial number")
                }
            } else {
                lifecycleScope.launch {
                    completeSuccess(payload.optJSONObject("record"))
                    currentStep = Step.ASSET
                    updateUiForStep()
                }
            }
        }
    }

    private suspend fun submitSerialScan(value: String) = withContext(Dispatchers.IO) {
        val body = JSONObject().apply {
            put("serial_number", value)
            put("skip_serial_number", false)
        }
        val request = Request.Builder()
            .url("${baseUrl}/api/complete-scan?session_id=${sessionId}")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()
        client.newCall(request).execute().use { response ->
            val payload = JSONObject(response.body?.string() ?: "{}")
            if (!response.isSuccessful) {
                lifecycleScope.launch { showToast(payload.optString("detail", "Serial scan failed")) }
                return@withContext
            }
            lifecycleScope.launch {
                pendingAsset = null
                completeSuccess(payload.optJSONObject("record"))
                currentStep = Step.ASSET
                updateUiForStep()
            }
        }
    }

    private fun skipSerial() {
        lifecycleScope.launch(Dispatchers.IO) {
            val body = JSONObject().apply { put("skip_serial_number", true) }
            val request = Request.Builder()
                .url("${baseUrl}/api/complete-scan?session_id=${sessionId}")
                .post(body.toString().toRequestBody("application/json".toMediaType()))
                .build()
            client.newCall(request).execute().use { response ->
                val payload = JSONObject(response.body?.string() ?: "{}")
                if (!response.isSuccessful) {
                    lifecycleScope.launch { showToast(payload.optString("detail", "Skip failed")) }
                    return@launch
                }
                lifecycleScope.launch {
                    pendingAsset = null
                    completeSuccess(payload.optJSONObject("record"))
                    currentStep = Step.ASSET
                    updateUiForStep()
                }
            }
        }
    }

    private fun completeSuccess(record: JSONObject?) {
        if (record == null) {
            return
        }
        vibrate()
        flashView.visibility = View.VISIBLE
        flashView.postDelayed({ flashView.visibility = View.GONE }, 300)
        val label = record.optString("Item Name", "scan")
        countText.text = "${(countText.text.toString().toIntOrNull() ?: 0) + 1}"
        lastItemText.text = label
        broadcastCompletedRecord(record)
        showToast("Scan completed")
    }

    private fun submitManualInput() {
        val input = manualInput.text.toString().trim()
        if (input.isBlank()) return
        manualInput.setText("")
        lifecycleScope.launch {
            if (currentStep == Step.ASSET) submitAssetScan(input) else submitSerialScan(input)
        }
    }

    private fun showToast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    private fun vibrate() {
        val vibrator = getSystemService(VIBRATOR_SERVICE) as Vibrator
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator.vibrate(VibrationEffect.createOneShot(120, VibrationEffect.DEFAULT_AMPLITUDE))
        } else {
            vibrator.vibrate(120)
        }
    }

    private enum class Step { ASSET, SERIAL }
}
