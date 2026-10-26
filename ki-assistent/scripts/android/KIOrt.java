package de.ergoforyou.kiassistent;

import android.Manifest;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.util.Log;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Orte und Situationen (Bereich Privat). Die Oberfläche übergibt, was beobachtet werden soll (begleiter.js →
 * ortWatch): je Ort ein Umkreis (Google-Ortungsdienste, sonst Android-Näherungsalarm), ein WLAN oder ein
 * Bluetooth-Gerät (Auto) und die Einträge, die beim Ankommen/Verlassen erscheinen. Alles läuft auch bei geschlossener
 * App; Bedingungen (Zeitfenster, werktags, schon erledigt) prüft dieser Empfänger selbst. Standorte gehen nirgendwohin.
 */
public class KIOrt extends BroadcastReceiver {
    static final String ACTION = "de.ergoforyou.kiassistent.ORT";
    static final String ACTION_GEO = "de.ergoforyou.kiassistent.ORT_GEO";
    static final String ACTION_WLAN = "de.ergoforyou.kiassistent.ORT_WLAN";
    static final int MAX = 30;
    static final long COOLDOWN = 30 * 60 * 1000L; // „jedes Mal“: höchstens alle 30 Minuten
    static final long WLAN_COOLDOWN = 60 * 60 * 1000L; // WLAN verbindet sich oft neu: frühestens nach einer Stunde wieder

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("ki_orte", Context.MODE_PRIVATE);
    }

    /** Neue Liste speichern und alles neu einrichten; liefert eine kurze Rückmeldung (Technik, für das Protokoll). */
    static String store(Context c, String json) {
        prefs(c).edit().putString("liste", json == null ? "[]" : json).apply();
        return schedule(c);
    }

    static JSONArray list(Context c) {
        try {
            return new JSONArray(prefs(c).getString("liste", "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    static int flags() {
        return PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
    }

    static String schedule(Context c) {
        JSONArray list = list(c);
        List<JSONObject> geo = new ArrayList<>();
        boolean wlan = false;
        for (int i = 0; i < list.length() && i < MAX; i++) {
            JSONObject o = list.optJSONObject(i);
            if (o == null) continue;
            if (o.has("lat") && o.has("lon")) geo.add(o);
            if (!o.optString("ssid").isEmpty()) wlan = true;
        }
        String how = scheduleGeo(c, geo);
        scheduleWlan(c, wlan);
        return how;
    }

    /** Umkreise: zuerst die Google-Ortungsdienste (genauer, sparsam), sonst der Näherungsalarm von Android. */
    static String scheduleGeo(Context c, List<JSONObject> geo) {
        clearProximity(c);
        if (c.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return "keine Standort-Freigabe";
        PendingIntent pi = PendingIntent.getBroadcast(c, 3500, new Intent(c, KIOrt.class).setAction(ACTION_GEO), flags());
        try {
            com.google.android.gms.location.GeofencingClient gc = com.google.android.gms.location.LocationServices.getGeofencingClient(c);
            gc.removeGeofences(pi);
            if (geo.isEmpty()) return "keine Orte";
            com.google.android.gms.location.GeofencingRequest.Builder req = new com.google.android.gms.location.GeofencingRequest.Builder()
                .setInitialTrigger(0); // nicht sofort melden, nur weil man gerade schon dort ist
            for (JSONObject o : geo) {
                req.addGeofence(new com.google.android.gms.location.Geofence.Builder()
                    .setRequestId(o.getString("id"))
                    .setCircularRegion(o.getDouble("lat"), o.getDouble("lon"), (float) Math.max(100, o.optDouble("radius", 200)))
                    .setExpirationDuration(com.google.android.gms.location.Geofence.NEVER_EXPIRE)
                    .setTransitionTypes(com.google.android.gms.location.Geofence.GEOFENCE_TRANSITION_ENTER | com.google.android.gms.location.Geofence.GEOFENCE_TRANSITION_EXIT)
                    .build());
            }
            gc.addGeofences(req.build(), pi).addOnFailureListener((e) -> {
                Log.w("KI-Assistent", "Orte: Google-Ortung abgelehnt – Näherungsalarm", e);
                prefs(c).edit().putString("technik", "Näherungsalarm (" + e.getMessage() + ")").apply();
                scheduleProximity(c, geo);
            }).addOnSuccessListener((v) -> prefs(c).edit().putString("technik", "Google-Ortung").apply());
            return "Google-Ortung";
        } catch (Throwable e) {
            // keine Google-Dienste auf dem Gerät
            Log.w("KI-Assistent", "Orte: keine Google-Ortung – Näherungsalarm", e);
            scheduleProximity(c, geo);
            prefs(c).edit().putString("technik", "Näherungsalarm").apply();
            return "Näherungsalarm";
        }
    }

    static void clearProximity(Context c) {
        LocationManager lm = c.getSystemService(LocationManager.class);
        if (lm == null) return;
        for (int i = 0; i < MAX; i++) {
            PendingIntent old = PendingIntent.getBroadcast(c, 3000 + i, new Intent(c, KIOrt.class).setAction(ACTION),
                PendingIntent.FLAG_NO_CREATE | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0));
            if (old != null) {
                try {
                    lm.removeProximityAlert(old);
                } catch (Exception ignored) {}
                old.cancel();
            }
        }
    }

    static void scheduleProximity(Context c, List<JSONObject> geo) {
        LocationManager lm = c.getSystemService(LocationManager.class);
        if (lm == null) return;
        try {
            for (int i = 0; i < geo.size() && i < MAX; i++) {
                JSONObject o = geo.get(i);
                Intent it = new Intent(c, KIOrt.class).setAction(ACTION).putExtra("id", o.getString("id"));
                PendingIntent pi = PendingIntent.getBroadcast(c, 3000 + i, it, flags());
                lm.addProximityAlert(o.getDouble("lat"), o.getDouble("lon"), (float) Math.max(100, o.optDouble("radius", 200)), -1, pi);
            }
        } catch (SecurityException e) {
            Log.w("KI-Assistent", "Orte: keine Standort-Freigabe", e);
        } catch (Exception e) {
            Log.w("KI-Assistent", "Orte planen", e);
        }
    }

    /** WLAN: Android meldet jede neue WLAN-Verbindung (auch bei geschlossener App) – dann wird der Name verglichen. */
    static void scheduleWlan(Context c, boolean on) {
        ConnectivityManager cm = c.getSystemService(ConnectivityManager.class);
        if (cm == null) return;
        PendingIntent pi = PendingIntent.getBroadcast(c, 3600, new Intent(c, KIOrt.class).setAction(ACTION_WLAN), flags());
        try {
            cm.unregisterNetworkCallback(pi);
        } catch (Exception ignored) {}
        if (!on) return;
        try {
            cm.registerNetworkCallback(new NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build(), pi);
        } catch (Exception e) {
            Log.w("KI-Assistent", "Orte: WLAN beobachten", e);
        }
    }

    /** Name des verbundenen WLANs (ohne Anführungszeichen) oder "" – Android verlangt dafür die Standort-Freigabe. */
    @SuppressWarnings("deprecation")
    static String currentWifi(Context c) {
        try {
            WifiManager wm = (WifiManager) c.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm == null || wm.getConnectionInfo() == null) return "";
            String s = wm.getConnectionInfo().getSSID();
            if (s == null || s.contains("unknown ssid")) return "";
            return s.replaceAll("^\"|\"$", "");
        } catch (Exception e) {
            return "";
        }
    }

    @Override
    public void onReceive(Context c, Intent intent) {
        String act = intent.getAction();
        try {
            if (ACTION_GEO.equals(act)) {
                com.google.android.gms.location.GeofencingEvent ev = com.google.android.gms.location.GeofencingEvent.fromIntent(intent);
                if (ev == null || ev.hasError() || ev.getTriggeringGeofences() == null) return;
                boolean enter = ev.getGeofenceTransition() == com.google.android.gms.location.Geofence.GEOFENCE_TRANSITION_ENTER;
                for (com.google.android.gms.location.Geofence g : ev.getTriggeringGeofences()) handle(c, g.getRequestId(), enter, "umkreis");
            } else if (ACTION.equals(act)) {
                if (!intent.hasExtra(LocationManager.KEY_PROXIMITY_ENTERING)) return;
                handle(c, intent.getStringExtra("id"), intent.getBooleanExtra(LocationManager.KEY_PROXIMITY_ENTERING, false), "umkreis");
            } else if (ACTION_WLAN.equals(act)) {
                String ssid = currentWifi(c);
                if (ssid.isEmpty()) return;
                JSONArray list = list(c);
                for (int i = 0; i < list.length(); i++) {
                    JSONObject o = list.optJSONObject(i);
                    if (o != null && ssid.equals(o.optString("ssid"))) handle(c, o.optString("id"), true, "wlan");
                }
            }
        } catch (Exception e) {
            Log.w("KI-Assistent", "Ort erkannt", e);
        }
    }

    /** Bluetooth-Gerät (z. B. das Auto) verbunden/getrennt – kommt von KIBluetooth. */
    static void bluetooth(Context c, String name, boolean on) {
        if (name == null) return;
        try {
            JSONArray list = list(c);
            for (int i = 0; i < list.length(); i++) {
                JSONObject o = list.optJSONObject(i);
                if (o != null && name.equals(o.optString("bt"))) handle(c, o.optString("id"), on, "bluetooth");
            }
        } catch (Exception e) {
            Log.w("KI-Assistent", "Orte: Bluetooth", e);
        }
    }

    static String day(long t) {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.GERMANY).format(new Date(t));
    }

    /** Zeitfenster („von“/„bis“ als HH:MM, auch über Mitternacht) und „nur werktags“. */
    static boolean inWindow(JSONObject t, long now) {
        Calendar cal = Calendar.getInstance();
        cal.setTimeInMillis(now);
        int dow = cal.get(Calendar.DAY_OF_WEEK);
        if (t.optBoolean("werktags") && (dow == Calendar.SATURDAY || dow == Calendar.SUNDAY)) return false;
        int min = cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE);
        int a = toMin(t.optString("von"));
        int b = toMin(t.optString("bis"));
        if (a < 0 && b < 0) return true;
        if (a >= 0 && b >= 0) return a <= b ? (min >= a && min < b) : (min >= a || min < b);
        return a >= 0 ? min >= a : min < b;
    }

    static int toMin(String s) {
        if (s == null || !s.matches("\\d{2}:\\d{2}")) return -1;
        return Integer.parseInt(s.substring(0, 2)) * 60 + Integer.parseInt(s.substring(3, 5));
    }

    /** Ankommen/Verlassen eines Orts: Zustand merken, Ereignis für die App, passende Einträge anzeigen. */
    static synchronized void handle(Context c, String id, boolean enter, String how) throws Exception {
        if (id == null) return;
        SharedPreferences p = prefs(c);
        long now = System.currentTimeMillis();
        JSONObject place = null;
        JSONArray list = list(c);
        for (int i = 0; i < list.length(); i++) if (id.equals(list.getJSONObject(i).optString("id"))) place = list.getJSONObject(i);
        if (place == null) return;
        // WLAN meldet sich oft mehrfach: nicht jedes Mal als neues Ankommen werten
        JSONObject last = new JSONObject(p.getString("zuletzt", "{}"));
        if ("wlan".equals(how) && enter && now - last.optLong("wlan:" + id) < WLAN_COOLDOWN) return;
        if ("wlan".equals(how)) last.put("wlan:" + id, now);
        // wo man gerade ist (für „Was steht hier an?“ und das Verhalten je Ort)
        JSONObject drin = new JSONObject(p.getString("drin", "{}"));
        if (enter) drin.put(id, now);
        else drin.remove(id);
        JSONArray events = new JSONArray(p.getString("ereignisse", "[]"));
        events.put(new JSONObject().put("ort", id).put("an", enter).put("t", now).put("wie", how));
        while (events.length() > 30) events.remove(0);
        String name = place.optString("name");
        JSONArray texte = place.optJSONArray("texte");
        for (int i = 0; texte != null && i < texte.length(); i++) {
            JSONObject t = texte.getJSONObject(i);
            if (enter != !"weg".equals(t.optString("wann", "an"))) continue;
            if (!inWindow(t, now)) continue;
            String tid = t.optString("id");
            String art = t.optString("art");
            if ("runde".equals(art) && day(now).equals(t.optString("erledigt"))) continue;
            if ((t.optBoolean("jedes") || !art.isEmpty()) && now - last.optLong(tid) < COOLDOWN) continue;
            last.put(tid, now);
            String key;
            String title;
            String text;
            if ("notiz".equals(art)) {
                key = "n:" + id + ":" + now / COOLDOWN;
                title = "📍 " + name + ": " + t.optInt("anzahl", 1) + (t.optInt("anzahl", 1) == 1 ? " Notiz" : " Notizen");
                text = t.optString("text");
            } else if ("runde".equals(art)) {
                key = "runde:f:" + day(now);
                title = "🌆 Willkommen zu Hause";
                text = "Antippen für den Tagesrückblick.";
            } else if ("verkehr".equals(art)) {
                key = "verkehr:" + day(now);
                title = "🚗 Feierabend";
                text = "Antippen für die Verkehrslage nach Hause.";
            } else {
                key = t.optBoolean("jedes") ? "o:" + tid + ":" + now / COOLDOWN : "o:" + tid;
                title = (enter ? "📍 " : "📍 Verlassen: ") + name;
                text = t.optString("text");
            }
            new KIReminder().onReceive(c, new Intent(c, KIReminder.class).setAction(KIReminder.ACTION)
                .putExtra("key", key).putExtra("title", title).putExtra("text", text));
        }
        p.edit().putString("zuletzt", last.toString()).putString("drin", drin.toString()).putString("ereignisse", events.toString()).apply();
        MainActivity a = MainActivity.current.get();
        if (a != null && a.resumed) a.pushEvent(new JSONObject().put("action", "ort").put("ort", id).put("an", enter));
    }

    /** Für die Oberfläche: wo man gerade ist und was seit dem letzten Abholen passiert ist. */
    static synchronized String takeState(Context c) {
        SharedPreferences p = prefs(c);
        try {
            JSONObject out = new JSONObject()
                .put("drin", new JSONObject(p.getString("drin", "{}")))
                .put("ereignisse", new JSONArray(p.getString("ereignisse", "[]")))
                .put("technik", p.getString("technik", ""))
                .put("wlan", currentWifi(c));
            p.edit().putString("ereignisse", "[]").apply();
            return out.toString();
        } catch (Exception e) {
            return "{}";
        }
    }
}
