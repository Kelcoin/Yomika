package app.yomika.reader

import org.junit.Assert.assertEquals
import org.junit.Test

class ReaderImageTransformTest {
    @Test fun panKeepsSmallGapAndReversesImmediatelyAtBoundary() {
        val start = ReaderImageTransform(1f, 18f, -20f)
        val near = start.follow(1f, 0f, 0f, 49f, 0f, 100, 100, 30, 160)
        assertEquals(67f, near.left, .001f)
        val edge = near.follow(1f, 49f, 0f, 57f, 12f, 100, 100, 30, 160)
        assertEquals(70f, edge.left, .001f)
        assertEquals(-8f, edge.top, .001f)
        val back = edge.follow(1f, 57f, 12f, 56f, 12f, 100, 100, 30, 160)
        assertEquals(69f, back.left, .001f)
    }

    @Test fun pinchAcrossFitKeepsTheUnconstrainedAxisAnchored() {
        val start = ReaderImageTransform(.99f, .5f, -40f)
        val next = start.follow(1.01f, 50f, 21f, 50f, 24f, 100, 100, 100, 200)
        assertEquals(-.5f, next.left, .001f)
        assertEquals(24f - (21f + 40f) * 1.01f / .99f, next.top, .001f)
    }
    @Test fun offCenterZoomStartsInsideTheDragBounds() {
        val zoom = ReaderImageTransform(2f, -1483f, 383f).bounded(1440, 2304, 1440, 810)
        assertEquals(-1440f, zoom.left, .001f)
        assertEquals(383f, zoom.top, .001f)
        val outward = zoom.follow(2f, 600f, 900f, 597f, 900f, 1440, 2304, 1440, 810)
        assertEquals(-1440f, outward.left, .001f)
        val back = outward.follow(2f, 597f, 900f, 600f, 900f, 1440, 2304, 1440, 810)
        assertEquals(-1437f, back.left, .001f)
    }
    @Test fun fittedPageCannotPanAndZoomingBackConvergesToFit() {
        val fit = ReaderImageTransform(1f, 0f, 75f)
        val dragged = fit.follow(1f, 50f, 110f, 52f, 180f, 100, 200, 100, 50)
        assertEquals(fit, dragged)
        val zoom = ReaderImageTransform(1.5f, -20f, 100f)
        val almostFit = zoom.follow(1.001f, 20f, 130f, 20f, 130f, 100, 200, 100, 50)
        assertEquals((200f - 50f * almostFit.scale) / 2f, almostFit.top, .201f)
        assertEquals(fit, almostFit.follow(1f, 20f, 130f, 20f, 160f, 100, 200, 100, 50))
    }
}
