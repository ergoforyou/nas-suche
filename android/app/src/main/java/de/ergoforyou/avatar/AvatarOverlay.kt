package de.ergoforyou.avatar

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import java.io.File
import kotlin.math.abs

/**
 * Schwebender, durchsichtiger Avatar über allen Apps. Als Bedienungshilfe-Overlay
 * braucht er keine zusätzliche Berechtigung "Über anderen Apps einblenden".
 *
 * Bedienung: ziehen = verschieben, tippen = Bedienleiste (− + Untertitel ×),
 * lange drücken = Bildschirmstruktur von ChatGPT in die Zwischenablage kopieren.
 */
@SuppressLint("ClickableViewAccessibility")
class AvatarOverlay(
    private val context: Context,
    private val onLongPress: () -> Unit,
    private val onClose: () -> Unit,
) {
    private companion object {
        const val MIN_SIZE_DP = 80
        const val MAX_SIZE_DP = 480
        const val SIZE_STEP_DP = 40
        const val CONTROLS_VISIBLE_MS = 4000L
    }

    private val windowManager = context.getSystemService(WindowManager::class.java)
    private val prefs = Prefs(context)
    private val density = context.resources.displayMetrics.density
    private val handler = Handler(Looper.getMainLooper())
    private val placeholder = AvatarView(context)
    private var avatarView: View = placeholder

    // Unsichtbare Fläche über dem Avatar fängt Gesten ab, damit die WebView sie nicht schluckt.
    private val touchLayer = View(context)
    private val stage = FrameLayout(context)
    private val pulse = ValueAnimator.ofFloat(1f, 1.04f).apply {
        duration = 420
        repeatMode = ValueAnimator.REVERSE
        repeatCount = ValueAnimator.INFINITE
        addUpdateListener { stage.scaleX = it.animatedValue as Float; stage.scaleY = it.animatedValue as Float }
    }
    private val caption = TextView(context).apply {
        setTextColor(Color.WHITE)
        textSize = 13f
        maxLines = 3
        maxWidth = (density * 240).toInt()
        setPadding(20, 10, 20, 10)
        background = pill()
        visibility = View.GONE
    }
    private val controls = LinearLayout(context).apply {
        background = pill()
        visibility = View.GONE
        addView(controlButton("−") { resize(-SIZE_STEP_DP) })
        addView(controlButton("+") { resize(SIZE_STEP_DP) })
        addView(controlButton("CC") { toggleCaption() })
        addView(controlButton("✕") { onClose() })
    }
    private val hideControls = Runnable { controls.visibility = View.GONE }
    private val root = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        addView(controls)
        addView(stage)
        addView(caption)
    }
    private val params = WindowManager.LayoutParams(
        WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
        PixelFormat.TRANSLUCENT,
    ).apply {
        gravity = Gravity.TOP or Gravity.START
        x = 40
        y = 300
    }
    private var shown = false
    private var showCaption = true

    init {
        loadAvatar()
        var downX = 0f
        var downY = 0f
        var startX = 0
        var startY = 0
        var downTime = 0L
        touchLayer.setOnTouchListener { _, e ->
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
                    else if (!moved) showControls()
                }
            }
            true
        }
    }

    /** Baut den Avatar nach den aktuellen Einstellungen neu auf (Video oder Platzhalter, Größe). */
    fun loadAvatar() {
        stage.removeAllViews()
        (avatarView as? VideoAvatarView)?.destroy()
        val video = prefs.videoPath?.let(::File)?.takeIf { it.exists() }
        avatarView = if (video != null) VideoAvatarView(context, video) else placeholder
        val size = (density * prefs.sizeDp).toInt()
        stage.addView(avatarView, FrameLayout.LayoutParams(size, size))
        stage.addView(touchLayer, FrameLayout.LayoutParams(size, size))
    }

    fun show() {
        if (shown) return
        windowManager.addView(root, params)
        shown = true
    }

    fun hide() {
        if (!shown) return
        controls.visibility = View.GONE
        windowManager.removeView(root)
        shown = false
    }

    fun setSpeaking(speaking: Boolean) {
        placeholder.speaking = speaking
        if (speaking) {
            if (!pulse.isStarted) pulse.start()
        } else {
            pulse.cancel()
            stage.scaleX = 1f
            stage.scaleY = 1f
        }
    }

    fun setCaption(text: String) {
        caption.text = text
        caption.visibility = if (showCaption) View.VISIBLE else View.GONE
    }

    private fun resize(deltaDp: Int) {
        prefs.sizeDp = (prefs.sizeDp + deltaDp).coerceIn(MIN_SIZE_DP, MAX_SIZE_DP)
        val size = (density * prefs.sizeDp).toInt()
        for (view in listOf(avatarView, touchLayer)) {
            view.layoutParams = view.layoutParams.apply { width = size; height = size }
        }
        showControls()
    }

    private fun toggleCaption() {
        showCaption = !showCaption
        if (!showCaption) caption.visibility = View.GONE
        showControls()
    }

    private fun showControls() {
        controls.visibility = View.VISIBLE
        handler.removeCallbacks(hideControls)
        handler.postDelayed(hideControls, CONTROLS_VISIBLE_MS)
    }

    private fun controlButton(label: String, onClick: () -> Unit) = TextView(context).apply {
        text = label
        setTextColor(Color.WHITE)
        textSize = 18f
        gravity = Gravity.CENTER
        val pad = (density * 10).toInt()
        setPadding(pad, pad / 2, pad, pad / 2)
        minWidth = (density * 44).toInt()
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    }

    private fun pill() = GradientDrawable().apply {
        cornerRadius = 24f * density
        setColor(Color.argb(170, 0, 0, 0))
    }
}
