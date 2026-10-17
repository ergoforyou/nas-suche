package de.ergoforyou.avatar

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.webkit.WebView
import java.io.File

/**
 * Spielt das Avatar-Video stumm in Endlosschleife in einer durchsichtigen WebView.
 *
 * Die WebView (Chrome-Technik) versteht den Alphakanal von WebM-Videos (VP8/VP9 mit
 * Transparenz) – der normale Android-Videoplayer ignoriert ihn. Später kann hier auch
 * der echte, web-basierte Avatar laufen.
 */
@SuppressLint("SetJavaScriptEnabled", "ViewConstructor")
class VideoAvatarView(context: Context, video: File) : WebView(context) {
    init {
        setBackgroundColor(Color.TRANSPARENT)
        isVerticalScrollBarEnabled = false
        isHorizontalScrollBarEnabled = false
        settings.apply {
            javaScriptEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = true
        }
        val page = File(video.parentFile, "avatar.html")
        page.writeText(
            """
            <!doctype html>
            <html><head><meta name="viewport" content="width=device-width,initial-scale=1">
            <style>
              html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
              video { width: 100%; height: 100%; object-fit: contain; display: block; }
            </style></head>
            <body><video src="${video.name}?v=${video.lastModified()}" autoplay loop muted playsinline></video></body></html>
            """.trimIndent(),
        )
        loadUrl("file://${page.absolutePath}")
    }
}
