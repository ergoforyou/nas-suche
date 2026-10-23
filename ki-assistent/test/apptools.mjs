// Werkzeug-Auswahl je Gerät und Bereich: Handy-Steuerung nur in der Android-App (Privat), Claude-Übergabe-Werkzeug nur am PC.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { appTools } = require('../cloud.js');

let failed = 0;
const check = (ok, name, info = '') => {
  console.log(`${ok ? '✔' : '✘'} ${name}${ok ? '' : ` ${info}`}`);
  if (!ok) failed++;
};
const names = (o) => appTools(() => {}, o).defs.map((d) => d.name);
const phonePriv = names({ desktop: false, privat: true });
const phoneWork = names({ desktop: false, privat: false });
const pcPriv = names({ desktop: true, privat: true });
check(phonePriv.includes('handy_steuern') && phonePriv.includes('video_abspielen') && !phonePriv.includes('an_claude_uebergeben'), 'Handy Privat: Handy steuern und Videos, keine PC-Übergabe', JSON.stringify(phonePriv));
check(!phoneWork.includes('handy_steuern') && !phoneWork.includes('video_abspielen'), 'Handy Dienstlich: keine Privat-Werkzeuge', JSON.stringify(phoneWork));
check(!pcPriv.includes('handy_steuern') && pcPriv.includes('an_claude_uebergeben') && pcPriv.includes('video_abspielen'), 'PC Privat: kein Handy steuern, aber Claude-Übergabe und Videos', JSON.stringify(pcPriv));
check(appTools(() => {}, { desktop: false, privat: true }).defs.every((d) => !('mobileOnly' in d) && !('privatOnly' in d) && !('desktopOnly' in d)), 'Merker gehen nicht an die API');
process.exit(failed ? 1 : 0);
