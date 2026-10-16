package de.ergoforyou.kiassistent;

import android.app.Notification;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONObject;

/**
 * Mitteilungen vorlesen (nur Bereich Privat, nur nach ausdrücklicher Freigabe in den Android-Einstellungen):
 * Neue Nachrichten der ausgewählten Apps (z. B. WhatsApp, SMS) gehen an die Oberfläche, die sie vorliest.
 * Es wird nichts gespeichert; ist die App nicht geöffnet, passiert nichts.
 */
public class KINotify extends NotificationListenerService {
    static SharedPreferences prefs(android.content.Context c) {
        return c.getSharedPreferences("ki_mitteilungen", MODE_PRIVATE);
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            SharedPreferences p = prefs(this);
            if (!p.getBoolean("an", false)) return;
            Set<String> apps = p.getStringSet("apps", new HashSet<>());
            if (!apps.contains(sbn.getPackageName())) return;
            Notification n = sbn.getNotification();
            if (n == null || (n.flags & Notification.FLAG_GROUP_SUMMARY) != 0 || (n.flags & Notification.FLAG_ONGOING_EVENT) != 0) return;
            Bundle x = n.extras;
            CharSequence title = x.getCharSequence(Notification.EXTRA_TITLE);
            CharSequence text = x.getCharSequence(Notification.EXTRA_BIG_TEXT);
            if (text == null) text = x.getCharSequence(Notification.EXTRA_TEXT);
            if (title == null && text == null) return;
            MainActivity a = MainActivity.current.get();
            if (a == null) return;
            a.pushEvent(new JSONObject()
                .put("action", "notification")
                .put("app", sbn.getPackageName())
                .put("title", title == null ? "" : title.toString())
                .put("text", text == null ? "" : text.toString()));
        } catch (Exception ignored) {}
    }
}
