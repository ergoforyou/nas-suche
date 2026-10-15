/* Telefonfenster: reine Oberfläche. Die Gespräche laufen in der Engine (engine.js),
   deshalb kann dieses Fenster geschlossen, verschoben oder ins Mini-Fenster gelegt werden. */
'use strict';

const app = document.getElementById('app');
const $ = (id) => app.querySelector('#' + id);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
};

let port = null;
let st = { reg: { status: 'connecting', error: '' }, lines: [], conference: [], maxLines: 3, monitor: { status: 'off', calls: [] } };
let settings = Object.assign({}, DEFAULT_SETTINGS);
let phonebook = [];
let callLog = [];
let dtmfLine = 0;
let pipWin = null;
let lastDialed = '';

// ------------------------------------------------------------------ Engine-Verbindung

function send(msg) {
  if (!port) { toast('Keine Verbindung zur Telefon-Engine – bitte kurz warten.'); return; }
  port.postMessage(msg);
}

async function connectEngine() {
  try { await chrome.runtime.sendMessage({ type: 'ensure-engine' }); } catch (e) { /* SW startet gerade */ }
  const p = chrome.runtime.connect({ name: 'ui' });
  port = p;
  p.onMessage.addListener((msg) => {
    if (msg.type === 'state') { st = msg.state; renderPhone(); renderHeader(); }
    if (msg.type === 'toast') toast(msg.text, msg.level);
  });
  p.onDisconnect.addListener(() => {
    if (port === p) port = null;
    setTimeout(connectEngine, 800);
  });
  p.postMessage({ cmd: 'hello' });
}

// ------------------------------------------------------------------ Hilfen

let toastTimer = null;
function toast(text, level = 'error') {
  const t = $('toast');
  t.textContent = text;
  t.className = level;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, level === 'error' ? 6000 : 3500);
}

function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const hh = Math.floor(m / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${pad(m % 60)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  const today = new Date();
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return time;
  const y = new Date(today); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'gestern ' + time;
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) + ' ' + time;
}

function extensions() { return parseExtensions(settings.extensions); }

/** Name zur Nummer: Telefonbuch, dann Nebenstellen */
function nameFor(number, fallback) {
  const hit = lookupNumber(phonebook, number);
  if (hit) return displayName(hit.entry);
  const ext = extensions().find((e) => e.number === number);
  if (ext) return ext.name;
  return fallback || '';
}

function dial(number, name) {
  const n = cleanDial(number);
  if (!n) { toast('Bitte eine Nummer eingeben'); return; }
  lastDialed = n;
  chrome.storage.local.set({ lastDialed: n });
  send({ cmd: 'call', number: n, name: name || nameFor(n) });
  $('dialInput').value = '';
  hideSuggest($('suggest'));
}

// ------------------------------------------------------------------ Kopfzeile

function renderHeader() {
  const r = st.reg;
  const dot = $('regDot');
  const map = { registered: ['ok', 'Bereit'], connecting: ['warn', 'Verbinde…'], failed: ['err', 'Keine Verbindung'], unconfigured: ['', 'Nicht eingerichtet'] };
  const [cls, text] = map[r.status] || ['', r.status];
  dot.className = 'dot ' + cls;
  const flags = [settings.dnd && 'Nicht stören', settings.anonymous && 'Anonym', !settings.callWaiting && 'kein Anklopfen'].filter(Boolean);
  $('regText').textContent = [text, ...flags].join(' · ');
  $('regSub').textContent = r.status === 'registered' ? `${settings.user} · ${st.maxLines} Leitungen` : (r.error || '');
  $('btnWait').classList.toggle('off', !settings.callWaiting);
  $('btnWait').title = settings.callWaiting ? 'Anklopfen ist AN – zweite Anrufe klingeln während eines Gesprächs' : 'Anklopfen ist AUS – während eines Gesprächs ist besetzt';
  $('btnAnon').classList.toggle('active', !!settings.anonymous);
  $('btnAnon').title = settings.anonymous ? 'Anonym ist AN – externe Anrufe ohne eigene Nummer' : 'Anonym anrufen einschalten';
  $('btnDnd').classList.toggle('active', !!settings.dnd);
  $('btnDnd').textContent = settings.dnd ? '🔕' : '🔔';
  $('btnDnd').title = settings.dnd ? 'Nicht stören ist AN – klicken zum Ausschalten' : 'Nicht stören einschalten';
  $('pickupCode').textContent = st.pickupCode || settings.pickupCode;

  const banner = $('banner');
  banner.replaceChildren();
  if (st.mic === 'denied' || st.mic === 'prompt') {
    banner.append(h('span', {}, 'Mikrofon ist noch nicht freigegeben.'),
      h('button', { class: 'btn sm', onclick: () => chrome.runtime.sendMessage({ type: 'open-permission' }) }, 'Freigeben'));
  } else if (r.status === 'unconfigured') {
    banner.append(h('span', {}, 'Bitte zuerst die Verbindung einrichten.'),
      h('button', { class: 'btn sm', onclick: () => showTab('settings') }, 'Einstellungen'));
  }
  banner.hidden = !banner.childElementCount;
}

// ------------------------------------------------------------------ Leitungen

const STATE_TEXT = { incoming: 'Klingelt', dialing: 'Wählt…', ringback: 'Klingelt beim Gegenüber…', active: 'Verbunden' };

function lineCard(l) {
  const anon = !l.number || /^anonymous$/i.test(l.number);
  const name = l.name && l.name !== l.number && !/^anonymous$/i.test(l.name) ? l.name : nameFor(l.number);
  const title = name || (anon ? 'Rufnummer unterdrückt' : l.number);
  let state = STATE_TEXT[l.state] || l.state;
  if (l.state === 'active' && l.held) state = 'Gehalten';
  if (l.state === 'active' && l.remoteHeld) state += ' · Gegenüber hält';
  if (l.inConference) state = 'Konferenz';
  if (l.muted) state += ' · stumm';
  if (l.anonymous) state += ' · anonym';
  const cls = ['line', l.state, l.held ? 'held' : '', l.inConference ? 'conf' : ''].join(' ');
  const since = l.answeredAt || l.createdAt;

  const acts = [];
  if (l.state === 'incoming') {
    acts.push(h('button', { class: 'btn green grow', onclick: () => send({ cmd: 'answer', id: l.id }) }, '📞 Annehmen'));
    acts.push(h('button', { class: 'btn red', onclick: () => send({ cmd: 'hangup', id: l.id }) }, 'Ablehnen'));
  } else if (l.state === 'active') {
    acts.push(l.held
      ? h('button', { class: 'btn on grow', onclick: () => send({ cmd: 'unhold', id: l.id }), title: 'Gespräch fortsetzen' }, '▶ Fortsetzen')
      : h('button', { class: 'btn grow', onclick: () => send({ cmd: 'hold', id: l.id }), title: 'Halten' }, '⏸ Halten'));
    acts.push(h('button', { class: 'btn' + (l.muted ? ' on' : ''), onclick: () => send({ cmd: 'mute', id: l.id }), title: 'Mikrofon stumm' }, l.muted ? '🔇' : '🎙'));
    acts.push(h('button', { class: 'btn' + (dtmfLine === l.id ? ' on' : ''), onclick: () => toggleDtmf(l.id), title: 'Tonwahl (z.B. für Sprachmenüs)' }, '⌨'));
    acts.push(h('button', { class: 'btn', onclick: () => openTransfer(l), title: 'Weiterleiten an andere Nummer' }, '↪'));
    acts.push(h('button', { class: 'btn red', onclick: () => send({ cmd: 'hangup', id: l.id }), title: 'Auflegen' }, 'Auflegen'));
  } else {
    acts.push(h('button', { class: 'btn red grow', onclick: () => send({ cmd: 'hangup', id: l.id }) }, 'Abbrechen'));
  }

  return h('div', { class: cls, 'data-id': l.id },
    h('div', { class: 'top' },
      h('span', { class: 'slot' }, 'L' + l.slot),
      h('span', { class: 'name', title }, (l.direction === 'in' ? '↙ ' : '↗ ') + title),
      h('span', { class: 'time', 'data-since': since }, fmtDur(Date.now() - since))),
    h('div', { class: 'meta' }, (name && !anon ? l.number + ' · ' : '') + state),
    h('div', { class: 'acts' }, acts));
}

function renderPhone() {
  if (dtmfLine && !st.lines.some((l) => l.id === dtmfLine && l.state === 'active')) dtmfLine = 0;
  $('lines').replaceChildren(...st.lines.map(lineCard));
  renderMulti();
  renderPad();
  renderExtensions();
}

function renderMulti() {
  const box = $('multi');
  box.replaceChildren();
  const connected = st.lines.filter((l) => l.state === 'active');
  const label = (l) => `L${l.slot} ${nameFor(l.number, l.name) || l.number}`;
  if (connected.length >= 2) {
    if (st.conference.length) {
      box.append(h('button', { class: 'btn', onclick: () => send({ cmd: 'split' }) }, '✂ Konferenz trennen'));
    } else {
      box.append(h('button', { class: 'btn', onclick: () => send({ cmd: 'conference' }) }, '👥 Konferenz – alle zusammenschalten'));
    }
    if (connected.length === 2) {
      const [a, b] = connected;
      box.append(h('button', { class: 'btn green', onclick: () => send({ cmd: 'connect', a: a.id, b: b.id }), title: 'Beide Gesprächspartner werden verbunden, Sie selbst sind danach raus' },
        `⇄ ${label(a)} mit ${label(b)} verbinden`));
    } else {
      const opts = () => connected.map((l) => h('option', { value: l.id }, label(l)));
      const selA = h('select', {}, opts());
      const selB = h('select', {}, opts());
      selB.selectedIndex = 1;
      box.append(selA, selB, h('button', {
        class: 'btn green',
        onclick: () => { if (selA.value === selB.value) return toast('Zwei verschiedene Leitungen wählen'); send({ cmd: 'connect', a: Number(selA.value), b: Number(selB.value) }); }
      }, '⇄ Diese beiden verbinden'));
    }
  } else if (connected.length === 1 && st.lines.length < st.maxLines) {
    box.append(h('div', { class: 'sub' }, 'Zweite Leitung: einfach eine weitere Nummer wählen – das laufende Gespräch wird automatisch gehalten. Danach können Sie die Gesprächspartner verbinden oder eine Konferenz starten.'));
  }
  box.hidden = !box.childElementCount;
}

function tick() {
  for (const el of app.querySelectorAll('[data-since]')) el.textContent = fmtDur(Date.now() - Number(el.dataset.since));
}
setInterval(tick, 1000);

// ------------------------------------------------------------------ Wähltastatur / DTMF

function toggleDtmf(id) {
  dtmfLine = dtmfLine === id ? 0 : id;
  if (dtmfLine) $('pad').hidden = false;
  renderPhone();
}

function renderPad() {
  const l = st.lines.find((x) => x.id === dtmfLine);
  $('padHint').textContent = l ? `Tonwahl an L${l.slot} – Tasten werden direkt gesendet` : '';
}

function buildPad() {
  const keys = $('pad').querySelector('.keys');
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#']) {
    keys.append(h('button', {
      class: 'btn',
      onclick: () => {
        if (dtmfLine) send({ cmd: 'dtmf', id: dtmfLine, tones: k });
        else { const i = $('dialInput'); i.value += k; i.focus(); }
      }
    }, k));
  }
}

// ------------------------------------------------------------------ Nebenstellen

function renderExtensions() {
  const exts = extensions();
  const panel = $('extPanel');
  const mon = st.monitor || { status: 'off', calls: [] };
  panel.hidden = !exts.length && !(mon.calls || []).length;
  if (panel.hidden) return;
  $('monState').textContent = { ok: '● live', connecting: 'verbinde…', failed: mon.error || 'Monitor aus', off: '' }[mon.status] || '';

  const ringing = (mon.calls || []).filter((c) => c.state === 'ringing');
  $('ringingExt').replaceChildren(...ringing.map((c) => h('div', { class: 'ringcall' },
    h('span', {}, '🔔 ', nameFor(c.remote) || c.remote || 'Unbekannt', c.own ? h('small', { class: 'sub' }, ' → ' + c.own) : ''),
    h('button', { class: 'btn sm green', onclick: () => send({ cmd: 'pickup' }) }, '⤵ Heranholen'))));

  $('extList').replaceChildren(...exts.map((e) => {
    const call = (mon.calls || []).find((c) => c.ext !== null && String(c.ext) === e.extId && c.state !== 'ringing');
    const busy = !!call;
    const watched = !!e.extId && mon.status === 'ok';
    let sub = e.number;
    if (busy) sub = (call.state === 'dialing' ? 'wählt ' : 'spricht mit ') + (nameFor(call.remote) || call.remote || '…');
    else if (watched) sub = e.number + ' · frei';
    return h('div', { class: 'ext' + (busy ? ' busy' : ''), title: `${e.name} intern anrufen (${e.number})`, onclick: () => dial(e.number, e.name) },
      e.extId ? h('span', { class: 'dot ' + (busy ? 'err' : watched ? 'ok' : '') }) : h('span', { class: 'sub' }, '☆'),
      h('div', { class: 't' }, h('div', {}, e.name), h('div', { class: 'sub' }, sub)),
      busy ? h('span', { class: 'sub', 'data-since': call.since }, fmtDur(Date.now() - call.since)) : '');
  }));
}

// ------------------------------------------------------------------ Vorschläge (Name/Nummer)

function candidates() {
  const out = [];
  for (const e of phonebook) for (const n of e.numbers) out.push({ label: displayName(e), sub: `${NUMBER_LABELS[n.type] || ''} ${n.number}`, number: n.number, key: (displayName(e) + ' ' + (e.company || '')).toLowerCase() });
  for (const e of extensions()) out.push({ label: e.name, sub: 'intern ' + e.number, number: e.number, key: e.name.toLowerCase() });
  const seen = new Set(out.map((c) => normalizeNumber(c.number)));
  for (const c of callLog) {
    const k = normalizeNumber(c.number);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push({ label: c.name || c.number, sub: 'zuletzt ' + fmtTime(c.startedAt), number: c.number, key: (c.name || '').toLowerCase() });
  }
  return out;
}

function search(q) {
  q = q.trim().toLowerCase();
  if (q.length < 2) return [];
  const digits = normalizeNumber(q);
  return candidates().filter((c) => c.key.includes(q) || (digits.length >= 2 && normalizeNumber(c.number).includes(digits))).slice(0, 8);
}

function hideSuggest(box) { box.hidden = true; box.replaceChildren(); box._items = []; box._sel = -1; }

function wireSuggest(input, box, onPick) {
  const render = () => {
    const items = search(input.value);
    box._items = items;
    box._sel = -1;
    box.replaceChildren(...items.map((c, i) => h('div', {
      onmousedown: (ev) => { ev.preventDefault(); onPick(c); }, 'data-i': i
    }, h('span', {}, c.label), h('small', {}, c.sub))));
    box.hidden = !items.length;
  };
  input.addEventListener('input', render);
  input.addEventListener('blur', () => setTimeout(() => hideSuggest(box), 100));
  input.addEventListener('keydown', (ev) => {
    const items = box._items || [];
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (!items.length) return;
      ev.preventDefault();
      box._sel = (box._sel + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      [...box.children].forEach((el, i) => el.classList.toggle('sel', i === box._sel));
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (box._sel >= 0 && items[box._sel]) onPick(items[box._sel]);
      else if (cleanDial(input.value).replace('+', '').length) onPick({ number: input.value });
      else if (items[0]) onPick(items[0]);
    } else if (ev.key === 'Escape') {
      input.value = '';
      hideSuggest(box);
    }
  });
}

// ------------------------------------------------------------------ Weiterleiten

let xferLine = null;
function openTransfer(l) {
  xferLine = l;
  $('xferTitle').textContent = `L${l.slot} weiterleiten`;
  $('xferInput').value = '';
  $('xferDlg').showModal();
  $('xferInput').focus();
}

function doTransfer(number) {
  if (!xferLine) return;
  send({ cmd: 'transfer', id: xferLine.id, target: number });
  $('xferDlg').close();
  xferLine = null;
}

// ------------------------------------------------------------------ Telefonbuch

function renderBook() {
  const q = $('bookSearch').value.trim().toLowerCase();
  const digits = normalizeNumber(q);
  const list = phonebook
    .filter((e) => !q || displayName(e).toLowerCase().includes(q) || (e.note || '').toLowerCase().includes(q) ||
      (digits.length >= 2 && e.numbers.some((n) => normalizeNumber(n.number).includes(digits))))
    .sort((a, b) => displayName(a).localeCompare(displayName(b), 'de'));
  const box = $('bookList');
  if (!list.length) {
    box.replaceChildren(h('div', { class: 'empty' }, phonebook.length ? 'Kein Treffer' : 'Noch keine Kontakte. Mit ＋ anlegen oder importieren.'));
    return;
  }
  box.replaceChildren(...list.slice(0, 300).map((e) => h('div', { class: 'item' },
    h('div', { class: 't' },
      h('div', {}, h('b', {}, e.name || e.company), e.name && e.company ? h('span', { class: 'sub' }, ' · ' + e.company) : ''),
      e.note ? h('div', { class: 'sub' }, e.note) : '',
      h('div', { class: 'nums' }, e.numbers.map((n) => h('button', {
        class: 'btn sm', title: 'Anrufen', onclick: () => { dial(n.number, displayName(e)); showTab('phone'); }
      }, `📞 ${NUMBER_LABELS[n.type] ? NUMBER_LABELS[n.type] + ': ' : ''}${n.number}`)))),
    h('button', { class: 'icon', title: 'Als Kurzwahltaste übernehmen', onclick: () => addSpeedDial(e) }, '☆'),
    h('button', { class: 'icon', title: 'Bearbeiten', onclick: () => editContact(e) }, '✎'))));
}

async function addSpeedDial(e) {
  const n = e.numbers[0];
  if (!n) return;
  if (extensions().some((x) => x.number === cleanDial(n.number))) return toast('Ist schon eine Kurzwahltaste', 'warn');
  const text = (settings.extensions ? settings.extensions.replace(/\s*$/, '') + '\n' : '') + `${displayName(e).replace(/[=;]/g, ' ')} = ${n.number}`;
  await saveAndApply(Object.assign({}, settings, { extensions: text }));
  toast(`„${displayName(e)}“ als Kurzwahltaste übernommen`, 'ok');
}

let editing = null;
function editContact(e, preset) {
  editing = e || null;
  const f = $('contactForm').elements;
  const by = (t) => (e ? e.numbers.filter((n) => n.type === t).map((n) => n.number).join(', ') : '');
  f.name.value = e ? e.name : (preset && preset.name) || '';
  f.company.value = e ? e.company || '' : '';
  f.mobile.value = by('mobile');
  f.home.value = by('home');
  f.work.value = e ? [by('work'), by('other')].filter(Boolean).join(', ') : (preset && preset.number) || '';
  f.note.value = e ? e.note || '' : '';
  $('contactDelete').hidden = !e;
  $('contactDlg').returnValue = '';
  $('contactDlg').showModal();
}

async function saveContact(action) {
  const f = $('contactForm').elements;
  if (action === 'delete' && editing) {
    if (!confirm(`„${displayName(editing)}“ löschen?`)) return;
    phonebook = phonebook.filter((x) => x.id !== editing.id);
  } else if (action === 'save') {
    const numbers = [];
    for (const t of ['mobile', 'home', 'work']) {
      for (const n of f[t].value.split(',').map((x) => x.trim()).filter(Boolean)) numbers.push({ type: t, number: n });
    }
    if (!f.name.value.trim() && !f.company.value.trim()) return toast('Bitte Name oder Firma eingeben');
    const entry = { id: editing ? editing.id : newId(), name: f.name.value.trim(), company: f.company.value.trim(), numbers, note: f.note.value.trim() };
    phonebook = editing ? phonebook.map((x) => (x.id === editing.id ? entry : x)) : [...phonebook, entry];
  } else return;
  await chrome.storage.local.set({ phonebook });
  renderBook();
}

async function importFile(file) {
  const text = await file.text();
  let items;
  try { items = parsePhonebookFile(file.name, text); } catch (e) { return toast('Import fehlgeschlagen: ' + e.message); }
  if (!items.length) return toast('Keine Kontakte mit Telefonnummer gefunden');
  // Doppelte (gleicher Name + gleiche Nummer) überspringen
  const known = new Set(phonebook.flatMap((e) => e.numbers.map((n) => displayName(e) + '|' + normalizeNumber(n.number))));
  const fresh = items.filter((e) => !e.numbers.every((n) => known.has(displayName(e) + '|' + normalizeNumber(n.number))));
  phonebook = [...phonebook, ...fresh];
  await chrome.storage.local.set({ phonebook });
  renderBook();
  toast(`${fresh.length} Kontakte importiert` + (items.length - fresh.length ? `, ${items.length - fresh.length} schon vorhanden` : ''), 'ok');
}

function exportBook() {
  const blob = new Blob([exportCsv(phonebook)], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: 'telefonbuch.csv' });
  document.body.append(a);
  a.click();
  a.remove();
}

// ------------------------------------------------------------------ Anrufliste

const REASON_TEXT = {
  elsewhere: 'anderswo angenommen', rejected: 'abgelehnt', declined: 'abgelehnt', canceled: 'Anrufer hat aufgelegt',
  aborted: 'abgebrochen', busy: 'besetzt', 'not-found': 'nicht erreichbar', unavailable: 'nicht erreichbar',
  'no-answer': 'keine Antwort', connection: 'Verbindungsfehler', mic: 'kein Mikrofon',
  'hangup-local': 'selbst aufgelegt', 'hangup-remote': 'Gegenüber hat aufgelegt'
};

function renderHistory() {
  const filter = $('histFilter').value;
  const list = callLog.filter((c) => filter === 'all' || (filter === 'missed' ? c.missed : filter === 'elsewhere' ? c.reason === 'elsewhere' : c.direction === filter));
  const box = $('histList');
  if (!list.length) { box.replaceChildren(h('div', { class: 'empty' }, 'Keine Anrufe')); return; }
  box.replaceChildren(...list.slice(0, 200).map((c) => {
    const anon = !c.number || /^anonymous$/i.test(c.number);
    const name = anon ? 'Rufnummer unterdrückt' : nameFor(c.number, c.name);
    const why = REASON_TEXT[c.reason] || (c.missed ? 'nicht angenommen' : '');
    const dur = c.answeredAt ? fmtDur(c.endedAt - c.answeredAt) + (why ? ' · ' + why : '') : (why || 'nicht verbunden');
    const elsewhere = c.reason === 'elsewhere';
    const known = !!lookupNumber(phonebook, c.number) || /^[*#]|anonymous/i.test(c.number || '');
    return h('div', { class: 'item' + (c.missed ? ' missed' : '') },
      h('span', { class: 'dir', title: elsewhere ? 'anderswo angenommen' : c.direction === 'in' ? 'eingehend' : 'ausgehend' }, c.missed ? '✕' : elsewhere ? '⤳' : c.direction === 'in' ? '↙' : '↗'),
      h('div', { class: 't' }, h('div', {}, name || c.number || 'Unbekannt'),
        h('div', { class: 'sub' }, `${name && !anon ? c.number + ' · ' : ''}${fmtTime(c.startedAt)} · ${dur}${c.anonymous ? ' · anonym' : ''}`)),
      !known && !anon ? h('button', { class: 'icon', title: 'Ins Telefonbuch', onclick: () => editContact(null, { number: c.number, name: c.name }) }, '＋') : '',
      !anon ? h('button', { class: 'btn sm green', title: 'Zurückrufen', onclick: () => { dial(c.number, name); showTab('phone'); } }, '📞') : '');
  }));
}

// ------------------------------------------------------------------ Einstellungen

async function fillDevices() {
  let devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); } catch (e) { /* */ }
  const f = $('settingsForm').elements;
  const fill = (sel, kind, val) => {
    const opts = [h('option', { value: '' }, 'Standard')];
    devs.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .forEach((d, i) => opts.push(h('option', { value: d.deviceId }, d.label || `${kind === 'audioinput' ? 'Mikrofon' : 'Ausgabe'} ${i + 1}`)));
    sel.replaceChildren(...opts);
    sel.value = val || '';
  };
  fill(f.micId, 'audioinput', settings.micId);
  fill(f.speakerId, 'audiooutput', settings.speakerId);
  fill(f.ringId, 'audiooutput', settings.ringId);
}

function fillSettings() {
  const f = $('settingsForm');
  for (const [k, v] of Object.entries(settings)) {
    const el = f.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }
  fillDevices();
}

async function saveSettings(ev) {
  ev.preventDefault();
  const f = $('settingsForm');
  const next = Object.assign({}, settings);
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    const el = f.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') next[k] = el.checked;
    else if (k === 'lines' || k === 'ringVolume') next[k] = Number(el.value);
    else next[k] = el.value.trim();
  }
  if (next.wsUrl && !/^wss?:\/\//.test(next.wsUrl)) return toast('Gateway-Adresse muss mit ws:// oder wss:// beginnen');
  if (next.monitorUrl && !/^https?:\/\//.test(next.monitorUrl)) return toast('Monitor-Adresse muss mit http:// beginnen');
  await saveAndApply(next);
  toast('Gespeichert', 'ok');
  showTab('phone');
}

async function saveAndApply(next) {
  settings = next;
  await chrome.storage.local.set({ settings });
  send({ cmd: 'config', config: settings });
  renderHeader();
  renderPhone();
}

// ------------------------------------------------------------------ Tabs & Mini-Fenster

function showTab(name) {
  for (const b of app.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const s of app.querySelectorAll('.tab')) s.classList.toggle('on', s.id === 'tab-' + name);
  if (name === 'book') renderBook();
  if (name === 'history') { renderHistory(); chrome.runtime.sendMessage({ type: 'clear-missed' }).catch(() => {}); }
  if (name === 'settings') fillSettings();
  if (name === 'phone') setTimeout(() => $('dialInput').focus(), 0);
}

async function togglePip() {
  if (pipWin) { pipWin.close(); return; }
  if (!('documentPictureInPicture' in window)) return toast('Mini-Fenster wird von diesem Chrome nicht unterstützt (ab Version 116).');
  try {
    pipWin = await documentPictureInPicture.requestWindow({ width: 340, height: 460 });
  } catch (e) { return toast('Mini-Fenster konnte nicht geöffnet werden: ' + e.message); }
  const link = pipWin.document.createElement('link');
  link.rel = 'stylesheet';
  link.href = chrome.runtime.getURL('app.css');
  pipWin.document.head.append(link);
  pipWin.document.title = 'Telefon';
  pipWin.document.body.classList.add('pip');
  pipWin.document.body.append(app);
  document.body.classList.add('in-pip');
  document.getElementById('pipNote').hidden = false;
  pipWin.addEventListener('pagehide', () => {
    document.body.append(app);
    document.body.classList.remove('in-pip');
    document.getElementById('pipNote').hidden = true;
    pipWin = null;
  });
}

// ------------------------------------------------------------------ Start

async function init() {
  const data = await chrome.storage.local.get(['settings', 'phonebook', 'callLog', 'missed', 'lastDialed']);
  settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
  phonebook = data.phonebook || [];
  callLog = data.callLog || [];
  lastDialed = data.lastDialed || '';
  updateMissed(data.missed || 0);

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.phonebook) { phonebook = ch.phonebook.newValue || []; renderBook(); renderPhone(); }
    if (ch.callLog) { callLog = ch.callLog.newValue || []; if ($('tab-history').classList.contains('on')) renderHistory(); }
    if (ch.missed) updateMissed(ch.missed.newValue || 0);
    if (ch.settings) { settings = Object.assign({}, DEFAULT_SETTINGS, ch.settings.newValue || {}); renderHeader(); renderPhone(); }
  });

  for (const b of app.querySelectorAll('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
  for (const b of document.querySelectorAll('[data-act="pip"]')) b.addEventListener('click', togglePip);

  wireSuggest($('dialInput'), $('suggest'), (c) => dial(c.number, c.label));
  $('btnDial').addEventListener('click', () => {
    const v = $('dialInput').value;
    if (cleanDial(v).replace('+', '')) dial(v);
    else { const hit = search(v)[0]; if (hit) dial(hit.number, hit.label); else toast('Bitte eine Nummer eingeben'); }
  });
  $('btnPickup').addEventListener('click', () => send({ cmd: 'pickup' }));
  $('btnRedial').addEventListener('click', () => { if (lastDialed) dial(lastDialed); else toast('Noch keine Nummer gewählt', 'warn'); });
  $('btnPad').addEventListener('click', () => { $('pad').hidden = !$('pad').hidden; });
  $('btnDnd').addEventListener('click', () => saveAndApply(Object.assign({}, settings, { dnd: !settings.dnd })));
  $('btnWait').addEventListener('click', () => saveAndApply(Object.assign({}, settings, { callWaiting: !settings.callWaiting })));
  $('btnAnon').addEventListener('click', () => saveAndApply(Object.assign({}, settings, { anonymous: !settings.anonymous })));
  buildPad();

  wireSuggest($('xferInput'), $('xferSuggest'), (c) => doTransfer(c.number));
  $('xferOk').addEventListener('click', (ev) => { ev.preventDefault(); doTransfer($('xferInput').value); });

  $('bookSearch').addEventListener('input', renderBook);
  $('btnNewContact').addEventListener('click', () => editContact(null));
  $('contactDlg').addEventListener('close', () => saveContact($('contactDlg').returnValue));
  $('importFile').addEventListener('change', (ev) => { const f = ev.target.files[0]; if (f) importFile(f); ev.target.value = ''; });
  $('btnExport').addEventListener('click', exportBook);

  $('histFilter').addEventListener('change', renderHistory);
  $('btnClearHist').addEventListener('click', async () => {
    if (!confirm('Anrufliste wirklich leeren?')) return;
    await chrome.storage.local.set({ callLog: [], missed: 0 });
    chrome.runtime.sendMessage({ type: 'clear-missed' }).catch(() => {});
  });

  $('settingsForm').addEventListener('submit', saveSettings);
  $('btnMic').addEventListener('click', async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      send({ cmd: 'mic-recheck' });
      toast('Mikrofon freigegeben', 'ok');
    } catch (e) {
      chrome.runtime.sendMessage({ type: 'open-permission' });
    }
    fillDevices();
  });

  renderHeader();
  renderPhone();
  if (settings.wsUrl) showTab('phone'); else showTab('settings');
  connectEngine();
}

function updateMissed(n) {
  const b = $('missedBadge');
  b.textContent = n;
  b.hidden = !n;
}

init();
