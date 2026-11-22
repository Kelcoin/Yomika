package app.yomika.reader

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.ImageDecoder as PlatformImageDecoder
import android.graphics.drawable.AnimatedImageDrawable
import android.graphics.drawable.Drawable
import android.os.Build
import android.graphics.PointF
import android.graphics.Rect
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.util.Log
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewGroup
import android.view.ViewConfiguration
import android.view.animation.PathInterpolator
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.davemorrissey.labs.subscaleview.ImageSource
import com.davemorrissey.labs.subscaleview.SubsamplingScaleImageView
import com.davemorrissey.labs.subscaleview.decoder.ImageDecoder
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.Executors

/** The WebView draws controls. Ready static pages render and animate underneath it. */
internal class ReaderTiles(private val web: WebView) {
    private val io = Executors.newSingleThreadExecutor()
    private val main = android.os.Handler(android.os.Looper.getMainLooper())
    private val slots = mutableMapOf<Int, SubsamplingScaleImageView?>()
    // Reserve a decode thread for the displayed page. Preparing neighbours
    // and derived slots must leave capacity for the page being pinched.
    private val visibleDecode = Executors.newSingleThreadExecutor()
    private val prefetchDecode = Executors.newSingleThreadExecutor()
    private val jobs = mutableMapOf<Int, TileJobs>()
    // recycle() takes SSIV's decoder write lock. Detach immediately, skip stale
    // queued reads, then recycle on the UI thread after the last read releases it.
    private inner class TileJobs(
        private val id: Int,
        val view: SubsamplingScaleImageView,
        private val sources: List<ParcelFileDescriptor>,
    ) : java.util.concurrent.Executor {
        @Volatile private var retired = false
        private var outstanding = 0 // accessed on the WebView thread only
        override fun execute(task: Runnable) {
            if (retired) return
            outstanding++
            val executor = if (id == selected || view === underlay || view === showing || id in continuousPresented) {
                visibleDecode
            } else {
                prefetchDecode
            }
            executor.execute {
                try { if (!retired) task.run() }
                finally { main.post {
                    outstanding--
                    if (retired && outstanding == 0) release()
                } }
            }
        }
        fun retire() {
            retired = true
            if (outstanding == 0) release()
        }
        private fun release() {
            try { view.recycle() }
            finally { sources.forEach { runCatching { it.close() } } }
        }
    }
    private var selected = 0
    private var turnLeft = 0
    private var turnRight = 0
    private var reduceTurnMotion = false
    private var allowTurn = false
    private data class Swipe(
        val from: SubsamplingScaleImageView,
        val to: SubsamplingScaleImageView,
        val end: Float,
        var offset: Float = 0f,
        val onSettled: (() -> Unit)? = null,
        val resetFromZoom: Boolean = false,
    )
    private var swipe: Swipe? = null
    private var swipeAnimation: ValueAnimator? = null
    private val swipeEasing = PathInterpolator(.22f, .45f, .28f, 1f)
    private val edgeEasing = PathInterpolator(.22f, 1f, .36f, 1f)
    private var edgeView: View? = null
    private data class ReaderPage(val session: Long, val number: Int)
    private val View.readerPage: ReaderPage
        get() = tag as ReaderPage
    private fun JSONObject.readerPage() = ReaderPage(getLong("session"), getInt("page"))
    private val committedSlots = mutableMapOf<ReaderPage, Int>()
    private var singleTouch = false
    private var turnVelocity: VelocityTracker? = null
    private var webSwipe = false
    // A replacement and its predecessor may both be requested until React
    // receives the presentation acknowledgement and retires the predecessor.
    private data class Viewport(val scale: Float, val x: Float, val y: Float)
    private data class Presentation(val replacement: Boolean, val viewport: Viewport?)
    private val presentations = LinkedHashMap<Int, Presentation>()
    private val viewportRequests = mutableMapOf<Int, ReaderPage>()
    // SSIV applies setScaleAndCenter on its next draw. Keep the requested
    // viewport available if another replacement arrives before that draw.
    private var pendingViewport: Pair<SubsamplingScaleImageView, Viewport>? = null
    private val retiringAfterWebFrame = mutableSetOf<Int>()
    private data class SuspendedView(val page: ReaderPage, val viewport: Viewport, val maxRelativeScale: Float)
    private var suspendedView: SuspendedView? = null
    private var paused = false
    private var underlay: SubsamplingScaleImageView? = null
    private val continuousRects = mutableMapOf<Int, Rect>()
    private var continuousScrollTop = 0
    private val continuousInput = ReaderContinuousScroll(web, { offset ->
        continuousScrollTop = offset
        continuousRects.keys.forEach(::placeContinuous)
    }, { session, revision, sample, offset ->
        web.evaluateJavascript("window.dispatchEvent(new CustomEvent('yomika-reader-continuous-scroll',{detail:{session:$session,revision:$revision,sample:$sample,offset:$offset}}))", null)
    })
    private val continuousPresented = mutableSetOf<Int>()
    private val continuousCropped = mutableSetOf<Int>()
    private var webTransparent = false
    private var previousWebBackground: android.graphics.drawable.Drawable? = null
    private var showing: SubsamplingScaleImageView? = null
    private var nativeTouchActive = false
    private var nativePanStarted = false
    private data class GestureSample(val x: Float, val y: Float, val span: Float = 0f)
    private class ImageGesture(
        val width: Int, val height: Int, val screenX: Int, val screenY: Int,
        var transform: ReaderImageTransform, var sample: GestureSample,
        var rawScale: Float,
    )
    private var imageGesture: ImageGesture? = null
    private var pinchReturn: ValueAnimator? = null
    private var zoomAnimation: ValueAnimator? = null
    private val touchSlop = ViewConfiguration.get(web.context).scaledTouchSlop
    private var down: MotionEvent? = null
    private val localOrigins = setOf("http://tauri.localhost", "https://tauri.localhost")

    init {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "YomikaTiles", localOrigins) { _, msg, _, main, _ ->
                if (main) runCatching {
                    val args = JSONObject(msg.data ?: return@runCatching)
                    val id = args.getInt("id")
                    when (args.getString("op")) {
                        "select" -> {
                            if (selected != id && showing != null && slots[id]?.tag != showing?.tag) hide()
                            selected = id
                            allowTurn = args.has("left") && args.has("right")
                            turnLeft = args.optInt("left")
                            turnRight = args.optInt("right")
                            reduceTurnMotion = args.optBoolean("reduceMotion")
                        }
                        "arm" -> committedSlots[args.readerPage()] = id
                        "disarm" -> {
                            val page = args.readerPage()
                            if (committedSlots[page] == id) committedSlots.remove(page)
                        }
                        "deselect" -> if (selected == id && id !in retiringAfterWebFrame) {
                            if (showing === slots[id]) hide()
                            selected = 0
                            updateUnderlay()
                        }
                        "present" -> {
                            val input = args.optJSONObject("viewport")
                            val viewport = input?.let {
                                Viewport(it.optDouble("scale").toFloat(), it.optDouble("x").toFloat(), it.optDouble("y").toFloat())
                            }?.takeIf { it.scale > 1f && it.scale.isFinite() && it.x.isFinite() && it.y.isFinite() }
                            requestPresentation(id, args.optBoolean("replacement"), viewport)
                        }
                        "viewport" -> {
                            viewportRequests[id] = args.readerPage()
                            reportViewports()
                        }
                        "continuous-input" -> continuousInput.configure(
                            args.optLong("session"), args.optBoolean("active"),
                            args.optInt("limit", -1), args.optBoolean("reduceMotion"), args.optInt("scrollTop"),
                        )
                        "continuous-reposition" -> continuousInput.reposition(
                            args.optLong("session"), args.optInt("revision"),
                            args.optInt("offset"), args.optBoolean("relative"),
                        )
                        "continuous-layout" -> {
                            continuousScrollTop = continuousInput.layoutOffset(
                                args.optLong("session"), args.optInt("revision"), args.optInt("sample"), args.optInt("scrollTop"),
                            )
                            val entries = args.optJSONArray("entries")
                            if (entries != null) {
                                val old = continuousRects.keys.toSet()
                                val incoming = mutableSetOf<Int>()
                                for (index in 0 until entries.length()) {
                                    val entry = entries.getJSONObject(index)
                                    val slot = entry.getInt("id")
                                    val rect = entry.getJSONArray("rect")
                                    val left = rect.getInt(0)
                                    val top = rect.getInt(1)
                                    val width = rect.getInt(2).coerceIn(0, web.width)
                                    val height = rect.getInt(3).coerceAtLeast(0)
                                    continuousRects[slot] = Rect(left, top, left + width, top + height)
                                    incoming.add(slot)
                                }
                                // The old image stays visible until Chromium commits a
                                // decoded replacement, even when its anchor is gone.
                                (old - incoming - retiringAfterWebFrame).forEach(::hideContinuous)
                            }
                            continuousRects.keys.forEach(::placeContinuous)
                        }
                        "continuous-hide" -> if (id !in retiringAfterWebFrame) hideContinuous(id)
                        "unpresent" -> if (id !in retiringAfterWebFrame && presentations.remove(id) != null) updateUnderlay()
                        "fit-for-turn" -> showing?.let { view ->
                            if (view.tag == args.readerPage() && nearFit(view)) {
                                if (args.optBoolean("reduceMotion")) view.resetScaleAndCenter()
                                else animateFit(view)
                            }
                        }
                        "edge-drag" -> dragEdge(args.readerPage(), args.getDouble("offset").toFloat(), args.optLong("duration"))
                        "double-tap" -> doubleTap(
                            args.readerPage(), args.getDouble("x").toFloat(),
                            args.getDouble("y").toFloat(), args.optBoolean("reduceMotion"),
                        )
                        "drop-after-web-frame" -> dropAfterWebFrame(id)
                        "prepare" -> prepare(id, args.getString("hash"), args.readerPage())
                        "drop" -> drop(id)
                    }
                }
            }
        }
    }

    private fun canPrepare(id: Int) = id > 0 && id !in slots && slots.size < 6

    fun prepareLeased(id: Int, page: Int, fd: Int, rightFd: Int, aspect: Float, session: Long, animationFd: Int, rightAnimationFd: Int): Boolean {
        if (!canPrepare(id) || fd < 0 || page < 1 || session < 1) return false
        if (rightFd >= 0 && (!aspect.isFinite() || aspect !in 0.1f..10f)) return false
        val sources = mutableListOf<ParcelFileDescriptor>()
        val frameSources = mutableListOf<ParcelFileDescriptor?>()
        fun duplicate(descriptor: Int) = ParcelFileDescriptor.open(File("/proc/self/fd/$descriptor"), ParcelFileDescriptor.MODE_READ_ONLY)
        try {
            sources += duplicate(fd)
            if (rightFd >= 0) sources += duplicate(rightFd)
            frameSources += if (animationFd >= 0) duplicate(animationFd) else null
            if (rightFd >= 0) frameSources += if (rightAnimationFd >= 0) duplicate(rightAnimationFd) else null
        } catch (_: Exception) {
            (sources + frameSources.filterNotNull()).forEach { runCatching { it.close() } }
            return false
        }
        prepareFile(id, ReaderPage(session, page), leased = true, aspect, frameSources) { sources }
        return true
    }

    private fun prepare(id: Int, hash: String, page: ReaderPage) {
        if (!canPrepare(id) || page.session < 1 || page.number < 1 || !hash.matches(Regex("[a-f0-9]{64}"))) return
        val file = File(web.context.cacheDir, "images/${hash.take(2)}/$hash.bin")
        prepareFile(id, page) {
            listOf(ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY))
        }
    }

    private fun prepareFile(
        id: Int, page: ReaderPage, leased: Boolean = false, aspect: Float = 1f,
        frameSources: List<ParcelFileDescriptor?> = emptyList(), open: () -> List<ParcelFileDescriptor>,
    ) {
        slots[id] = null
        io.execute {
            val sources = runCatching(open).getOrDefault(emptyList())
            val files = sources.map { File("/proc/self/fd/${it.fd}") }
            val sizes = files.map { file ->
                runCatching { staticTileSize(file, requireLarge = !leased) }.getOrNull()
            }
            val animations = files.mapIndexed { index, file ->
                val packed = frameSources.getOrNull(index)
                when {
                    packed != null -> runCatching { ReaderApngDrawable.decode(packed) }.getOrNull()
                    leased && sizes[index] == null -> decodePlatformAnimation(file)
                    else -> null
                }
            }
            val pageSizes = sizes.mapIndexed { index, size ->
                size ?: animations[index]?.let { android.graphics.Point(it.intrinsicWidth, it.intrinsicHeight) }
            }
            if (pageSizes.isEmpty() || pageSizes.any { it == null }) {
                sources.forEach { runCatching { it.close() } }
                if (leased) main.post { if (id in slots) reportStatus(id) }
                return@execute
            }
            // Use the activity's main looper, so a detached WebView cannot hold
            // a preparation callback (and its open file) until reattachment.
            main.post {
                val parent = web.parent as? ViewGroup
                if (parent == null || id !in slots) {
                    sources.forEach { runCatching { it.close() } }
                    return@post
                }
                val animated = if (animations.any { it != null }) ReaderAnimatedView(web.context, animations) else null
                val tiles = animated ?: SubsamplingScaleImageView(web.context)
                slots[id] = tiles
                val tileJobs = TileJobs(id, tiles, sources)
                jobs[id] = tileJobs
                tiles.setExecutor(tileJobs)
                tiles.setEagerLoadingEnabled(false)
                tiles.tag = page
                tiles.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
                tiles.alpha = 0.001f
                tiles.isClickable = false
                tiles.setOnTouchListener { _, _ -> false }
                if (animated != null || files.size == 2) {
                    fun spreadDecoder() = if (animated == null) ReaderSpreadDecoder(files, aspect)
                        else ReaderSpreadDecoder(files, aspect, animated.animatedSizes) { animated.imageBounds = it }
                    tiles.setRegionDecoderFactory { spreadDecoder() }
                    tiles.setBitmapDecoderFactory {
                        ImageDecoder { context, uri ->
                            val decoder = spreadDecoder()
                            try {
                                val size = decoder.init(context, uri)
                                decoder.decodeRegion(Rect(0, 0, size.x, size.y), 1)
                            } finally {
                                decoder.recycle()
                            }
                        }
                    }
                } else {
                    tiles.orientation = SubsamplingScaleImageView.ORIENTATION_USE_EXIF
                }
                tiles.setMaxTileSize(2048)
                tiles.setMaxScale(4f)
                tiles.setOnImageEventListener(object : SubsamplingScaleImageView.DefaultOnImageEventListener() {
                    override fun onReady() {
                        if (slots[id] !== tiles) return
                        Log.i("YomikaTiles", "ready page=${page.number} ${tiles.sWidth}x${tiles.sHeight} leased=$leased")
                        if (leased) reportStatus(id, tiles.sWidth, tiles.sHeight, pageSizes.filterNotNull())
                        updateUnderlay()
                        placeContinuous(id)
                    }
                    override fun onImageLoadError(e: Exception) { fail() }
                    override fun onTileLoadError(e: Exception) {
                        // After onReady the base layer is available. A failed
                        // detail tile must not evict a page during a pinch.
                        if (tiles.isReady) Log.w("YomikaTiles", "detail tile failed for page=${page.number}", e)
                        else fail()
                    }
                    private fun fail() {
                        if (leased && slots[id] === tiles) reportStatus(id)
                        drop(id)
                    }
                })
                // Behind the WebView until a gesture claims it. This also keeps single
                // taps/swipes on the existing DOM gesture path.
                tiles.addOnLayoutChangeListener { _, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
                    if (right - left != oldRight - oldLeft || bottom - top != oldBottom - oldTop) {
                        resizePage(id, tiles, oldRight - oldLeft, oldBottom - oldTop)
                    }
                }
                parent.addView(tiles, parent.indexOfChild(web), ViewGroup.LayoutParams(-1, -1))
                val source = ImageSource.uri(Uri.fromFile(files.first()))
                val size = sizes.singleOrNull()
                // Small static pages can skip the region decoder. Bound both
                // the texture edge and memory cost of warming adjacent slots.
                val small = animated == null && size != null && maxOf(size.x, size.y) <= 2048 &&
                    size.x.toLong() * size.y <= 2L * 1024 * 1024
                tiles.setImage(if (small) source.tilingDisabled() else source.tilingEnabled())
            }
        }
    }

    private fun reportStatus(id: Int, width: Int = 0, height: Int = 0, sizes: List<android.graphics.Point> = emptyList()) {
        val pages = sizes.joinToString(prefix = "[", postfix = "]") { "{naturalWidth:${it.x},naturalHeight:${it.y}}" }
        web.evaluateJavascript("window.dispatchEvent(new CustomEvent('yomika-reader-tile-status',{detail:{slot:$id,width:$width,height:$height,pages:$pages}}))", null)
    }

    private fun viewportOf(tiles: SubsamplingScaleImageView): Viewport? {
        pendingViewport?.takeIf { it.first === tiles }?.let { return it.second }
        val center = tiles.center ?: return null
        if (tiles.minScale <= 0f || tiles.sWidth <= 0 || tiles.sHeight <= 0) return null
        val sideways = tiles.appliedOrientation == 90 || tiles.appliedOrientation == 270
        val width = if (sideways) tiles.sHeight else tiles.sWidth
        val height = if (sideways) tiles.sWidth else tiles.sHeight
        return Viewport(tiles.scale / tiles.minScale, center.x / width, center.y / height)
    }

    private fun resizePage(id: Int, view: SubsamplingScaleImageView, oldWidth: Int, oldHeight: Int) {
        if (!view.isReady || oldWidth <= 0 || oldHeight <= 0 || view.width <= 0 || view.height <= 0 ||
            id in continuousRects || id in continuousPresented
        ) return
        if (view !== showing) {
            if (view === underlay) {
                finishSwipe("resize")
                resetEdge()
            }
            view.resetScaleAndCenter()
            return
        }

        // SSIV's size callback queues a new center using the new view's midpoint
        // against the old translation. Read the old midpoint before it draws.
        val fit = fitCenter(view)
        val width = fit.x * 2f
        val height = fit.y * 2f
        val oldMin = minOf(oldWidth / width, oldHeight / height)
        val viewport = pendingViewport?.takeIf { it.first === view }?.second
            ?: view.viewToSourceCoord((oldWidth / 2).toFloat(), (oldHeight / 2).toFloat())?.let { center ->
                Viewport(maxOf(1f, view.scale / oldMin), center.x / width, center.y / height)
            } ?: return
        stopZoomAnimation()
        clearPinchFeedback()
        finishSwipe("resize")
        resetEdge()
        imageGesture = null
        nativePanStarted = false
        nativeTouchActive = false
        singleTouch = false
        webSwipe = false
        takeTurnVelocity()
        down?.recycle()
        down = null
        applyViewport(view, viewport)
    }

    private fun applyViewport(tiles: SubsamplingScaleImageView, viewport: Viewport) {
        val fit = fitCenter(tiles)
        val width = (fit.x * 2f).toInt()
        val height = (fit.y * 2f).toInt()
        val scale = tiles.minScale * viewport.scale
        if (scale > tiles.maxScale) tiles.maxScale = scale
        val transform = transformAt(tiles, scale, viewport.x * width, viewport.y * height)
            .bounded(tiles.width, tiles.height, width, height)
        val center = gestureCenter(tiles, transform)
        tiles.setScaleAndCenter(scale, center)
        val pending = tiles to Viewport(viewport.scale, center.x / width, center.y / height)
        pendingViewport = pending
        tiles.postOnAnimation { tiles.postOnAnimation { if (pendingViewport === pending) pendingViewport = null } }
    }

    private fun reportViewports() {
        if (paused || nativeTouchActive || pinchReturn != null) return
        for ((id, page) in viewportRequests) {
            val active = (showing ?: underlay)?.takeIf { it.tag == page }
            val viewport = active?.let(::viewportOf)
            val value = viewport?.let { "{scale:${it.scale},x:${it.x},y:${it.y}}" } ?: "null"
            web.evaluateJavascript("window.dispatchEvent(new CustomEvent('yomika-reader-tile-viewport',{detail:{id:$id,viewport:$value}}))", null)
        }
        viewportRequests.clear()
    }

    private fun requestPresentation(id: Int, replacement: Boolean = false, viewport: Viewport? = null) {
        presentations.remove(id)
        presentations[id] = Presentation(replacement, viewport)
        updateUnderlay()
    }

    private fun updateUnderlay() {
        val entry = if (paused) null else presentations.entries.lastOrNull { (id, request) ->
            val tiles = slots[id]
            tiles?.isReady == true && (!request.replacement || (!nativeTouchActive && pinchReturn == null) || showing === tiles)
        }
        val id = entry?.key
        val next = slots[id]
        if (underlay === next) return
        finishSwipe("presentation")
        resetEdge()
        val previous = underlay
        val resumed = next?.let { view ->
            suspendedView.takeIf { it?.page == view.readerPage }.also { suspendedView = null }
        }
        // Reader gestures provide the bounds. SSIV must accept the exact
        // requested position even when an axis is smaller than the viewport.
        next?.setPanLimit(SubsamplingScaleImageView.PAN_LIMIT_OUTSIDE)
        if (next != null && next.minScale > 0f) {
            // SSIV uses source pixels as its unit. Preserve the upper limit
            // relative to fit when a differently sampled rendition takes over.
            val relativeLimit = previous?.takeIf { it.tag == next.tag && it.minScale > 0f }
                ?.let { (it.maxScale / it.minScale).coerceAtLeast(1f) } ?: resumed?.maxRelativeScale
            if (relativeLimit != null) next.maxScale = next.minScale * relativeLimit
        }
        val zoomOwner = showing?.takeIf { next != null && it.tag == next.tag }
        val viewport = zoomOwner?.let(::viewportOf) ?: resumed?.viewport ?: entry?.value?.viewport
        if (previous === showing || zoomOwner != null) hide()
        if (next != null && viewport != null && viewport.scale > 1f) {
            applyViewport(next, viewport)
            showing = next
        }
        previous?.alpha = 0.001f
        underlay = next
        updateWebBackground()
        if (next != null && id != null) {
            // Keep the new artwork and the input owner in sync. React can
            // retire the previous slot before its next selection arrives.
            if (previous != null && slots[selected] === previous && previous.tag == next.tag) {
                selected = id
            }
            next.setBackgroundColor(Color.BLACK)
            next.alpha = 1f
            web.bringToFront()
            Log.i("YomikaTiles", "present page=${next.readerPage.number} slot=$id")
            web.evaluateJavascript("window.dispatchEvent(new CustomEvent('yomika-reader-tile-presented',{detail:{slot:$id}}))", null)
        }
    }

    private fun updateWebBackground() {
        val transparent = !paused && (underlay != null || continuousPresented.isNotEmpty())
        if (transparent == webTransparent) return
        webTransparent = transparent
        if (transparent) {
            previousWebBackground = web.background
            web.setBackgroundColor(Color.TRANSPARENT)
        } else {
            web.background = previousWebBackground
            previousWebBackground = null
        }
    }

    private fun placeContinuous(id: Int) {
        if (id in retiringAfterWebFrame) return
        val geometry = continuousRects[id] ?: return
        val rect = Rect(geometry.left, geometry.top - continuousScrollTop, geometry.right, geometry.bottom - continuousScrollTop)
        val view = slots[id] ?: return
        if (paused || rect.isEmpty || rect.bottom <= 0 || rect.top >= web.height) {
            view.alpha = 0.001f
            if (continuousPresented.remove(id)) updateWebBackground()
            return
        }
        // Keep SSIV's tile viewport screen-sized. For a long strip, scroll
        // within its source coordinates rather than laying out a giant view.
        val height = minOf(rect.height(), web.height)
        val top = rect.top.coerceAtLeast(0).coerceAtMost(rect.bottom - height)
        val params = view.layoutParams
        if (params.width != rect.width() || params.height != height) {
            params.width = rect.width()
            params.height = height
            view.layoutParams = params
        }
        view.translationX = web.left + rect.left - view.left.toFloat()
        view.translationY = web.top + top - view.top.toFloat()
        if (!view.isReady) return
        if (id !in continuousPresented) view.setPanLimit(SubsamplingScaleImageView.PAN_LIMIT_INSIDE)
        if (height < rect.height()) {
            val sideways = view.appliedOrientation == 90 || view.appliedOrientation == 270
            val sourceWidth = if (sideways) view.sHeight else view.sWidth
            val sourceHeight = if (sideways) view.sWidth else view.sHeight
            if (sourceWidth <= 0 || sourceHeight <= 0) return
            val scale = rect.height().toFloat() / sourceHeight
            val sourceY = (top - rect.top + height * .5f) / scale
            view.setScaleAndCenter(scale, PointF(sourceWidth * .5f, sourceY))
            continuousCropped.add(id)
        } else if (continuousCropped.remove(id)) {
            view.resetScaleAndCenter()
        }
        view.alpha = 1f
        if (continuousPresented.add(id)) {
            updateWebBackground()
            web.evaluateJavascript("window.dispatchEvent(new CustomEvent('yomika-reader-tile-presented',{detail:{slot:$id}}))", null)
        }
    }

    private fun hideContinuous(id: Int) {
        if (continuousRects.remove(id) == null) return
        slots[id]?.let {
            it.alpha = 0.001f
            if (continuousCropped.remove(id)) it.resetScaleAndCenter()
        }
        if (continuousPresented.remove(id)) updateWebBackground()
    }

    private fun decodePlatformAnimation(file: File): Drawable? {
        if (Build.VERSION.SDK_INT < 28) return null
        return runCatching {
            PlatformImageDecoder.decodeDrawable(PlatformImageDecoder.createSource(file)) { decoder, info, _ ->
                val size = info.size
                check(info.isAnimated && size.width > 0 && size.height > 0)
                check(size.width.toLong() * size.height <= 4L * 1024 * 1024)
                decoder.allocator = PlatformImageDecoder.ALLOCATOR_SOFTWARE
            } as? AnimatedImageDrawable
        }.getOrNull()
    }

    private fun staticTileSize(file: File, requireLarge: Boolean): android.graphics.Point? {
        val info = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, info)
        if (info.outWidth <= 0 || info.outHeight <= 0) return null
        if (requireLarge && info.outWidth.toLong() * info.outHeight <= 100L * 1024 * 1024 / 4) return null
        val static = when (info.outMimeType) {
            "image/jpeg" -> true
            "image/webp" -> RandomAccessFile(file, "r").use { f ->
                f.seek(12); val kind = f.readInt(); f.skipBytes(4)
                kind != 0x56503858 || f.readUnsignedByte() and 2 == 0
            }
            "image/png" -> RandomAccessFile(file, "r").use { f ->
                f.seek(8)
                while (f.filePointer + 12 <= f.length()) {
                    val length = f.readInt().toLong() and 0xffffffffL
                    when (f.readInt()) {
                        0x6163544c -> return@use false // acTL precedes IDAT in APNG
                        0x49444154 -> return@use true
                    }
                    f.seek(f.filePointer + length + 4)
                }
                false
            }
            else -> false
        }
        if (!static) return null
        val orientation = runCatching {
            android.media.ExifInterface(file.path).getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, 1)
        }.getOrDefault(1)
        return if (orientation in 5..8) android.graphics.Point(info.outHeight, info.outWidth)
            else android.graphics.Point(info.outWidth, info.outHeight)
    }

    fun dispatch(e: MotionEvent, normal: (MotionEvent) -> Boolean): Boolean {
        val canScroll = !paused && underlay == null && showing == null && continuousPresented.isNotEmpty()
        if (continuousInput.handle(e, canScroll) {
            val cancel = MotionEvent.obtain(e)
            cancel.action = MotionEvent.ACTION_CANCEL
            normal(cancel)
            cancel.recycle()
            down?.recycle()
            down = null
        }) return true
        if (continuousInput.isAttached) return normal(e)
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                // A turn is logically committed on release. A fresh touch sees
                // the new page settled, even if the visual slide was in flight.
                if (swipe?.onSettled == null) finishSwipe("touch")
                resetEdge()
                clearPinchFeedback()
                stopZoomAnimation()
                down?.recycle()
                down = MotionEvent.obtain(e)
                singleTouch = true
                turnVelocity?.recycle()
                turnVelocity = VelocityTracker.obtain().also { it.addMovement(e) }
                webSwipe = false
            }
            MotionEvent.ACTION_MOVE -> if (singleTouch) {
                turnVelocity?.addMovement(e)
                val start = down
                val active = showing
                if (webSwipe) return normal(e)
                if (swipe?.onSettled != null && start != null) {
                    if (kotlin.math.hypot(e.rawX - start.rawX, e.rawY - start.rawY) <= touchSlop) return normal(e)
                    finishSwipe("drag")
                }
                if (start != null) {
                    val dx = e.rawX - start.rawX
                    val dy = e.rawY - start.rawY
                    if (previewSwipe(e, dx, dy, normal)) return true
                    if (active != null && kotlin.math.abs(dx) >= touchSlop && canSwipe(active, dx, dy)) {
                        // The DOM track owns the boundary and unprepared pages.
                        // A captured zoom consumes DOWN, so replay it before handing off.
                        webSwipe = true
                        normal(start)
                        return normal(e)
                    }
                }
            }
            MotionEvent.ACTION_POINTER_DOWN, MotionEvent.ACTION_CANCEL -> {
                singleTouch = false
                takeTurnVelocity()
                if (webSwipe) {
                    webSwipe = false
                    if (e.actionMasked == MotionEvent.ACTION_CANCEL) {
                        nativeTouchActive = false
                        val result = normal(e)
                        finishNativeTouch(null)
                        return result
                    }
                    val cancel = MotionEvent.obtain(e)
                    cancel.action = MotionEvent.ACTION_CANCEL
                    normal(cancel)
                    cancel.recycle()
                }
                finishSwipe()
                if (e.actionMasked == MotionEvent.ACTION_POINTER_DOWN) resetEdge()
            }
            MotionEvent.ACTION_UP -> if (singleTouch) {
                val velocity = takeTurnVelocity(e)
                if (webSwipe) {
                    webSwipe = false
                    nativeTouchActive = false
                    val result = normal(e)
                    finishNativeTouch(null)
                    return result
                }
                if (tryTurn(e, velocity, normal)) return true
                swipe?.takeIf { it.onSettled == null }?.let {
                    animateSwipe(it, 0f, 160)
                    finishNativeTouch(null)
                    return true
                }
            }
        }
        val selectedTiles = slots[selected]?.takeUnless { selected in retiringAfterWebFrame }
        // During a same-page handoff the new underlay can be visible before
        // React sends its selection. Pinch the visible version of that page.
        val tiles = showing ?: underlay?.takeIf { it.tag == selectedTiles?.tag } ?: selectedTiles
        if (tiles != null && showing == null && tiles.isReady && down != null && e.actionMasked == MotionEvent.ACTION_POINTER_DOWN) {
            val cancel = MotionEvent.obtain(e); cancel.action = MotionEvent.ACTION_CANCEL; normal(cancel); cancel.recycle()
            showing = tiles
            if (tiles !== underlay) tiles.bringToFront()
            tiles.setBackgroundColor(Color.BLACK); tiles.alpha = 1f
            val slot = slots.entries.firstOrNull { it.value === tiles }?.key ?: selected
            Log.i("YomikaTiles", "pinch page=${tiles.readerPage.number} slot=$slot ${tiles.sWidth}x${tiles.sHeight}")
        }
        val active = showing
        if (active != null) {
            val start = down
            val action = e.actionMasked
            nativeTouchActive = action != MotionEvent.ACTION_UP && action != MotionEvent.ACTION_CANCEL
            val dx = if (start == null) 0f else e.rawX - start.rawX
            val dy = if (start == null) 0f else e.rawY - start.rawY
            val moved = kotlin.math.hypot(dx, dy) > touchSlop
            // Only page turns use the system slop. Applying it to image pans
            // delays the first pixels and then replays them in a single jump.
            val panMove = action == MotionEvent.ACTION_MOVE && (dx != 0f || dy != 0f) &&
                (viewportOf(active)?.scale ?: 1f) > 1f && !canSwipe(active, dx, dy)
            if (!nativePanStarted && start != null && (action == MotionEvent.ACTION_POINTER_DOWN || panMove)) {
                beginImageGesture(active, if (action == MotionEvent.ACTION_POINTER_DOWN) e else start)
                nativePanStarted = imageGesture != null
            }
            val wasPan = nativePanStarted
            if (wasPan) moveImageGesture(active, e)
            if (!nativeTouchActive) {
                if (singleTouch && !moved && action == MotionEvent.ACTION_UP && start != null && e.eventTime - start.eventTime < 500L) {
                    normal(start)
                    normal(e)
                }
                nativePanStarted = false
                if (wasPan) {
                    finishImageGesture(active)
                    settlePinchFeedback(active) { finishNativeTouch(active) }
                } else finishNativeTouch(active)
            }
            return true
        }
        return normal(e)
    }

    private fun finishNativeTouch(active: SubsamplingScaleImageView?) {
        if (active != null && showing === active) {
            if ((viewportOf(active)?.scale ?: 1f) <= 1f) hide()
        }
        reportViewports()
        updateUnderlay()
    }

    private fun sampleGesture(event: MotionEvent, screenX: Int, screenY: Int): GestureSample {
        val lifted = if (event.actionMasked == MotionEvent.ACTION_POINTER_UP) event.actionIndex else -1
        val first = if (lifted == 0) 1 else 0
        val second = if (lifted in 0..1) 2 else 1
        val x = event.rawX - event.x + event.getX(first) - screenX
        val y = event.rawY - event.y + event.getY(first) - screenY
        if (second >= event.pointerCount) return GestureSample(x, y)
        val dx = event.getX(second) - event.getX(first)
        val dy = event.getY(second) - event.getY(first)
        return GestureSample(x + dx / 2f, y + dy / 2f, kotlin.math.hypot(dx, dy))
    }

    private fun beginImageGesture(view: SubsamplingScaleImageView, event: MotionEvent) {
        val viewport = viewportOf(view) ?: return
        val fit = fitCenter(view)
        val width = (fit.x * 2f).toInt()
        val height = (fit.y * 2f).toInt()
        val location = IntArray(2)
        view.getLocationOnScreen(location)
        val scale = viewport.scale * view.minScale
        val transform = transformAt(view, scale, viewport.x * width, viewport.y * height)
        imageGesture = ImageGesture(width, height, location[0], location[1], transform,
            sampleGesture(event, location[0], location[1]), scale)
    }

    private fun moveImageGesture(view: SubsamplingScaleImageView, event: MotionEvent) {
        val gesture = imageGesture ?: return
        when (event.actionMasked) {
            MotionEvent.ACTION_POINTER_DOWN, MotionEvent.ACTION_POINTER_UP -> {
                gesture.sample = sampleGesture(event, gesture.screenX, gesture.screenY)
                gesture.rawScale = gesture.transform.scale
                if (event.actionMasked == MotionEvent.ACTION_POINTER_DOWN) clearPinchFeedback()
            }
            MotionEvent.ACTION_MOVE -> {
                val sample = sampleGesture(event, gesture.screenX, gesture.screenY)
                val previous = gesture.sample
                if (sample.span > 0f && previous.span > 0f) gesture.rawScale *= sample.span / previous.span
                val min = view.minScale
                val scale = gesture.rawScale.coerceIn(min, maxOf(min, view.maxScale))
                val next = gesture.transform.follow(
                    scale, previous.x, previous.y, sample.x, sample.y,
                    view.width, view.height, gesture.width, gesture.height,
                )
                gesture.sample = sample
                if (next != gesture.transform) {
                    gesture.transform = next
                    // SSIV consumes only the latest requested transform on draw.
                    view.setScaleAndCenter(scale, gestureCenter(view, next))
                }
                if (sample.span > 0f) {
                    val feedback = ReaderPinchElasticity.feedback(gesture.rawScale, scale)
                    if (feedback != 1f && view.scaleX == 1f) {
                        view.pivotX = sample.x
                        view.pivotY = sample.y
                    }
                    applyPinchFeedback(view, feedback)
                } else if (view.scaleX != 1f) applyPinchFeedback(view, 1f)
            }
        }
    }

    private fun transformAt(view: SubsamplingScaleImageView, scale: Float, centerX: Float, centerY: Float) =
        ReaderImageTransform(scale, view.width / 2 - centerX * scale, view.height / 2 - centerY * scale)

    private fun gestureCenter(view: SubsamplingScaleImageView, transform: ReaderImageTransform) = PointF(
        (view.width / 2 - transform.left) / transform.scale,
        (view.height / 2 - transform.top) / transform.scale,
    )

    private fun finishImageGesture(view: SubsamplingScaleImageView) {
        val gesture = imageGesture ?: return
        imageGesture = null
        val center = gestureCenter(view, gesture.transform)
        applyViewport(view, Viewport(gesture.transform.scale / view.minScale, center.x / gesture.width, center.y / gesture.height))
    }

    private fun settlePinchFeedback(tiles: SubsamplingScaleImageView, onSettled: () -> Unit) {
        if (tiles.scaleX == 1f || (android.os.Build.VERSION.SDK_INT >= 26 && !ValueAnimator.areAnimatorsEnabled())) {
            clearPinchFeedback()
            onSettled()
            return
        }
        pinchReturn = ValueAnimator.ofFloat(tiles.scaleX, 1f).apply {
            duration = 140L
            interpolator = edgeEasing
            addUpdateListener {
                val scale = it.animatedValue as Float
                applyPinchFeedback(tiles, scale)
            }
            addListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) {
                    if (pinchReturn !== animation) return
                    pinchReturn = null
                    applyPinchFeedback(tiles, 1f)
                    onSettled()
                }
            })
        }
        pinchReturn?.start()
    }

    private fun clearPinchFeedback() {
        val animation = pinchReturn
        pinchReturn = null
        animation?.cancel()
        showing?.let { applyPinchFeedback(it, 1f) }
    }

    private fun applyPinchFeedback(tiles: SubsamplingScaleImageView, scale: Float) {
        // Composite adjacent tiles into one surface before applying a fractional
        // overscale. Otherwise antialiasing each tile exposes hairline seams.
        val layer = if (scale == 1f) View.LAYER_TYPE_NONE else View.LAYER_TYPE_HARDWARE
        if (layer != tiles.layerType) tiles.setLayerType(layer, null)
        tiles.scaleX = scale
        tiles.scaleY = scale
    }

    private fun doubleTap(page: ReaderPage, x: Float, y: Float, reduceMotion: Boolean) {
        val tiles = underlay ?: return
        if (paused || nativeTouchActive || tiles.tag != page || !x.isFinite() || !y.isFinite()) return
        val zoomed = tiles.scale > tiles.minScale * 1.05f
        if (zoomed || showing === tiles) {
            hide()
        } else {
            val center = tiles.viewToSourceCoord(x.coerceIn(0f, 1f) * tiles.width, y.coerceIn(0f, 1f) * tiles.height) ?: return
            val scale = minOf(tiles.maxScale, tiles.minScale * 2f)
            val current = tiles.center ?: return
            val start = transformAt(tiles, tiles.scale, current.x, current.y)
            val target = transformAt(tiles, scale, center.x, center.y)
            val fit = fitCenter(tiles)
            val width = (fit.x * 2f).toInt()
            val height = (fit.y * 2f).toInt()
            val end = target.bounded(tiles.width, tiles.height, width, height)
            showing = tiles
            if (reduceMotion) {
                tiles.setScaleAndCenter(scale, gestureCenter(tiles, end))
            } else {
                zoomAnimation = ValueAnimator.ofFloat(0f, 1f).apply {
                    duration = 180L
                    addUpdateListener {
                        val t = it.animatedFraction
                        val frame = ReaderImageTransform(
                            start.scale + (end.scale - start.scale) * t,
                            start.left + (end.left - start.left) * t,
                            start.top + (end.top - start.top) * t,
                        ).bounded(tiles.width, tiles.height, width, height)
                        tiles.setScaleAndCenter(frame.scale, gestureCenter(tiles, frame))
                    }
                    addListener(object : AnimatorListenerAdapter() {
                        override fun onAnimationEnd(animation: Animator) {
                            if (zoomAnimation === animation) zoomAnimation = null
                        }
                    })
                }.also { it.start() }
            }
        }
    }

    private fun stopZoomAnimation() {
        val animation = zoomAnimation ?: return
        zoomAnimation = null
        animation.cancel()
        // Discard a frame queued by the animator after the last actual draw.
        showing?.let { view -> view.center?.let { view.setScaleAndCenter(view.scale, it) } }
    }

    private fun nearFit(view: SubsamplingScaleImageView) = (viewportOf(view)?.scale ?: 1f) <= 1.04f

    private fun canSwipe(from: SubsamplingScaleImageView, dx: Float, dy: Float): Boolean =
        !paused && allowTurn && underlay === from && selected !in retiringAfterWebFrame && slots[selected] === from && web.width > 0 &&
            (showing == null || showing === from && !nativePanStarted && nearFit(from)) &&
            (swipe?.let { it.from === from && it.onSettled == null } == true || kotlin.math.abs(dx) > kotlin.math.abs(dy))

    private fun swipeTarget(dx: Float, dy: Float): SubsamplingScaleImageView? {
        val from = underlay ?: return null
        if (!canSwipe(from, dx, dy)) return null
        val page = if (dx < 0) turnLeft else turnRight
        return slots[committedSlots[from.readerPage.copy(number = page)]]?.takeIf { it.isReady && it !== from }
    }

    private fun dragEdge(page: ReaderPage, offset: Float, duration: Long) {
        val view = underlay ?: return
        if (paused || (showing != null && (showing !== view || !nearFit(view))) || swipe != null || view.tag != page || !offset.isFinite()) return
        if (edgeView !== view) resetEdge()
        view.animate().cancel()
        edgeView = view
        val translation = offset.coerceIn(-1f, 1f) * view.width
        if (duration > 0) {
            view.animate().translationX(translation).setDuration(duration.coerceAtMost(360)).setInterpolator(edgeEasing).start()
        } else {
            view.translationX = translation
            if (translation == 0f) edgeView = null
        }
    }

    private fun resetEdge() {
        val view = edgeView ?: return
        edgeView = null
        view.animate().cancel()
        view.translationX = 0f
    }

    private fun previewSwipe(event: MotionEvent, dx: Float, dy: Float, normal: (MotionEvent) -> Boolean): Boolean {
        if (reduceTurnMotion) return false
        val current = swipe?.takeIf { it.onSettled == null }
        val target = if (dx == 0f) null else swipeTarget(dx, dy)
        if (target == null) {
            if (current == null) return false
            drawSwipe(current, 0f)
            return true
        }
        val from = underlay ?: return false
        if (current == null && showing == null) {
            // Cancel the WebView's copy of DOWN once the native preview owns
            // this gesture, so only one renderer can move the outgoing page.
            val cancel = MotionEvent.obtain(event)
            cancel.action = MotionEvent.ACTION_CANCEL
            normal(cancel)
            cancel.recycle()
        }
        resetEdge()
        val end = if (dx < 0) -web.width.toFloat() else web.width.toFloat()
        val pair = current?.takeIf { it.to === target && it.end == end } ?: run {
            finishSwipe()
            target.setBackgroundColor(Color.BLACK)
            Swipe(from, target, end).also { swipe = it }
        }
        drawSwipe(pair, dx.coerceIn(minOf(end, 0f), maxOf(end, 0f)))
        return true
    }

    private fun drawSwipe(pair: Swipe, offset: Float) {
        pair.offset = offset
        val position = kotlin.math.round(offset)
        pair.from.translationX = position
        pair.to.translationX = position - pair.end
        pair.from.alpha = 1f
        pair.to.alpha = 1f
    }

    private fun animateSwipe(pair: Swipe, end: Float, durationMs: Long) {
        swipeAnimation = ValueAnimator.ofFloat(pair.offset, end).apply {
            duration = durationMs
            interpolator = swipeEasing
            addUpdateListener { drawSwipe(pair, it.animatedValue as Float) }
            addListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) {
                    if (swipe === pair) finishSwipe("animation")
                }
            })
        }
        swipeAnimation?.start()
    }

    private fun finishSwipe(reason: String = "cancelled") {
        val pair = swipe ?: return
        swipe = null
        swipeAnimation?.removeAllUpdateListeners()
        swipeAnimation?.removeAllListeners()
        swipeAnimation?.cancel()
        swipeAnimation = null
        for (view in listOf(pair.from, pair.to)) {
            view.translationX = 0f
            view.alpha = if (view === underlay || view === showing) 1f else 0.001f
        }
        if (pair.onSettled != null) Log.i("YomikaTiles", "settled page=${pair.to.readerPage.number} reason=$reason")
        if (pair.resetFromZoom) pair.from.resetScaleAndCenter()
        pair.onSettled?.invoke()
    }

    private fun takeTurnVelocity(end: MotionEvent? = null): Float {
        val tracker = turnVelocity ?: return 0f
        turnVelocity = null
        val velocity = if (end == null) 0f else {
            tracker.addMovement(end)
            tracker.computeCurrentVelocity(1000)
            tracker.xVelocity
        }
        tracker.recycle()
        return velocity
    }

    private fun tryTurn(end: MotionEvent, velocity: Float, normal: (MotionEvent) -> Boolean): Boolean {
        val start = down ?: return false
        val dx = end.rawX - start.rawX
        val density = web.resources.displayMetrics.density
        val travel = kotlin.math.abs(dx)
        val draggedFar = travel >= maxOf(56f * density, web.width * 0.18f)
        val flicked = travel > 30f * density && kotlin.math.abs(velocity) > 400f * density && velocity * dx > 0f
        if (!draggedFar && !flicked) return false
        val from = underlay ?: return false
        val target = swipeTarget(dx, end.rawY - start.rawY) ?: return false
        val left = dx < 0
        val to = if (left) turnLeft else turnRight
        val id = committedSlots[from.readerPage.copy(number = to)] ?: return false
        val distance = if (left) -web.width.toFloat() else web.width.toFloat()
        val offset = dx.coerceIn(minOf(distance, 0f), maxOf(distance, 0f))
        val cancel = MotionEvent.obtain(end)
        cancel.action = MotionEvent.ACTION_CANCEL
        normal(cancel)
        cancel.recycle()
        val resetZoom = showing === from
        if (resetZoom) {
            showing = null
            nativeTouchActive = false
            nativePanStarted = false
            if (pendingViewport?.first === from) pendingViewport = null
        }
        selected = id
        // Do not consume a second turn until the UI supplies the new neighbours.
        allowTurn = false
        turnLeft = 0
        turnRight = 0
        resetEdge()
        requestPresentation(id)
        if (resetZoom) {
            if (reduceTurnMotion || offset == distance) from.resetScaleAndCenter()
            else animateFit(from)
        }
        // React can replace or retire either slot as soon as it receives the
        // turn. Let the native slide release both views before updating React.
        val publishTurn = {
            web.evaluateJavascript("window.dispatchEvent(new CustomEvent('yomika-reader-native-turn',{detail:{session:${from.readerPage.session},from:${from.readerPage.number},to:$to,left:$left}}))", null)
        }
        Log.i("YomikaTiles", "turn from=${from.readerPage.number} page=$to slot=$id")
        if (!reduceTurnMotion && offset != distance) {
            val pair = Swipe(from, target, distance, onSettled = publishTurn, resetFromZoom = resetZoom).also { swipe = it }
            drawSwipe(pair, offset)
            val speed = maxOf(.7f, kotlin.math.abs(dx) / (end.eventTime - start.eventTime).coerceAtLeast(1L))
            val remaining = kotlin.math.abs(distance - offset)
            val densityScale = web.resources.displayMetrics.density
            val travelDuration = 115f + remaining / densityScale * .15f
            val minimum = maxOf(if (resetZoom) 140f else 115f, minOf(180f, travelDuration))
            val duration = maxOf(minimum, minOf(240f, remaining / speed)).toLong()
            animateSwipe(pair, distance, duration)
        } else {
            publishTurn()
        }
        return true
    }

    private fun fitCenter(view: SubsamplingScaleImageView): PointF =
        if (view.appliedOrientation == 90 || view.appliedOrientation == 270) PointF(view.sHeight / 2f, view.sWidth / 2f)
        else PointF(view.sWidth / 2f, view.sHeight / 2f)

    private fun animateFit(view: SubsamplingScaleImageView) {
        view.animateScaleAndCenter(view.minScale, fitCenter(view))
            ?.withDuration(120)?.start()
    }

    fun pause() {
        if (paused) return
        takeTurnVelocity()
        // Pausing hides the native views and resets SSIV. Keep the settled
        // coordinates in logical page units in case a replacement is ready on resume.
        suspendedView = (showing ?: underlay)?.let { view ->
            viewportOf(view)?.let { viewport ->
                SuspendedView(view.readerPage, viewport, (view.maxScale / view.minScale).coerceAtLeast(1f))
            }
        }
        continuousInput.interrupt(publishPending = true)
        paused = true
        retiringAfterWebFrame.toList().forEach(::drop)
        hide()
        updateUnderlay()
        continuousRects.keys.toList().forEach(::placeContinuous)
        updateWebBackground()
    }
    fun resume() {
        paused = false
        updateUnderlay()
        reportViewports()
        continuousRects.keys.toList().forEach(::placeContinuous)
    }
    fun hide() {
        stopZoomAnimation()
        clearPinchFeedback()
        showing?.let { it.alpha = if (it === underlay) 1f else 0.001f; it.resetScaleAndCenter(); web.bringToFront() }
        if (pendingViewport?.first === showing) pendingViewport = null
        showing = null
        imageGesture = null
        nativeTouchActive = false
        nativePanStarted = false
    }
    private fun dropAfterWebFrame(id: Int) {
        val view = slots[id]
        if (view == null || (view !== underlay && view !== showing && id !in continuousPresented) || !web.isShown) {
            drop(id)
            return
        }
        if (!retiringAfterWebFrame.add(id)) return
        // The DOM has committed the decoded result. Keep the old view behind
        // the WebView until Chromium has that visual state ready to draw.
        web.postVisualStateCallback(id.toLong(), object : WebView.VisualStateCallback() {
            override fun onComplete(requestId: Long) {
                if (id in retiringAfterWebFrame) {
                    Log.i("YomikaTiles", "web replacement ready slot=$id")
                    drop(id)
                }
            }
        })
    }

    private fun drop(id: Int) {
        hideContinuous(id)
        val view = slots[id]
        if (swipe?.let { it.from === view || it.to === view } == true) finishSwipe("drop")
        if (view != null && edgeView === view) resetEdge()
        retiringAfterWebFrame.remove(id)
        committedSlots.entries.removeAll { it.value == id }
        val wasRequested = presentations.remove(id) != null
        if (view != null && showing === view) hide()
        if (selected == id) selected = 0
        if (wasRequested) updateUnderlay()
        slots.remove(id)?.let { removed -> (removed.parent as? ViewGroup)?.removeView(removed); jobs.remove(id)?.retire() }
    }
    fun destroy() {
        continuousInput.interrupt()
        slots.keys.toList().forEach(::drop)
        down?.recycle()
        down = null
        io.shutdown()
        visibleDecode.shutdown()
        prefetchDecode.shutdown()
    }
}
