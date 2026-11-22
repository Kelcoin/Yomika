# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# 原生宿主（登录浮层 + SAF 写文件）与它的参数类：类名由 Rust 侧 `Class.forName` 解析、
# 命令按方法名反射派发、参数对象由 Jackson 按字段名填——R8 这三样都看不见，release 里
# 一压缩就全没了（表现是「登录页打不开」，而不是崩溃，所以更难查）。
-keep class app.yomika.reader.MobileHost { *; }
-keep class app.yomika.reader.ReaderKeyboardOverlayArgs { *; }
-keep class app.yomika.reader.EhLoginOpenArgs { *; }
-keep class app.yomika.reader.WriteTextFileArgs { *; }-keep class app.yomika.reader.PrepareReaderSlotArgs { *; }
