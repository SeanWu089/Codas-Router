package com.codassol.mobile

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * UI-only adapter for the existing phone service. The Flutter view receives
 * snapshots, not credentials. All real work stays in the original native classes.
 */
class MainActivity : FlutterActivity() {
    private val store by lazy { PhoneStore(this) }
    private var channel: MethodChannel? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        channel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "codas/native")
        channel?.setMethodCallHandler { call, result ->
            try {
                when (call.method) {
                    "snapshot" -> result.success(snapshot())
                    "setAccess" -> {
                        val enable = call.argument<Boolean>("enabled") ?: error("ACCESS_VALUE_REQUIRED")
                        if (enable) {
                            // Identical validation and service invocation to the native Preview.8 UI.
                            check(AgentService.current == null) { "WAIT_FOR_SERVICE_STOP" }
                            val endpoint = call.argument<String>("endpoint").orEmpty()
                            if (endpoint.isBlank()) throw IllegalArgumentException("HTTPS_ORIGIN_REQUIRED")
                            try { store.endpoint = endpoint } catch (_: IllegalArgumentException) {
                                throw IllegalArgumentException("HTTPS_ORIGIN_REQUIRED")
                            }
                            val pairing = call.argument<String>("pairing").orEmpty().trim()
                            check(store.token() != null || pairing.isNotEmpty()) { "PAIRING_REQUIRED" }
                            if (Build.VERSION.SDK_INT >= 33 &&
                                checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                                requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 4)
                            }
                            startForegroundService(Intent(this, AgentService::class.java).putExtra("pairing", pairing))
                        } else {
                            store.requestAccess(false)
                            AgentState.disable()
                            AgentService.current?.disable()
                            ApkOperations.cancel(this)
                        }
                        result.success(snapshot())
                    }
                    "openPermission" -> {
                        when (call.argument<String>("kind")) {
                            "control" -> startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                            "install" -> startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
                            "background" -> {
                                val power = getSystemService(PowerManager::class.java)
                                val action = if (power.isIgnoringBatteryOptimizations(packageName))
                                    Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                                else Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
                                startActivity(action)
                            }
                            else -> error("UNKNOWN_PERMISSION")
                        }
                        result.success(null)
                    }
                    "install" -> {
                        val state = ApkOperations.snapshot(this)
                        if (state.optString("status") == "awaiting_confirmation") {
                            val next = ApkOperations.confirmation() ?: error("MISSING_INSTALL_CONFIRMATION")
                            startActivity(next)
                        } else ApkOperations.install(this)
                        result.success(snapshot())
                    }
                    else -> result.notImplemented()
                }
            } catch (e: Exception) {
                result.error(safeError(e), null, null)
            }
        }
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        channel?.setMethodCallHandler(null)
        channel = null
        super.cleanUpFlutterEngine(flutterEngine)
    }

    override fun onResume() {
        super.onResume()
        // Preserve the native UI's existing current-boot access restoration.
        if (store.accessRequested() && AgentService.current == null) {
            startForegroundService(Intent(this, AgentService::class.java))
        }
    }

    private fun snapshot(): Map<String, Any?> {
        val apk = ApkOperations.snapshot(this)
        return mapOf(
            "enabled" to AgentState.enabled,
            "connected" to AgentState.connected,
            "status" to AgentState.status,
            "lastAction" to AgentState.lastAction,
            "endpoint" to store.endpoint,
            // This reports saved enrollment only, never the encrypted token or pairing code.
            "paired" to getSharedPreferences("codas-phone", MODE_PRIVATE).contains("credential"),
            "device" to if (Build.MANUFACTURER.equals("nubia", true)) "RedMagic" else Build.MODEL,
            "deviceId" to store.deviceId,
            "version" to packageManager.getPackageInfo(packageName, 0).versionName,
            "control" to (PhoneAccessibility.current != null),
            "install" to packageManager.canRequestPackageInstalls(),
            "background" to getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName),
            "task" to mapOf(
                "status" to apk.optString("status", "idle"),
                "package" to apk.optString("package"),
                "version" to apk.optString("version"),
                "installed_version" to apk.optString("installed_version"),
                "error" to apk.optString("error"),
                "bytes" to apk.optLong("bytes", 0)
            )
        )
    }
}
