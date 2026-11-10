package app.yomika.reader

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject

/** Native lifecycle cover: never waits for a suspended WebView before hiding content. */
object NativeAppSecurity {
  private var cover: View? = null
  private var locked = true
  private var backgrounded = false
  private var lockGeneration: Long = 0
  var authenticating = false
    private set
  private fun prefs(activity: Activity) = activity.getSharedPreferences("yomika_security", Context.MODE_PRIVATE)
  fun available(activity: Activity) = activity is FragmentActivity && BiometricManager.from(activity)
    .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS
  fun initialize(activity: Activity) {
    backgrounded = false
    locked = prefs(activity).getBoolean("passwordEnabled", false)
    if (locked) lockGeneration++
    applyFlags(activity)
    if (locked) showCover(activity)
  }
  private fun applyFlags(activity: Activity) {
    if (prefs(activity).getBoolean("hidePreview", false)) activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
  }
  private fun showCover(activity: Activity) {
    if (cover != null) return
    val root = activity.findViewById<ViewGroup>(android.R.id.content) ?: return
    val view = FrameLayout(activity).apply {
      setBackgroundColor(Color.rgb(13, 13, 13)); isClickable = true; isFocusable = true
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
      contentDescription = "应用已锁定"
    }
    root.addView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    cover = view
  }
  fun pause(activity: Activity) {
    if (authenticating) return
    backgrounded = true
    val p = prefs(activity)
    if (p.getBoolean("passwordEnabled", false) && p.getBoolean("lockOnBackground", false)) {
      locked = true
      lockGeneration++
    }
    if (locked || p.getBoolean("hidePreview", false)) showCover(activity)
  }
  fun stop(activity: Activity) {
    // BiometricPrompt stays inside our Activity; onStop means real background.
    backgrounded = true
    val p = prefs(activity)
    if (p.getBoolean("passwordEnabled", false) && p.getBoolean("lockOnBackground", false)) {
      locked = true
      lockGeneration++
    }
    if (locked || p.getBoolean("hidePreview", false)) showCover(activity)
  }
  fun resume(activity: Activity, web: WebView?) {
    backgrounded = false
    if (authenticating) return
    // Keep native cover until React has committed its lock/loading screen.
    if (locked) showCover(activity) else ready()
    web?.evaluateJavascript("window.dispatchEvent(new Event('yomika-security-resume'))", null)
  }
  fun destroy(activity: Activity) {
    if (cover?.context === activity) ready(force = true)
  }
  fun ready(force: Boolean = false) {
    if (backgrounded && !force) return
    cover?.let { (it.parent as? ViewGroup)?.removeView(it) }; cover = null
  }
  fun status(activity: Activity) = JSObject().apply {
    put("locked", locked && prefs(activity).getBoolean("passwordEnabled", false))
    put("biometricAvailable", available(activity))
    put("lockGeneration", lockGeneration)
  }
  fun configure(activity: Activity, args: SecurityConfigureArgs) {
    check(args.expectedLockGeneration < 0 || args.expectedLockGeneration == lockGeneration) { "安全状态已更改，请重新认证" }
    check(prefs(activity).edit().putBoolean("passwordEnabled", args.passwordEnabled)
      .putBoolean("lockOnBackground", args.lockOnBackground).putBoolean("hidePreview", args.hidePreview).commit()) { "无法保存原生安全设置" }
    // An auth response arriving after onPause/onStop cannot clear a background lock.
    locked = args.passwordEnabled && (args.locked || (backgrounded && args.lockOnBackground))
    applyFlags(activity)
    // UI readiness removes the cover; configuration itself cannot reveal a frame.
  }
  fun authenticate(activity: Activity, invoke: Invoke) {
    val host = activity as? FragmentActivity
    if (host == null || !available(activity)) { invoke.reject("当前设备没有可用的系统生物认证"); return }
    if (authenticating) { invoke.reject("系统认证正在进行"); return }
    authenticating = true
    val prompt = BiometricPrompt(host, ContextCompat.getMainExecutor(host), object : BiometricPrompt.AuthenticationCallback() {
      override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
        authenticating = false
        invoke.resolve(JSObject().apply { put("authenticated", true) })
      }
      override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
        authenticating = false; invoke.reject("生物认证未完成，请重试或使用密码")
      }
      // Failed scans stay in the system prompt; they never resolve success.
    })
    try {
      prompt.authenticate(BiometricPrompt.PromptInfo.Builder().setTitle("解锁 Yomika")
        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        .setNegativeButtonText("使用密码").build())
    } catch (_: Throwable) { authenticating = false; invoke.reject("无法启动系统生物认证") }
  }
}
