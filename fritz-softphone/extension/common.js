/* Gemeinsame Hilfsfunktionen für Hintergrund, Telefonfenster und Engine. */
'use strict';

const DEFAULT_SETTINGS = {
  wsUrl: '',            // z.B. ws://192.168.178.10:8088/ws
  user: 'webphone',
  password: '',
  displayName: '',
  lines: 3,             // Anzahl paralleler Leitungen
  pickupCode: '*09',    // FRITZ!Box: Anruf heranholen
  autoStart: true,      // beim Browserstart anmelden
  popupOnIncoming: true,
  notifications: true,
  dnd: false,           // Nicht stören
  micId: '',
  speakerId: '',
  ringId: '',
  ringVolume: 0.6,
  monitorUrl: '',       // z.B. http://192.168.178.10:8089  (Nebenstellen-Monitor)
  extensions: ''        // je Zeile: Name = **610   (optional "= 10" als Callmonitor-Kennung)
};

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return Object.assign({}, DEFAULT_SETTINGS, settings || {});
}

/** Wählbare Zeichen behalten: Ziffern, *, #, führendes + */
function cleanDial(input) {
  if (!input) return '';
  let s = String(input).trim();
  if (s.toLowerCase().startsWith('tel:')) s = decodeURIComponent(s.slice(4));
  const plus = s.startsWith('+');
  return (plus ? '+' : '') + s.replace(/[^0-9*#]/g, '');
}

/** Für Vergleiche: +49 / 0049 -> 0, nur Ziffern. */
function normalizeNumber(n) {
  let s = String(n || '').replace(/[^0-9+]/g, '');
  if (s.startsWith('+49')) s = '0' + s.slice(3);
  else if (s.startsWith('0049')) s = '0' + s.slice(4);
  else if (s.startsWith('+')) s = '00' + s.slice(1);
  return s;
}

/** Sucht einen Kontakt zur Nummer. Liefert {entry, number} oder null. */
function lookupNumber(phonebook, number) {
  const n = normalizeNumber(number);
  if (n.length < 3) return null;
  let partial = null;
  for (const e of phonebook || []) {
    for (const num of e.numbers || []) {
      const m = normalizeNumber(num.number);
      if (!m) continue;
      if (m === n) return { entry: e, number: num };
      // Durchwahl-/Vorwahl-Varianten: hintere 8 Ziffern gleich
      if (!partial && n.length >= 8 && m.length >= 8 && m.slice(-8) === n.slice(-8)) partial = { entry: e, number: num };
    }
  }
  return partial;
}

function displayName(entry) {
  if (!entry) return '';
  return entry.company && entry.name ? `${entry.name} (${entry.company})` : (entry.name || entry.company || '');
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Callmonitor-Kennung einer internen Nummer: **1..**3 -> 0..2, **610 -> 10, **620 -> 20 */
function extensionIdFor(number) {
  let m = /^\*\*([1-3])$/.exec(number);
  if (m) return String(Number(m[1]) - 1);
  m = /^\*\*6(\d\d)$/.exec(number);
  if (m) return String(Number(m[1]));
  return '';
}

/** "Name = **610 [= id]" je Zeile -> [{name, number, extId}] */
function parseExtensions(text) {
  return String(text || '').split(/\r?\n/).map((row) => row.trim()).filter(Boolean).map((row) => {
    const parts = row.split(/[=;]/).map((x) => x.trim());
    const name = parts[0] || '';
    const number = cleanDial(parts[1] || '');
    const extId = (parts[2] || extensionIdFor(number)).trim();
    return { name, number, extId };
  }).filter((e) => e.name && e.number);
}
