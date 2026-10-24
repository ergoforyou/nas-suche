package de.ergoforyou.kiassistent;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.widget.RemoteViews;
import org.json.JSONObject;

/**
 * Widget für den Startbildschirm: oben Name der Figur und was ansteht (Zwischenspeicher, offene Punkte), darunter
 * Sprechen, Diktat, „Für später“ (kleines Eingabefenster ohne App) und „Was ist offen?“; 📞 startet das Live-Gespräch.
 */
public class KIWidget extends AppWidgetProvider {
    private static PendingIntent action(Context c, String what, int code) {
        Intent i = new Intent(c, MainActivity.class)
            .setData(Uri.parse("kiassistent://widget/" + what)) // macht die Absichten unterscheidbar
            .putExtra("ki_action", what)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent quickNote(Context c) {
        Intent i = new Intent(c, KIQuickNote.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        return PendingIntent.getActivity(c, 35, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("ki_widget", Context.MODE_PRIVATE);
    }

    /** Stand für die Kopfzeile (von der Oberfläche): {"name","zwischen","offen"}. */
    static void setInfo(Context c, String json) {
        prefs(c).edit().putString("info", json == null ? "{}" : json).apply();
        refresh(c);
    }

    static RemoteViews views(Context c) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.ki_widget);
        String name = "KI-Assistent";
        int zwischen = KIQuickNote.pending(c);
        int offen = 0;
        try {
            JSONObject o = new JSONObject(prefs(c).getString("info", "{}"));
            if (!o.optString("name").isEmpty()) name = o.optString("name");
            zwischen += o.optInt("zwischen");
            offen = o.optInt("offen");
        } catch (Exception ignored) {}
        String status = zwischen == 0 && offen == 0 ? "Bereit – tippen zum Sprechen"
            : (zwischen > 0 ? "📥 " + zwischen + " für später" : "") + (zwischen > 0 && offen > 0 ? "  ·  " : "") + (offen > 0 ? "⏳ " + offen + " offen" : "");
        v.setTextViewText(R.id.ki_widget_name, name);
        v.setTextViewText(R.id.ki_widget_status, status);
        v.setOnClickPendingIntent(R.id.ki_widget_head, action(c, "open", 29));
        v.setOnClickPendingIntent(R.id.ki_widget_live, action(c, "live", 31));
        v.setOnClickPendingIntent(R.id.ki_widget_talk, action(c, "listen", 30));
        v.setOnClickPendingIntent(R.id.ki_widget_dict, action(c, "dictate", 33));
        v.setOnClickPendingIntent(R.id.ki_widget_quick, quickNote(c));
        v.setOnClickPendingIntent(R.id.ki_widget_open, action(c, zwischen > 0 ? "zwischen" : "offen", 34));
        v.setTextViewText(R.id.ki_widget_open_label, zwischen > 0 ? "Durchgehen" : "Offen");
        return v;
    }

    static void refresh(Context c) {
        try {
            AppWidgetManager m = AppWidgetManager.getInstance(c);
            int[] ids = m.getAppWidgetIds(new ComponentName(c, KIWidget.class));
            if (ids.length == 0) return;
            RemoteViews v = views(c);
            for (int id : ids) m.updateAppWidget(id, v);
        } catch (Exception ignored) {}
    }

    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        RemoteViews v = views(c);
        for (int id : ids) m.updateAppWidget(id, v);
    }
}
