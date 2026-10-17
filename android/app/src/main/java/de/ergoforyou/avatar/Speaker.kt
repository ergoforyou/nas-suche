package de.ergoforyou.avatar

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale

/** Sprachausgabe direkt auf dem Handy (kostenlos), meldet ob gerade gesprochen wird. */
class Speaker(context: Context, private val onSpeaking: (Boolean) -> Unit) : TextToSpeech.OnInitListener {
    private val main = Handler(Looper.getMainLooper())
    private val tts = TextToSpeech(context, this)
    private val pending = mutableListOf<String>()
    private var ready = false
    private var counter = 0

    override fun onInit(status: Int) {
        if (status != TextToSpeech.SUCCESS) {
            EventLog.add("Sprachausgabe konnte nicht gestartet werden (Status $status)")
            return
        }
        val result = tts.setLanguage(Locale.GERMANY)
        if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
            EventLog.add("Deutsche Stimme fehlt – bitte in den Android-Einstellungen nachinstallieren")
        }
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {
                main.post { onSpeaking(true) }
            }

            override fun onDone(utteranceId: String?) = finished()
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) = finished()
        })
        ready = true
        pending.forEach(::say)
        pending.clear()
    }

    private fun finished() {
        main.postDelayed({ if (!tts.isSpeaking) onSpeaking(false) }, 150)
    }

    fun say(text: String) {
        if (!ready) {
            pending.add(text)
            return
        }
        tts.speak(text, TextToSpeech.QUEUE_ADD, null, "u${counter++}")
    }

    fun stop() {
        tts.stop()
        onSpeaking(false)
    }

    fun shutdown() = tts.shutdown()
}
