package app.yomika.reader

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.drawable.Animatable
import android.graphics.drawable.Drawable
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import java.io.BufferedInputStream
import java.io.DataInputStream
import java.nio.ByteBuffer

/** APNG frames are composited by the Rust worker and delivered through a private fd. */
internal class ReaderApngDrawable private constructor(
    private val frames: List<Bitmap>,
    private val ends: LongArray,
    private val loops: Long,
) : Drawable(), Animatable {
    private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
    private val advance = Runnable { invalidateSelf() }
    private var started: Long? = null
    private var index = 0

    override fun getIntrinsicWidth() = frames[0].width
    override fun getIntrinsicHeight() = frames[0].height
    override fun setAlpha(alpha: Int) { paint.alpha = alpha }
    override fun setColorFilter(colorFilter: ColorFilter?) { paint.colorFilter = colorFilter }
    @Deprecated("Required by Drawable")
    override fun getOpacity() = PixelFormat.TRANSLUCENT

    override fun start() {
        if (isRunning || frames.size < 2) return
        started = SystemClock.uptimeMillis()
        index = 0
        invalidateSelf()
    }

    override fun stop() {
        started = null
        unscheduleSelf(advance)
    }

    override fun isRunning() = started != null

    override fun draw(canvas: Canvas) {
        started?.let { begin ->
            val now = SystemClock.uptimeMillis()
            val elapsed = (now - begin).coerceAtLeast(0)
            val duration = ends.last()
            if (loops != 0L && elapsed / duration >= loops) {
                index = frames.lastIndex
                stop()
            } else {
                val phase = elapsed % duration
                val found = ends.binarySearch(phase)
                index = if (found < 0) -found - 1 else found + 1
                unscheduleSelf(advance)
                scheduleSelf(advance, now + ends[index] - phase)
            }
        }
        canvas.drawBitmap(frames[index], null, bounds, paint)
    }

    companion object {
        fun decode(source: ParcelFileDescriptor): ReaderApngDrawable =
            DataInputStream(BufferedInputStream(ParcelFileDescriptor.AutoCloseInputStream(source))).use { input ->
                check(input.readInt() == 0x59415031) // YAP1
                val width = input.readInt()
                val height = input.readInt()
                val count = input.readInt()
                val loops = input.readInt().toLong() and 0xffff_ffffL
                val pixels = width.toLong() * height
                check(width > 0 && height > 0 && pixels <= 4L * 1024 * 1024 && count in 1..360)
                val bytesPerFrame = pixels.toInt() * 4
                check(bytesPerFrame.toLong() * count <= 24L * 1024 * 1024)
                val ends = LongArray(count)
                val bytes = ByteArray(bytesPerFrame)
                val buffer = ByteBuffer.wrap(bytes)
                val images = ArrayList<Bitmap>(count)
                try {
                    for (index in 0 until count) {
                        ends[index] = input.readLong()
                        check(ends[index] > (ends.getOrNull(index - 1) ?: 0L))
                        input.readFully(bytes)
                        buffer.rewind()
                        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                        images += bitmap
                        bitmap.copyPixelsFromBuffer(buffer)
                    }
                } catch (error: Throwable) {
                    images.forEach(Bitmap::recycle)
                    throw error
                }
                ReaderApngDrawable(images, ends, loops)
            }
    }
}
