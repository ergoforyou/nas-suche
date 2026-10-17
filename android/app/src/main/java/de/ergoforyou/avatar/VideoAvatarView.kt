package de.ergoforyou.avatar

import android.content.Context
import android.graphics.SurfaceTexture
import android.media.MediaPlayer
import android.net.Uri
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLSurface
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.opengl.Matrix
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface
import android.view.TextureView
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Spielt das Avatar-Video stumm in Endlosschleife auf transparentem Grund.
 *
 * Normale Videos (MP4) haben keinen durchsichtigen Hintergrund. Deshalb wird optional
 * die Farbe der linken oberen Ecke per Shader ausgestanzt (Greenscreen-Prinzip) – das
 * klappt gut bei einfarbigem Hintergrund (grün, schwarz, weiß).
 */
class VideoAvatarView(
    context: Context,
    private val uri: Uri,
    private val keyEnabled: Boolean,
    tolerancePercent: Int,
) : TextureView(context), TextureView.SurfaceTextureListener {

    private val tolerance = 0.05f + tolerancePercent / 100f * 0.5f
    private var renderer: Renderer? = null

    init {
        isOpaque = false
        surfaceTextureListener = this
    }

    override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
        renderer = Renderer(surface, width, height).also { it.start() }
    }

    override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {
        renderer?.resize(width, height)
    }

    override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
        renderer?.release()
        renderer = null
        return true
    }

    override fun onSurfaceTextureUpdated(surface: SurfaceTexture) = Unit

    private inner class Renderer(
        private val output: SurfaceTexture,
        @Volatile private var width: Int,
        @Volatile private var height: Int,
    ) {
        private val thread = HandlerThread("AvatarVideo").apply { start() }
        private val handler = Handler(thread.looper)

        private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
        private var eglContext: EGLContext = EGL14.EGL_NO_CONTEXT
        private var eglSurface: EGLSurface = EGL14.EGL_NO_SURFACE
        private var program = 0
        private var textureId = 0
        private var videoTexture: SurfaceTexture? = null
        private var videoSurface: Surface? = null
        private var player: MediaPlayer? = null
        private var videoW = 1
        private var videoH = 1
        private val texMatrix = FloatArray(16)
        private val keyUv = FloatArray(4)

        fun start() = handler.post {
            try {
                setUpEgl()
                setUpGl()
                setUpPlayer()
            } catch (e: Exception) {
                EventLog.add("Video konnte nicht abgespielt werden: ${e.message}")
            }
        }

        fun resize(w: Int, h: Int) {
            width = w
            height = h
        }

        fun release() {
            handler.post {
                player?.release()
                videoSurface?.release()
                videoTexture?.release()
                if (display != EGL14.EGL_NO_DISPLAY) {
                    EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
                    EGL14.eglDestroySurface(display, eglSurface)
                    EGL14.eglDestroyContext(display, eglContext)
                    EGL14.eglTerminate(display)
                }
                thread.quitSafely()
            }
        }

        private fun setUpEgl() {
            display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
            val version = IntArray(2)
            EGL14.eglInitialize(display, version, 0, version, 1)
            val attribs = intArrayOf(
                EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8,
                EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT, EGL14.EGL_NONE,
            )
            val configs = arrayOfNulls<EGLConfig>(1)
            val count = IntArray(1)
            EGL14.eglChooseConfig(display, attribs, 0, configs, 0, 1, count, 0)
            val config = configs[0] ?: error("Keine passende EGL-Konfiguration")
            eglContext = EGL14.eglCreateContext(
                display, config, EGL14.EGL_NO_CONTEXT,
                intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0,
            )
            eglSurface = EGL14.eglCreateWindowSurface(display, config, output, intArrayOf(EGL14.EGL_NONE), 0)
            EGL14.eglMakeCurrent(display, eglSurface, eglSurface, eglContext)
        }

        private fun setUpGl() {
            program = linkProgram(VERTEX_SHADER, FRAGMENT_SHADER)
            val ids = IntArray(1)
            GLES20.glGenTextures(1, ids, 0)
            textureId = ids[0]
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)

            videoTexture = SurfaceTexture(textureId).apply {
                setOnFrameAvailableListener({ draw() }, handler)
            }
            videoSurface = Surface(videoTexture)
        }

        private fun setUpPlayer() {
            player = MediaPlayer().apply {
                setDataSource(context, uri)
                setSurface(videoSurface)
                isLooping = true
                setVolume(0f, 0f)
                setOnVideoSizeChangedListener { _, w, h ->
                    if (w > 0 && h > 0) {
                        videoW = w
                        videoH = h
                    }
                }
                setOnErrorListener { _, what, extra ->
                    EventLog.add("Videofehler ($what/$extra) – Format wird evtl. nicht unterstützt")
                    true
                }
                prepare()
                start()
            }
            EventLog.add("Avatar-Video läuft")
        }

        private fun draw() {
            val texture = videoTexture ?: return
            texture.updateTexImage()
            texture.getTransformMatrix(texMatrix)
            // Farbe der linken oberen Ecke als "durchsichtig" verwenden.
            Matrix.multiplyMV(keyUv, 0, texMatrix, 0, floatArrayOf(0.02f, 0.98f, 0f, 1f), 0)

            GLES20.glViewport(0, 0, width, height)
            GLES20.glClearColor(0f, 0f, 0f, 0f)
            GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
            GLES20.glUseProgram(program)

            // Seitenverhältnis des Videos beibehalten.
            val viewAspect = width.toFloat() / height
            val videoAspect = videoW.toFloat() / videoH
            val sx = if (videoAspect > viewAspect) 1f else videoAspect / viewAspect
            val sy = if (videoAspect > viewAspect) viewAspect / videoAspect else 1f

            val aPos = GLES20.glGetAttribLocation(program, "aPos")
            val aTex = GLES20.glGetAttribLocation(program, "aTex")
            GLES20.glEnableVertexAttribArray(aPos)
            GLES20.glVertexAttribPointer(aPos, 2, GLES20.GL_FLOAT, false, 0, QUAD)
            GLES20.glEnableVertexAttribArray(aTex)
            GLES20.glVertexAttribPointer(aTex, 2, GLES20.GL_FLOAT, false, 0, TEX)
            GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(program, "uTexMatrix"), 1, false, texMatrix, 0)
            GLES20.glUniform2f(GLES20.glGetUniformLocation(program, "uScale"), sx, sy)
            GLES20.glUniform2f(GLES20.glGetUniformLocation(program, "uKeyUv"), keyUv[0], keyUv[1])
            GLES20.glUniform1f(GLES20.glGetUniformLocation(program, "uTolerance"), tolerance)
            GLES20.glUniform1f(GLES20.glGetUniformLocation(program, "uKeyOn"), if (keyEnabled) 1f else 0f)

            GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId)
            GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
            EGL14.eglSwapBuffers(display, eglSurface)
        }
    }

    private companion object {
        val QUAD = floatBuffer(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f)
        val TEX = floatBuffer(0f, 0f, 1f, 0f, 0f, 1f, 1f, 1f)

        const val VERTEX_SHADER = """
            attribute vec4 aPos;
            attribute vec4 aTex;
            uniform mat4 uTexMatrix;
            uniform vec2 uScale;
            varying vec2 vTex;
            void main() {
                gl_Position = vec4(aPos.xy * uScale, 0.0, 1.0);
                vTex = (uTexMatrix * aTex).xy;
            }
        """

        const val FRAGMENT_SHADER = """
            #extension GL_OES_EGL_image_external : require
            precision mediump float;
            uniform samplerExternalOES sTex;
            uniform vec2 uKeyUv;
            uniform float uTolerance;
            uniform float uKeyOn;
            varying vec2 vTex;
            void main() {
                vec4 c = texture2D(sTex, vTex);
                vec3 key = texture2D(sTex, uKeyUv).rgb;
                float a = mix(1.0, smoothstep(uTolerance, uTolerance + 0.12, distance(c.rgb, key)), uKeyOn);
                gl_FragColor = vec4(c.rgb * a, a);
            }
        """

        fun floatBuffer(vararg values: Float) =
            ByteBuffer.allocateDirect(values.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply {
                put(values)
                position(0)
            }

        fun linkProgram(vertex: String, fragment: String): Int {
            val program = GLES20.glCreateProgram()
            GLES20.glAttachShader(program, compile(GLES20.GL_VERTEX_SHADER, vertex))
            GLES20.glAttachShader(program, compile(GLES20.GL_FRAGMENT_SHADER, fragment))
            GLES20.glLinkProgram(program)
            return program
        }

        fun compile(type: Int, source: String): Int {
            val shader = GLES20.glCreateShader(type)
            GLES20.glShaderSource(shader, source.trimIndent())
            GLES20.glCompileShader(shader)
            val ok = IntArray(1)
            GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, ok, 0)
            if (ok[0] == 0) error("Shader-Fehler: ${GLES20.glGetShaderInfoLog(shader)}")
            return shader
        }
    }
}
