package de.ergoforyou.avatar

import android.accessibilityservice.AccessibilityService
import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Toast

/** Liest die Antworten der ChatGPT-App vom Bildschirm und lässt den Avatar sie sprechen. */
class ReaderService : AccessibilityService() {

    companion object {
        const val CHATGPT = "com.openai.chatgpt"
        private const val SCAN_DELAY_MS = 150L
        private const val TICK_MS = 500L

        var instance: ReaderService? = null
            private set
    }

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var prefs: Prefs
    private lateinit var speaker: Speaker
    private var overlay: AvatarOverlay? = null
    private var scanScheduled = false
    private val bounds = Rect()

    private val tracker = AnswerTracker(
        speak = { text ->
            EventLog.add("→ spricht: ${text.take(60)}")
            overlay?.setCaption(text)
            if (prefs.speak) speaker.say(text)
        },
        log = EventLog::add,
    )

    private val scan = Runnable {
        scanScheduled = false
        scanScreen()
    }

    private val tick = object : Runnable {
        override fun run() {
            tracker.onTick(SystemClock.uptimeMillis())
            handler.postDelayed(this, TICK_MS)
        }
    }

    override fun onServiceConnected() {
        instance = this
        prefs = Prefs(this)
        speaker = Speaker(this) { overlay?.setSpeaking(it) }
        overlay = AvatarOverlay(this, onLongPress = ::copyScreenStructure, onClose = { setActive(false) })
        setActive(prefs.overlay)
        handler.post(tick)
        EventLog.add("Mitlesen aktiv – öffne jetzt ChatGPT")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.packageName != CHATGPT || !prefs.overlay) return
        // Throttle statt Debounce: beim Streaming kommen ständig Events, wir wollen trotzdem mitlesen.
        if (!scanScheduled) {
            scanScheduled = true
            handler.postDelayed(scan, SCAN_DELAY_MS)
        }
    }

    override fun onInterrupt() = speaker.stop()

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        overlay?.hide()
        speaker.shutdown()
        instance = null
        super.onDestroy()
    }

    /** Avatar an/aus. Aus = ausgeblendet, still und es wird nicht mehr mitgelesen. */
    fun setActive(active: Boolean) {
        prefs.overlay = active
        if (active) {
            tracker.reset()
            overlay?.show()
        } else {
            speaker.stop()
            overlay?.hide()
        }
        EventLog.add(if (active) "Avatar eingeschaltet" else "Avatar ausgeschaltet")
    }

    fun stopSpeaking() = speaker.stop()

    fun reloadAvatar() = overlay?.loadAvatar()

    private fun chatGptRoot(): AccessibilityNodeInfo? =
        rootInActiveWindow?.takeIf { it.packageName == CHATGPT }
            ?: windows.firstNotNullOfOrNull { w -> w.root?.takeIf { it.packageName == CHATGPT } }

    private fun scanScreen() {
        val root = chatGptRoot() ?: return
        val nodes = mutableListOf<TextNode>()
        collectTexts(root, nodes)
        tracker.update(nodes, resources.displayMetrics.widthPixels, SystemClock.uptimeMillis())
    }

    private fun collectTexts(node: AccessibilityNodeInfo, out: MutableList<TextNode>) {
        val text = node.text?.toString()?.trim()
        if (!text.isNullOrEmpty() && !node.isEditable && node.isVisibleToUser) {
            node.getBoundsInScreen(bounds)
            out.add(TextNode(text, bounds.left))
        }
        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { collectTexts(it, out) }
        }
    }

    /** Für die Auswertung: komplette Bildschirmstruktur von ChatGPT als Text. */
    private fun copyScreenStructure() {
        val root = chatGptRoot()
        if (root == null) {
            Toast.makeText(this, "ChatGPT ist gerade nicht auf dem Bildschirm", Toast.LENGTH_SHORT).show()
            return
        }
        val sb = StringBuilder()
        dump(root, 0, sb)
        getSystemService(ClipboardManager::class.java)
            .setPrimaryClip(ClipData.newPlainText("ChatGPT-Struktur", sb.toString()))
        EventLog.add("Bildschirmstruktur kopiert (${sb.length} Zeichen)")
        Toast.makeText(this, "Struktur in Zwischenablage kopiert", Toast.LENGTH_SHORT).show()
    }

    private fun dump(node: AccessibilityNodeInfo, depth: Int, sb: StringBuilder) {
        node.getBoundsInScreen(bounds)
        sb.append("  ".repeat(depth))
            .append(node.className?.toString()?.substringAfterLast('.'))
        node.viewIdResourceName?.let { sb.append(" id=").append(it.substringAfter(":id/")) }
        node.text?.let { sb.append(" text=\"").append(it.toString().take(120).replace('\n', ' ')).append('"') }
        node.contentDescription?.let { sb.append(" desc=\"").append(it.toString().take(80)).append('"') }
        if (node.isEditable) sb.append(" [editierbar]")
        sb.append(" ").append(bounds.toShortString()).append('\n')
        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { dump(it, depth + 1, sb) }
        }
    }
}
