package app.yomika.reader

import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject
import java.io.File

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // 先挂上崩溃记录再走 super：`WryActivity.onCreate` 正是 Rust 与 WebView 起来的地方，
    // 那里出的异常同样要留痕。
    installJavaCrashRecorder()
    // **沉浸**：系统栏透明、内容画到屏幕边缘。`enableEdgeToEdge()` 不带参数时会给状态栏盖
    // 一层随系统主题走的半透明遮罩（浅色模式下是一层白），压在这个深色应用上就是一条突兀
    // 的亮带——所以这里两个栏都用 `dark(TRANSPARENT)`：栏本身透明，图标明暗随后由应用主题
    // 决定（`MobileHost.setSystemBarStyle`，前端拿到偏好后立刻调一次）。
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    // This matches the last app canvas after activity creation. Android 12's
    // earlier OS launch screen still uses system day/night resources.
    val startup = getSharedPreferences("yomika_startup", MODE_PRIVATE)
    startup.getString("canvas", null)?.let { canvas ->
      applySystemBarAppearance(this, startup.getBoolean("dark", true), canvas)
    }
    super.onCreate(savedInstanceState)

    // 边到边之后，那一圈高度得有人管：系统栏（状态栏、手势条、刘海）交给**页面**——WebView
    // 不会把它交给 `env(safe-area-inset-*)`，所以这里量好，写进页面的 `--safe-top` /
    // `--safe-bottom`；键盘交给**视图**（内边距，等价于旧的 adjustResize），因为页面的视口
    // 高度就是视图高度，压短视图等于压短视口，浮动层、输入框才会跟着让位。
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, windowInsets ->
      applyInsets(view, windowInsets)
    }
    ViewCompat.requestApplyInsets(content)
  }

  private fun applyInsets(view: View, windowInsets: WindowInsetsCompat): WindowInsetsCompat {
    val bars = windowInsets.getInsets(
      WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
    )
    val ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
    // androidx 交来的 inset 是**物理像素**，而页面吃的是 CSS 像素（Android WebView 里
    // 1 CSS px = 1 dp，`devicePixelRatio` 就是 density）：直接写进 `--safe-top` 会大出
    // density 倍——3x 机上状态栏那 24dp 变成 72px，页面顶部与底栏上方各留一条空白
    // （「移动端上下避让过大」）。键盘那一份不换算：它落在**视图**的内边距上，
    // 而 View 本来就以物理像素计。
    val density = resources.displayMetrics.density
    val top = Math.round(bars.top / density)
    val bottom = Math.round(bars.bottom / density)
    view.setPadding(0, 0, 0, ime.bottom)
    SystemBars.top = top
    SystemBars.bottom = bottom
    pushInsetsToPage(appWebView(view), top, bottom)
    // 键盘那一份已经被内边距吃掉了，别再让 WebView 按它缩一次——两次叠加的结果是页面比
    // 可见区域还短一截。
    return WindowInsetsCompat.Builder(windowInsets)
      .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
      .build()
  }

  /**
   * 应用自己那个 WebView（`RustWebView`）。
   *
   * 按类型找而不是「第几个孩子」：登录浮层也是往内容视图上加的，而它用的是普通 WebView，
   * 这里要的始终是应用自己那一个。
   */
  private fun appWebView(root: View): WebView? {
    if (root is RustWebView) return root
    if (root is ViewGroup) {
      for (index in 0 until root.childCount) {
        appWebView(root.getChildAt(index))?.let { return it }
      }
    }
    return null
  }

  /**
   * Java 层的闪退也要留痕。
   *
   * Rust 的 panic 钩子只接得住 Rust panic，而 Android 上「应用一闪就没了」多半是 Java/原生
   * 层的异常（线程约束、JNI、视图被换掉…）：那边崩起来一行 Rust 都不会跑，「错误日志」里
   * 什么都没有，用户只看到应用消失。这里写进 Rust 侧读的那份黑匣子
   * （`<dataDir>/logs/java-crash.log`，一行一条 JSON，下次启动时显示在「上次运行」里）。
   *
   * 记录本身必须绝对安全——记录崩溃的过程再崩一次就什么都留不下——所以整段包在
   * `runCatching` 里，而且无论成败都把异常交回原来的处理器（系统该杀还是照杀）。
   */
  private fun installJavaCrashRecorder() {
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, error ->
      runCatching {
        val directory = File(dataDir, "logs")
        directory.mkdirs()
        val line = JSONObject().apply {
          // 与 Rust 侧 `now_stamp()` 同一种写法：界面按需把它换成本地时间。
          put("at", "epoch:" + System.currentTimeMillis())
          put("level", "error")
          put("source", "core/java-crash")
          put("message", LogRedaction.text(thread.name + " · " + error.toString()))
          put("detail", LogRedaction.text(error.stackTrace.joinToString("\n") { it.toString() }))
        }
        File(directory, "java-crash.log").appendText(line.toString() + "\n")
      }
      previous?.uncaughtException(thread, error)
    }
  }
}
