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
}
