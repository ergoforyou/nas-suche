package de.ergoforyou.kiassistent;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Erinnerungen an Termine und Aufgaben (nur wenn in den Einstellungen eingeschaltet): Die Oberfläche übergibt die
 * nächsten Erinnerungen, hier werden sie als Wecker geplant und zur Zeit als Benachrichtigung gezeigt – auch wenn die
 * App geschlossen ist. Ist die App gerade offen, sagt die Figur die Erinnerung zusätzlich an.
 */
public class KIReminder extends BroadcastReceiver {
    static final String ACTION = "de.ergoforyou.kiassistent.ERINNERUNG";
    static final String CHANNEL = "erinnerungen";
    static final int MAX = 60;

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("ki_erinnerungen", Context.MODE_PRIVATE);
    }

    /** Neue Liste speichern und alle Wecker neu planen. */
    static void store(Context c, String json) {
        prefs(c).edit().putString("liste", json == null ? "[]" : json).apply();
        schedule(c);
    }

    static void schedule(Context c) {
        SharedPreferences p = prefs(c);
        AlarmManager am = c.getSystemService(AlarmManager.class);
        if (am == null) return;
        int old = p.getInt("anzahl", 0);
        for (int i = 0; i < Math.max(old, MAX); i++) {
            PendingIntent pi = PendingIntent.getBroadcast(c, 1000 + i, new Intent(c, KIReminder.class).setAction(ACTION),
                PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
            if (pi != null) {
                am.cancel(pi);
                pi.cancel();
            }
        }
        Set<String> shown = p.getStringSet("gezeigt", new HashSet<>());
        int n = 0;
        try {
            JSONArray list = new JSONArray(p.getString("liste", "[]"));
            long now = System.currentTimeMillis();
            for (int i = 0; i < list.length() && n < MAX; i++) {
                JSONObject r = list.getJSONObject(i);
                long at = r.optLong("at");
                String key = r.optString("key");
                if (at <= now || shown.contains(key)) continue;
                Intent it = new Intent(c, KIReminder.class).setAction(ACTION)
                    .putExtra("key", key)
                    .putExtra("title", r.optString("title"))
                    .putExtra("text", r.optString("text"));
                PendingIntent pi = PendingIntent.getBroadcast(c, 1000 + n, it, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                if (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                n++;
            }
        } catch (Exception e) {
            Log.w("KI-Assistent", "Erinnerungen planen", e);
        }
        p.edit().putInt("anzahl", n).apply();
    }

    @Override
    public void onReceive(Context c, Intent intent) {
        if (!ACTION.equals(intent.getAction())) return;
        String key = intent.getStringExtra("key");
        String title = intent.getStringExtra("title");
        String text = intent.getStringExtra("text");
        if (key == null) return;
        SharedPreferences p = prefs(c);
        Set<String> shown = new HashSet<>(p.getStringSet("gezeigt", new HashSet<>()));
        if (shown.contains(key)) return;
        if (shown.size() > 300) shown.clear();
        shown.add(key);
        p.edit().putStringSet("gezeigt", shown).apply();

        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm != null) {
            if (Build.VERSION.SDK_INT >= 26) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "Erinnerungen", NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("Termine und Aufgaben aus Google Kalender und Google Aufgaben");
                nm.createNotificationChannel(ch);
            }
            Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CHANNEL) : new Notification.Builder(c);
            b.setSmallIcon(R.drawable.ic_ki_mic)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_REMINDER)
                .setContentIntent(PendingIntent.getActivity(c, key.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
            if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
            nm.notify(key.hashCode(), b.build());
        }
        // App offen: Figur sagt es an
        MainActivity a = MainActivity.current.get();
        if (a != null && (a.resumed || KIConversationService.running)) {
            try {
                a.pushEvent(new JSONObject().put("action", "reminder").put("title", title).put("text", text));
            } catch (Exception ignored) {}
        }
    }
}
