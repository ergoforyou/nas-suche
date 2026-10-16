package de.ergoforyou.kiassistent;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.RemoteViews;

/** Widget für den Startbildschirm: „Sprechen“ (hört sofort zu) und „Live“ (freihändiges Gespräch). */
public class KIWidget extends AppWidgetProvider {
    private static PendingIntent action(Context c, String what, int code) {
        Intent i = new Intent(c, MainActivity.class)
            .setData(Uri.parse("kiassistent://widget/" + what)) // macht die beiden Absichten unterscheidbar
            .putExtra("ki_action", what)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        for (int id : ids) {
            RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.ki_widget);
            v.setOnClickPendingIntent(R.id.ki_widget_talk, action(c, "listen", 30));
            v.setOnClickPendingIntent(R.id.ki_widget_live, action(c, "live", 31));
            v.setOnClickPendingIntent(R.id.ki_widget_note, action(c, "note", 32));
            m.updateAppWidget(id, v);
        }
    }
}
