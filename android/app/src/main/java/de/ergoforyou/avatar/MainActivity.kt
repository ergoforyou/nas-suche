package de.ergoforyou.avatar

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.webkit.MimeTypeMap
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import java.io.File

/** Einrichtung und Protokoll für den Machbarkeitstest. */
class MainActivity : Activity() {
    private companion object {
        const val PICK_VIDEO = 1
    }

    private lateinit var prefs: Prefs
    private lateinit var status: TextView
    private lateinit var activeSwitch: Switch
    private lateinit var logView: TextView
    private val logListener: () -> Unit = { logView.text = EventLog.text() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        val pad = (resources.displayMetrics.density * 16).toInt()

        status = TextView(this).apply { textSize = 15f }
        activeSwitch = Switch(this).apply {
            text = "Avatar aktiv (anzeigen + mitlesen)"
            setOnCheckedChangeListener { _, on ->
                if (on == prefs.overlay) return@setOnCheckedChangeListener
                val service = ReaderService.instance
                if (service != null) service.setActive(on) else prefs.overlay = on
            }
        }
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
            addView(activeSwitch)
            addView(section("Avatar"))
            addView(button("Avatar-Video auswählen") {
                startActivityForResult(
                    Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("video/*"),
                    PICK_VIDEO,
                )
            })
            addView(button("Platzhalter statt Video") {
                prefs.videoPath?.let { File(it).delete() }
                prefs.videoPath = null
                ReaderService.instance?.reloadAvatar()
            })
            addView(slider("Größe (dp)", 80, 480, prefs.sizeDp) { prefs.sizeDp = it })
            addView(TextView(context).apply {
                text = "Für einen durchsichtigen Hintergrund ein WebM-Video mit Transparenz (Alphakanal) " +
                    "verwenden. Am Avatar: tippen = Bedienleiste mit − / + (Größe), CC (Untertitel), ✕ (aus)."
                textSize = 12f
            })

            addView(section("Test"))
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
        activeSwitch.isChecked = prefs.overlay
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

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val uri = data?.data
        if (requestCode != PICK_VIDEO || resultCode != RESULT_OK || uri == null) return
        toast("Video wird übernommen …")
        // Lokal kopieren: die WebView spielt es dann direkt aus dem App-Speicher ab.
        Thread {
            val result = runCatching {
                val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(contentResolver.getType(uri)) ?: "webm"
                filesDir.listFiles { f -> f.name.startsWith("avatar-video.") }?.forEach { it.delete() }
                val target = File(filesDir, "avatar-video.$ext")
                contentResolver.openInputStream(uri)!!.use { input -> target.outputStream().use { input.copyTo(it) } }
                target
            }
            runOnUiThread {
                result.onSuccess {
                    prefs.videoPath = it.absolutePath
                    ReaderService.instance?.reloadAvatar()
                    EventLog.add("Avatar-Video gesetzt: ${it.name} (${it.length() / 1024} KB)")
                    toast("Video gesetzt")
                }.onFailure { toast("Video konnte nicht übernommen werden: ${it.message}") }
            }
        }.start()
    }

    private fun section(title: String) = TextView(this).apply {
        text = title
        textSize = 17f
        setTypeface(typeface, Typeface.BOLD)
        setPadding(0, (resources.displayMetrics.density * 16).toInt(), 0, 0)
    }

    /** Schieberegler, der den Avatar beim Loslassen mit dem neuen Wert neu lädt. */
    private fun slider(label: String, min: Int, max: Int, value: Int, onChange: (Int) -> Unit): View {
        val title = TextView(this).apply { text = "$label: $value" }
        val bar = SeekBar(this).apply {
            this.max = max - min
            progress = value - min
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(bar: SeekBar, progress: Int, fromUser: Boolean) {
                    title.text = "$label: ${progress + min}"
                }
                override fun onStartTrackingTouch(bar: SeekBar) = Unit
                override fun onStopTrackingTouch(bar: SeekBar) {
                    onChange(bar.progress + min)
                    ReaderService.instance?.reloadAvatar()
                }
            })
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(title)
            addView(bar)
        }
    }

    private fun button(label: String, onClick: (View) -> Unit) =
        Button(this).apply {
            text = label
            isAllCaps = false
            setOnClickListener(onClick)
        }

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
}
