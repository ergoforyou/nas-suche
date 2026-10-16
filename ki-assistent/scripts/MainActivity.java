package de.ergoforyou.kiassistent;

import android.Manifest;
import android.app.PictureInPictureParams;
import android.app.StatusBarManager;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.drawable.Icon;
import android.location.Address;
import android.location.Geocoder;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.BatteryManager;
import android.os.PowerManager;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.view.KeyEvent;
import android.annotation.SuppressLint;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.util.DisplayMetrics;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.Toast;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;
import android.net.Uri;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import java.io.OutputStream;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import android.content.Intent;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;
import android.util.Rational;
import android.webkit.JavascriptInterface;
import com.getcapacitor.BridgeActivity;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Bild-im-Bild (wie bei YouTube): Beim Verlassen der App schrumpft sie zu einem kleinen, frei verschiebbaren
 * Fenster, in dem nur die Figur zu sehen ist. Die Oberfläche schaltet dafür per window.__setPip um und kann
 * über window.KIPip die Funktion an- und ausschalten oder sofort auslösen.
 */
public class MainActivity extends BridgeActivity {
    private boolean pipEnabled = true;
    /** die laufende Oberfläche (für Erinnerungen, die bei offener App angesagt werden) */
    static WeakReference<MainActivity> current = new WeakReference<>(null);
    boolean resumed;
    // Ereignisse von außen (Teilen, Widget, Kachel, Assistent-Taste, Headset), bis die Oberfläche sie abholt
    private final JSONArray pendingEvents = new JSONArray();
    private MediaSession session;

    // ---- Beta: schwebende Figur über anderen Apps (statt Bild-im-Bild)
    private boolean floatEnabled = false;
    private FrameLayout floatBox;
    private WindowManager.LayoutParams floatParams;
    private ViewGroup webParent;
    private int webIndex;
    private ViewGroup.LayoutParams webLayout;
    private boolean floatStartedService;
    private boolean floatHintShown;
    private boolean floatDock = true; // am Rand andocken (bzw. halb verstecken)
    private boolean floatHalf; // halb hinter dem Rand versteckt
    private android.widget.TextView bubbleView;
    private android.view.View menuView;
    private final android.os.Handler bubbleHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private android.content.BroadcastReceiver carReceiver;
    private int pipW = 3;
    private int pipH = 4;

    // ---- „Speichern unter …“: Android fragt nach Ordner und Dateiname (Downloads, Drive, …)
    private ActivityResultLauncher<String> createDoc;
    private ActivityResultLauncher<Intent> screenAsk;
    private byte[] pendingBytes;
    private String pendingId;

    private void saveDone(boolean ok, String msg) {
        String id = pendingId;
        pendingBytes = null;
        pendingId = null;
        if (bridge == null || id == null) return;
        String js = "window.__kiSaveDone && window.__kiSaveDone(" + org.json.JSONObject.quote(id) + "," + ok + "," + org.json.JSONObject.quote(msg == null ? "" : msg) + ")";
        bridge.getWebView().post(() -> bridge.getWebView().evaluateJavascript(js, null));
    }

    private void writePending(Uri uri) {
        if (uri == null) {
            saveDone(false, "abgebrochen");
            return;
        }
        if (pendingBytes == null) {
            // nur Speicherort gewählt (Datei wird später mit writeUri geschrieben)
            saveDone(true, uri.toString());
            return;
        }
        try (OutputStream out = getContentResolver().openOutputStream(uri)) {
            out.write(pendingBytes);
            saveDone(true, uri.toString());
        } catch (Exception e) {
            saveDone(false, String.valueOf(e.getMessage()));
        }
    }


    // ---- Ereignisse an die Oberfläche: sie holt sie mit KIDevice.takeIntents() ab
    void pushEvent(JSONObject ev) {
        synchronized (pendingEvents) {
            pendingEvents.put(ev);
        }
        runJs("window.__kiIntent && window.__kiIntent()");
    }

    void pushAction(String action) {
        try {
            pushEvent(new JSONObject().put("action", action));
        } catch (Exception ignored) {}
    }

    // nicht über webView.post(): Während die Ansicht ins schwebende Fenster umzieht, ist sie kurz abgehängt,
    // und solche Aufträge würden erst später (und in falscher Reihenfolge) ausgeführt
    private final android.os.Handler mainHandler = new android.os.Handler(android.os.Looper.getMainLooper());

    void runJs(String js) {
        if (bridge == null) return;
        mainHandler.post(() -> {
            if (bridge != null) bridge.getWebView().evaluateJavascript(js, null);
        });
    }

    private static final int SHARE_MAX = 30 * 1024 * 1024;

    /** „Teilen mit KI-Assistent“: Text, Links und Dateien aus anderen Apps. */
    private void readShared(Intent intent) {
        try {
            JSONObject ev = new JSONObject().put("action", "share");
            CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            if (text != null) ev.put("text", text.toString());
            String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
            if (subject != null) ev.put("subject", subject);
            List<Uri> uris = new ArrayList<>();
            if (Intent.ACTION_SEND.equals(intent.getAction())) {
                Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (u != null) uris.add(u);
            } else {
                ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (list != null) uris.addAll(list);
            }
            if (uris.isEmpty() && intent.getClipData() != null && text == null) {
                for (int i = 0; i < intent.getClipData().getItemCount(); i++) {
                    Uri u = intent.getClipData().getItemAt(i).getUri();
                    if (u != null) uris.add(u);
                }
            }
            JSONArray files = new JSONArray();
            for (Uri u : uris) {
                if (files.length() >= 10) break;
                JSONObject f = new JSONObject();
                String name = "Datei";
                long size = -1;
                try (Cursor c = getContentResolver().query(u, null, null, null, null)) {
                    if (c != null && c.moveToFirst()) {
                        int n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                        int sz = c.getColumnIndex(OpenableColumns.SIZE);
                        if (n >= 0 && c.getString(n) != null) name = c.getString(n);
                        if (sz >= 0 && !c.isNull(sz)) size = c.getLong(sz);
                    }
                } catch (Exception ignored) {}
                String mime = getContentResolver().getType(u);
                if (mime == null) mime = intent.getType();
                f.put("name", name).put("mime", mime == null ? "application/octet-stream" : mime);
                if (size > SHARE_MAX) {
                    f.put("tooBig", true);
                } else {
                    try (InputStream in = getContentResolver().openInputStream(u)) {
                        ByteArrayOutputStream buf = new ByteArrayOutputStream();
                        byte[] chunk = new byte[65536];
                        int r;
                        while ((r = in.read(chunk)) > 0) {
                            buf.write(chunk, 0, r);
                            if (buf.size() > SHARE_MAX) break;
                        }
                        if (buf.size() > SHARE_MAX) f.put("tooBig", true);
                        else f.put("data", Base64.encodeToString(buf.toByteArray(), Base64.NO_WRAP));
                    }
                }
                files.put(f);
            }
            if (files.length() > 0) ev.put("files", files);
            pushEvent(ev);
        } catch (Exception e) {
            Log.w("KI-Assistent", "Teilen", e);
            try {
                pushEvent(new JSONObject().put("action", "share").put("error", String.valueOf(e.getMessage())));
            } catch (Exception ignored) {}
        }
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            // Dateien im Hintergrund lesen (können groß sein)
            final Intent copy = intent;
            new Thread(() -> readShared(copy)).start();
        } else if (Intent.ACTION_ASSIST.equals(action) || "android.intent.action.VOICE_COMMAND".equals(action)) {
            pushAction("listen");
        } else if (intent.hasExtra("ki_action")) {
            pushAction(intent.getStringExtra("ki_action"));
        } else {
            return;
        }
        // nicht noch einmal auswerten (z. B. nach Drehen des Bildschirms)
        setIntent(new Intent(this, MainActivity.class));
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    // ---- Gespräch im Hintergrund: Dienst mit Benachrichtigung hält Mikrofon und Ton aktiv, Headset-Taste = Sprechen
    void setBackground(boolean on) {
        Intent svc = new Intent(this, KIConversationService.class);
        if (on) {
            List<String> ask = new ArrayList<>();
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) ask.add(Manifest.permission.POST_NOTIFICATIONS);
            if (Build.VERSION.SDK_INT >= 31 && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) ask.add(Manifest.permission.BLUETOOTH_CONNECT);
            if (!ask.isEmpty()) requestPermissions(ask.toArray(new String[0]), 4711);
            try {
                if (Build.VERSION.SDK_INT >= 26) startForegroundService(svc);
                else startService(svc);
            } catch (Exception e) {
                Log.w("KI-Assistent", "Hintergrund-Dienst", e);
            }
            if (session == null) {
                session = new MediaSession(this, "KI-Assistent");
                session.setCallback(new MediaSession.Callback() {
                    @Override
                    public boolean onMediaButtonEvent(Intent i) {
                        KeyEvent k = i.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
                        if (k != null && k.getAction() == KeyEvent.ACTION_DOWN && k.getRepeatCount() == 0) {
                            int c = k.getKeyCode();
                            if (c == KeyEvent.KEYCODE_HEADSETHOOK || c == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE || c == KeyEvent.KEYCODE_MEDIA_PLAY || c == KeyEvent.KEYCODE_MEDIA_PAUSE) {
                                pushAction("talk");
                                return true;
                            }
                        }
                        return super.onMediaButtonEvent(i);
                    }
                });
                session.setPlaybackState(new PlaybackState.Builder()
                    .setActions(PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE)
                    .setState(PlaybackState.STATE_PLAYING, 0, 1f)
                    .build());
            }
            session.setActive(true);
        } else {
            stopService(svc);
            if (session != null) {
                session.setActive(false);
                session.release();
                session = null;
            }
        }
    }


    // ---- Beta: schwebende Figur. Die WebView mit der laufenden Figur wandert beim Verlassen der App in ein
    // rahmenloses, durchsichtiges Fenster über allen Apps und beim Zurückkehren wieder in die App.
    // Alles läuft weiter (Stimme, Mikrofon, Mimik), weil es dieselbe Oberfläche ist.
    boolean canFloat() {
        return Build.VERSION.SDK_INT >= 26 && Settings.canDrawOverlays(this);
    }

    private WindowManager floatWm() {
        return (WindowManager) getApplicationContext().getSystemService(Context.WINDOW_SERVICE);
    }

    /** Form der Figur hat sich geändert: Fenster anpassen (Breite bleibt). */
    void refitFloat() {
        if (floatBox == null) return;
        DisplayMetrics m = getResources().getDisplayMetrics();
        floatParams.height = Math.max(dp(90), Math.min(Math.round(floatParams.width * (float) pipH / pipW), Math.round(m.heightPixels * 0.85f)));
        floatWm().updateViewLayout(floatBox, floatParams);
    }

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    @SuppressLint("ClickableViewAccessibility")
    void showFloat() {
        if (floatBox != null || bridge == null || !floatEnabled || !canFloat()) return;
        WebView wv = bridge.getWebView();
        if (!(wv.getParent() instanceof ViewGroup)) return;
        DisplayMetrics dm = getResources().getDisplayMetrics();
        android.content.SharedPreferences pref = getSharedPreferences("ki_schwebend", MODE_PRIVATE);
        int w = pref.getInt("w", Math.max(dp(120), Math.round(dm.widthPixels * 0.28f)));
        w = Math.max(dp(90), Math.min(w, dm.widthPixels));
        int h = Math.round(w * (float) pipH / pipW);
        h = Math.max(dp(90), Math.min(h, Math.round(dm.heightPixels * 0.7f)));
        floatParams = new WindowManager.LayoutParams(w, h, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT);
        floatParams.gravity = Gravity.TOP | Gravity.START;
        floatParams.x = pref.getInt("x", dm.widthPixels - w - dp(12));
        floatParams.y = pref.getInt("y", dm.heightPixels - h - dp(120));

        webParent = (ViewGroup) wv.getParent();
        webIndex = webParent.indexOfChild(wv);
        webLayout = wv.getLayoutParams();
        webParent.removeView(wv);

        final GestureDetector taps = new GestureDetector(this, new GestureDetector.SimpleOnGestureListener() {
            @Override
            public boolean onDown(MotionEvent e) {
                return true;
            }

            @Override
            public boolean onSingleTapConfirmed(MotionEvent e) {
                if (floatHalf) {
                    slideIn();
                    return true;
                }
                pushAction("talk");
                return true;
            }

            @Override
            public boolean onDoubleTap(MotionEvent e) {
                Intent back = new Intent(MainActivity.this, MainActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(back);
                return true;
            }

            @Override
            public void onLongPress(MotionEvent e) {
                showFloatMenu();
            }

            @Override
            public boolean onScroll(MotionEvent e1, MotionEvent e2, float dx, float dy) {
                if (floatBox == null || e2.getPointerCount() > 1) return false;
                floatParams.x = Math.round(floatParams.x - dx);
                floatParams.y = Math.round(floatParams.y - dy);
                floatWm().updateViewLayout(floatBox, floatParams);
                return true;
            }
        });
        final ScaleGestureDetector pinch = new ScaleGestureDetector(this, new ScaleGestureDetector.SimpleOnScaleGestureListener() {
            @Override
            public boolean onScale(ScaleGestureDetector d) {
                if (floatBox == null) return false;
                scaleFloat(d.getScaleFactor());
                return true;
            }
        });
        floatBox = new FrameLayout(this) {
            @Override
            public boolean onInterceptTouchEvent(MotionEvent ev) {
                return true; // alle Berührungen sind Gesten für das Fenster, nicht für die Seite
            }

            @Override
            public boolean onTouchEvent(MotionEvent ev) {
                pinch.onTouchEvent(ev);
                if (!pinch.isInProgress()) taps.onTouchEvent(ev);
                if (ev.getActionMasked() == MotionEvent.ACTION_UP || ev.getActionMasked() == MotionEvent.ACTION_CANCEL) saveFloatPlace();
                return true;
            }
        };
        floatBox.setBackgroundColor(Color.TRANSPARENT);
        wv.setBackgroundColor(Color.TRANSPARENT);
        floatBox.addView(wv, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        try {
            floatWm().addView(floatBox, floatParams);
        } catch (Exception e) {
            Log.w("KI-Assistent", "Schwebende Figur", e);
            floatBox.removeView(wv);
            webParent.addView(wv, webIndex, webLayout);
            floatBox = null;
            return;
        }
        // Mikrofon und Ton dürfen im Hintergrund nur mit Vordergrund-Dienst weiterlaufen
        if (!KIConversationService.running) {
            floatStartedService = true;
            try {
                Intent svc = new Intent(this, KIConversationService.class);
                if (Build.VERSION.SDK_INT >= 26) startForegroundService(svc);
                else startService(svc);
            } catch (Exception e) {
                Log.w("KI-Assistent", "Dienst für schwebende Figur", e);
            }
        }
        runJs("window.__setFloat && window.__setFloat(true)");
        if (!floatHintShown) {
            floatHintShown = true;
            Toast.makeText(this, "Tippen: sprechen · doppelt: App · ziehen: verschieben · zwei Finger: Größe · lange drücken: Menü", Toast.LENGTH_LONG).show();
        }
    }

    private void saveFloatPlace() {
        if (floatParams == null) return;
        // im Bildschirm halten (mindestens ein gutes Stück der Figur bleibt sichtbar)
        if (floatBox != null) {
            DisplayMetrics m = getResources().getDisplayMetrics();
            int keepX = Math.min(floatParams.width, dp(60));
            int keepY = Math.min(floatParams.height, dp(60));
            int x = Math.max(keepX - floatParams.width, Math.min(floatParams.x, m.widthPixels - keepX));
            int y = Math.max(0, Math.min(floatParams.y, m.heightPixels - keepY));
            floatHalf = false;
            if (floatDock) {
                int w = floatParams.width;
                int left = x;
                int right = m.widthPixels - (x + w);
                // weit über den Rand gezogen: halb verstecken; nahe am Rand: bündig andocken
                if (left < -w * 0.3f) { x = -w / 2; floatHalf = true; }
                else if (right < -w * 0.3f) { x = m.widthPixels - w / 2; floatHalf = true; }
                else if (left < m.widthPixels * 0.12f) x = 0;
                else if (right < m.widthPixels * 0.12f) x = m.widthPixels - w;
            }
            if (x != floatParams.x || y != floatParams.y) {
                floatParams.x = x;
                floatParams.y = y;
                floatWm().updateViewLayout(floatBox, floatParams);
            }
        }
        getSharedPreferences("ki_schwebend", MODE_PRIVATE).edit()
            .putInt("x", floatParams.x).putInt("y", floatParams.y).putInt("w", floatParams.width).apply();
    }

    void hideFloat() {
        hideBubble();
        hideFloatMenu();
        if (floatBox == null) return;
        saveFloatPlace();
        WebView wv = bridge.getWebView();
        try {
            floatWm().removeView(floatBox);
        } catch (Exception e) {
            Log.w("KI-Assistent", "Schwebende Figur schließen", e);
        }
        floatBox.removeView(wv);
        floatBox = null;
        if (webParent != null) webParent.addView(wv, Math.min(webIndex, webParent.getChildCount()), webLayout);
        wv.setBackgroundColor(Color.WHITE);
        if (floatStartedService) {
            floatStartedService = false;
            stopService(new Intent(this, KIConversationService.class));
        }
        runJs("window.__setFloat && window.__setFloat(false)");
    }


    /** Halb versteckte Figur wieder ganz hereinholen. */
    void slideIn() {
        if (floatBox == null) return;
        DisplayMetrics m = getResources().getDisplayMetrics();
        floatParams.x = floatParams.x < 0 ? 0 : m.widthPixels - floatParams.width;
        floatHalf = false;
        floatWm().updateViewLayout(floatBox, floatParams);
        saveFloatPlace();
    }

    /** Sprechblase neben der schwebenden Figur (eigenes kleines Fenster, nimmt keine Berührungen an). */
    void showBubble(String text, int ms) {
        if (floatBox == null || text == null || text.trim().isEmpty()) return;
        hideBubble();
        DisplayMetrics m = getResources().getDisplayMetrics();
        android.widget.TextView tv = new android.widget.TextView(this);
        tv.setText(text.length() > 220 ? text.substring(0, 217) + " …" : text);
        tv.setTextColor(0xFF1B1F27);
        tv.setTextSize(14);
        tv.setMaxWidth(dp(240));
        tv.setPadding(dp(12), dp(8), dp(12), dp(8));
        android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
        bg.setColor(0xF2FAFBFD);
        bg.setCornerRadius(dp(14));
        tv.setBackground(bg);
        tv.setElevation(dp(4));
        WindowManager.LayoutParams p = new WindowManager.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
            PixelFormat.TRANSLUCENT);
        p.gravity = Gravity.TOP | Gravity.START;
        tv.measure(android.view.View.MeasureSpec.makeMeasureSpec(dp(240), android.view.View.MeasureSpec.AT_MOST), android.view.View.MeasureSpec.UNSPECIFIED);
        int bw = tv.getMeasuredWidth();
        int cx = floatParams.x + floatParams.width / 2;
        p.x = cx > m.widthPixels / 2 ? Math.max(dp(4), floatParams.x - bw - dp(6)) : Math.min(m.widthPixels - bw - dp(4), floatParams.x + floatParams.width + dp(6));
        p.y = Math.max(dp(4), floatParams.y + dp(8));
        try {
            floatWm().addView(tv, p);
            bubbleView = tv;
            bubbleHandler.postDelayed(this::hideBubble, Math.max(1500, ms));
        } catch (Exception e) {
            Log.w("KI-Assistent", "Sprechblase", e);
        }
    }

    void hideBubble() {
        bubbleHandler.removeCallbacksAndMessages(null);
        if (bubbleView != null) {
            try { floatWm().removeView(bubbleView); } catch (Exception ignored) {}
            bubbleView = null;
        }
    }

    /** Menü bei langem Drücken: Sprechen, Live, App öffnen, Ausblenden. */
    void showFloatMenu() {
        if (floatBox == null) return;
        hideFloatMenu();
        android.widget.LinearLayout box = new android.widget.LinearLayout(this);
        box.setOrientation(android.widget.LinearLayout.VERTICAL);
        box.setPadding(dp(6), dp(6), dp(6), dp(6));
        android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
        bg.setColor(0xF01E2430);
        bg.setCornerRadius(dp(14));
        box.setBackground(bg);
        box.setElevation(dp(6));
        String[][] items = { { "🎤  Sprechen", "talk" }, { "📞  Live an/aus", "livetoggle" }, { "🖼  Bildschirm fragen", "screenask" }, { "➖  Kleiner", "smaller" }, { "➕  Größer", "bigger" }, { "📱  App öffnen", "app" }, { "🙈  Ausblenden", "hide" } };
        for (String[] it : items) {
            android.widget.TextView tv = new android.widget.TextView(this);
            tv.setText(it[0]);
            tv.setTextColor(Color.WHITE);
            tv.setTextSize(16);
            tv.setPadding(dp(14), dp(10), dp(18), dp(10));
            final String what = it[1];
            tv.setOnClickListener((v) -> {
                // Größe: Menü bleibt offen, damit man mehrmals tippen kann
                if (what.equals("smaller") || what.equals("bigger")) {
                    scaleFloat(what.equals("smaller") ? 0.85f : 1.18f);
                    saveFloatPlace();
                    return;
                }
                hideFloatMenu();
                if (what.equals("hide")) {
                    hideFloat();
                    Toast.makeText(MainActivity.this, "Figur ausgeblendet – App öffnen, um sie wieder zu sehen", Toast.LENGTH_SHORT).show();
                } else if (what.equals("app")) {
                    startActivity(new Intent(MainActivity.this, MainActivity.class)
                        .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK));
                } else pushAction(what);
            });
            box.addView(tv);
        }
        box.setOnTouchListener((v, ev) -> {
            if (ev.getActionMasked() == MotionEvent.ACTION_OUTSIDE) hideFloatMenu();
            return false;
        });
        WindowManager.LayoutParams p = new WindowManager.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
            PixelFormat.TRANSLUCENT);
        p.gravity = Gravity.TOP | Gravity.START;
        DisplayMetrics m = getResources().getDisplayMetrics();
        box.measure(android.view.View.MeasureSpec.UNSPECIFIED, android.view.View.MeasureSpec.UNSPECIFIED);
        int mw = box.getMeasuredWidth();
        int cx = floatParams.x + floatParams.width / 2;
        p.x = cx > m.widthPixels / 2 ? Math.max(dp(4), floatParams.x - mw - dp(6)) : Math.min(m.widthPixels - mw - dp(4), floatParams.x + floatParams.width + dp(6));
        p.y = Math.max(dp(4), floatParams.y + dp(20));
        try {
            floatWm().addView(box, p);
            menuView = box;
        } catch (Exception e) {
            Log.w("KI-Assistent", "Menü", e);
        }
    }

    /** Schwebende Figur vergrößern/verkleinern (um die Mitte, mit Grenzen). */
    void scaleFloat(float k) {
        if (floatBox == null || floatParams == null) return;
        DisplayMetrics m = getResources().getDisplayMetrics();
        int nw = Math.max(dp(90), Math.min(m.widthPixels, Math.round(floatParams.width * k)));
        int nh = Math.round(nw * (float) pipH / pipW);
        if (nh > m.heightPixels * 0.85f) return;
        floatParams.x -= (nw - floatParams.width) / 2;
        floatParams.y -= (nh - floatParams.height) / 2;
        floatParams.width = nw;
        floatParams.height = nh;
        try {
            floatWm().updateViewLayout(floatBox, floatParams);
        } catch (Exception e) {
            Log.w("KI-Assistent", "Größe", e);
        }
    }

    void hideFloatMenu() {
        if (menuView != null) {
            try { floatWm().removeView(menuView); } catch (Exception ignored) {}
            menuView = null;
        }
    }

    // ---- Fahrmodus: Verbindet sich das gewählte Auto-Bluetooth, meldet die App das der Oberfläche
    @SuppressLint("MissingPermission")
    void registerCarReceiver() {
        if (carReceiver != null) return;
        carReceiver = new android.content.BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent i) {
                String car = getSharedPreferences("ki_auto", MODE_PRIVATE).getString("name", "");
                if (car.isEmpty()) return;
                android.bluetooth.BluetoothDevice d = i.getParcelableExtra(android.bluetooth.BluetoothDevice.EXTRA_DEVICE);
                String name = null;
                try { name = d == null ? null : d.getName(); } catch (Exception ignored) {}
                if (name == null || !name.equals(car)) return;
                boolean on = android.bluetooth.BluetoothDevice.ACTION_ACL_CONNECTED.equals(i.getAction());
                try {
                    pushEvent(new JSONObject().put("action", "car").put("on", on));
                } catch (Exception ignored) {}
                if (on && !resumed) {
                    try {
                        startActivity(new Intent(MainActivity.this, MainActivity.class)
                            .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK));
                    } catch (Exception e) {
                        Log.w("KI-Assistent", "Fahrmodus: App nach vorn", e);
                    }
                }
            }
        };
        IntentFilter f = new IntentFilter();
        f.addAction(android.bluetooth.BluetoothDevice.ACTION_ACL_CONNECTED);
        f.addAction(android.bluetooth.BluetoothDevice.ACTION_ACL_DISCONNECTED);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(carReceiver, f, Context.RECEIVER_EXPORTED);
        else registerReceiver(carReceiver, f);
    }

    /** Schnittstelle für die Oberfläche: window.KIFloat */
    public class Floater {
        @JavascriptInterface
        public boolean supported() {
            return Build.VERSION.SDK_INT >= 26;
        }

        @JavascriptInterface
        public boolean allowed() {
            return canFloat();
        }

        /** Android-Einstellung „Über anderen Apps einblenden“ für diese App öffnen. */
        @JavascriptInterface
        public void askPermission() {
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName())));
                } catch (Exception e) {
                    startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION));
                }
            });
        }

        /** Beim Verlassen der App schweben (statt Bild-im-Bild). */
        @JavascriptInterface
        public void setEnabled(boolean on) {
            runOnUiThread(() -> {
                floatEnabled = on;
                applyParams();
            });
        }

        /** Sofort schweben lassen: App in den Hintergrund, Figur bleibt. */
        @JavascriptInterface
        public void now() {
            runOnUiThread(() -> {
                if (!floatEnabled || !canFloat()) return;
                showFloat();
                moveTaskToBack(true);
            });
        }

        @JavascriptInterface
        public boolean showing() {
            return floatBox != null;
        }

        @JavascriptInterface
        public void bubble(String text, int ms) {
            runOnUiThread(() -> showBubble(text, ms));
        }

        @JavascriptInterface
        public void setDock(boolean on) {
            floatDock = on;
        }
    }

    /** Schnittstelle für Teilen, Schnellstart, Standort-Namen, Erinnerungen, Hintergrund-Gespräch und Akku. */
    public class Device {
        @JavascriptInterface
        public String takeIntents() {
            synchronized (pendingEvents) {
                String out = pendingEvents.toString();
                while (pendingEvents.length() > 0) pendingEvents.remove(0);
                return out;
            }
        }

        /** Akku: {"level":0..100,"charging":bool,"saver":bool} */
        @JavascriptInterface
        public String power() {
            try {
                Intent b = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
                int level = b == null ? -1 : b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
                int scale = b == null ? 100 : b.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
                int plugged = b == null ? 0 : b.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                return new JSONObject()
                    .put("level", level < 0 ? -1 : Math.round(level * 100f / Math.max(1, scale)))
                    .put("charging", plugged != 0)
                    .put("saver", pm != null && pm.isPowerSaveMode())
                    .toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        /** Ortsname zu einer Position (über den Geocoder des Handys); "" wenn keiner verfügbar ist. */
        @JavascriptInterface
        public String placeName(double lat, double lon) {
            try {
                if (!Geocoder.isPresent()) return "";
                List<Address> list = new Geocoder(MainActivity.this, Locale.GERMANY).getFromLocation(lat, lon, 1);
                if (list == null || list.isEmpty()) return "";
                Address a = list.get(0);
                List<String> parts = new ArrayList<>();
                if (a.getSubLocality() != null) parts.add(a.getSubLocality());
                if (a.getLocality() != null) parts.add(a.getLocality());
                else if (a.getSubAdminArea() != null) parts.add(a.getSubAdminArea());
                if (a.getAdminArea() != null) parts.add(a.getAdminArea());
                if (a.getCountryName() != null) parts.add(a.getCountryName());
                return android.text.TextUtils.join(", ", parts);
            } catch (Exception e) {
                Log.w("KI-Assistent", "Ortsname", e);
                return "";
            }
        }

        /** Erinnerungen planen: [{"key","at"(ms),"title","text"}] – ersetzt die bisherige Liste. */
        @JavascriptInterface
        public void setReminders(String json) {
            KIReminder.store(MainActivity.this, json);
        }

        @JavascriptInterface
        public boolean notifyAllowed() {
            return Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        }

        @JavascriptInterface
        public void askNotify() {
            if (Build.VERSION.SDK_INT >= 33) runOnUiThread(() -> requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 4712));
        }

        @JavascriptInterface
        public void setBackground(boolean on) {
            runOnUiThread(() -> MainActivity.this.setBackground(on));
        }

        @JavascriptInterface
        public boolean backgroundRunning() {
            return KIConversationService.running;
        }

        /** Widget auf den Startbildschirm legen (Android fragt nach). */
        @JavascriptInterface
        public boolean pinWidget() {
            if (Build.VERSION.SDK_INT < 26) return false;
            AppWidgetManager m = getSystemService(AppWidgetManager.class);
            if (m == null || !m.isRequestPinAppWidgetSupported()) return false;
            return m.requestPinAppWidget(new ComponentName(MainActivity.this, KIWidget.class), null, null);
        }

        /** Kachel „KI sprechen“ zu den Schnelleinstellungen hinzufügen (ab Android 13; sonst von Hand). */
        @JavascriptInterface
        public boolean addTile() {
            if (Build.VERSION.SDK_INT < 33) return false;
            runOnUiThread(() -> {
                try {
                    StatusBarManager sbm = getSystemService(StatusBarManager.class);
                    sbm.requestAddTileService(new ComponentName(MainActivity.this, KITile.class), "KI sprechen",
                        Icon.createWithResource(MainActivity.this, R.drawable.ic_ki_mic), getMainExecutor(), (r) -> {});
                } catch (Exception e) {
                    Log.w("KI-Assistent", "Kachel", e);
                }
            });
            return true;
        }

        /** Ist die App vom Akku-Sparen ausgenommen (wichtig bei Samsung für Hintergrund und schwebende Figur)? */
        @JavascriptInterface
        public boolean batteryExempt() {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            return pm == null || pm.isIgnoringBatteryOptimizations(getPackageName());
        }

        @JavascriptInterface
        public void askBatteryExempt() {
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
                } catch (Exception e) {
                    try {
                        startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                    } catch (Exception ignored) {}
                }
            });
        }

        /** Systemprotokoll dieser App (nur eigene Einträge) für das Fehlerprotokoll. */
        @JavascriptInterface
        public String appLog() {
            try {
                Process p = Runtime.getRuntime().exec(new String[] { "logcat", "-d", "-t", "400", "--pid=" + android.os.Process.myPid() });
                BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = r.readLine()) != null) sb.append(line).append('\n');
                return sb.toString();
            } catch (Exception e) {
                return "Systemprotokoll nicht lesbar: " + e.getMessage();
            }
        }

        @JavascriptInterface
        public String deviceInfo() {
            try {
                return new JSONObject()
                    .put("hersteller", Build.MANUFACTURER).put("modell", Build.MODEL).put("android", Build.VERSION.RELEASE)
                    .put("sdk", Build.VERSION.SDK_INT).put("app", getPackageName())
                    .put("ueberlagern", canFloat()).put("akkuAusnahme", ((PowerManager) getSystemService(Context.POWER_SERVICE)).isIgnoringBatteryOptimizations(getPackageName()))
                    .toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        /** Gekoppelte Bluetooth-Geräte (Namen) – für die Auswahl des Autos im Fahrmodus. */
        @SuppressLint("MissingPermission")
        @JavascriptInterface
        public String bondedDevices() {
            JSONArray out = new JSONArray();
            try {
                if (Build.VERSION.SDK_INT >= 31 && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
                    runOnUiThread(() -> requestPermissions(new String[] { Manifest.permission.BLUETOOTH_CONNECT }, 4713));
                    return "null";
                }
                android.bluetooth.BluetoothManager bm = getSystemService(android.bluetooth.BluetoothManager.class);
                if (bm == null || bm.getAdapter() == null) return "[]";
                for (android.bluetooth.BluetoothDevice d : bm.getAdapter().getBondedDevices()) if (d.getName() != null) out.put(d.getName());
            } catch (Exception e) {
                Log.w("KI-Assistent", "Bluetooth-Geräte", e);
            }
            return out.toString();
        }

        /** Bildschirm fragen: Android-Freigabe anfordern (danach kommt ein Ereignis „screen“ mit dem Bild). */
        @JavascriptInterface
        public void captureScreen() {
            runOnUiThread(() -> {
                hideFloatMenu();
                try {
                    android.media.projection.MediaProjectionManager mpm = getSystemService(android.media.projection.MediaProjectionManager.class);
                    screenAsk.launch(mpm.createScreenCaptureIntent());
                } catch (Exception e) {
                    Log.w("KI-Assistent", "Bildschirm-Freigabe", e);
                    pushAction("screen-failed");
                }
            });
        }

        /** Mitteilungen vorlesen: an/aus und Apps (Paketnamen, kommagetrennt). */
        @JavascriptInterface
        public void setNotifyApps(boolean on, String packages) {
            java.util.Set<String> set = new java.util.HashSet<>();
            for (String p : (packages == null ? "" : packages).split(",")) if (!p.trim().isEmpty()) set.add(p.trim());
            KINotify.prefs(MainActivity.this).edit().putBoolean("an", on).putStringSet("apps", set).apply();
        }

        /** Hat der Nutzer den Zugriff auf Mitteilungen erlaubt? */
        @JavascriptInterface
        public boolean notifyAccess() {
            String flat = Settings.Secure.getString(getContentResolver(), "enabled_notification_listeners");
            return flat != null && flat.contains(getPackageName() + "/");
        }

        @JavascriptInterface
        public void askNotifyAccess() {
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS"));
                } catch (Exception e) {
                    startActivity(new Intent(Settings.ACTION_SETTINGS));
                }
            });
        }

        @JavascriptInterface
        public void setCar(String name) {
            getSharedPreferences("ki_auto", MODE_PRIVATE).edit().putString("name", name == null ? "" : name).apply();
            if (name != null && !name.isEmpty()) runOnUiThread(MainActivity.this::registerCarReceiver);
        }

        /** Einstellungen für den Standard-Assistenten öffnen. */
        @JavascriptInterface
        public void assistantSettings() {
            runOnUiThread(() -> {
                for (String a : new String[] { Settings.ACTION_VOICE_INPUT_SETTINGS, Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS, Settings.ACTION_SETTINGS }) {
                    try {
                        startActivity(new Intent(a));
                        return;
                    } catch (Exception ignored) {}
                }
            });
        }
    }

    // ---- Google-Anmeldung: Browser öffnen, kurz auf 127.0.0.1 lauschen, Antwort (Code) an die Oberfläche geben
    public class Auth {
        /** Startet den Empfänger und liefert den Port (0 bei Fehler). */
        @JavascriptInterface
        public int listen() {
            try {
                ServerSocket server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
                server.setSoTimeout(5 * 60 * 1000);
                int port = server.getLocalPort();
                new Thread(() -> {
                    String target = "";
                    try (Socket sock = server.accept()) {
                        BufferedReader in = new BufferedReader(new InputStreamReader(sock.getInputStream(), StandardCharsets.UTF_8));
                        String line = in.readLine(); // GET /?code=…&state=… HTTP/1.1
                        if (line != null && line.startsWith("GET ")) target = line.split(" ")[1];
                        String html = "<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">"
                            + "<body style=\"font:18px sans-serif;padding:32px\">✔ Fertig – zurück zum KI-Assistenten …</body>";
                        byte[] body = html.getBytes(StandardCharsets.UTF_8);
                        OutputStream out = sock.getOutputStream();
                        out.write(("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                        out.write(body);
                        out.flush();
                    } catch (Exception e) {
                        Log.w("KI-Assistent", "Google-Anmeldung", e);
                    } finally {
                        try { server.close(); } catch (Exception ignored) {}
                    }
                    final String result = target;
                    runOnUiThread(() -> {
                        // App wieder nach vorn holen
                        Intent back = new Intent(MainActivity.this, MainActivity.class);
                        back.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                        startActivity(back);
                        if (bridge != null) {
                            String js = "window.__kiAuthDone && window.__kiAuthDone(" + org.json.JSONObject.quote(result) + ")";
                            bridge.getWebView().evaluateJavascript(js, null);
                        }
                    });
                }).start();
                return port;
            } catch (Exception e) {
                Log.w("KI-Assistent", "Empfänger für Google-Anmeldung", e);
                return 0;
            }
        }

        /** Adresse im Browser öffnen (Google-Anmeldung). */
        @JavascriptInterface
        public void open(String url) {
            runOnUiThread(() -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))));
        }
    }

    public class FileSaver {
        @JavascriptInterface
        public void saveAs(String id, String name, String base64) {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            runOnUiThread(() -> {
                if (pendingId != null) saveDone(false, "abgebrochen");
                pendingId = id;
                pendingBytes = bytes;
                try {
                    createDoc.launch(name);
                } catch (Exception e) {
                    saveDone(false, String.valueOf(e.getMessage()));
                }
            });
        }

        /** Nur den Speicherort wählen lassen (vor einer längeren Berechnung); Antwort wie bei saveAs. */
        @JavascriptInterface
        public void pickTarget(String id, String name) {
            runOnUiThread(() -> {
                if (pendingId != null) saveDone(false, "abgebrochen");
                pendingId = id;
                pendingBytes = null;
                try {
                    createDoc.launch(name);
                } catch (Exception e) {
                    saveDone(false, String.valueOf(e.getMessage()));
                }
            });
        }

        /** In einen vorher gewählten Speicherort schreiben. Liefert "" oder eine Fehlermeldung. */
        @JavascriptInterface
        public String writeUri(String uri, String base64) {
            try (OutputStream out = getContentResolver().openOutputStream(Uri.parse(uri), "wt")) {
                out.write(Base64.decode(base64, Base64.DEFAULT));
                return "";
            } catch (Exception e) {
                return String.valueOf(e.getMessage());
            }
        }
    }

    // ---- API-Schlüssel verschlüsseln: AES-256-GCM, der Schlüssel liegt im Android-Keystore und verlässt ihn nie
    private static final String KEY_ALIAS = "ki-assistent-schluessel";

    private static SecretKey vaultKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return gen.generateKey();
    }

    /** Für die Oberfläche: window.KIKeys.encrypt(text) -> "iv:daten" (Base64), decrypt(...) -> text; null bei Fehlern. */
    public static class KeyVault {
        @JavascriptInterface
        public boolean available() {
            try {
                vaultKey();
                return true;
            } catch (Exception e) {
                Log.w("KI-Assistent", "Keystore nicht verfügbar", e);
                return false;
            }
        }

        @JavascriptInterface
        public String encrypt(String plain) {
            try {
                Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
                c.init(Cipher.ENCRYPT_MODE, vaultKey());
                byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
                return Base64.encodeToString(c.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP);
            } catch (Exception e) {
                Log.w("KI-Assistent", "Verschlüsseln fehlgeschlagen", e);
                return null;
            }
        }

        @JavascriptInterface
        public String decrypt(String packed) {
            try {
                String[] parts = packed.split(":", 2);
                Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
                c.init(Cipher.DECRYPT_MODE, vaultKey(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
                return new String(c.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
            } catch (Exception e) {
                Log.w("KI-Assistent", "Entschlüsseln fehlgeschlagen", e);
                return null;
            }
        }
    }

    private PictureInPictureParams pipParams() {
        PictureInPictureParams.Builder b = new PictureInPictureParams.Builder().setAspectRatio(new Rational(pipW, pipH));
        if (Build.VERSION.SDK_INT >= 31) {
            b.setAutoEnterEnabled(pipEnabled && !(floatEnabled && canFloat()));
            b.setSeamlessResizeEnabled(true);
        }
        return b.build();
    }

    private void applyParams() {
        if (Build.VERSION.SDK_INT >= 26) setPictureInPictureParams(pipParams());
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // muss vor dem Start der Activity registriert werden
        createDoc = registerForActivityResult(new ActivityResultContracts.CreateDocument("application/octet-stream"), this::writePending);
        // „Bildschirm fragen“: Freigabe holen, dann nimmt der Vordergrund-Dienst genau ein Bild auf
        screenAsk = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), (res) -> {
            if (res.getResultCode() != android.app.Activity.RESULT_OK || res.getData() == null) {
                pushAction("screen-failed");
                return;
            }
            Intent svc = new Intent(this, KIConversationService.class).setAction(KIConversationService.PROJECT)
                .putExtra("code", res.getResultCode()).putExtra("data", res.getData());
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                try {
                    if (Build.VERSION.SDK_INT >= 26) startForegroundService(svc);
                    else startService(svc);
                } catch (Exception e) {
                    Log.w("KI-Assistent", "Bildschirm-Dienst", e);
                    pushAction("screen-failed");
                }
            }, 500); // Freigabe-Dialog erst verschwinden lassen
        });
        super.onCreate(savedInstanceState);
        applyParams();
        bridge.getWebView().addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void setEnabled(boolean on) {
                runOnUiThread(() -> {
                    pipEnabled = on;
                    applyParams();
                });
            }

            @JavascriptInterface
            public void enter() {
                runOnUiThread(() -> {
                    if (Build.VERSION.SDK_INT >= 26) enterPictureInPictureMode(pipParams());
                });
            }

            @JavascriptInterface
            public boolean supported() {
                return Build.VERSION.SDK_INT >= 26;
            }

            /** Seitenverhältnis des Fensters = Form der Figur (Android erlaubt 1:2,39 bis 2,39:1). */
            @JavascriptInterface
            public void setAspect(int w, int h) {
                if (w <= 0 || h <= 0) return;
                double r = Math.max(1 / 2.38, Math.min(2.38, (double) w / h));
                runOnUiThread(() -> {
                    pipW = (int) Math.round(r * 1000);
                    pipH = 1000;
                    applyParams();
                    refitFloat();
                });
            }
        }, "KIPip");
        bridge.getWebView().addJavascriptInterface(new KeyVault(), "KIKeys");
        bridge.getWebView().addJavascriptInterface(new FileSaver(), "KIFiles");
        bridge.getWebView().addJavascriptInterface(new Auth(), "KIAuth");
        bridge.getWebView().addJavascriptInterface(new Device(), "KIDevice");
        bridge.getWebView().addJavascriptInterface(new Floater(), "KIFloat");
        current = new WeakReference<>(this);
        if (!getSharedPreferences("ki_auto", MODE_PRIVATE).getString("name", "").isEmpty()) registerCarReceiver();
    }

    @Override
    public void onResume() {
        super.onResume();
        resumed = true;
        hideFloat();
        applyParams();
        current = new WeakReference<>(this);
    }

    @Override
    public void onPause() {
        super.onPause();
        resumed = false;
    }

    @Override
    public void onDestroy() {
        if (carReceiver != null) {
            try { unregisterReceiver(carReceiver); } catch (Exception ignored) {}
            carReceiver = null;
        }
        hideBubble();
        hideFloatMenu();
        if (floatBox != null) {
            try {
                floatWm().removeView(floatBox);
            } catch (Exception ignored) {}
            floatBox = null;
        }
        if (session != null) {
            session.release();
            session = null;
        }
        stopService(new Intent(this, KIConversationService.class));
        super.onDestroy();
    }

    // Android 8–11: beim Verlassen (Home-Taste, App-Wechsel) selbst auslösen; ab 12 macht das setAutoEnterEnabled
    @Override
    public void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (floatEnabled && canFloat()) {
            showFloat();
            return;
        }
        if (pipEnabled && Build.VERSION.SDK_INT >= 26 && Build.VERSION.SDK_INT < 31) enterPictureInPictureMode(pipParams());
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPip, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPip, newConfig);
        if (bridge != null) {
            bridge.getWebView().post(() ->
                bridge.getWebView().evaluateJavascript("window.__setPip && window.__setPip(" + isInPip + ")", null)
            );
        }
    }
}
