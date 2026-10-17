package de.ergoforyou.avatar

import android.os.Handler
import android.os.Looper
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** In-Memory-Protokoll mit Zeitstempeln, damit wir Verzögerungen im Test ablesen können. */
object EventLog {
    private const val MAX_LINES = 300
    private val lines = ArrayDeque<String>()
    private val listeners = mutableSetOf<() -> Unit>()
    private val main = Handler(Looper.getMainLooper())
    private val format = SimpleDateFormat("HH:mm:ss.SSS", Locale.GERMANY)

    @Synchronized
    fun add(message: String) {
        lines.addLast("${format.format(Date())}  $message")
        while (lines.size > MAX_LINES) lines.removeFirst()
        main.post { listeners.forEach { it() } }
    }

    @Synchronized
    fun text(): String = lines.joinToString("\n")

    @Synchronized
    fun clear() {
        lines.clear()
        main.post { listeners.forEach { it() } }
    }

    fun addListener(listener: () -> Unit) = listeners.add(listener)
    fun removeListener(listener: () -> Unit) = listeners.remove(listener)
}
