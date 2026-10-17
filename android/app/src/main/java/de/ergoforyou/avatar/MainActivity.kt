package de.ergoforyou.avatar

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast

/** Einrichtung und Protokoll für den Machbarkeitstest. */
class MainActivity : Activity() {
    private lateinit var prefs: Prefs
    private lateinit var status: TextView
    private lateinit var logView: TextView
    private val logListener: () -> Unit = { logView.text = EventLog.text() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        val pad = (resources.displayMetrics.density * 16).toInt()

        status = TextView(this).apply { textSize = 15f }
        logView = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 11f
            setTextIsSelectable(true)
        }

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            addView(status)
            addView(button("1. Bedienungshilfe aktivieren") {
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            })
            addView(button("2. ChatGPT öffnen") {
                val intent = packageManager.getLaunchIntentForPackage(ReaderService.CHATGPT)
                if (intent != null) startActivity(intent) else toast("ChatGPT-App nicht gefunden")
            })
            addView(Switch(context).apply {
                text = "Avatar spricht (Sprachausgabe)"
                isChecked = prefs.speak
                setOnCheckedChangeListener { _, on ->
                    prefs.speak = on
                    if (!on) ReaderService.instance?.stopSpeaking()
                }
            })
            addView(Switch(context).apply {
                text = "Schwebenden Avatar anzeigen"
                isChecked = prefs.overlay
                setOnCheckedChangeListener { _, on ->
                    prefs.overlay = on
                    ReaderService.instance?.setOverlayVisible(on)
                }
            })
            addView(TextView(context).apply {
                text = "Tipp: ChatGPT-Sprachausgabe stumm schalten bzw. Chat mit Diktierfunktion nutzen. " +
                    "Avatar lange drücken = ChatGPT-Bildschirmstruktur kopieren (für die Auswertung)."
                textSize = 12f
                setPadding(0, pad / 2, 0, pad / 2)
            })
            addView(LinearLayout(context).apply {
                addView(button("Protokoll kopieren") {
                    getSystemService(ClipboardManager::class.java)
                        .setPrimaryClip(ClipData.newPlainText("Protokoll", EventLog.text()))
                    toast("Protokoll kopiert")
                })
                addView(button("Leeren") { EventLog.clear() })
            })
            addView(logView)
        }
        setContentView(ScrollView(this).apply { addView(content) })
    }

    override fun onResume() {
        super.onResume()
        EventLog.addListener(logListener)
        logListener()
        status.text = if (ReaderService.instance != null) {
            "✅ Mitlesen ist aktiv"
        } else {
            "⚠️ Bedienungshilfe ist aus. Unter „Installierte Apps“ → „Avatar Overlay“ einschalten.\n" +
                "Ist der Schalter ausgegraut: App-Info → ⋮ → „Eingeschränkte Einstellungen zulassen“."
        }
    }

    override fun onPause() {
        EventLog.removeListener(logListener)
        super.onPause()
    }

    private fun button(label: String, onClick: (View) -> Unit) =
        Button(this).apply {
            text = label
            isAllCaps = false
            setOnClickListener(onClick)
        }

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
}
