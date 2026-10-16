package de.ergoforyou.kiassistent;

import android.app.PictureInPictureParams;
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
    private int pipW = 3;
    private int pipH = 4;

    // ---- „Speichern unter …“: Android fragt nach Ordner und Dateiname (Downloads, Drive, …)
    private ActivityResultLauncher<String> createDoc;
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
            b.setAutoEnterEnabled(pipEnabled);
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
                });
            }
        }, "KIPip");
        bridge.getWebView().addJavascriptInterface(new KeyVault(), "KIKeys");
        bridge.getWebView().addJavascriptInterface(new FileSaver(), "KIFiles");
        bridge.getWebView().addJavascriptInterface(new Auth(), "KIAuth");
    }

    // Android 8–11: beim Verlassen (Home-Taste, App-Wechsel) selbst auslösen; ab 12 macht das setAutoEnterEnabled
    @Override
    public void onUserLeaveHint() {
        super.onUserLeaveHint();
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
