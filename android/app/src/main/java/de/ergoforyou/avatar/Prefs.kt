package de.ergoforyou.avatar

import android.content.Context

class Prefs(context: Context) {
    private val prefs = context.getSharedPreferences("avatar", Context.MODE_PRIVATE)

    var speak: Boolean
        get() = prefs.getBoolean("speak", true)
        set(value) = prefs.edit().putBoolean("speak", value).apply()

    var overlay: Boolean
        get() = prefs.getBoolean("overlay", true)
        set(value) = prefs.edit().putBoolean("overlay", value).apply()

    /** Ausgewähltes Avatar-Video; ohne Video wird das Platzhalter-Gesicht gezeigt. */
    var videoUri: String?
        get() = prefs.getString("videoUri", null)
        set(value) = prefs.edit().putString("videoUri", value).apply()

    var removeBackground: Boolean
        get() = prefs.getBoolean("removeBackground", true)
        set(value) = prefs.edit().putBoolean("removeBackground", value).apply()

    /** 0–100: wie stark Farben ähnlich der Hintergrundfarbe mit ausgestanzt werden. */
    var tolerance: Int
        get() = prefs.getInt("tolerance", 30)
        set(value) = prefs.edit().putInt("tolerance", value).apply()

    var sizeDp: Int
        get() = prefs.getInt("sizeDp", 180)
        set(value) = prefs.edit().putInt("sizeDp", value).apply()
}
