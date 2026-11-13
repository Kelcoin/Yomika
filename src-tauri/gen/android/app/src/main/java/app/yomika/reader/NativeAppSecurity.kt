package app.yomika.reader

import android.app.Activity
import android.app.ActivityManager
import android.content.Context
import android.graphics.Color
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
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
  private var backgroundSince: Long? = null
  private var lockGeneration: Long = 0
  private var activePrompt: BiometricPrompt? = null
  var authenticating = false
    private set
  private fun prefs(activity: Activity) = activity.getSharedPreferences("yomika_security", Context.MODE_PRIVATE)
  private fun protected(activity: Activity): Boolean = prefs(activity).let { it.getBoolean("protectionEnabled", it.getBoolean("passwordEnabled", false)) }
  private fun authenticators(): Int = BiometricManager.Authenticators.BIOMETRIC_WEAK or
    (if (Build.VERSION.SDK_INT >= 30) BiometricManager.Authenticators.DEVICE_CREDENTIAL else 0)
  fun available(activity: Activity) = activity is FragmentActivity && BiometricManager.from(activity)
    .canAuthenticate(authenticators()) == BiometricManager.BIOMETRIC_SUCCESS
  fun initialize(activity: Activity) {
    backgrounded = false
    backgroundSince = null
    locked = protected(activity)
    if (locked) lockGeneration++
    applyFlags(activity)
    if (locked) showCover(activity)
  }
  private fun applyFlags(activity: Activity) {
    // Clear older persisted screenshot blocking; privacy is limited to task previews.
    activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    if (Build.VERSION.SDK_INT >= 33) {
      val hidePreview = prefs(activity).getBoolean("hidePreview", false)
      // With snapshots disabled, Android synthesizes a task image using these
      // colors. A transparent/default status bar otherwise becomes a black strip.
      val canvas = activity.getSharedPreferences("yomika_startup", Context.MODE_PRIVATE).getString("canvas", null)
      val background = if (hidePreview) Color.rgb(13, 13, 13) else try { Color.parseColor(canvas ?: "#0d0d0d") } catch (_: IllegalArgumentException) { Color.rgb(13, 13, 13) }
      activity.setTaskDescription(ActivityManager.TaskDescription.Builder()
        .setLabel(activity.title.toString()).setIcon(R.mipmap.ic_launcher)
        .setPrimaryColor(background).setBackgroundColor(background)
        .setStatusBarColor(background).setNavigationBarColor(background).build())
      activity.setRecentsScreenshotEnabled(!hidePreview)
    }
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
  private fun applyBackgroundDeadline(activity: Activity) {
    val since = backgroundSince ?: return
    val p = prefs(activity)
    if (protected(activity) && p.getBoolean("lockOnBackground", false)
        && SystemClock.elapsedRealtime() - since >= p.getInt("backgroundLockSeconds", 0).toLong() * 1000L && !locked) {
      locked = true
      lockGeneration++
    }
  }
  private fun enterBackground(activity: Activity) {
    if (backgroundSince == null) backgroundSince = SystemClock.elapsedRealtime()
    backgrounded = true
    applyBackgroundDeadline(activity)
    if (locked || prefs(activity).getBoolean("hidePreview", false)) showCover(activity)
  }
  fun pause(activity: Activity) {
    if (authenticating) return
    enterBackground(activity)
  }
  fun stop(activity: Activity) {
    // SystemUI's credential Activity is part of our official authentication.
    if (authenticating && activity.getSystemService(PowerManager::class.java).isInteractive) return
    if (authenticating) userLeave(activity)
    enterBackground(activity)
  }
  fun userLeave(activity: Activity) {
    if (!authenticating) return
    // Home/Recents is a real user departure, unlike the OS credential Activity.
    lockGeneration++
    backgrounded = true
    activePrompt?.cancelAuthentication()
    showCover(activity)
  }
  fun resume(activity: Activity, web: WebView?) {
    applyBackgroundDeadline(activity)
    backgroundSince = null
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
    applyBackgroundDeadline(activity)
    put("locked", locked && protected(activity))
    put("biometricAvailable", available(activity))
    put("lockGeneration", lockGeneration)
  }
  fun configure(activity: Activity, args: SecurityConfigureArgs) {
    check(args.expectedLockGeneration < 0 || args.expectedLockGeneration == lockGeneration) { "安全状态已更改，请重新认证" }
    check(prefs(activity).edit().putBoolean("protectionEnabled", args.protectionEnabled).remove("passwordEnabled")
      .putBoolean("lockOnBackground", args.lockOnBackground).putInt("backgroundLockSeconds", args.backgroundLockSeconds).putBoolean("hidePreview", args.hidePreview).commit()) { "无法保存原生安全设置" }
    // An auth response arriving after onPause/onStop cannot clear a background lock.
    locked = args.protectionEnabled && args.locked
    applyBackgroundDeadline(activity)
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
        activePrompt = null
        invoke.resolve(JSObject().apply { put("authenticated", true) })
      }
      override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
        authenticating = false; activePrompt = null; invoke.reject("系统认证未完成，请重试或使用手势密码")
      }
      // Failed scans stay in the system prompt; they never resolve success.
    })
    activePrompt = prompt
    try {
      val info = BiometricPrompt.PromptInfo.Builder().setTitle("解锁 Yomika")
        .setAllowedAuthenticators(authenticators())
      if (Build.VERSION.SDK_INT < 30) info.setNegativeButtonText("使用图案")
      prompt.authenticate(info.build())
    } catch (_: Throwable) { authenticating = false; activePrompt = null; invoke.reject("无法启动系统认证") }
  }
}
