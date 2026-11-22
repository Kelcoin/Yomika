package app.yomika.reader

import android.content.Context
import android.graphics.Canvas
import android.graphics.Point
import android.graphics.PointF
import android.graphics.RectF
import android.graphics.drawable.Animatable
import android.graphics.drawable.Drawable
import com.davemorrissey.labs.subscaleview.SubsamplingScaleImageView

/** Draws the platform's animated frames in the same coordinates as the SSIV tiles. */
internal class ReaderAnimatedView(context: Context, private val animations: List<Drawable?>) :
    SubsamplingScaleImageView(context) {
    @Volatile var imageBounds: List<RectF> = emptyList()
    private val topLeft = PointF()
    private val bottomRight = PointF()

    val animatedSizes: List<Point?> = animations.map { image ->
        image?.let { Point(it.intrinsicWidth, it.intrinsicHeight) }
    }

    init {
        animations.filterNotNull().forEach { image ->
            image.callback = this
            image.setBounds(0, 0, image.intrinsicWidth, image.intrinsicHeight)
        }
    }

    override fun verifyDrawable(who: Drawable): Boolean =
        animations.any { it === who } || super.verifyDrawable(who)

    override fun setAlpha(alpha: Float) {
        super.setAlpha(alpha)
        if (alpha <= .01f) updatePlayback(false) else invalidate()
    }

    override fun onVisibilityAggregated(isVisible: Boolean) {
        super.onVisibilityAggregated(isVisible)
        if (isVisible) invalidate() else updatePlayback(false)
    }

    override fun onDetachedFromWindow() {
        updatePlayback(false)
        super.onDetachedFromWindow()
    }

    private fun stopAnimations() {
        animations.forEach { (it as? Animatable)?.stop() }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (alpha <= .01f || !isReady) return
        if (imageBounds.isEmpty()) return
        updatePlayback(true)
        val bounds = imageBounds
        animations.forEachIndexed { index, image ->
            if (image == null) return@forEachIndexed
            val rect = bounds.getOrNull(index) ?: return@forEachIndexed
            sourceToViewCoord(rect.left, rect.top, topLeft) ?: return@forEachIndexed
            sourceToViewCoord(rect.right, rect.bottom, bottomRight) ?: return@forEachIndexed
            val save = canvas.save()
            canvas.translate(topLeft.x, topLeft.y)
            canvas.scale((bottomRight.x - topLeft.x) / image.intrinsicWidth,
                (bottomRight.y - topLeft.y) / image.intrinsicHeight)
            image.draw(canvas)
            canvas.restoreToCount(save)
        }
    }

    // Start only on the first visible paint. A finite-loop drawable must not
    // be restarted by regular view invalidations after its last frame.
    private var playbackStarted = false

    private fun updatePlayback(visible: Boolean) {
        if (!visible) {
            stopAnimations()
            playbackStarted = false
        } else if (!playbackStarted) {
            playbackStarted = true
            animations.forEach { (it as? Animatable)?.start() }
        }
    }
}
