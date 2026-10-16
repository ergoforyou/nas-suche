package de.ergoforyou.kiassistent;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import org.json.JSONObject;

/**
 * „Was ist auf meinem Bildschirm?“: nach der Android-Freigabe genau ein Bildschirmfoto aufnehmen und an die
 * Oberfläche geben (die es nur mit der Frage an Claude schickt). Danach wird die Aufnahme sofort beendet.
 */
public class KIScreen {
    static void capture(Context c, int resultCode, Intent data) {
        MainActivity a = MainActivity.current.get();
        try {
            MediaProjectionManager mpm = c.getSystemService(MediaProjectionManager.class);
            MediaProjection mp = mpm.getMediaProjection(resultCode, data);
            if (mp == null) throw new IllegalStateException("keine Freigabe");
            DisplayMetrics dm = c.getResources().getDisplayMetrics();
            // verkleinert (höchstens 1280 px hoch) – reicht zum Lesen und spart Datenmenge
            float k = Math.min(1f, 1280f / Math.max(dm.widthPixels, dm.heightPixels));
            int w = Math.max(1, Math.round(dm.widthPixels * k));
            int h = Math.max(1, Math.round(dm.heightPixels * k));
            Handler main = new Handler(Looper.getMainLooper());
            mp.registerCallback(new MediaProjection.Callback() {}, main);
            ImageReader reader = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2);
            VirtualDisplay vd = mp.createVirtualDisplay("KI-Bildschirm", w, h, dm.densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                reader.getSurface(), null, main);
            final boolean[] done = { false };
            reader.setOnImageAvailableListener((r) -> {
                if (done[0]) return;
                Image img = r.acquireLatestImage();
                if (img == null) return;
                done[0] = true;
                try {
                    Image.Plane pl = img.getPlanes()[0];
                    ByteBuffer buf = pl.getBuffer();
                    int rowPad = pl.getRowStride() - pl.getPixelStride() * w;
                    Bitmap bmp = Bitmap.createBitmap(w + rowPad / pl.getPixelStride(), h, Bitmap.Config.ARGB_8888);
                    bmp.copyPixelsFromBuffer(buf);
                    Bitmap crop = Bitmap.createBitmap(bmp, 0, 0, w, h);
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    crop.compress(Bitmap.CompressFormat.JPEG, 82, out);
                    String b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
                    if (a != null) a.pushEvent(new JSONObject().put("action", "screen").put("data", b64));
                } catch (Exception e) {
                    Log.w("KI-Assistent", "Bildschirmfoto", e);
                } finally {
                    img.close();
                    vd.release();
                    reader.close();
                    mp.stop();
                    KIConversationService.projectionDone(c);
                }
            }, main);
            // falls kein Bild kommt: nach 5 s aufgeben
            main.postDelayed(() -> {
                if (done[0]) return;
                done[0] = true;
                vd.release();
                reader.close();
                mp.stop();
                KIConversationService.projectionDone(c);
                if (a != null) a.pushAction("screen-failed");
            }, 5000);
        } catch (Exception e) {
            Log.w("KI-Assistent", "Bildschirm aufnehmen", e);
            KIConversationService.projectionDone(c);
            if (a != null) a.pushAction("screen-failed");
        }
    }
}
