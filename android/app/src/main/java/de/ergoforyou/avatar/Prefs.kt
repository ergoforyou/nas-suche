package de.ergoforyou.avatar

import android.content.Context

class Prefs(context: Context) {
    private val prefs = context.getSharedPreferences("avatar", Context.MODE_PRIVATE)

    var speak: Boolean
        get() = prefs.getBoolean("speak", true)
        set(value) = prefs.edit().putBoolean("speak", value).apply()

    /** Avatar an = anzeigen und mitlesen; aus = alles pausiert (auch per ×-Knopf am Avatar). */
    var overlay: Boolean
        get() = prefs.getBoolean("overlay", true)
        set(value) = prefs.edit().putBoolean("overlay", value).apply()

    /** Lokale Kopie des Avatar-Videos; ohne Video wird das Platzhalter-Gesicht gezeigt. */
    var videoPath: String?
        get() = prefs.getString("videoPath", null)
        set(value) = prefs.edit().putString("videoPath", value).apply()

    var sizeDp: Int
        get() = prefs.getInt("sizeDp", 180)
        set(value) = prefs.edit().putInt("sizeDp", value).apply()
}
