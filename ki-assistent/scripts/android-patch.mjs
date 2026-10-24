// Nach "npx cap add android": Mikrofon-Recht und unverschlüsselte Verbindungen (nur für LM Studio im
// eigenen WLAN) in das Android-Manifest eintragen, App-Version aus package.json übernehmen.
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'de.ergoforyou.kiassistent';
// Beta-Linie (Datei kanal.json, nur im Beta-Zweig): eigene App-ID und eigener Name -> neben der normalen App installierbar
const kanalFile = new URL('../kanal.json', import.meta.url);
const BETA = fs.existsSync(kanalFile) && JSON.parse(fs.readFileSync(kanalFile, 'utf8')).kanal === 'beta';
const APP = BETA ? `${BASE}.beta` : BASE;
const shortcut = (id, label, action, icon = '@drawable/ic_ki_mic', cls = 'MainActivity') => `
    <shortcut android:shortcutId="${id}" android:enabled="true" android:icon="${icon}" android:shortcutShortLabel="@string/${label}">
        <intent android:action="android.intent.action.VIEW" android:targetPackage="${APP}" android:targetClass="${BASE}.${cls}">
            <extra android:name="ki_action" android:value="${action}" />
        </intent>
    </shortcut>`;
const RESOURCES = {
  'drawable/ic_ki_mic.xml': `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp"
    android:viewportWidth="24" android:viewportHeight="24" android:tint="#FFFFFF">
    <path android:fillColor="#FFFFFFFF"
        android:pathData="M12,14c1.66,0 3,-1.34 3,-3V5c0,-1.66 -1.34,-3 -3,-3S9,3.34 9,5v6c0,1.66 1.34,3 3,3zM17.3,11c0,3 -2.54,5.1 -5.3,5.1S6.7,14 6.7,11H5c0,3.41 2.72,6.23 6,6.72V21h2v-3.28c3.28,-0.48 6,-3.3 6,-6.72h-1.7z" />
</vector>
`,
  // Bild-im-Bild-Knöpfe: Live aus (Hörer), Live an (Hörer mit Schallwellen), zurück zur App
  'drawable/ic_ki_live.xml': `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp"
    android:viewportWidth="24" android:viewportHeight="24" android:tint="#FFFFFF">
    <path android:fillColor="#FFFFFFFF"
        android:pathData="M6.62,10.79c1.44,2.83 3.76,5.14 6.59,6.59l2.2,-2.2c0.27,-0.27 0.67,-0.36 1.02,-0.24 1.12,0.37 2.33,0.57 3.57,0.57 0.55,0 1,0.45 1,1V20c0,0.55 -0.45,1 -1,1 -9.39,0 -17,-7.61 -17,-17 0,-0.55 0.45,-1 1,-1h3.5c0.55,0 1,0.45 1,1 0,1.25 0.2,2.45 0.57,3.57 0.11,0.35 0.03,0.74 -0.25,1.02l-2.2,2.2z" />
</vector>
`,
  'drawable/ic_ki_live_on.xml': `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp"
    android:viewportWidth="24" android:viewportHeight="24" android:tint="#FFFFFF">
    <!-- Auflegen-Hörer: im Bild-im-Bild deutlich anders als „Live starten“ (Android färbt die Symbole einheitlich weiß) -->
    <path android:fillColor="#FFFFFFFF"
        android:pathData="M12,9c-1.6,0 -3.15,0.25 -4.6,0.72v3.1c0,0.39 -0.23,0.74 -0.56,0.9 -0.98,0.49 -1.87,1.12 -2.66,1.85 -0.18,0.18 -0.43,0.28 -0.7,0.28 -0.28,0 -0.53,-0.11 -0.71,-0.29L0.29,13.08c-0.18,-0.17 -0.29,-0.42 -0.29,-0.7 0,-0.28 0.11,-0.53 0.29,-0.71C3.34,8.78 7.46,7 12,7s8.66,1.78 11.71,4.67c0.18,0.18 0.29,0.43 0.29,0.71 0,0.28 -0.11,0.53 -0.29,0.71l-2.48,2.48c-0.18,0.18 -0.43,0.29 -0.71,0.29 -0.27,0 -0.52,-0.11 -0.7,-0.28 -0.79,-0.74 -1.69,-1.36 -2.67,-1.85 -0.33,-0.16 -0.56,-0.5 -0.56,-0.9v-3.1C15.15,9.25 13.6,9 12,9z" />
</vector>
`,
  'drawable/ic_ki_app.xml': `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp"
    android:viewportWidth="24" android:viewportHeight="24" android:tint="#FFFFFF">
    <path android:fillColor="#FFFFFFFF"
        android:pathData="M19,19H5V5h7V3H5c-1.11,0 -2,0.9 -2,2v14c0,1.1 0.89,2 2,2h14c1.1,0 2,-0.9 2,-2v-7h-2v7zM14,3v2h3.59l-9.83,9.83 1.41,1.41L19,6.41V10h2V3h-7z" />
</vector>
`,
  'drawable/ki_widget_bg.xml': `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="#EB161B25" />
    <stroke android:width="1dp" android:color="#33FFFFFF" />
    <corners android:radius="26dp" />
</shape>
`,
  'layout/ki_widget.xml': `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android" android:layout_width="match_parent"
    android:layout_height="match_parent" android:orientation="vertical" android:background="@drawable/ki_widget_bg"
    android:padding="10dp">
    <LinearLayout android:layout_width="match_parent" android:layout_height="wrap_content" android:orientation="horizontal"
        android:gravity="center_vertical">
        <LinearLayout android:id="@+id/ki_widget_head" android:layout_width="0dp" android:layout_height="wrap_content"
            android:layout_weight="1" android:orientation="horizontal" android:gravity="center_vertical">
            <ImageView android:layout_width="34dp" android:layout_height="34dp" android:src="@mipmap/ic_launcher_round"
                android:contentDescription="@string/ki_widget" />
            <LinearLayout android:layout_width="wrap_content" android:layout_height="wrap_content" android:orientation="vertical"
                android:layout_marginStart="8dp">
                <TextView android:id="@+id/ki_widget_name" android:layout_width="wrap_content" android:layout_height="wrap_content"
                    android:text="KI-Assistent" android:textColor="#FFFFFF" android:textSize="15sp" android:textStyle="bold"
                    android:maxLines="1" />
                <TextView android:id="@+id/ki_widget_status" android:layout_width="wrap_content" android:layout_height="wrap_content"
                    android:text="Bereit – tippen zum Sprechen" android:textColor="#9FB0C8" android:textSize="12sp" android:maxLines="1" />
            </LinearLayout>
        </LinearLayout>
        <TextView android:id="@+id/ki_widget_live" android:layout_width="wrap_content" android:layout_height="wrap_content"
            android:background="@drawable/ki_widget_pill" android:paddingStart="12dp" android:paddingEnd="12dp"
            android:paddingTop="5dp" android:paddingBottom="5dp" android:text="@string/ki_sc_live_short"
            android:textColor="#BFD8FF" android:textSize="13sp" />
    </LinearLayout>
    <LinearLayout android:layout_width="match_parent" android:layout_height="0dp" android:layout_weight="1"
        android:layout_marginTop="8dp" android:orientation="horizontal">
        <LinearLayout android:id="@+id/ki_widget_talk" android:layout_width="0dp" android:layout_height="match_parent"
            android:layout_weight="1" android:orientation="vertical" android:gravity="center" android:layout_margin="3dp"
            android:background="@drawable/ki_widget_btn">
            <TextView android:layout_width="wrap_content" android:layout_height="wrap_content" android:text="🎤"
                android:textSize="20sp" />
            <TextView android:layout_width="wrap_content" android:layout_height="wrap_content" android:text="Sprechen"
                android:textColor="#D7DEEA" android:textSize="11sp" android:layout_marginTop="2dp" />
        </LinearLayout>
        <LinearLayout android:id="@+id/ki_widget_dict" android:layout_width="0dp" android:layout_height="match_parent"
            android:layout_weight="1" android:orientation="vertical" android:gravity="center" android:layout_margin="3dp"
            android:background="@drawable/ki_widget_btn">
            <TextView android:layout_width="wrap_content" android:layout_height="wrap_content" android:text="✍"
                android:textSize="20sp" />
            <TextView android:layout_width="wrap_content" android:layout_height="wrap_content" android:text="Diktat"
                android:textColor="#D7DEEA" android:textSize="11sp" android:layout_marginTop="2dp" />
        </LinearLayout>
        <LinearLayout android:id="@+id/ki_widget_quick" android:layout_width="0dp" android:layout_height="match_parent"
            android:layout_weight="1" android:orientation="vertical" android:gravity="center" android:layout_margin="3dp"
            android:background="@drawable/ki_widget_btn">
            <TextView android:layout_width="wrap_content" android:layout_height="wrap_content" android:text="📥"
                android:textSize="20sp" />
            <TextView android:layout_width="wrap_content" android:layout_height="wrap_content" android:text="Für später"
                android:textColor="#D7DEEA" android:textSize="11sp" android:layout_marginTop="2dp" />
        </LinearLayout>
        <LinearLayout android:id="@+id/ki_widget_open" android:layout_width="0dp" android:layout_height="match_parent"
            android:layout_weight="1" android:orientation="vertical" android:gravity="center" android:layout_margin="3dp"
            android:background="@drawable/ki_widget_btn">
            <TextView android:layout_width="wrap_content" android:layout_height="wrap_content" android:text="⏳"
                android:textSize="20sp" />
            <TextView android:id="@+id/ki_widget_open_label" android:layout_width="wrap_content" android:layout_height="wrap_content" android:text="Offen"
                android:textColor="#D7DEEA" android:textSize="11sp" android:layout_marginTop="2dp" />
        </LinearLayout>
    </LinearLayout>
</LinearLayout>
`,
  'drawable/ki_widget_btn.xml': `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="#2A3344" />
    <corners android:radius="16dp" />
</shape>
`,
  'drawable/ki_widget_pill.xml': `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="#2B4A7A" />
    <corners android:radius="14dp" />
</shape>
`,
  'xml/ki_widget_info.xml': `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android" android:minWidth="250dp"
    android:minHeight="110dp" android:targetCellWidth="4" android:targetCellHeight="2" android:updatePeriodMillis="0"
    android:minResizeWidth="180dp" android:minResizeHeight="100dp"
    android:initialLayout="@layout/ki_widget" android:previewLayout="@layout/ki_widget"
    android:resizeMode="horizontal|vertical" android:widgetCategory="home_screen" android:description="@string/ki_widget" />
`,
  'xml/ki_shortcuts.xml': `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">${shortcut('sprechen', 'ki_sc_talk', 'listen')}${shortcut('live', 'ki_sc_live', 'live')}${shortcut('spaeter', 'ki_sc_later', 'later', '@drawable/ic_ki_mic', 'KIQuickNote')}${shortcut('diktat', 'ki_sc_dict', 'dictate')}${shortcut('offen', 'ki_sc_open', 'offen')}
</shortcuts>
`,
  'values/ki_strings.xml': `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="ki_tile">KI sprechen</string>
    <string name="ki_widget">KI-Assistent: Sprechen</string>
    <string name="ki_sc_talk">Sprechen</string>
    <string name="ki_sc_live">Live-Gespräch</string>
    <string name="ki_sc_live_short">📞 Live</string>
    <string name="ki_sc_note_short">📝</string>
    <string name="ki_sc_note">Notiz</string>
    <string name="ki_sc_dict">Diktat</string>
    <string name="ki_sc_later">Für später</string>
    <string name="ki_sc_dict_short">✍ Diktat</string>
    <string name="ki_sc_open">Was ist offen?</string>
    <string name="ki_sc_open_short">⏳</string>
    <string name="ki_tile_dict">KI Diktat</string>
    <string name="ki_notify">KI-Assistent: Nachrichten vorlesen</string>
</resources>
`,
};

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const manifest = path.join(root, 'android/app/src/main/AndroidManifest.xml');
let xml = fs.readFileSync(manifest, 'utf8');
const PERMS = [
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.CAMERA', // QR-Code des PCs scannen (Kopplung für den Abgleich)
  'android.permission.USE_BIOMETRIC', // App-Sperre mit Fingerabdruck/Gesicht
  // ungefährer Ort für Wetter/Verkehr (nur wenn eingeschaltet; Android fragt beim ersten Mal)
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  // Erinnerungen (nur wenn eingeschaltet)
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.USE_EXACT_ALARM',
  ['android.permission.SCHEDULE_EXACT_ALARM', 32],
  // Gespräch im Hintergrund (nur wenn eingeschaltet)
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
  'android.permission.WAKE_LOCK',
  'android.permission.BLUETOOTH_CONNECT',
  // Beta: schwebende Figur über anderen Apps (muss in den Android-Einstellungen erlaubt werden)
  'android.permission.SYSTEM_ALERT_WINDOW',
  // Privat: Wecker/Timer auf Zuruf (Uhr-App des Handys)
  'com.android.alarm.permission.SET_ALARM',
  // Privat: „Ruf Anna an“ – Nummer im Adressbuch nachschlagen (Android fragt beim ersten Mal)
  'android.permission.READ_CONTACTS',
  'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
  // Privat: Bildschirm fragen (ein Bildschirmfoto nach Android-Freigabe)
  'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
  ['android.permission.BLUETOOTH', 30],
];
for (const entry of PERMS) {
  const [perm, maxSdk] = Array.isArray(entry) ? entry : [entry];
  if (xml.includes(`"${perm}"`)) continue;
  const max = maxSdk ? ` android:maxSdkVersion="${maxSdk}"` : '';
  xml = xml.replace('</manifest>', `    <uses-permission android:name="${perm}"${max} />\n</manifest>`);
}
// Kamera nur für den QR-Code – die App läuft auch auf Geräten ohne Kamera
if (!xml.includes('android.hardware.camera')) xml = xml.replace('</manifest>', '    <uses-feature android:name="android.hardware.camera" android:required="false" />\n</manifest>');
if (!xml.includes('usesCleartextTraffic')) xml = xml.replace('<application', '<application\n        android:usesCleartextTraffic="true"');
// Bild-im-Bild: Aktivität darf als kleines schwebendes Fenster laufen
if (!xml.includes('supportsPictureInPicture')) {
  xml = xml.replace(/<activity\b/, '<activity\n            android:supportsPictureInPicture="true"\n            android:resizeableActivity="true"');
}
// Teilen mit KI-Assistent, Assistent-Taste, App-Verknüpfungen (langes Drücken aufs Symbol)
if (!xml.includes('android.intent.action.SEND')) {
  const filters = `
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="text/*" />
                <data android:mimeType="image/*" />
                <data android:mimeType="application/*" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SEND_MULTIPLE" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="image/*" />
                <data android:mimeType="application/*" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.ASSIST" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.VOICE_COMMAND" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
            <meta-data android:name="android.app.shortcuts" android:resource="@xml/ki_shortcuts" />
`;
  xml = xml.replace(/(<category android:name="android.intent.category.LAUNCHER" \/>\s*<\/intent-filter>)/, `$1\n${filters}`);
}
if (!xml.includes('KIConversationService')) {
  const parts = `
        <service android:name=".KIConversationService" android:exported="false"
            android:foregroundServiceType="microphone|mediaPlayback|mediaProjection" />
        <service android:name=".KINotify" android:exported="true" android:label="@string/ki_notify"
            android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE">
            <intent-filter>
                <action android:name="android.service.notification.NotificationListenerService" />
            </intent-filter>
        </service>
        <receiver android:name=".KIReminder" android:exported="false" />
        <activity android:name=".KIQuickNote" android:exported="true" android:excludeFromRecents="true"
            android:taskAffinity="" android:theme="@android:style/Theme.DeviceDefault.Dialog.NoActionBar"
            android:windowSoftInputMode="stateAlwaysVisible|adjustResize" />
        <receiver android:name=".KIBoot" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
            </intent-filter>
        </receiver>
        <service android:name=".KITileDiktat" android:exported="true" android:label="@string/ki_tile_dict"
            android:icon="@drawable/ic_ki_mic" android:permission="android.permission.BIND_QUICK_SETTINGS_TILE">
            <intent-filter>
                <action android:name="android.service.quicksettings.action.QS_TILE" />
            </intent-filter>
        </service>
        <service android:name=".KITile" android:exported="true" android:label="@string/ki_tile"
            android:icon="@drawable/ic_ki_mic" android:permission="android.permission.BIND_QUICK_SETTINGS_TILE">
            <intent-filter>
                <action android:name="android.service.quicksettings.action.QS_TILE" />
            </intent-filter>
        </service>
        <receiver android:name=".KIWidget" android:exported="false" android:label="@string/ki_widget">
            <intent-filter>
                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
            </intent-filter>
            <meta-data android:name="android.appwidget.provider" android:resource="@xml/ki_widget_info" />
        </receiver>
`;
  xml = xml.replace('</application>', `${parts}    </application>`);
}
// Handy-Aktionen (Privat): installierte Apps finden und öffnen, Navigation, Claude/WhatsApp übergeben (ab Android 11
// nötig, damit diese Apps sichtbar sind)
if (!xml.includes('<queries>')) {
  const queries = `
    <queries>
        <intent>
            <action android:name="android.intent.action.MAIN" />
            <category android:name="android.intent.category.LAUNCHER" />
        </intent>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="google.navigation" />
        </intent>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="geo" />
        </intent>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="spotify" />
        </intent>
        <intent>
            <action android:name="android.intent.action.SEND" />
            <data android:mimeType="text/plain" />
        </intent>
        <package android:name="com.anthropic.claude" />
        <package android:name="com.whatsapp" />
        <package android:name="com.google.android.youtube" />
        <package android:name="com.spotify.music" />
    </queries>
`;
  xml = xml.replace('<application', `${queries}    <application`);
}
fs.writeFileSync(manifest, xml);
// eigene MainActivity (Bild-im-Bild, Schlüssel, Speichern, Teilen …) und weitere Android-Teile
const javaDir = path.join(root, 'android/app/src/main/java/de/ergoforyou/kiassistent');
fs.copyFileSync(path.join(root, 'scripts/MainActivity.java'), path.join(javaDir, 'MainActivity.java'));
for (const f of fs.readdirSync(path.join(root, 'scripts/android'))) {
  if (f.endsWith('.java')) fs.copyFileSync(path.join(root, 'scripts/android', f), path.join(javaDir, f));
}
// Ressourcen: Symbol, Widget, Verknüpfungen, Texte
const res = path.join(root, 'android/app/src/main/res');
for (const [file, content] of Object.entries(RESOURCES)) {
  fs.mkdirSync(path.dirname(path.join(res, file)), { recursive: true });
  fs.writeFileSync(path.join(res, file), content);
}

const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const gradle = path.join(root, 'android/app/build.gradle');
let g = fs.readFileSync(gradle, 'utf8');
const [maj, min, pat] = version.split('.').map((n) => parseInt(n, 10));
// Beta: Nummer hinter „-beta.“ – jede neue Beta hat eine höhere versionCode und installiert sich über die vorige
const betaNo = Number(/-beta\.(\d+)/.exec(version)?.[1] ?? 0);
const versionCode = BETA ? (maj * 10000 + min * 100 + pat) * 100 + betaNo : maj * 10000 + min * 100 + pat;
// Fester Test-Signierschlüssel: Sonst signiert jeder Build mit einem neuen Zufallsschlüssel, und Android
// verweigert das Update über die vorherige Version.
if (!g.includes('android-test.keystore')) {
  g = g.replace(
    /android \{/,
    `android {
    signingConfigs {
        debug {
            storeFile file('../../scripts/android-test.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }`,
  );
}
if (BETA) {
  g = g.replace(/applicationId "[^"]*"/, `applicationId "${APP}"`);
  const strings = path.join(root, 'android/app/src/main/res/values/strings.xml');
  fs.writeFileSync(strings, fs.readFileSync(strings, 'utf8').replace(/(<string name="(?:app_name|title_activity_main)">)[^<]*/g, '$1KI-Assistent Beta'));
}
g = g.replace(/versionCode \d+/, `versionCode ${versionCode}`).replace(/versionName "[^"]*"/, `versionName "${version}"`);
fs.writeFileSync(gradle, g);
console.log('Android-Manifest und Version angepasst:', version);
