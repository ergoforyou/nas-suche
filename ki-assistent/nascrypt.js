// Verschlüsselung für die NAS (optional): Bevor etwas auf die NAS geht, wird es mit einem eigenen Passwort
// verschlüsselt (AES-256-GCM, Schlüssel per PBKDF2 aus dem Passwort) – auf der NAS liegt dann nur Datensalat.
// Das Passwort wird auf jedem Gerät selbst eingetragen, liegt verschlüsselt bei den Schlüsseln und geht nirgends hin.
// Läuft am PC im Hauptprozess und auf dem Handy in der App (beide mit WebCrypto).

const MAGIC = new TextEncoder().encode('KIENC1');
const ITER = 200000;
const keys = new Map(); // Salz (Base64) → abgeleiteter Schlüssel (Ableiten ist absichtlich langsam)

const subtle = () => globalThis.crypto.subtle;
const b64 = (u8) => (typeof Buffer !== 'undefined' ? Buffer.from(u8).toString('base64') : btoa(String.fromCharCode(...u8)));

async function deriveKey(pass, salt) {
  const id = `${b64(salt)}:${pass.length}:${pass.charCodeAt(0)}:${pass.charCodeAt(pass.length - 1)}`;
  const cached = keys.get(id);
  if (cached?.pass === pass) return cached.key;
  const base = await subtle().importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle().deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  keys.set(id, { pass, key });
  return key;
}

/** Ist das ein verschlüsselter Inhalt dieser App? */
function isEncrypted(bytes) {
  if (!bytes || bytes.length < MAGIC.length + 28) return false;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return false;
  return true;
}

// ein Salz je Sitzung/Gerät: so muss der Schlüssel nur einmal abgeleitet werden (jede Datei bekommt trotzdem ein
// eigenes, zufälliges iv)
let sessionSalt = null;

/** Verschlüsseln: KIENC1 | Salz (16) | iv (12) | Daten+Prüfsumme */
async function encrypt(bytes, pass) {
  sessionSalt ??= globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, sessionSalt);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(MAGIC.length + 16 + 12 + ct.length);
  out.set(MAGIC, 0);
  out.set(sessionSalt, MAGIC.length);
  out.set(iv, MAGIC.length + 16);
  out.set(ct, MAGIC.length + 28);
  return out;
}

/** Entschlüsseln; Unverschlüsseltes kommt unverändert zurück (Umstieg). Falsches Passwort → Fehler. */
async function decrypt(bytes, pass) {
  if (!isEncrypted(bytes)) return bytes;
  if (!pass) throw new Error('Der Stand auf der NAS ist verschlüsselt – bitte das Passwort für die Verschlüsselung eintragen');
  const salt = bytes.slice(MAGIC.length, MAGIC.length + 16);
  const iv = bytes.slice(MAGIC.length + 16, MAGIC.length + 28);
  try {
    const key = await deriveKey(pass, salt);
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv }, key, bytes.slice(MAGIC.length + 28)));
  } catch {
    throw new Error('Das Passwort für die Verschlüsselung passt nicht zum Stand auf der NAS');
  }
}

/**
 * Anfrage an die NAS mit Verschlüsselung drumherum: PUT verschlüsselt den Inhalt, GET entschlüsselt ihn. ETags und
 * Bedingungen (If-Match …) bleiben unberührt. send(method, path, body, headers) → { status, etag, body }.
 */
async function cryptReq(send, pass, method, path, body, headers = {}) {
  const out = pass && method === 'PUT' && body ? await encrypt(body instanceof Uint8Array ? body : new Uint8Array(body), pass) : body;
  const r = await send(method, path, out, headers);
  if (method === 'GET' && r?.status === 200 && r.body) return { ...r, body: await decrypt(r.body instanceof Uint8Array ? r.body : new Uint8Array(r.body), pass) };
  return r;
}

module.exports = { isEncrypted, encrypt, decrypt, cryptReq };
