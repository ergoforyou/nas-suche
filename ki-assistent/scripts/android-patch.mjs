// Nach "npx cap add android": Mikrofon-Recht und unverschlüsselte Verbindungen (nur für LM Studio im
// eigenen WLAN) in das Android-Manifest eintragen, App-Version aus package.json übernehmen.
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'de.ergoforyou.kiassistent';
// Beta-Linie (Datei kanal.json, nur im Beta-Zweig): eigene App-ID und eigener Name -> neben der normalen App installierbar
const kanalFile = new URL('../kanal.json', import.meta.url);
const BETA = fs.existsSync(kanalFile) && JSON.parse(fs.readFileSync(kanalFile, 'utf8')).kanal === 'beta';
const APP = BETA ? `${BASE}.beta` : BASE;
const shortcut = (id, label, action, icon = '@drawable/ic_ki_mic') => `
    <shortcut android:shortcutId="${id}" android:enabled="true" android:icon="${icon}" android:shortcutShortLabel="@string/${label}">
        <intent android:action="android.intent.action.VIEW" android:targetPackage="${APP}" android:targetClass="${BASE}.MainActivity">
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
    <path android:fillColor="#FFFFFFFF"
        android:pathData="M20,15.5c-1.25,0 -2.45,-0.2 -3.57,-0.57 -0.35,-0.11 -0.74,-0.03 -1.02,0.24l-2.2,2.2c-2.83,-1.44 -5.15,-3.75 -6.59,-6.59l2.2,-2.21c0.28,-0.26 0.36,-0.65 0.25,-1C8.7,6.45 8.5,5.25 8.5,4c0,-0.55 -0.45,-1 -1,-1H4c-0.55,0 -1,0.45 -1,1 0,9.39 7.61,17 17,17 0.55,0 1,-0.45 1,-1v-3.5c0,-0.55 -0.45,-1 -1,-1zM19,12h2c0,-4.97 -4.03,-9 -9,-9v2c3.87,0 7,3.13 7,7zM15,12h2c0,-2.76 -2.24,-5 -5,-5v2c1.66,0 3,1.34 3,3z" />
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
    <solid android:color="#E61E2430" />
    <corners android:radius="24dp" />
</shape>
`,
  'layout/ki_widget.xml': `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android" android:layout_width="match_parent"
    android:layout_height="match_parent" android:orientation="horizontal" android:gravity="center"
    android:background="@drawable/ki_widget_bg" android:padding="6dp">
    <LinearLayout android:id="@+id/ki_widget_talk" android:layout_width="0dp" android:layout_height="match_parent"
        android:layout_weight="1" android:orientation="horizontal" android:gravity="center">
        <ImageView android:layout_width="40dp" android:layout_height="40dp" android:src="@mipmap/ic_launcher_round"
            android:contentDescription="@string/ki_widget" />
        <TextView android:layout_width="wrap_content" android:layout_height="wrap_content" android:layout_marginStart="8dp"
            android:text="@string/ki_sc_talk" android:textColor="#FFFFFF" android:textSize="16sp" />
    </LinearLayout>
    <TextView android:id="@+id/ki_widget_live" android:layout_width="wrap_content" android:layout_height="match_parent"
        android:gravity="center" android:paddingStart="12dp" android:paddingEnd="12dp"
        android:text="@string/ki_sc_live_short" android:textColor="#9FC3FF" android:textSize="15sp" />
    <TextView android:id="@+id/ki_widget_note" android:layout_width="wrap_content" android:layout_height="match_parent"
        android:gravity="center" android:paddingStart="8dp" android:paddingEnd="12dp"
        android:text="@string/ki_sc_note_short" android:textColor="#FFD27F" android:textSize="15sp" />
</LinearLayout>
`,
  'xml/ki_widget_info.xml': `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android" android:minWidth="220dp"
    android:minHeight="50dp" android:targetCellWidth="3" android:targetCellHeight="1" android:updatePeriodMillis="0"
    android:initialLayout="@layout/ki_widget" android:resizeMode="horizontal" android:widgetCategory="home_screen"
    android:description="@string/ki_widget" />
`,
  'xml/ki_shortcuts.xml': `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">${shortcut('sprechen', 'ki_sc_talk', 'listen')}${shortcut('live', 'ki_sc_live', 'live')}${shortcut('notiz', 'ki_sc_note', 'note')}
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
        <receiver android:name=".KIBoot" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
            </intent-filter>
        </receiver>
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
