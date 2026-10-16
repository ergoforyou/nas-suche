// Google Kalender und Google Tasks (Aufgaben) – gemeinsam für PC (Electron-Hauptprozess) und Android-App.
// Anmeldung: OAuth 2.0 mit PKCE über den Browser; zurück kommt die App über eine Adresse auf dem eigenen Gerät
// (127.0.0.1). Gespeichert wird nur das Erneuerungs-Token – verschlüsselt (Windows bzw. Android-Keystore).
// Das Sprachmodell bekommt Werkzeuge zum Lesen und Eintragen; geschrieben wird nur nach Bestätigung im Gespräch.

const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/tasks'];
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const TASKS = 'https://tasks.googleapis.com/tasks/v1/lists/@default/tasks';

const b64url = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return (typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** PKCE: geheimer Prüfwert und dessen Hash für die Anmeldeadresse. */
async function pkce() {
  const c = globalThis.crypto;
  const verifier = b64url(c.getRandomValues(new Uint8Array(32)));
  const hash = new Uint8Array(await c.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(hash), state: b64url(c.getRandomValues(new Uint8Array(12))) };
}

function authUrl({ clientId, redirectUri, challenge, state }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${AUTH}?${q}`;
}

const form = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null)).toString();

/** E-Mail-Adresse aus dem ID-Token lesen (nur zur Anzeige „verbunden als …“). */
function emailFromIdToken(idToken) {
  try {
    const part = String(idToken).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = typeof atob === 'function' ? decodeURIComponent(escape(atob(part))) : Buffer.from(part, 'base64').toString('utf8');
    return JSON.parse(json).email ?? '';
  } catch {
    return '';
  }
}

/**
 * @param {{http: (req: {method: string, url: string, headers?: object, body?: string}) => Promise<{status: number, data: any}>,
 *          load: () => Promise<object|null>, save: (tokens: object|null) => Promise<void>}} io
 */
function createGoogle(io) {
  let cache = null;
  const tokens = async () => (cache ??= (await io.load()) ?? null);

  async function exchange({ clientId, clientSecret, code, verifier, redirectUri }) {
    const r = await io.http({
      method: 'POST',
      url: TOKEN,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ client_id: clientId, client_secret: clientSecret || undefined, code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
    });
    if (r.status !== 200 || !r.data?.refresh_token) throw new Error(`Google-Anmeldung fehlgeschlagen (${r.status}): ${r.data?.error_description ?? r.data?.error ?? ''}`);
    const t = {
      clientId,
      clientSecret: clientSecret || '',
      refresh: r.data.refresh_token,
      access: r.data.access_token,
      expires: Date.now() + (r.data.expires_in - 60) * 1000,
      email: emailFromIdToken(r.data.id_token),
    };
    cache = t;
    await io.save(t);
    return t.email;
  }

  async function accessToken() {
    const t = await tokens();
    if (!t) throw new Error('Nicht mit Google verbunden (⚙ → Verbindung → Google).');
    if (t.access && Date.now() < t.expires) return t.access;
    const r = await io.http({
      method: 'POST',
      url: TOKEN,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ client_id: t.clientId, client_secret: t.clientSecret || undefined, refresh_token: t.refresh, grant_type: 'refresh_token' }),
    });
    if (r.status !== 200) {
      if (r.data?.error === 'invalid_grant') {
        cache = null;
        await io.save(null);
        throw new Error('Die Google-Verbindung ist abgelaufen – bitte unter ⚙ → Verbindung neu verbinden.');
      }
      throw new Error(`Google antwortet mit ${r.status}`);
    }
    Object.assign(t, { access: r.data.access_token, expires: Date.now() + (r.data.expires_in - 60) * 1000 });
    await io.save(t);
    return t.access;
  }

  async function api(method, url, body) {
    const r = await io.http({
      method,
      url,
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status >= 300) throw new Error(`Google: ${r.data?.error?.message ?? r.status}`);
    return r.data;
  }

  return {
    exchange,
    status: async () => {
      const t = await tokens();
      return t ? { connected: true, email: t.email } : { connected: false };
    },
    disconnect: async () => {
      const t = await tokens();
      cache = null;
      await io.save(null);
      if (t?.refresh) await io.http({ method: 'POST', url: `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.refresh)}` }).catch(() => {});
    },
    api,
  };
}

// ---------------------------------------------------------------- Werkzeuge für das Sprachmodell
// Beschreibungen auf Deutsch – das Modell entscheidet anhand dieser Texte, wann es sie nutzt.
const TOOLS = [
  {
    name: 'kalender_termine_lesen',
    description: 'Termine aus dem Google-Kalender des Nutzers lesen (Hauptkalender). Für Fragen wie „Was steht morgen an?“ oder „Wann habe ich Zeit?“.',
    input_schema: {
      type: 'object',
      properties: {
        von: { type: 'string', description: 'Beginn des Zeitraums, ISO 8601 in Ortszeit, z. B. 2026-10-20T00:00' },
        bis: { type: 'string', description: 'Ende des Zeitraums, ISO 8601 in Ortszeit' },
        suche: { type: 'string', description: 'optional: Suchbegriff im Titel/Ort' },
      },
      required: ['von', 'bis'],
    },
  },
  {
    name: 'kalender_termin_anlegen',
    description: 'Neuen Termin im Google-Kalender eintragen. NUR nach ausdrücklicher Bestätigung durch den Nutzer aufrufen.',
    input_schema: {
      type: 'object',
      properties: {
        titel: { type: 'string' },
        beginn: { type: 'string', description: 'ISO 8601 in Ortszeit, z. B. 2026-10-20T14:00; bei ganztägig nur Datum 2026-10-20' },
        ende: { type: 'string', description: 'optional, ISO 8601 in Ortszeit; sonst dauer_minuten' },
        dauer_minuten: { type: 'integer', description: 'optional, Standard 60' },
        ganztags: { type: 'boolean' },
        ort: { type: 'string' },
        beschreibung: { type: 'string' },
        erinnerung_minuten: { type: 'integer', description: 'optional: Erinnerung so viele Minuten vorher (Benachrichtigung auf dem Handy)' },
      },
      required: ['titel', 'beginn'],
    },
  },
  {
    name: 'kalender_termin_aendern',
    description: 'Vorhandenen Termin verschieben oder ändern (ID aus kalender_termine_lesen). NUR nach Bestätigung durch den Nutzer.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        titel: { type: 'string' },
        beginn: { type: 'string' },
        ende: { type: 'string' },
        ort: { type: 'string' },
        beschreibung: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'kalender_termin_loeschen',
    description: 'Termin löschen (ID aus kalender_termine_lesen). NUR nach ausdrücklicher Bestätigung durch den Nutzer.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'aufgaben_lesen',
    description: 'Aufgaben aus Google Tasks (Standardliste) lesen.',
    input_schema: {
      type: 'object',
      properties: { auch_erledigte: { type: 'boolean', description: 'auch erledigte Aufgaben zeigen (Standard: nein)' } },
    },
  },
  {
    name: 'aufgabe_anlegen',
    description: 'Neue Aufgabe in Google Tasks anlegen. NUR nach Bestätigung durch den Nutzer.',
    input_schema: {
      type: 'object',
      properties: {
        titel: { type: 'string' },
        notiz: { type: 'string' },
        faellig: { type: 'string', description: 'optional: Fälligkeitsdatum YYYY-MM-DD' },
      },
      required: ['titel'],
    },
  },
  {
    name: 'aufgabe_erledigt',
    description: 'Aufgabe als erledigt abhaken (ID aus aufgaben_lesen). Nach Bestätigung durch den Nutzer.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

const TOOL_STATUS = {
  kalender_termine_lesen: '📅 schaut in den Kalender …',
  kalender_termin_anlegen: '📅 trägt den Termin ein …',
  kalender_termin_aendern: '📅 ändert den Termin …',
  kalender_termin_loeschen: '📅 löscht den Termin …',
  aufgaben_lesen: '✅ schaut in die Aufgaben …',
  aufgabe_anlegen: '✅ legt die Aufgabe an …',
  aufgabe_erledigt: '✅ hakt die Aufgabe ab …',
};

/** Hinweise für das Sprachmodell (kommen in den Systemprompt). */
function toolPrompt(now = new Date(), timeZone = 'Europe/Berlin') {
  const day = now.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', timeZone });
  const time = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone });
  return (
    `Du hast Zugriff auf den Google-Kalender und die Google-Aufgaben des Nutzers. Jetzt ist ${day}, ${time} Uhr (${timeZone}). ` +
    'Lesen darfst du jederzeit. Bevor du einen Termin oder eine Aufgabe anlegst, änderst, löschst oder abhakst: fasse in einem Satz ' +
    'zusammen, was du tun willst, und frag „Soll ich das so machen?“ – rufe das Werkzeug erst nach einem klaren Ja auf. ' +
    'Nenne Termine natürlich gesprochen (z. B. „morgen um 14 Uhr“), ohne IDs.'
  );
}

// Ortszeit-Angabe ("2026-10-20T14:00") in RFC 3339 mit Zeitzone der Anfrage umwandeln: Google akzeptiert dateTime ohne
// Versatz, wenn timeZone mitgegeben wird.
const localDT = (s) => String(s).replace(/(Z|[+-]\d\d:?\d\d)$/, '').slice(0, 19).padEnd(19, ':00');
const fixSeconds = (s) => (/T\d\d:\d\d$/.test(s) ? `${s}:00` : s);

function addMinutes(local, min) {
  const [d, t = '00:00'] = local.split('T');
  const [Y, M, D] = d.split('-').map(Number);
  const [h, m] = t.split(':').map(Number);
  const x = new Date(Date.UTC(Y, M - 1, D, h, m + min));
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getUTCFullYear()}-${p(x.getUTCMonth() + 1)}-${p(x.getUTCDate())}T${p(x.getUTCHours())}:${p(x.getUTCMinutes())}:00`;
}

/** Werkzeug ausführen. Liefert ein kurzes JSON-taugliches Ergebnis für das Modell. */
async function runTool(g, name, input, { timeZone = 'Europe/Berlin' } = {}) {
  const need = (k) => {
    if (input?.[k] == null || input[k] === '') throw new Error(`Angabe „${k}“ fehlt`);
    return input[k];
  };
  const evOut = (e) => ({
    id: e.id,
    titel: e.summary ?? '(ohne Titel)',
    beginn: e.start?.dateTime ?? e.start?.date,
    ende: e.end?.dateTime ?? e.end?.date,
    ...(e.location ? { ort: e.location } : {}),
  });
  switch (name) {
    case 'kalender_termine_lesen': {
      const toRfc = async (s) => {
        // Ortszeit -> Zeitpunkt: über den Versatz der Zeitzone zu diesem Datum
        const local = fixSeconds(String(s).length === 10 ? `${s}T00:00` : localDT(s));
        const guess = new Date(`${local}Z`);
        const tzDate = new Date(guess.toLocaleString('en-US', { timeZone }));
        const utcDate = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
        return new Date(guess.getTime() - (tzDate - utcDate)).toISOString();
      };
      const q = new URLSearchParams({
        timeMin: await toRfc(need('von')),
        timeMax: await toRfc(need('bis')),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '50',
        timeZone,
        ...(input.suche ? { q: input.suche } : {}),
      });
      const r = await g.api('GET', `${CAL}?${q}`);
      return { termine: (r.items ?? []).map(evOut) };
    }
    case 'kalender_termin_anlegen': {
      const titel = need('titel');
      const beginn = String(need('beginn'));
      const allDay = input.ganztags || /^\d{4}-\d\d-\d\d$/.test(beginn);
      let start;
      let end;
      if (allDay) {
        const d = beginn.slice(0, 10);
        start = { date: d };
        end = { date: (input.ende ? String(input.ende) : addMinutes(`${d}T00:00`, 24 * 60)).slice(0, 10) };
      } else {
        const s = fixSeconds(localDT(beginn));
        const e = input.ende ? fixSeconds(localDT(input.ende)) : addMinutes(s, Math.max(5, input.dauer_minuten ?? 60));
        start = { dateTime: s, timeZone };
        end = { dateTime: e, timeZone };
      }
      const body = {
        summary: titel,
        start,
        end,
        ...(input.ort ? { location: input.ort } : {}),
        ...(input.beschreibung ? { description: input.beschreibung } : {}),
        ...(input.erinnerung_minuten != null
          ? { reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: Math.max(0, input.erinnerung_minuten) }] } }
          : {}),
      };
      const e = await g.api('POST', CAL, body);
      return { eingetragen: evOut(e) };
    }
    case 'kalender_termin_aendern': {
      const id = need('id');
      const patch = {};
      if (input.titel) patch.summary = input.titel;
      if (input.ort) patch.location = input.ort;
      if (input.beschreibung) patch.description = input.beschreibung;
      if (input.beginn) patch.start = { dateTime: fixSeconds(localDT(input.beginn)), timeZone };
      if (input.ende) patch.end = { dateTime: fixSeconds(localDT(input.ende)), timeZone };
      if (input.beginn && !input.ende) {
        // Dauer beibehalten
        const old = await g.api('GET', `${CAL}/${encodeURIComponent(id)}`);
        const dur = old.start?.dateTime && old.end?.dateTime ? (new Date(old.end.dateTime) - new Date(old.start.dateTime)) / 60000 : 60;
        patch.end = { dateTime: addMinutes(patch.start.dateTime, dur), timeZone };
      }
      const e = await g.api('PATCH', `${CAL}/${encodeURIComponent(id)}`, patch);
      return { geaendert: evOut(e) };
    }
    case 'kalender_termin_loeschen': {
      await g.api('DELETE', `${CAL}/${encodeURIComponent(need('id'))}`);
      return { geloescht: true };
    }
    case 'aufgaben_lesen': {
      const q = new URLSearchParams({ showCompleted: input?.auch_erledigte ? 'true' : 'false', showHidden: input?.auch_erledigte ? 'true' : 'false', maxResults: '100' });
      const r = await g.api('GET', `${TASKS}?${q}`);
      return {
        aufgaben: (r.items ?? []).map((t) => ({
          id: t.id,
          titel: t.title,
          ...(t.notes ? { notiz: t.notes } : {}),
          ...(t.due ? { faellig: t.due.slice(0, 10) } : {}),
          ...(t.status === 'completed' ? { erledigt: true } : {}),
        })),
      };
    }
    case 'aufgabe_anlegen': {
      const body = { title: need('titel'), ...(input.notiz ? { notes: input.notiz } : {}), ...(input.faellig ? { due: `${String(input.faellig).slice(0, 10)}T00:00:00.000Z` } : {}) };
      const t = await g.api('POST', TASKS, body);
      return { angelegt: { id: t.id, titel: t.title, ...(t.due ? { faellig: t.due.slice(0, 10) } : {}) } };
    }
    case 'aufgabe_erledigt': {
      const t = await g.api('PATCH', `${TASKS}/${encodeURIComponent(need('id'))}`, { status: 'completed' });
      return { erledigt: t.title };
    }
    default:
      throw new Error(`Unbekanntes Werkzeug ${name}`);
  }
}

module.exports = { SCOPES, pkce, authUrl, createGoogle, TOOLS, TOOL_STATUS, toolPrompt, runTool };
