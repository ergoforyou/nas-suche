// Startschutz: zählt Starts, die nicht stabil durchgelaufen sind (Absturz, Hängen, sofortiges Schließen). Nach
// mehreren Fehlstarts hintereinander startet die App im „sicheren Modus“ – nur Chat, Sprache und Einstellungen, alle
// Extras (Nachtschicht, Orte, Suche nach Bedeutung, Abgleich, Begrüßung …) ruhen – und zeigt, was zuletzt schiefging.
// Gespeichert wird nur Technisches (Zähler, Fehlerzeilen ohne Inhalte) im Browser-Speicher der App.

export const BOOT_KEY = 'ki-start';
export const ERR_KEY = 'ki-letzte-fehler';
export const SAFE_AFTER = 3; // so viele Fehlstarts hintereinander
export const STABLE_MS = 20e3; // so lange muss die App laufen, damit der Start als gelungen zählt

const read = (st, key, fallback) => {
  try {
    return JSON.parse(st.getItem(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (st, key, value) => {
  try {
    st.setItem(key, JSON.stringify(value));
  } catch {}
};

/** Beim Laden aufrufen: zählt den Start mit; safe = sicherer Modus (nach SAFE_AFTER Fehlstarts oder auf Wunsch). */
export function bootStart(st, now = Date.now()) {
  const b = read(st, BOOT_KEY, {});
  const n = (Number(b.n) || 0) + 1;
  const forced = b.force === 'sicher';
  const safe = forced || n > SAFE_AFTER;
  write(st, BOOT_KEY, { n, t: now, ...(b.force && !forced ? { force: b.force } : {}) });
  return { n, safe, forced };
}

/** Start ist gelungen (App lief STABLE_MS): Zähler zurück. */
export function bootStable(st) {
  write(st, BOOT_KEY, { n: 0, t: Date.now() });
}

/** Nächsten Start bewusst sicher („sicher“) oder normal („normal“) – „normal“ setzt auch den Zähler zurück. */
export function bootNext(st, how) {
  write(st, BOOT_KEY, how === 'sicher' ? { n: 0, force: 'sicher' } : { n: 0 });
}

/** Fehlerzeile für den nächsten Start aufheben (die letzten 12). */
export function rememberError(st, line) {
  const list = read(st, ERR_KEY, []);
  list.push(String(line).slice(0, 300));
  write(st, ERR_KEY, list.slice(-12));
}
export const lastErrors = (st) => read(st, ERR_KEY, []);
