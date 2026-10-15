// Nach "npx cap add android": Mikrofon-Recht und unverschlüsselte Verbindungen (nur für LM Studio im
// eigenen WLAN) in das Android-Manifest eintragen, App-Version aus package.json übernehmen.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const manifest = path.join(root, 'android/app/src/main/AndroidManifest.xml');
let xml = fs.readFileSync(manifest, 'utf8');
for (const perm of ['android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS']) {
  if (!xml.includes(perm)) xml = xml.replace('</manifest>', `    <uses-permission android:name="${perm}" />\n</manifest>`);
}
if (!xml.includes('usesCleartextTraffic')) xml = xml.replace('<application', '<application\n        android:usesCleartextTraffic="true"');
fs.writeFileSync(manifest, xml);

const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const gradle = path.join(root, 'android/app/build.gradle');
let g = fs.readFileSync(gradle, 'utf8');
const [maj, min, pat] = version.split('.').map(Number);
g = g.replace(/versionCode \d+/, `versionCode ${maj * 10000 + min * 100 + pat}`).replace(/versionName "[^"]*"/, `versionName "${version}"`);
fs.writeFileSync(gradle, g);
console.log('Android-Manifest und Version angepasst:', version);
