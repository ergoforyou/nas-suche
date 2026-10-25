package de.ergoforyou.kiassistent;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Calendar;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Nachtschicht (Bereich Privat): Die Oberfläche hinterlegt einen fertigen Arbeitsauftrag (nächster Schritt eines
 * Vorhabens der Figur). Nachts zwischen 1 und 6 Uhr, nur wenn das Handy lädt und im WLAN ist, schickt das Gerät ihn an
 * Claude – auch bei geschlossener App. Den API-Schlüssel liest es selbst aus der verschlüsselten Schlüsseldatei
 * (Android-Keystore); er geht nirgends sonst hin. Das Ergebnis holt die App beim nächsten Öffnen ab.
 */
public class KINachtschicht extends JobService {
    static final int JOB_ID = 4711;
    static final int FROM = 1;
    static final int TO = 6;

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("ki_nacht", Context.MODE_PRIVATE);
    }

    /** Auftrag hinterlegen (leer = keiner) und für die nächste Nacht planen. */
    static void plan(Context c, String json) {
        if (json == null || json.isEmpty()) {
            prefs(c).edit().remove("auftrag").apply();
            JobScheduler js = c.getSystemService(JobScheduler.class);
            if (js != null) js.cancel(JOB_ID);
            return;
        }
        prefs(c).edit().putString("auftrag", json).apply();
        schedule(c);
    }

    static long untilNight() {
        Calendar now = Calendar.getInstance();
        int h = now.get(Calendar.HOUR_OF_DAY);
        if (h >= FROM && h < TO) return 0;
        Calendar at = (Calendar) now.clone();
        at.set(Calendar.HOUR_OF_DAY, FROM);
        at.set(Calendar.MINUTE, 0);
        at.set(Calendar.SECOND, 0);
        if (!at.after(now)) at.add(Calendar.DAY_OF_MONTH, 1);
        return at.getTimeInMillis() - now.getTimeInMillis();
    }

    /**
     * Für die nächste Nacht planen. Lehnt Android eine Variante ab (je nach Gerät/Version unterschiedlich streng), die
     * nächst einfachere versuchen: ohne „übersteht Neustart“ (KIBoot plant dann neu), dann ohne Lade-Bedingung (die
     * prüft der Auftrag selbst). Scheitern alle, geht der Grund an die Oberfläche (Protokoll).
     */
    static void schedule(Context c) {
        if (prefs(c).getString("auftrag", null) == null) return;
        JobScheduler js = c.getSystemService(JobScheduler.class);
        if (js == null) throw new IllegalStateException("JobScheduler nicht verfügbar");
        StringBuilder why = new StringBuilder();
        for (int v = 0; v < 3; v++) {
            try {
                JobInfo.Builder b = new JobInfo.Builder(JOB_ID, new ComponentName(c, KINachtschicht.class))
                    .setMinimumLatency(untilNight())
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_UNMETERED);
                if (v < 2) b.setRequiresCharging(true);
                if (v == 0) b.setPersisted(true);
                int res = js.schedule(b.build());
                if (res == JobScheduler.RESULT_SUCCESS) {
                    prefs(c).edit().putInt("variante", v).apply();
                    return;
                }
                why.append("Variante ").append(v).append(": abgelehnt; ");
            } catch (Exception e) {
                why.append("Variante ").append(v).append(": ").append(e.getClass().getSimpleName()).append(" ").append(e.getMessage()).append("; ");
            }
        }
        throw new IllegalStateException(why.toString());
    }

    /** Ergebnis für die Oberfläche abholen (und löschen); "" = nichts da. */
    static synchronized String take(Context c) {
        SharedPreferences p = prefs(c);
        String s = p.getString("ergebnis", "");
        p.edit().remove("ergebnis").apply();
        return s;
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        int h = Calendar.getInstance().get(Calendar.HOUR_OF_DAY);
        // ohne Lade-Bedingung geplant (Variante 2): nur arbeiten, wenn das Handy wirklich lädt
        android.os.BatteryManager bm = getSystemService(android.os.BatteryManager.class);
        boolean charging = bm == null || bm.isCharging();
        if (h < FROM || h >= TO || !charging) {
            try {
                schedule(this);
            } catch (Exception e) {
                Log.w("KI-Assistent", "Nachtschicht neu planen", e);
            }
            return false;
        }
        String auftrag = prefs(this).getString("auftrag", null);
        if (auftrag == null) return false;
        new Thread(() -> {
            JSONObject out = new JSONObject();
            try {
                JSONObject job = new JSONObject(auftrag);
                out.put("noteId", job.optString("noteId")).put("step", job.optString("step")).put("t", System.currentTimeMillis());
                String key = apiKey();
                if (key == null) throw new Exception("kein Claude-Schlüssel");
                JSONObject body = job.getJSONObject("body");
                JSONArray antworten = new JSONArray();
                // Serverwerkzeuge (Internetsuche) können pausieren – dann mit dem bisherigen Verlauf fortsetzen
                for (int round = 0; round < 4; round++) {
                    JSONObject res = post(key, body);
                    antworten.put(res);
                    if (!"pause_turn".equals(res.optString("stop_reason"))) break;
                    body.getJSONArray("messages").put(new JSONObject().put("role", "assistant").put("content", res.getJSONArray("content")));
                }
                out.put("antworten", antworten);
            } catch (Exception e) {
                Log.w("KI-Assistent", "Nachtschicht", e);
                try {
                    out.put("fehler", String.valueOf(e.getMessage()));
                } catch (Exception ignored) {}
            }
            prefs(this).edit().putString("ergebnis", out.toString()).remove("auftrag").apply();
            jobFinished(params, false);
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        // abgebrochen (Ladekabel ab, WLAN weg): beim nächsten Mal noch einmal
        return true;
    }

    /** Claude-Schlüssel des Bereichs Privat aus der verschlüsselten Schlüsseldatei der App. */
    private String apiKey() {
        try {
            File f = new File(getFilesDir(), "privat/schluessel.json");
            if (!f.exists()) return null;
            byte[] data;
            try (InputStream in = new FileInputStream(f)) {
                data = readAll(in);
            }
            JSONObject file = new JSONObject(new String(data, StandardCharsets.UTF_8));
            String packed = file.optString("anthropic", null);
            if (packed == null || packed.isEmpty()) return null;
            return file.optInt("enc") == 1 ? new MainActivity.KeyVault().decrypt(packed) : packed;
        } catch (Exception e) {
            Log.w("KI-Assistent", "Nachtschicht: Schlüssel", e);
            return null;
        }
    }

    private static JSONObject post(String key, JSONObject body) throws Exception {
        HttpURLConnection con = (HttpURLConnection) new URL("https://api.anthropic.com/v1/messages").openConnection();
        con.setRequestMethod("POST");
        con.setConnectTimeout(30000);
        con.setReadTimeout(180000);
        con.setDoOutput(true);
        con.setRequestProperty("content-type", "application/json");
        con.setRequestProperty("x-api-key", key);
        con.setRequestProperty("anthropic-version", "2023-06-01");
        try (OutputStream o = con.getOutputStream()) {
            o.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }
        int code = con.getResponseCode();
        InputStream in = code >= 400 ? con.getErrorStream() : con.getInputStream();
        String text = in == null ? "" : new String(readAll(in), StandardCharsets.UTF_8);
        con.disconnect();
        if (code >= 400) throw new Exception("Claude " + code + ": " + text.substring(0, Math.min(200, text.length())));
        return new JSONObject(text);
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
        return b.toByteArray();
    }
}
