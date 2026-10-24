package de.ergoforyou.kiassistent;

import android.Manifest;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.os.Build;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Erinnerungen an Orten (Bereich Privat): „Erinnere mich an Milch, wenn ich beim Supermarkt bin.“ Die gemerkten Orte
 * liegen nur auf dem Handy; Android meldet, wenn man in den Umkreis kommt – dann erscheint die Erinnerung wie jede
 * andere (KIReminder), auch bei geschlossener App. Der Standort wird nirgendwohin geschickt.
 */
public class KIOrt extends BroadcastReceiver {
    static final String ACTION = "de.ergoforyou.kiassistent.ORT";
    static final int MAX = 20;

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("ki_orte", Context.MODE_PRIVATE);
    }

    static void store(Context c, String json) {
        prefs(c).edit().putString("liste", json == null ? "[]" : json).apply();
        schedule(c);
    }

    static void schedule(Context c) {
        LocationManager lm = c.getSystemService(LocationManager.class);
        if (lm == null) return;
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
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
        if (c.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return;
        try {
            JSONArray list = new JSONArray(prefs(c).getString("liste", "[]"));
            for (int i = 0; i < list.length() && i < MAX; i++) {
                JSONObject o = list.getJSONObject(i);
                Intent it = new Intent(c, KIOrt.class).setAction(ACTION).putExtra("nr", i);
                PendingIntent pi = PendingIntent.getBroadcast(c, 3000 + i, it, flags);
                lm.addProximityAlert(o.getDouble("lat"), o.getDouble("lon"), (float) o.optDouble("radius", 150), -1, pi);
            }
        } catch (SecurityException e) {
            Log.w("KI-Assistent", "Orte: keine Standort-Freigabe", e);
        } catch (Exception e) {
            Log.w("KI-Assistent", "Orte planen", e);
        }
    }

    @Override
    public void onReceive(Context c, Intent intent) {
        if (!ACTION.equals(intent.getAction())) return;
        if (!intent.getBooleanExtra(LocationManager.KEY_PROXIMITY_ENTERING, false)) return;
        try {
            JSONObject o = new JSONArray(prefs(c).getString("liste", "[]")).getJSONObject(intent.getIntExtra("nr", -1));
            JSONArray texte = o.optJSONArray("texte");
            for (int i = 0; texte != null && i < texte.length(); i++) {
                JSONObject t = texte.getJSONObject(i);
                Intent show = new Intent(c, KIReminder.class).setAction(KIReminder.ACTION)
                    .putExtra("key", "o:" + t.optString("id"))
                    .putExtra("title", "📍 " + o.optString("name"))
                    .putExtra("text", t.optString("text"));
                new KIReminder().onReceive(c, show);
            }
        } catch (Exception e) {
            Log.w("KI-Assistent", "Ort erreicht", e);
        }
    }
}
