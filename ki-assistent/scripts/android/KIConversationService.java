package de.ergoforyou.kiassistent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;
import java.lang.ref.WeakReference;

/**
 * Gespräch im Hintergrund: Ein Vordergrund-Dienst mit dauerhafter Benachrichtigung erlaubt Android, dass Mikrofon
 * und Sprachausgabe weiterlaufen, auch wenn der Bildschirm aus ist oder eine andere App vorne ist.
 * Läuft nur, solange es in den Einstellungen eingeschaltet ist; „Beenden“ in der Benachrichtigung schaltet es ab.
 */
public class KIConversationService extends Service {
    static final String CHANNEL = "gespraech";
    static final String STOP = "de.ergoforyou.kiassistent.GESPRAECH_BEENDEN";
    static volatile boolean running;
    private PowerManager.WakeLock lock;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) {
            MainActivity a = MainActivity.current.get();
            if (a != null) a.pushAction("background-off");
            stopSelf();
            return START_NOT_STICKY;
        }
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm != null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Gespräch im Hintergrund", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Zeigt an, dass der KI-Assistent im Hintergrund zuhören und sprechen kann");
            nm.createNotificationChannel(ch);
        }
        int pf = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        Intent stop = new Intent(this, KIConversationService.class).setAction(STOP);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        b.setSmallIcon(R.drawable.ic_ki_mic)
            .setContentTitle("KI-Assistent hört im Hintergrund")
            .setContentText("Sprechen per Headset-Taste oder im Live-Gespräch. Tippen öffnet die App.")
            .setOngoing(true)
            .setContentIntent(PendingIntent.getActivity(this, 10, open, pf))
            .addAction(new Notification.Action.Builder(null, "Beenden", PendingIntent.getService(this, 11, stop, pf)).build());
        Notification n = b.build();
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
                if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                }
                startForeground(1, n, type);
            } else {
                startForeground(1, n);
            }
        } catch (Exception e) {
            Log.w("KI-Assistent", "Vordergrund-Dienst", e);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (lock == null) {
            PowerManager pm = getSystemService(PowerManager.class);
            if (pm != null) {
                lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "KI-Assistent:Gespraech");
                lock.acquire(4 * 60 * 60 * 1000L); // höchstens 4 Stunden am Stück
            }
        }
        running = true;
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (lock != null && lock.isHeld()) lock.release();
        lock = null;
        super.onDestroy();
    }
}
