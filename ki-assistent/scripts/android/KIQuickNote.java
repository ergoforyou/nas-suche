package de.ergoforyou.kiassistent;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * „Für später“: kleines Eingabefenster (vom Widget oder der App-Verknüpfung), ohne die App zu öffnen. Die Notiz landet
 * im Zwischenspeicher und wird beim nächsten Öffnen der App übernommen – durchgegangen wird sie später mit der Figur.
 * Diktieren geht über das Mikrofon der Tastatur.
 */
public class KIQuickNote extends Activity {
    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("ki_zwischenspeicher", Context.MODE_PRIVATE);
    }

    static synchronized void add(Context c, String text) {
        try {
            JSONArray a = new JSONArray(prefs(c).getString("liste", "[]"));
            a.put(new JSONObject().put("text", text).put("t", System.currentTimeMillis()));
            prefs(c).edit().putString("liste", a.toString()).apply();
        } catch (Exception ignored) {}
    }

    /** Abholen für die Oberfläche: [{"text","t"}] – danach ist die Liste hier leer. */
    static synchronized String take(Context c) {
        String s = prefs(c).getString("liste", "[]");
        prefs(c).edit().putString("liste", "[]").apply();
        return s;
    }

    static synchronized int pending(Context c) {
        try {
            return new JSONArray(prefs(c).getString("liste", "[]")).length();
        } catch (Exception e) {
            return 0;
        }
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE | WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(18), dp(20), dp(12));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#1E2430"));
        bg.setCornerRadius(dp(18));
        box.setBackground(bg);

        TextView title = new TextView(this);
        title.setText("📥 Für später");
        title.setTextColor(Color.WHITE);
        title.setTextSize(18);
        box.addView(title);
        TextView hint = new TextView(this);
        hint.setText("Landet im Zwischenspeicher – du gehst es später mit der Figur durch.");
        hint.setTextColor(Color.parseColor("#9AA7BA"));
        hint.setTextSize(13);
        hint.setPadding(0, dp(4), 0, dp(10));
        box.addView(hint);

        EditText text = new EditText(this);
        text.setHint("Gedanke, Aufgabe, Idee …");
        text.setHintTextColor(Color.parseColor("#6F7B8E"));
        text.setTextColor(Color.WHITE);
        text.setMinLines(3);
        text.setGravity(Gravity.TOP | Gravity.START);
        text.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        box.addView(text, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.END);
        row.setPadding(0, dp(10), 0, 0);
        Button cancel = new Button(this, null, android.R.attr.borderlessButtonStyle);
        cancel.setText("Abbrechen");
        cancel.setTextColor(Color.parseColor("#9AA7BA"));
        cancel.setOnClickListener(v -> finish());
        Button save = new Button(this, null, android.R.attr.borderlessButtonStyle);
        save.setText("Ablegen");
        save.setTextColor(Color.parseColor("#7FB2FF"));
        save.setOnClickListener(v -> {
            String t = text.getText().toString().trim();
            if (t.isEmpty()) {
                finish();
                return;
            }
            add(this, t.length() > 4000 ? t.substring(0, 4000) : t);
            KIWidget.refresh(this);
            Toast.makeText(this, "📥 Für später abgelegt", Toast.LENGTH_SHORT).show();
            // läuft die App gerade: gleich übernehmen
            MainActivity a = MainActivity.current.get();
            if (a != null) {
                try {
                    a.pushEvent(new JSONObject().put("action", "quicknote"));
                } catch (Exception ignored) {}
            }
            finish();
        });
        row.addView(cancel);
        row.addView(save);
        box.addView(row);

        setContentView(box);
        getWindow().setLayout((int) (getResources().getDisplayMetrics().widthPixels * 0.92), ViewGroup.LayoutParams.WRAP_CONTENT);
        getWindow().setBackgroundDrawableResource(android.R.color.transparent);
        text.requestFocus();
    }
}
