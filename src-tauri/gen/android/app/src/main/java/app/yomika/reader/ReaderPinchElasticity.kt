package app.yomika.reader

/** Visual overscale applied to the composited image outside its decoder limits. */
internal object ReaderPinchElasticity {
    fun feedback(rawScale: Float, boundedScale: Float): Float {
        if (rawScale == boundedScale) return 1f
        val travel = rawScale / boundedScale - 1f
        // Match elasticPinchScale in the WebView reader.
        val overshoot = 0.12f * (1f - kotlin.math.exp(-2.75f * kotlin.math.abs(travel)))
        return 1f + if (travel < 0f) -overshoot else overshoot
    }
}
