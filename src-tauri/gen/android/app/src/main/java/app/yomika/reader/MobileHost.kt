package app.yomika.reader

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import app.tauri.plugin.PluginManager
import org.json.JSONObject
import java.io.File

@InvokeArg
class EhLoginOpenArgs {
  lateinit var url: String
  lateinit var userAgent: String
}

@InvokeArg
class WriteTextFileArgs {
  lateinit var path: String
  lateinit var contents: String
}

@InvokeArg
class ReadTextFileArgs {
  lateinit var path: String
}

@InvokeArg
class OpenUrlArgs {
  lateinit var url: String
}

@InvokeArg
class SystemBarStyleArgs {
  var dark: Boolean = false
  /** 窗口底色（`#rrggbb`）：页面画上来之前露出来的就是它，跟主题一致才不会闪一下白。 */
  var background: String = "#0D0D0D"
}

@InvokeArg
class VibrateArgs {
  /** `light` / `medium` / `heavy` / `selection`，映射到系统预置的那几种效果。 */
  var kind: String = "medium"
}

/** 最近一次量到的系统栏高度（CSS 像素）：`MainActivity` 写，`insets` 命令读。 */
object SystemBars {
  var top: Int = 0
  var bottom: Int = 0
}

private var insetScript: String? = null

/**
 * 把系统栏高度交给页面：`--safe-top` / `--safe-bottom` 是页面自己的语言（`tokens.css` 里
 * 那两条先由 `env(safe-area-inset-*)` 兜底，而 Android 上那边是 0——WebView 只把刘海交给
 * `env()`，状态栏与手势条的高度从来不暴露给 CSS）。
 *
 * 两件事一起做：
 * - 写进**当前文档**：旋转、手势条切换这类运行时变化靠它；
 * - 登记一条 **document-start 脚本**：每次新文档一开始就写好，所以重新加载也不会先画错
 *   位置（脚本自己等 `DOMContentLoaded`，那时 `documentElement` 才一定在）。
 *
 * 同一种高度只登记一次：这一版 androidx.webkit（1.14.0）**没有**移除 document-start 脚本
 * 的 API，而高度一共就那么几种（竖屏/横屏 × 手势条开关），按值去重之后不会越攒越多。
 * 页面启动时还会通过 `system_insets` 命令再问一次（见 `lib/safeArea`），所以即使这里的值
 * 落后一格也会被纠正回来。
 */
fun pushInsetsToPage(web: WebView?, top: Int, bottom: Int) {
  val target = web ?: return
  val values = "document.documentElement.style.setProperty('--safe-top','${top}px');" +
    "document.documentElement.style.setProperty('--safe-bottom','${bottom}px');"
  target.evaluateJavascript(values, null)
  if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
  val script = "window.addEventListener('DOMContentLoaded',function(){$values});"
  if (script == insetScript) return
  insetScript = script
  runCatching { WebViewCompat.addDocumentStartJavaScript(target, script, setOf("*")) }
}

/**
 * 状态栏/导航栏图标跟着**应用主题**：图标明暗是系统按「栏是亮是暗」选的，而应用可以整体
 * 是深色、系统却是浅色——那时深色图标落在深色栏上等于看不见（「状态栏很突兀」有一半是它）。
 * 顺带把窗口底色也定下来：页面画上来之前露出的就是这一层。
 */
fun applySystemBarAppearance(activity: Activity, dark: Boolean, background: String) {
  val color = runCatching { Color.parseColor(background) }.getOrNull()
  if (color != null) {
    activity.window?.setBackgroundDrawable(ColorDrawable(color))
  }
  val window = activity.window ?: return
  val controller = WindowInsetsControllerCompat(window, window.decorView)
  controller.isAppearanceLightStatusBars = !dark
  controller.isAppearanceLightNavigationBars = !dark
}

/**
 * 原生宿主：Rust 够不着、只有 Android 侧做得成的两件事。
 *
 * **登录页**。应用自己的 WebView 就是 activity 的内容视图（wry 建 webview 时对它调
 * `setContentView`），所以「另开一个窗口」会把应用自己的界面顶掉，「顶层导航走」等于把
 * 应用整个换掉——两条都试过，两条都闪退。这里换个方向：往内容视图**上面**再叠一层
 * WebView，应用原样在下面活着，登录页只是一层浮层（JHenTai 就是这么做的，它把 WebView
 * 当控件放进自己的页面）。Cookie 读出来交给 Rust 判，这里不做「算不算登录成功」的判断。
 *
 * **写文件**。`dialog.save` 在 Android 上给回来的是 SAF 的 `content://` URI，Rust 侧的
 * `std::fs` 写不了它，得用 ContentResolver。
 *
 * 命令都跑在主线程（Tauri 把插件调用派发到 Android 主线程），所以这里可以直接碰视图。
 */
@TauriPlugin
class MobileHost(private val hostActivity: Activity) : Plugin(hostActivity) {
  private companion object {
    /** 读 Cookie 的三个域，与 Rust 侧 `COOKIE_ORIGINS` 同一份名单。 */
    val COOKIE_URLS = listOf(
      "https://forums.e-hentai.org",
      "https://e-hentai.org",
      "https://exhentai.org",
    )

    /** 浮层（它的父视图就是活动的内容视图）、里面的 WebView、返回键回调。 */
    var sheet: View? = null
    var sheetWeb: WebView? = null
    var backCallback: OnBackPressedCallback? = null

    /** 最近一次看到的 Cookie（三个域的原文拼在一起）。不做筛选：那是 Rust 的事。 */
    var latestCookies: String = ""
  }

  /**
   * 打开登录页浮层。已经开着就什么都不做——重复点按钮不该叠出第二层。
   */
  @Command
  fun ehLoginOpen(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(EhLoginOpenArgs::class.java)
      if (sheet == null) {
        showSheet(args.url, args.userAgent)
      }
      invoke.resolve()
    } catch (error: Throwable) {
      invoke.reject(error.message ?: "打开登录页失败")
    }
  }

  /** 原生侧现在看到什么：`cookie` 是 Cookie 头的原文，`open` 是浮层还在不在。 */
  @Command
  fun ehLoginPoll(invoke: Invoke) {
    try {
      invoke.resolve(JSObject().apply {
        put("cookie", latestCookies)
        put("open", sheet != null)
      })
    } catch (error: Throwable) {
      invoke.reject(error.message ?: "读登录状态失败")
    }
  }

  /** 关掉浮层（登录成功、超时、用户取消都走这里）。 */
  @Command
  fun ehLoginClose(invoke: Invoke) {
    try {
      closeSheet()
      invoke.resolve()
    } catch (error: Throwable) {
      invoke.reject(error.message ?: "关闭登录页失败")
    }
  }

  /**
   * 写一份文本到用户选定的位置。SAF 给的是 `content://` URI（系统的「新建文档」已经把
   * 文件建好了，零字节），普通路径直接写文件。
   */
  @Command
  fun writeTextFile(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(WriteTextFileArgs::class.java)
      val bytes = args.contents.toByteArray(Charsets.UTF_8)
      if (args.path.startsWith("content://")) {
        val stream = hostActivity.contentResolver.openOutputStream(Uri.parse(args.path))
          ?: throw IllegalStateException("无法写入所选位置")
        stream.use { it.write(bytes) }
      } else {
        File(args.path).writeBytes(bytes)
      }
      invoke.resolve(JSObject().apply { put("bytes", bytes.size) })
    } catch (error: Throwable) {
      invoke.reject(error.message ?: "写入文件失败")
    }
  }

  /**
   * 读一份用户选定的文本（「从文件导入」）。与 `writeTextFile` 对称：SAF 给的是
   * `content://` URI，只有 ContentResolver 读得动。
   */
  @Command
  fun readTextFile(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ReadTextFileArgs::class.java)
      val bytes = if (args.path.startsWith("content://")) {
        val stream = hostActivity.contentResolver.openInputStream(Uri.parse(args.path))
          ?: throw IllegalStateException("无法读取所选文件")
        stream.use { it.readBytes() }
      } else {
        File(args.path).readBytes()
      }
      invoke.resolve(JSObject().apply { put("contents", String(bytes, Charsets.UTF_8)) })
    } catch (error: Throwable) {
      invoke.reject(error.message ?: "读取文件失败")
    }
  }

  /**
   * 用系统浏览器打开链接。手机上这是唯一的一条路（`open_external_url` 的 Android 分支
   * 走这里）——没有它，文档链接、来源链接、仓库地址全都是点不动的。
   */
  @Command
  fun openExternalUrl(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(OpenUrlArgs::class.java)
      hostActivity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(args.url)))
      invoke.resolve()
    } catch (error: Throwable) {
      invoke.reject(error.message ?: "打不开这个链接")
    }
  }

  /** 系统栏占掉的高度（CSS 像素），给页面避开自己的顶部栏与底部栏用。 */
  @Command
  fun insets(invoke: Invoke) {
    try {
      invoke.resolve(JSObject().apply {
        put("top", SystemBars.top)
        put("bottom", SystemBars.bottom)
      })
    } catch (error: Throwable) {
      invoke.reject(error.message ?: "读不到系统栏高度")
    }
  }

  /** 系统栏图标的明暗与窗口底色：跟着应用主题（见 [applySystemBarAppearance]）。 */
  @Command
  fun setSystemBarStyle(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SystemBarStyleArgs::class.java)
      applySystemBarAppearance(hostActivity, args.dark, args.background)
      invoke.resolve()
    } catch (error: Throwable) {
      invoke.reject(error.message ?: "设置系统栏失败")
    }
  }

  /**
   * 触感：长按这类「按住了」的确认（页面的 `hapticFeedback` 走这里）。
   *
   * 只在这台设备真有马达时动手——模拟器与部分平板 `hasVibrator()` 就是 false，那时安静
   * 收场：震动是可选的确认，不是功能本身。缺 `VIBRATE` 权限时系统会静默忽略，所以那条
   * 权限是必需的（见 `AndroidManifest.xml`）。
   */
  @Command
  fun vibrate(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(VibrateArgs::class.java)
      val vibrator = vibratorOf()
      if (vibrator?.hasVibrator() == true) {
        vibrateOnce(vibrator, args.kind)
      }
      invoke.resolve()
    } catch (error: Throwable) {
      invoke.reject(error.message ?: "震动失败")
    }
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun showSheet(url: String, userAgent: String) {
    // 活动和内容视图从 PluginManager 拿：那是个 AppCompatActivity（`onBackPressedDispatcher`
    // 要 LifecycleOwner），也是 Tauri 自己记着的那一个。
    val app: AppCompatActivity = PluginManager.activity
    val root = app.findViewById<ViewGroup>(android.R.id.content)
      ?: throw IllegalStateException("应用没有内容视图")

    val web = WebView(app)
    web.settings.javaScriptEnabled = true
    web.settings.domStorageEnabled = true
    // 登录页的 UA 要和后面重放 HTTP 请求的那个一致：Cloudflare 的通行证是按 UA 绑定的
    // （Rust 侧传进来的就是 `EH_CLIENT_UA`）。
    web.settings.userAgentString = userAgent
    // 登录页会从 e-hentai.org 取资源，第三方 Cookie 得放行（Android 5 起默认是关的）。
    CookieManager.getInstance().setAcceptCookie(true)
    CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
    web.webViewClient = object : WebViewClient() {
      override fun onPageStarted(view: WebView, pageUrl: String, favicon: android.graphics.Bitmap?) {
        noteStep("浮层：开始加载 $pageUrl")
      }

      override fun onPageFinished(view: WebView, pageUrl: String) {
        latestCookies = readCookies()
        noteStep("浮层：加载完成 $pageUrl")
      }
    }

    val container = FrameLayout(app)
    val column = LinearLayout(app)
    column.orientation = LinearLayout.VERTICAL
    column.setBackgroundColor(Color.parseColor("#0D0D0D"))

    // 顶上一条自己的栏：页面上没有能点的「关闭」，系统返回键又只管应用自己的 webview。
    val bar = LinearLayout(app)
    bar.orientation = LinearLayout.HORIZONTAL
    bar.gravity = Gravity.CENTER_VERTICAL
    bar.setBackgroundColor(Color.parseColor("#1A1A1A"))
    bar.setPadding(dp(16), dp(8), dp(16), dp(8))
    val close = TextView(app)
    close.text = "关闭"
    close.setTextColor(Color.parseColor("#F2F2F2"))
    close.textSize = 16f
    close.setPadding(dp(12), dp(10), dp(12), dp(10))
    close.setOnClickListener { closeSheet() }
    bar.addView(close)
    val title = TextView(app)
    title.text = "登录 E-Hentai"
    title.setTextColor(Color.parseColor("#9A9A9A"))
    title.textSize = 14f
    title.setPadding(dp(12), 0, 0, 0)
    bar.addView(title)
    column.addView(
      bar,
      LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
    )
    column.addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    container.addView(
      column,
      FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )

    // 返回键先给这一层：能往登录页的历史里退就退，退无可退才关掉浮层。
    // 活动自己的回调（WryActivity 装的那个）管的是应用那个 webview，会把应用翻得不知所云。
    val callback = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        if (web.canGoBack()) {
          web.goBack()
        } else {
          closeSheet()
        }
      }
    }
    app.onBackPressedDispatcher.addCallback(app, callback)

    sheet = container
    sheetWeb = web
    backCallback = callback
    latestCookies = ""
    noteStep("浮层：已呈现")
    root.addView(container)
    web.loadUrl(url)
  }

  private fun closeSheet() {
    val wasOpen = sheet != null
    backCallback?.let { callback ->
      callback.isEnabled = false
      callback.remove()
    }
    backCallback = null
    val web = sheetWeb
    sheetWeb = null
    val container = sheet
    sheet = null
    if (web != null) {
      (web.parent as? ViewGroup)?.removeView(web)
      web.stopLoading()
      web.destroy()
    }
    if (container != null) {
      (container.parent as? ViewGroup)?.removeView(container)
    }
    if (wasOpen) {
      noteStep("浮层：已关闭")
    }
  }

  /**
   * 黑匣子：浮层里发生的、Rust 看不到的步骤也写进同一份 `logs/crash.log`（JSON 行，字段与
   * Rust 那边一致）。下一次启动读出来时，就能看出登录页到底加载到哪一步才出的事——真崩在
   * Java/原生层的话，这是唯一还能说话的记录。
   */
  private fun noteStep(step: String) {
    runCatching {
      val directory = File(hostActivity.applicationInfo.dataDir, "logs")
      directory.mkdirs()
      val line = JSONObject().apply {
        put("at", "epoch:" + System.currentTimeMillis())
        put("level", "warn")
        put("source", "eh/in-app-login")
        put("message", step)
        put("detail", JSONObject.NULL)
      }
      File(directory, "crash.log").appendText(line.toString() + "\n")
    }
  }

  /** 三个域的 Cookie 原文拼在一起（不筛：会话规则只有 Rust 那一处）。 */
  private fun readCookies(): String {
    val manager = CookieManager.getInstance()
    return COOKIE_URLS
      .mapNotNull { manager.getCookie(it) }
      .filter { it.isNotBlank() }
      .joinToString("; ")
  }

  private fun dp(value: Int): Int =
    (value * hostActivity.resources.displayMetrics.density).toInt()

  /** API 31 起震动器归 `VibratorManager` 管（一台设备可能挂好几个），之前是系统服务里的
   *  那一个。两者都拿不到就是没有马达。 */
  private fun vibratorOf(): Vibrator? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val manager = hostActivity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
      manager?.defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      hostActivity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }

  /** 档位 → 系统预置效果（`createPredefined` 从 API 29 起）。minSdk 是 24，低版本退成一段
   *  一次性振动：手感粗一点，但「按住了」这件事照样感觉得到。 */
  private fun vibrateOnce(vibrator: Vibrator, kind: String) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val effect = when (kind) {
        "light" -> VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK)
        "heavy" -> VibrationEffect.createPredefined(VibrationEffect.EFFECT_HEAVY_CLICK)
        "selection" -> VibrationEffect.createPredefined(VibrationEffect.EFFECT_CLICK)
        else -> VibrationEffect.createPredefined(VibrationEffect.EFFECT_CLICK)
      }
      vibrator.vibrate(effect)
      return
    }
    val milliseconds = when (kind) {
      "light", "selection" -> 10L
      "heavy" -> 40L
      else -> 22L
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      vibrator.vibrate(VibrationEffect.createOneShot(milliseconds, VibrationEffect.DEFAULT_AMPLITUDE))
      return
    }
    @Suppress("DEPRECATION")
    vibrator.vibrate(milliseconds)
  }
}
