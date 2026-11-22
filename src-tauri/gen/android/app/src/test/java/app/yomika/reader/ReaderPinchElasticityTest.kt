package app.yomika.reader

import org.junit.Assert.assertEquals
import org.junit.Test

class ReaderPinchElasticityTest {
    @Test fun resistsBothLimitsAndClearsWhenFingersReturn() {
        assertEquals(0.910f, ReaderPinchElasticity.feedback(.1f, .2f), .001f)
        assertEquals(0.940f, ReaderPinchElasticity.feedback(.15f, .2f), .001f)
        assertEquals(1f, ReaderPinchElasticity.feedback(.215f, .215f), 0f)
        assertEquals(1.090f, ReaderPinchElasticity.feedback(6f, 4f), .001f)
        assertEquals(1f, ReaderPinchElasticity.feedback(3.9f, 3.9f), 0f)
        assertEquals(1.120f, ReaderPinchElasticity.feedback(16f, 4f), .001f)
    }
}
