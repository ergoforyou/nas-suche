package de.ergoforyou.kiassistent;

import android.bluetooth.BluetoothDevice;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Bluetooth verbunden/getrennt (vom System, auch bei geschlossener App): für Orte wie „im Auto“. Eigener Empfänger,
 * damit KIOrt selbst nicht von außen erreichbar sein muss; hier zählt nur der Gerätename.
 */
public class KIBluetooth extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        String act = intent.getAction();
        if (!BluetoothDevice.ACTION_ACL_CONNECTED.equals(act) && !BluetoothDevice.ACTION_ACL_DISCONNECTED.equals(act)) return;
        BluetoothDevice d = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
        String name = null;
        try {
            name = d == null ? null : d.getName();
        } catch (SecurityException ignored) {}
        KIOrt.bluetooth(c, name, BluetoothDevice.ACTION_ACL_CONNECTED.equals(act));
    }
}
