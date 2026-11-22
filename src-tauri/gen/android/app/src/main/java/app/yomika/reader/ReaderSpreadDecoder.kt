package app.yomika.reader

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapRegionDecoder
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Point
import android.graphics.Rect
import android.graphics.RectF
import android.media.ExifInterface
import android.net.Uri
import com.davemorrissey.labs.subscaleview.decoder.ImageRegionDecoder
import java.io.File
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.roundToInt

/** Decodes only the parts of the two pages intersecting an SSIV tile. */
internal class ReaderSpreadDecoder(
    private val files: List<File>,
    private val aspect: Float,
    private val animatedSizes: List<Point?> = List(files.size) { null },
    private val onPlaced: (List<RectF>) -> Unit = {},
) : ImageRegionDecoder {
    private class Page(file: File, animatedSize: Point?) {
        @Suppress("DEPRECATION")
        val decoder = if (animatedSize == null) {
            checkNotNull(BitmapRegionDecoder.newInstance(file.path, false))
        } else null
        val oriented = Matrix()
        val size: RectF
        val toSpread = Matrix()
        val fromSpread = Matrix()
        val bounds = RectF()

        init {
            val orientation = if (animatedSize != null) 1 else runCatching {
                ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1)
            }.getOrDefault(1)
            when (orientation) {
                2 -> oriented.setScale(-1f, 1f)
                3 -> oriented.setRotate(180f)
                4 -> oriented.setScale(1f, -1f)
                5 -> { oriented.setRotate(90f); oriented.postScale(-1f, 1f) }
                6 -> oriented.setRotate(90f)
                7 -> { oriented.setRotate(90f); oriented.postScale(1f, -1f) }
                8 -> oriented.setRotate(270f)
            }
            val width = animatedSize?.x ?: checkNotNull(decoder).width
            val height = animatedSize?.y ?: checkNotNull(decoder).height
            size = RectF(0f, 0f, width.toFloat(), height.toFloat())
            oriented.mapRect(size)
            oriented.postTranslate(-size.left, -size.top)
        }

        fun place(halfWidth: Int, height: Int, left: Boolean) {
            val scale = minOf(halfWidth / size.width(), height / size.height())
            val width = size.width() * scale
            val imageHeight = size.height() * scale
            bounds.set(if (left) halfWidth - width else halfWidth.toFloat(), (height - imageHeight) / 2f,
                if (left) halfWidth.toFloat() else halfWidth + width, (height + imageHeight) / 2f)
            toSpread.set(oriented)
            toSpread.postScale(scale, scale)
            toSpread.postTranslate(bounds.left, bounds.top)
            check(toSpread.invert(fromSpread))
        }
    }

    private val pages = ArrayList<Page>(2)
    @Volatile private var ready = false

    override fun init(context: Context, uri: Uri): Point {
        try {
            files.forEachIndexed { index, file -> pages.add(Page(file, animatedSizes[index])) }
            if (pages.size == 1) {
                val page = pages.single()
                val width = page.size.width().roundToInt()
                val height = page.size.height().roundToInt()
                page.place(width, height, true)
                onPlaced(listOf(RectF(page.bounds)))
                ready = true
                return Point(width, height)
            }
            val halfWidth = pages.maxOf { it.size.width() }.roundToInt().coerceAtLeast(1)
            val height = (halfWidth * 2 / aspect).roundToInt().coerceAtLeast(1)
            pages.forEachIndexed { index, page -> page.place(halfWidth, height, index == 0) }
            onPlaced(pages.map { RectF(it.bounds) })
            ready = true
            return Point(halfWidth * 2, height)
        } catch (error: Exception) {
            recycle()
            throw error
        }
    }

    override fun decodeRegion(rect: Rect, sampleSize: Int): Bitmap {
        val output = Bitmap.createBitmap(
            (rect.width() + sampleSize - 1) / sampleSize,
            (rect.height() + sampleSize - 1) / sampleSize,
            Bitmap.Config.ARGB_8888,
        )
        try {
            val canvas = Canvas(output)
            canvas.drawColor(Color.BLACK)
            canvas.scale(1f / sampleSize, 1f / sampleSize)
            canvas.translate(-rect.left.toFloat(), -rect.top.toFloat())
            val paint = Paint(Paint.FILTER_BITMAP_FLAG)
            for (page in pages) {
                val decoder = page.decoder ?: continue
                val overlap = RectF(rect)
                if (!overlap.intersect(page.bounds)) continue
                val save = canvas.save()
                canvas.clipRect(overlap)
                page.fromSpread.mapRect(overlap)
                val source = Rect(floor(overlap.left).toInt().coerceAtLeast(0), floor(overlap.top).toInt().coerceAtLeast(0),
                    ceil(overlap.right).toInt().coerceAtMost(decoder.width), ceil(overlap.bottom).toInt().coerceAtMost(decoder.height))
                if (!source.isEmpty) {
                    val scale = page.bounds.width() / page.size.width()
                    val rawSample = Integer.highestOneBit((sampleSize / scale).toInt().coerceAtLeast(1))
                    // Adjacent output tiles must sample the same source grid.
                    // Include one neighbouring sample so filtering never clamps
                    // at an internal tile edge. The output clip stays exact.
                    val padded = Rect(
                        (source.left / rawSample * rawSample - rawSample).coerceAtLeast(0),
                        (source.top / rawSample * rawSample - rawSample).coerceAtLeast(0),
                        (((source.right + rawSample - 1) / rawSample + 1) * rawSample).coerceAtMost(decoder.width),
                        (((source.bottom + rawSample - 1) / rawSample + 1) * rawSample).coerceAtMost(decoder.height),
                    )
                    val tile = checkNotNull(decoder.decodeRegion(padded, BitmapFactory.Options().apply { inSampleSize = rawSample }))
                    try {
                        canvas.concat(page.toSpread)
                        canvas.drawBitmap(tile, null, RectF(padded), paint)
                    } finally {
                        tile.recycle()
                    }
                }
                canvas.restoreToCount(save)
            }
            return output
        } catch (error: Throwable) {
            output.recycle()
            throw error
        }
    }

    override fun isReady() = ready

    override fun recycle() {
        ready = false
        pages.forEach { it.decoder?.recycle() }
        pages.clear()
    }
}
