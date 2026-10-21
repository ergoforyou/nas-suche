// Persona als eine Datei (.kiavatar) mitnehmen – zwischen PC und Handy hin und her.
// Enthalten: Name, Texte, Stimme, Avatar mit allen Einstellungen (Markierungen, Gesichts-/Körper-Rig, Posen,
// Bewegungsbilder) und alle Medien (Videos, Masken, 3D-Figur). Nicht enthalten: Schlüssel, Google-Verbindung,
// Gedächtnis/Selbstbild, gespeichertes Wissen und Chatverlauf nur auf Wunsch (Komplett-Umzug aufs eigene Gerät).
// Format: ZIP mit profil.json und dem Ordner media/.
import JSZip from 'jszip';

// Adressen, die auf gespeicherte Medien des Geräts zeigen (PC: app://local/media, Android: Capacitor-Datei, Test: blob:)
const MEDIA = /^(app:\/\/local\/media\/|https?:\/\/localhost\/_capacitor_file_\/|capacitor:\/\/|blob:)/;
const TYPE_EXT = { 'video/webm': 'webm', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'model/gltf-binary': 'vrm', 'image/png': 'png', 'image/jpeg': 'jpg' };

async function walk(obj, fn) {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) obj[i] = typeof obj[i] === 'string' ? await fn(obj[i]) : (await walk(obj[i], fn), obj[i]);
  } else if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) obj[k] = typeof obj[k] === 'string' ? await fn(obj[k]) : (await walk(obj[k], fn), obj[k]);
  }
  return obj;
}

/** Persona packen. onProgress(text) für längere Videos. */
export async function packPersona(persona, { withMemory = false, version = '', onProgress, wissen, verlauf, bereich } = {}) {
  const p = structuredClone(persona);
  delete p.id;
  if (!withMemory) {
    // Gedächtnis und Selbstbild nur auf Wunsch (enthalten Persönliches aus den Gesprächen)
    delete p.memory;
    delete p.selbst;
    delete p.reflexion;
    delete p.themen;
    delete p.kanon;
    delete p.gemeinsam;
    delete p.tagebuch;
    delete p.stimmung;
    delete p.ziele;
    delete p.entwicklung;
    delete p.episoden;
    delete p.episodeUntil;
    delete p.signale;
    delete p.weekReviewAt;
  }
  delete p.reflectTurns;
  delete p.reflectedAt;
  const zip = new JSZip();
  const done = new Map();
  let n = 0;
  await walk(p, async (s) => {
    if (!MEDIA.test(s)) return s;
    if (done.has(s)) return done.get(s);
    onProgress?.(`Medien werden eingepackt … ${n + 1}`);
    const res = await fetch(s);
    if (!res.ok) throw new Error(`Datei nicht lesbar: ${s.split('/').pop()}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const ext = (s.match(/\.([a-z0-9]{2,5})(?:$|[?#])/i)?.[1] ?? TYPE_EXT[res.headers.get('content-type')?.split(';')[0]] ?? 'bin').toLowerCase();
    const path = `media/${++n}.${ext}`;
    zip.file(path, bytes, { compression: 'STORE' }); // Videos/Modelle sind schon gepackt
    done.set(s, `kimedia:${path}`);
    return `kimedia:${path}`;
  });
  const extra = { ...(bereich ? { bereich } : {}), ...(wissen?.length ? { wissen } : {}), ...(verlauf?.length ? { verlauf } : {}) };
  zip.file('profil.json', JSON.stringify({ kiAssistentPersona: 2, app: 'KI-Assistent', version, persona: p, ...extra }), { compression: 'DEFLATE' });
  return zip.generateAsync({ type: 'uint8array' });
}

/**
 * Persona aus einer .kiavatar-Datei (oder der älteren .persona.json) lesen. Medien werden über saveMedia(bytes, ext)
 * auf diesem Gerät gespeichert. Liefert die Persona (ohne id).
 */
export async function unpackPersona(bytes, saveMedia, { onProgress, full = false } = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] !== 0x50 || b[1] !== 0x4b) {
    // ältere Variante: reine JSON-Datei ohne Medien
    const data = JSON.parse(new TextDecoder().decode(b));
    if (!data.kiAssistentPersona) throw new Error('Keine gültige Persona-Datei');
    delete data.kiAssistentPersona;
    return full ? { persona: data.persona ?? data } : (data.persona ?? data);
  }
  const zip = await JSZip.loadAsync(b);
  const json = zip.file('profil.json');
  if (!json) throw new Error('Keine gültige Persona-Datei (profil.json fehlt)');
  const data = JSON.parse(await json.async('string'));
  if (!data.kiAssistentPersona || !data.persona) throw new Error('Keine gültige Persona-Datei');
  const saved = new Map();
  let n = 0;
  await walk(data.persona, async (s) => {
    if (!s.startsWith('kimedia:')) return s;
    if (saved.has(s)) return saved.get(s);
    const path = s.slice(8);
    const f = zip.file(path);
    if (!f) return '';
    onProgress?.(`Medien werden übernommen … ${++n}`);
    const url = await saveMedia(await f.async('uint8array'), path.split('.').pop());
    saved.set(s, url);
    return url;
  });
  // full: dazu Wissen und Chatverlauf, falls mit exportiert
  return full ? { persona: data.persona, wissen: data.wissen ?? null, verlauf: data.verlauf ?? null, bereich: data.bereich ?? null } : data.persona;
}
