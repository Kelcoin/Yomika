package app.yomika.reader

/** Image position in view pixels, shared by drag and pinch. */
internal data class ReaderImageTransform(val scale: Float, val left: Float, val top: Float) {
    fun follow(
        nextScale: Float, previousX: Float, previousY: Float, x: Float, y: Float,
        viewWidth: Int, viewHeight: Int, imageWidth: Int, imageHeight: Int,
    ): ReaderImageTransform {
        val ratio = nextScale / scale
        return ReaderImageTransform(
            nextScale,
            x - (previousX - left) * ratio,
            y - (previousY - top) * ratio,
        ).bounded(viewWidth, viewHeight, imageWidth, imageHeight)
    }

    fun bounded(viewWidth: Int, viewHeight: Int, imageWidth: Int, imageHeight: Int): ReaderImageTransform {
        val fitScale = minOf(viewWidth.toFloat() / imageWidth, viewHeight.toFloat() / imageHeight)
        val zoomAboveFit = if (fitScale > 0f) (scale / fitScale - 1f).coerceAtLeast(0f) else 0f
        return ReaderImageTransform(
            scale,
            limit(left, viewWidth - imageWidth * scale, viewWidth * zoomAboveFit),
            limit(top, viewHeight - imageHeight * scale, viewHeight * zoomAboveFit),
        )
    }

    private fun limit(position: Float, remaining: Float, roomAboveFit: Float): Float {
        if (remaining <= 0f) return position.coerceIn(remaining, 0f)
        // A short axis is centered at fit. Its pan range grows continuously
        // with zoom, so pinching back to fit cannot snap across the letterbox.
        val midpoint = remaining / 2f
        val room = minOf(midpoint, roomAboveFit)
        return position.coerceIn(midpoint - room, midpoint + room)
    }
}
