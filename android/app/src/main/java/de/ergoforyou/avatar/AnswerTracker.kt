package de.ergoforyou.avatar

/** Ein sichtbarer Text auf dem ChatGPT-Bildschirm. */
data class TextNode(val text: String, val left: Int)

/**
 * Erkennt in den wechselnden Bildschirmtexten der ChatGPT-App die neue Antwort
 * und gibt sie satzweise zum Vorlesen weiter, während sie noch gestreamt wird.
 *
 * Heuristiken (genau die wollen wir im Machbarkeitstest prüfen):
 * - Texte, die beim Start schon da sind, gelten als Verlauf und werden ignoriert.
 * - Ein Text, der mit der aktuellen Antwort beginnt, ist dieselbe Antwort, nur länger (Streaming).
 * - Rechts eingerückte Blasen stammen von dir, linksbündige von ChatGPT.
 * - Tauchen viele neue Texte auf einmal auf, wurde gescrollt oder der Chat gewechselt.
 */
class AnswerTracker(
    private val speak: (String) -> Unit,
    private val log: (String) -> Unit,
) {
    private val known = HashSet<String>()
    private var initialized = false
    private var activeText: String? = null
    private var spokenUpTo = 0
    private var lastGrowth = 0L

    fun reset() {
        flush()
        known.clear()
        initialized = false
        activeText = null
    }

    fun update(nodes: List<TextNode>, screenWidth: Int, now: Long) {
        if (!initialized) {
            nodes.forEach { known.add(it.text) }
            initialized = true
            log("Start: ${nodes.size} vorhandene Texte als Verlauf ignoriert")
            return
        }

        val fresh = nodes.filter { it.text !in known }
        if (fresh.isEmpty()) return
        fresh.forEach { known.add(it.text) }

        val growing = fresh.filter { n -> activeText?.let { n.text.startsWith(it) } == true }
        growing.maxByOrNull { it.text.length }?.let {
            activeText = it.text
            lastGrowth = now
        }

        val newMessages = fresh - growing.toSet()
        if (newMessages.size > MAX_NEW_PER_SCAN) {
            log("${newMessages.size} neue Texte auf einmal – vermutlich gescrollt, wird ignoriert")
        } else {
            val tail = nodes.takeLast(TAIL_SIZE).toSet()
            for (n in newMessages) {
                if (n !in tail) continue
                val fromUser = n.left > screenWidth * USER_BUBBLE_INDENT
                log((if (fromUser) "[DU] " else "[KI] ") + n.text.take(80).replace('\n', ' '))
                if (fromUser) continue
                flush()
                activeText = n.text
                spokenUpTo = 0
                lastGrowth = now
            }
        }
        speakCompletedSentences()
    }

    /** Wird regelmäßig aufgerufen; liest den Rest vor, sobald die Antwort nicht mehr wächst. */
    fun onTick(now: Long) {
        val text = activeText ?: return
        if (spokenUpTo < text.length && now - lastGrowth > IDLE_FLUSH_MS) flush()
    }

    private fun speakCompletedSentences() {
        val text = activeText ?: return
        val end = SENTENCE_END.findAll(text, spokenUpTo).lastOrNull()?.range?.last?.plus(1) ?: return
        if (end > spokenUpTo) {
            emit(text.substring(spokenUpTo, end))
            spokenUpTo = end
        }
    }

    private fun flush() {
        val text = activeText ?: return
        if (spokenUpTo < text.length) emit(text.substring(spokenUpTo))
        spokenUpTo = text.length
    }

    private fun emit(raw: String) {
        val clean = raw.replace(MARKDOWN, "").trim()
        if (clean.isNotEmpty()) speak(clean)
    }

    private companion object {
        const val TAIL_SIZE = 3
        const val MAX_NEW_PER_SCAN = 3
        const val USER_BUBBLE_INDENT = 0.2
        const val IDLE_FLUSH_MS = 1500L
        val SENTENCE_END = Regex("[.!?…:\\n]\\s")
        val MARKDOWN = Regex("[*#`_>]")
    }
}
