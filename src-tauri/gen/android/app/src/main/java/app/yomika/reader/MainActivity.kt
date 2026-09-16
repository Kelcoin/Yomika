package app.yomika.reader

import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Edge-to-edge 是 Android 15（targetSdk 35+）强制的：WebView 会铺到状态栏与
    // 导航栏底下。
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // 但 CSS 拿不到这些高度：Chromium 只把「物理刘海」交给 env(safe-area-inset-*)，
    // 状态栏与手势条的高度从来不暴露给页面（见 README 的运行说明）。所以这里在
    // 原生侧把 insets 让出来——给内容视图加内边距，WebView 本身就被推到系统栏
    // 之内，页面视口随之避开它们；页面上那些 env() 内边距在 Android 上保持 0，
    // 不会和这里叠加。旋转、折叠、手势条切换都会重新回调，所以每次重设。
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, windowInsets ->
      val bars = windowInsets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      windowInsets
    }
  }
}
