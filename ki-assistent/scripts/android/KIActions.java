package de.ergoforyou.kiassistent;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.media.AudioManager;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.net.Uri;
import android.os.SystemClock;
import android.provider.AlarmClock;
import android.provider.MediaStore;
import android.provider.Settings;
import android.view.KeyEvent;
import java.text.Normalizer;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Handy-Aktionen auf Zuruf (Bereich Privat): Apps öffnen, Navigation, Wecker/Timer, Musik, Lautstärke, Taschenlampe,
 * Einstellungen, Text an Claude oder eine Nachricht vorbereiten. Nichts geht ohne Zutun hinaus: Anrufe und Nachrichten
 * öffnen nur die fertige Eingabe – gewählt bzw. gesendet wird erst per Tippen.
 */
public class KIActions {
    /** Bis wann Medientasten von hier stammen (die eigene Kopfhörer-Taste soll sie dann nicht abfangen). */
    static volatile long selfKeyUntil = 0;

    static JSONObject run(Activity a, JSONObject in) throws Exception {
        String what = in.optString("aktion");
        switch (what) {
            case "app_oeffnen":
                return openApp(a, in.optString("app"));
            case "apps":
                return listApps(a);
            case "webseite": {
                String url = in.optString("url").trim();
                if (!url.matches("(?i)^https?://.+")) url = "https://" + url;
                return start(a, new Intent(Intent.ACTION_VIEW, Uri.parse(url)), "Seite geöffnet");
            }
            case "navigation": {
                String ziel = in.optString("ziel").trim();
                if (ziel.isEmpty()) throw new Exception("Wohin?");
                String mode = modeOf(in.optString("modus"));
                Intent nav = new Intent(Intent.ACTION_VIEW, Uri.parse("google.navigation:q=" + Uri.encode(ziel) + (mode.isEmpty() ? "" : "&mode=" + mode)));
                if (nav.resolveActivity(a.getPackageManager()) == null) nav = new Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=" + Uri.encode(ziel)));
                return start(a, nav, "Navigation gestartet");
            }
            case "karte":
                return start(a, new Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=" + Uri.encode(in.optString("ziel")))), "Karte geöffnet");
            case "anrufen": {
                String nr = in.optString("nummer").replaceAll("[^0-9+*#]", "");
                return start(a, new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(nr))), nr.isEmpty() ? "Telefon geöffnet" : "Nummer eingetippt – zum Anrufen auf den Hörer tippen");
            }
            case "sms": {
                String nr = in.optString("nummer").replaceAll("[^0-9+]", "");
                Intent sms = new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + nr)).putExtra("sms_body", in.optString("text"));
                return start(a, sms, "SMS vorbereitet – zum Senden auf Senden tippen");
            }
            case "whatsapp": {
                String nr = in.optString("nummer").replaceAll("[^0-9]", "");
                String text = in.optString("text");
                Intent wa = nr.isEmpty()
                    ? new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text).setPackage("com.whatsapp")
                    : new Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/" + nr + "?text=" + Uri.encode(text))).setPackage("com.whatsapp");
                return start(a, wa, nr.isEmpty() ? "WhatsApp geöffnet – Chat wählen und senden" : "WhatsApp-Nachricht vorbereitet – zum Senden tippen");
            }
            case "teilen":
                return start(a, Intent.createChooser(new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, in.optString("text")), "Teilen"), "Teilen geöffnet");
            case "an_claude": {
                Intent c = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, in.optString("text")).setPackage("com.anthropic.claude");
                if (c.resolveActivity(a.getPackageManager()) == null) throw new Exception("Die Claude-App ist auf dem Handy nicht installiert");
                return start(a, c, "An die Claude-App übergeben – dort abschicken");
            }
            case "wecker": {
                Intent al = new Intent(AlarmClock.ACTION_SET_ALARM)
                    .putExtra(AlarmClock.EXTRA_HOUR, in.optInt("stunde"))
                    .putExtra(AlarmClock.EXTRA_MINUTES, in.optInt("minute"))
                    .putExtra(AlarmClock.EXTRA_SKIP_UI, true);
                if (!in.optString("text").isEmpty()) al.putExtra(AlarmClock.EXTRA_MESSAGE, in.optString("text"));
                return start(a, al, String.format(Locale.GERMANY, "Wecker auf %d:%02d gestellt", in.optInt("stunde"), in.optInt("minute")));
            }
            case "timer": {
                int sec = Math.max(1, in.optInt("sekunden"));
                Intent t = new Intent(AlarmClock.ACTION_SET_TIMER).putExtra(AlarmClock.EXTRA_LENGTH, sec).putExtra(AlarmClock.EXTRA_SKIP_UI, true);
                if (!in.optString("text").isEmpty()) t.putExtra(AlarmClock.EXTRA_MESSAGE, in.optString("text"));
                return start(a, t, "Timer gestellt");
            }
            case "musik":
                return music(a, in.optString("befehl"));
            case "lautstaerke":
                return volume(a, in);
            case "taschenlampe":
                return torch(a, in.optBoolean("an", true));
            case "einstellungen":
                return start(a, new Intent(settingsAction(in.optString("bereich"))), "Einstellungen geöffnet");
            case "kamera":
                return start(a, new Intent(MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA), "Kamera geöffnet");
            default:
                throw new Exception("Unbekannte Aktion: " + what);
        }
    }

    static JSONObject ok(String msg) throws Exception {
        return new JSONObject().put("ok", true).put("erledigt", msg);
    }

    static JSONObject start(Activity a, Intent it, String msg) throws Exception {
        it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            a.startActivity(it);
        } catch (ActivityNotFoundException e) {
            throw new Exception("Dafür ist keine passende App installiert");
        }
        return ok(msg);
    }

    static String modeOf(String m) {
        m = m.toLowerCase(Locale.ROOT);
        if (m.contains("fuss") || m.contains("fuß") || m.contains("lauf")) return "w";
        if (m.contains("rad")) return "b";
        if (m.contains("auto") || m.contains("fahr")) return "d";
        return "";
    }

    static String norm(String s) {
        String n = Normalizer.normalize(s == null ? "" : s, Normalizer.Form.NFD).replaceAll("\\p{M}", "");
        return n.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", " ").trim();
    }

    /** App per Name öffnen: genau, Anfang, enthalten (Name der App, wie er im Startbildschirm steht). */
    static JSONObject openApp(Activity a, String name) throws Exception {
        String q = norm(name);
        if (q.isEmpty()) throw new Exception("Welche App?");
        PackageManager pm = a.getPackageManager();
        List<ResolveInfo> apps = pm.queryIntentActivities(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0);
        ResolveInfo best = null;
        int bestScore = 0;
        for (ResolveInfo r : apps) {
            String label = norm(String.valueOf(r.loadLabel(pm)));
            int score = label.equals(q) ? 3 : label.startsWith(q) ? 2 : label.contains(q) || (label.length() > 2 && q.contains(label)) ? 1 : 0;
            if (score > bestScore) {
                best = r;
                bestScore = score;
            }
        }
        if (best == null) throw new Exception("Keine App „" + name + "“ gefunden");
        Intent it = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
            .setComponent(new ComponentName(best.activityInfo.packageName, best.activityInfo.name));
        return start(a, it, String.valueOf(best.loadLabel(pm)) + " geöffnet");
    }

    static JSONObject listApps(Activity a) throws Exception {
        PackageManager pm = a.getPackageManager();
        JSONArray out = new JSONArray();
        for (ResolveInfo r : pm.queryIntentActivities(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)) {
            out.put(String.valueOf(r.loadLabel(pm)));
        }
        return new JSONObject().put("apps", out);
    }

    /**
     * Musik steuern: am liebsten direkt die spielende App (geht, wenn „Benachrichtigungen vorlesen“ freigegeben ist),
     * sonst als Medientaste.
     */
    static JSONObject music(Activity a, String cmd) throws Exception {
        String c = cmd.toLowerCase(Locale.ROOT);
        try {
            MediaSessionManager msm = a.getSystemService(MediaSessionManager.class);
            List<MediaController> list = msm.getActiveSessions(new ComponentName(a, KINotify.class));
            for (MediaController mc : list) {
                if (mc.getPackageName().equals(a.getPackageName())) continue;
                MediaController.TransportControls t = mc.getTransportControls();
                if (c.startsWith("weiter") || c.startsWith("next") || c.startsWith("naechst") || c.startsWith("nächst")) t.skipToNext();
                else if (c.startsWith("zurueck") || c.startsWith("zurück") || c.startsWith("prev")) t.skipToPrevious();
                else if (c.startsWith("pause") || c.startsWith("stop") || c.startsWith("anhalten")) t.pause();
                else t.play();
                return ok("Musik: " + cmd + " (" + mc.getPackageName() + ")");
            }
        } catch (SecurityException ignored) {
            // keine Freigabe für Benachrichtigungen – dann über die Medientaste
        }
        int code = c.startsWith("weiter") || c.startsWith("next") || c.startsWith("naechst") || c.startsWith("nächst") ? KeyEvent.KEYCODE_MEDIA_NEXT
            : c.startsWith("zurueck") || c.startsWith("zurück") || c.startsWith("prev") ? KeyEvent.KEYCODE_MEDIA_PREVIOUS
            : c.startsWith("pause") || c.startsWith("stop") || c.startsWith("anhalten") ? KeyEvent.KEYCODE_MEDIA_PAUSE
            : KeyEvent.KEYCODE_MEDIA_PLAY;
        AudioManager am = a.getSystemService(AudioManager.class);
        selfKeyUntil = SystemClock.uptimeMillis() + 1500;
        long now = SystemClock.uptimeMillis();
        am.dispatchMediaKeyEvent(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0));
        am.dispatchMediaKeyEvent(new KeyEvent(now, now, KeyEvent.ACTION_UP, code, 0));
        return ok("Musik: " + cmd);
    }

    static JSONObject volume(Activity a, JSONObject in) throws Exception {
        AudioManager am = a.getSystemService(AudioManager.class);
        int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        String dir = in.optString("richtung").toLowerCase(Locale.ROOT);
        if (in.has("wert")) {
            int v = Math.round(Math.max(0, Math.min(100, in.optInt("wert"))) * max / 100f);
            am.setStreamVolume(AudioManager.STREAM_MUSIC, v, AudioManager.FLAG_SHOW_UI);
        } else {
            int step = Math.max(1, max / 6);
            int cur = am.getStreamVolume(AudioManager.STREAM_MUSIC);
            int v = dir.startsWith("runter") || dir.startsWith("leiser") ? cur - step : cur + step;
            am.setStreamVolume(AudioManager.STREAM_MUSIC, Math.max(0, Math.min(max, v)), AudioManager.FLAG_SHOW_UI);
        }
        int now = am.getStreamVolume(AudioManager.STREAM_MUSIC);
        return ok("Lautstärke " + Math.round(now * 100f / max) + " %");
    }

    static JSONObject torch(Activity a, boolean on) throws Exception {
        CameraManager cm = a.getSystemService(CameraManager.class);
        for (String id : cm.getCameraIdList()) {
            Boolean flash = cm.getCameraCharacteristics(id).get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
            if (Boolean.TRUE.equals(flash)) {
                cm.setTorchMode(id, on);
                return ok(on ? "Taschenlampe an" : "Taschenlampe aus");
            }
        }
        throw new Exception("Dieses Handy hat keine Taschenlampe");
    }

    static String settingsAction(String area) {
        String b = norm(area);
        if (b.contains("wlan") || b.contains("wifi") || b.contains("internet")) return Settings.ACTION_WIFI_SETTINGS;
        if (b.contains("bluetooth")) return Settings.ACTION_BLUETOOTH_SETTINGS;
        if (b.contains("ton") || b.contains("laut") || b.contains("klingel")) return Settings.ACTION_SOUND_SETTINGS;
        if (b.contains("akku") || b.contains("batterie") || b.contains("energie")) return Intent.ACTION_POWER_USAGE_SUMMARY;
        if (b.contains("standort") || b.contains("gps")) return Settings.ACTION_LOCATION_SOURCE_SETTINGS;
        if (b.contains("display") || b.contains("bildschirm") || b.contains("helligkeit")) return Settings.ACTION_DISPLAY_SETTINGS;
        if (b.contains("nicht storen") || b.contains("nicht stoeren")) return Settings.ACTION_ZEN_MODE_PRIORITY_SETTINGS;
        if (b.contains("mobile daten") || b.contains("datennutzung")) return Settings.ACTION_DATA_ROAMING_SETTINGS;
        return Settings.ACTION_SETTINGS;
    }
}
