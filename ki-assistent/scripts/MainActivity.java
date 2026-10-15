package de.ergoforyou.kiassistent;

import android.app.PictureInPictureParams;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.util.Rational;
import android.webkit.JavascriptInterface;
import com.getcapacitor.BridgeActivity;

/**
 * Bild-im-Bild (wie bei YouTube): Beim Verlassen der App schrumpft sie zu einem kleinen, frei verschiebbaren
 * Fenster, in dem nur die Figur zu sehen ist. Die Oberfläche schaltet dafür per window.__setPip um und kann
 * über window.KIPip die Funktion an- und ausschalten oder sofort auslösen.
 */
public class MainActivity extends BridgeActivity {
    private boolean pipEnabled = true;

    private PictureInPictureParams pipParams() {
        PictureInPictureParams.Builder b = new PictureInPictureParams.Builder().setAspectRatio(new Rational(3, 4));
        if (Build.VERSION.SDK_INT >= 31) {
            b.setAutoEnterEnabled(pipEnabled);
            b.setSeamlessResizeEnabled(true);
        }
        return b.build();
    }

    private void applyParams() {
        if (Build.VERSION.SDK_INT >= 26) setPictureInPictureParams(pipParams());
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applyParams();
        bridge.getWebView().addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void setEnabled(boolean on) {
                runOnUiThread(() -> {
                    pipEnabled = on;
                    applyParams();
                });
            }

            @JavascriptInterface
            public void enter() {
                runOnUiThread(() -> {
                    if (Build.VERSION.SDK_INT >= 26) enterPictureInPictureMode(pipParams());
                });
            }

            @JavascriptInterface
            public boolean supported() {
                return Build.VERSION.SDK_INT >= 26;
            }
        }, "KIPip");
    }

    // Android 8–11: beim Verlassen (Home-Taste, App-Wechsel) selbst auslösen; ab 12 macht das setAutoEnterEnabled
    @Override
    public void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (pipEnabled && Build.VERSION.SDK_INT >= 26 && Build.VERSION.SDK_INT < 31) enterPictureInPictureMode(pipParams());
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPip, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPip, newConfig);
        if (bridge != null) {
            bridge.getWebView().post(() ->
                bridge.getWebView().evaluateJavascript("window.__setPip && window.__setPip(" + isInPip + ")", null)
            );
        }
    }
}
