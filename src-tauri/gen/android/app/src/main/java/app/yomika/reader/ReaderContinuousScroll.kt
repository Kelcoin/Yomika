package app.yomika.reader

import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.widget.OverScroller
import kotlin.math.abs
import kotlin.math.roundToInt

/** Scrolls native page layers on the UI thread and publishes their viewport once per frame. */
internal class ReaderContinuousScroll(
    private val view: View,
    private val draw: (Int) -> Unit,
    private val publish: (Long, Int, Int, Int) -> Unit,
) {
    private val config = ViewConfiguration.get(view.context)
    private val scroller = OverScroller(view.context)
    private var session = 0L
    private var enabled = false
    private var reduceMotion = false
    private var maxOffset = 0
    private var offset = 0
    private var revision = 0
    private var sample = 0
    private var publishedRevision = -1
    private var publishedSample = -1
    private var downX = 0f
    private var downY = 0f
    private var dragOrigin = 0f
    private var velocity: VelocityTracker? = null
    private var captured = false
    private var dragging = false
    private var framePending = false
    private val frame = Runnable { tick() }

    val isAttached: Boolean get() = session > 0

    fun configure(session: Long, active: Boolean, limit: Int, reduce: Boolean, current: Int) {
        if (limit < 0) {
            if (this.session == session) {
                enabled = false
                interrupt()
                this.session = 0L
            }
            return
        }
        if (this.session != session) {
            interrupt()
            this.session = session
            revision = 0
            sample = 0
            publishedRevision = -1
            publishedSample = -1
            offset = current
        }
        enabled = active
        if (!enabled) interrupt(publishPending = true)
        maxOffset = limit.coerceAtLeast(0)
        reduceMotion = reduce
        if (reduce) scroller.forceFinished(true)
        if (offset > maxOffset) {
            scroller.forceFinished(true)
            setOffset(maxOffset)
        }
    }

    fun layoutOffset(session: Long, revision: Int, sample: Int, offset: Int): Int {
        if (this.session == session && this.revision == revision && this.sample == sample && !dragging && scroller.isFinished) {
            this.offset = offset.coerceIn(0, maxOffset)
        } else if (session == 0L && !enabled) {
            return offset
        }
        return this.offset
    }

    fun reposition(session: Long, revision: Int, target: Int, relative: Boolean) {
        if (this.session != session || revision <= this.revision) return
        this.revision = revision
        if (relative) {
            dragOrigin += target
            val speed = scroller.currVelocity
            val direction = (scroller.finalY - scroller.currY).compareTo(0)
            val wasFlinging = !scroller.isFinished
            scroller.forceFinished(true)
            setOffset((offset.toLong() + target).coerceIn(0, maxOffset.toLong()).toInt())
            if (wasFlinging) fling((direction * speed).roundToInt())
        } else {
            scroller.forceFinished(true)
            dragging = false
            recycleVelocity()
            setOffset(target)
        }
        scheduleFrame()
    }

    fun handle(event: MotionEvent, canStart: Boolean, cancelWebTouch: () -> Unit): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                captured = false
                dragging = false
                scroller.forceFinished(true)
                recycleVelocity()
                if (enabled && canStart && maxOffset > 0) {
                    downX = event.rawX
                    downY = event.rawY
                    velocity = VelocityTracker.obtain().apply { addMovement(event) }
                }
            }
            MotionEvent.ACTION_MOVE -> {
                val tracker = velocity ?: return captured
                tracker.addMovement(event)
                if (!captured) {
                    val dx = abs(event.rawX - downX)
                    val dy = abs(event.rawY - downY)
                    if (dy <= config.scaledTouchSlop && dx <= config.scaledTouchSlop) return false
                    if (!enabled || !canStart || dy <= dx) {
                        recycleVelocity()
                        return false
                    }
                    captured = true
                    dragging = true
                    val adjustedY = downY + if (event.rawY > downY) config.scaledTouchSlop else -config.scaledTouchSlop
                    dragOrigin = offset + adjustedY
                    cancelWebTouch()
                }
                if (dragging) setOffset((dragOrigin - event.rawY).roundToInt())
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                dragging = false
                recycleVelocity()
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (captured && dragging && event.actionMasked == MotionEvent.ACTION_UP && !reduceMotion) {
                    velocity?.let { tracker ->
                        tracker.addMovement(event)
                        tracker.computeCurrentVelocity(1000, config.scaledMaximumFlingVelocity.toFloat())
                        fling(-tracker.yVelocity.roundToInt())
                    }
                }
                val consumed = captured
                captured = false
                dragging = false
                recycleVelocity()
                return consumed
            }
        }
        return captured
    }

    fun interrupt(publishPending: Boolean = false) {
        dragging = false
        scroller.forceFinished(true)
        recycleVelocity()
        view.removeCallbacks(frame)
        if (framePending && publishPending) publishOffset()
        framePending = false
    }

    private fun recycleVelocity() {
        velocity?.recycle()
        velocity = null
    }

    private fun fling(speed: Int) {
        if (abs(speed) < config.scaledMinimumFlingVelocity) return
        scroller.fling(0, offset, 0, speed, 0, 0, 0, maxOffset)
        scheduleFrame()
    }

    private fun setOffset(next: Int) {
        val bounded = next.coerceIn(0, maxOffset)
        if (bounded == offset) return
        offset = bounded
        sample++
        draw(offset)
        scheduleFrame()
    }

    private fun scheduleFrame() {
        if (framePending) return
        framePending = true
        view.postOnAnimation(frame)
    }

    private fun tick() {
        if (!scroller.isFinished && scroller.computeScrollOffset()) setOffset(scroller.currY)
        publishOffset()
        framePending = false
        if (!scroller.isFinished) scheduleFrame()
    }

    private fun publishOffset() {
        if (publishedRevision == revision && publishedSample == sample) return
        publishedRevision = revision
        publishedSample = sample
        publish(session, revision, sample, offset)
    }
}
