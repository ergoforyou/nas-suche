package de.ergoforyou.kiassistent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Nach einem Neustart des Handys bzw. einem Update die geplanten Erinnerungen wieder einrichten. */
public class KIBoot extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        String a = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) {
            KIReminder.schedule(c);
            KIOrt.schedule(c);
            try {
                KINachtschicht.schedule(c);
            } catch (Exception ignored) {}
        }
    }
}
