package de.ergoforyou.avatar

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.abs

/**
 * Schwebender, durchsichtiger Avatar über allen Apps. Als Bedienungshilfe-Overlay
 * braucht er keine zusätzliche Berechtigung "Über anderen Apps einblenden".
 *
 * Bedienung: ziehen = verschieben, tippen = Untertitel an/aus,
 * lange drücken = Bildschirmstruktur von ChatGPT in die Zwischenablage kopieren.
 */
@SuppressLint("ClickableViewAccessibility")
class AvatarOverlay(context: Context, private val onLongPress: () -> Unit) {
    private val windowManager = context.getSystemService(WindowManager::class.java)
    private val avatar = AvatarView(context)
    private val caption = TextView(context).apply {
        setTextColor(Color.WHITE)
        textSize = 13f
        maxLines = 3
        maxWidth = (context.resources.displayMetrics.density * 240).toInt()
        setPadding(20, 10, 20, 10)
        background = GradientDrawable().apply {
            cornerRadius = 24f
            setColor(Color.argb(170, 0, 0, 0))
        }
        visibility = TextView.GONE
    }
    private val root = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        addView(avatar)
        addView(caption)
    }
    private val params = WindowManager.LayoutParams(
        WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        PixelFormat.TRANSLUCENT,
    ).apply {
        gravity = Gravity.TOP or Gravity.START
        x = 40
        y = 300
    }
    private var shown = false
    private var showCaption = true

    init {
        var downX = 0f
        var downY = 0f
        var startX = 0
        var startY = 0
        var downTime = 0L
        avatar.setOnTouchListener { _, e ->
            when (e.action) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX; downY = e.rawY
                    startX = params.x; startY = params.y
                    downTime = e.eventTime
                }
                MotionEvent.ACTION_MOVE -> {
                    params.x = startX + (e.rawX - downX).toInt()
                    params.y = startY + (e.rawY - downY).toInt()
                    if (shown) windowManager.updateViewLayout(root, params)
                }
                MotionEvent.ACTION_UP -> {
                    val moved = abs(e.rawX - downX) > 20 || abs(e.rawY - downY) > 20
                    if (!moved && e.eventTime - downTime > 600) onLongPress()
                    else if (!moved) {
                        showCaption = !showCaption
                        if (!showCaption) caption.visibility = TextView.GONE
                    }
                }
            }
            true
        }
    }

    fun show() {
        if (shown) return
        windowManager.addView(root, params)
        shown = true
    }

    fun hide() {
        if (!shown) return
        windowManager.removeView(root)
        shown = false
    }

    fun setSpeaking(speaking: Boolean) {
        avatar.speaking = speaking
    }

    fun setCaption(text: String) {
        caption.text = text
        caption.visibility = if (showCaption) TextView.VISIBLE else TextView.GONE
    }
}
