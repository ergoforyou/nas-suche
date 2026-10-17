package de.ergoforyou.avatar

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.view.View
import kotlin.math.abs
import kotlin.math.sin

/**
 * Platzhalter-Avatar auf transparentem Grund. Wird später durch den echten Avatar
 * (z. B. als transparente WebView) ersetzt – die Schnittstelle bleibt [speaking].
 */
class AvatarView(context: Context) : View(context) {
    var speaking = false
        set(value) {
            field = value
            invalidate()
        }

    private val face = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(255, 196, 140) }
    private val outline = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(160, 0, 0, 0)
        style = Paint.Style.STROKE
        strokeWidth = 4f
    }
    private val feature = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(60, 40, 40) }
    private val mouth = RectF()

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val default = (resources.displayMetrics.density * 96).toInt()
        val size = minOf(resolveSize(default, widthMeasureSpec), resolveSize(default, heightMeasureSpec))
        setMeasuredDimension(size, size)
    }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val cx = w / 2
        val r = w / 2 - 4
        canvas.drawCircle(cx, cx, r, face)
        canvas.drawCircle(cx, cx, r, outline)
        canvas.drawCircle(cx - r * 0.35f, cx - r * 0.2f, r * 0.09f, feature)
        canvas.drawCircle(cx + r * 0.35f, cx - r * 0.2f, r * 0.09f, feature)

        val open = if (speaking) 0.06f + 0.22f * abs(sin(System.currentTimeMillis() / 90.0)).toFloat() else 0.04f
        mouth.set(cx - r * 0.3f, cx + r * 0.35f - r * open, cx + r * 0.3f, cx + r * 0.35f + r * open)
        canvas.drawOval(mouth, feature)

        if (speaking) postInvalidateOnAnimation()
    }
}
