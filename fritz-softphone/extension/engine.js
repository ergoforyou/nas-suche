/* Telefonie-Engine (läuft im Offscreen-Dokument).
   - meldet sich per SIP über WebSocket am Gateway an (JsSIP)
   - verwaltet mehrere Leitungen, Halten, Stumm, DTMF
   - Weiterleiten (blind) und Vermitteln (mit Rückfrage) per SIP REFER
   - lokale Dreierkonferenz: die Audiospuren werden hier im Browser gemischt */
/* global JsSIP */
'use strict';

const ports = new Set();
const lines = new Map();      // id -> Leitung
let config = Object.assign({}, DEFAULT_SETTINGS);
let ua = null;
let reg = { status: 'connecting', error: '' };
let mic = 'unknown';          // granted | prompt | denied | unknown
let nextId = 1;
let conf = null;              // { members:Set<id>, stream, src, gain, muted }
let audioCtx = null;
let retryTimer = null;
let pendingName = '';
let monitor = { status: 'off', error: '', calls: [] };
let monitorSrc = null;

// ------------------------------------------------------------------ Zustand

function publicLine(l) {
  return {
    id: l.id, slot: l.slot, number: l.number, name: l.name, direction: l.direction,
    state: l.state, createdAt: l.createdAt, answeredAt: l.answeredAt,
    held: l.held, remoteHeld: l.remoteHeld, muted: conf && conf.members.has(l.id) ? conf.muted : l.muted,
    inConference: !!(conf && conf.members.has(l.id))
  };
}

function snapshot() {
  return {
    reg, mic, maxLines: config.lines, dnd: config.dnd, pickupCode: config.pickupCode,
    lines: [...lines.values()].sort((a, b) => a.slot - b.slot).map(publicLine),
    conference: conf ? [...conf.members] : [],
    monitor
  };
}

function broadcast() {
  const msg = { type: 'state', state: snapshot() };
  for (const p of ports) { try { p.postMessage(msg); } catch (e) { ports.delete(p); } }
}

function toast(text, level = 'error') {
  for (const p of ports) { try { p.postMessage({ type: 'toast', text, level }); } catch (e) { /* */ } }
}

function toBackground(msg) { chrome.runtime.sendMessage(msg).catch(() => {}); }

// ------------------------------------------------------------------ Audio

function ctx() {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

function audioConstraints() {
  const a = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (config.micId) a.deviceId = { ideal: config.micId };
  return { audio: a, video: false };
}

function applySink(el, deviceId) {
  if (el && el.setSinkId) el.setSinkId(deviceId || '').catch(() => {});
}

async function checkMic() {
  try {
    const st = await navigator.permissions.query({ name: 'microphone' });
    mic = st.state;
    st.onchange = () => { mic = st.state; broadcast(); };
  } catch (e) { mic = 'unknown'; }
  broadcast();
}

// Töne (Klingeln, Anklopfen, Freizeichen) über WebAudio
const tones = { ring: null, wait: null, back: null };
let ringEl = null;
let ringDest = null;

function burst(dest, freqs, dur, vol) {
  const c = ctx();
  const g = c.createGain();
  g.gain.setValueAtTime(0, c.currentTime);
  g.gain.linearRampToValueAtTime(vol, c.currentTime + 0.02);
  g.gain.setValueAtTime(vol, c.currentTime + dur - 0.03);
  g.gain.linearRampToValueAtTime(0, c.currentTime + dur);
  g.connect(dest);
  for (const f of freqs) {
    const o = c.createOscillator();
    o.frequency.value = f;
    o.connect(g);
    o.start();
    o.stop(c.currentTime + dur + 0.05);
  }
}

function startTone(kind) {
  if (tones[kind]) return;
  const c = ctx();
  if (!ringDest) {
    ringDest = c.createMediaStreamDestination();
    ringEl = new Audio();
    ringEl.srcObject = ringDest.stream;
    ringEl.play().catch(() => {});
  }
  applySink(ringEl, kind === 'ring' ? (config.ringId || config.speakerId) : config.speakerId);
  const vol = kind === 'ring' ? Math.max(0.05, Math.min(1, config.ringVolume)) * 0.5 : 0.15;
  const play = {
    ring: () => { burst(ringDest, [660, 880], 0.4, vol); setTimeout(() => tones.ring && burst(ringDest, [660, 880], 0.4, vol), 600); },
    wait: () => burst(ringDest, [425], 0.2, vol),
    back: () => burst(ringDest, [425], 1.0, vol)
  }[kind];
  play();
  tones[kind] = setInterval(play, kind === 'ring' ? 3000 : kind === 'wait' ? 4000 : 5000);
}

function stopTone(kind) {
  if (tones[kind]) { clearInterval(tones[kind]); tones[kind] = null; }
}

function updateTones() {
  const ringingIn = [...lines.values()].some((l) => l.state === 'incoming');
  const talking = [...lines.values()].some((l) => l.state === 'active' && !l.held);
  if (ringingIn && !talking) { stopTone('wait'); startTone('ring'); }
  else if (ringingIn && talking) { stopTone('ring'); startTone('wait'); }
  else { stopTone('ring'); stopTone('wait'); }
  const back = [...lines.values()].some((l) => l.state === 'ringback' && !l.earlyMedia);
  if (back) startTone('back'); else stopTone('back');
}

// ------------------------------------------------------------------ SIP

function wsHost() {
  try { return new URL(config.wsUrl).hostname; } catch (e) { return ''; }
}

function stopUA() {
  clearTimeout(retryTimer);
  if (ua) {
    const old = ua;
    ua = null;
    try { old.removeAllListeners(); old.stop(); } catch (e) { /* */ }
  }
}

function startUA() {
  stopUA();
  const host = wsHost();
  if (!config.wsUrl || !host || !config.user || !config.password) {
    reg = { status: 'unconfigured', error: 'Bitte Gateway-Adresse und Zugangsdaten eintragen.' };
    broadcast();
    return;
  }
  let u;
  try {
    u = new JsSIP.UA({
      sockets: [new JsSIP.WebSocketInterface(config.wsUrl)],
      uri: `sip:${config.user}@${host}`,
      password: config.password,
      display_name: config.displayName || undefined,
      register: true,
      register_expires: 300,
      session_timers: false,
      user_agent: 'Fritz Browser-Telefon',
      connection_recovery_min_interval: 2,
      connection_recovery_max_interval: 30,
      no_answer_timeout: 180
    });
  } catch (e) {
    reg = { status: 'failed', error: 'Ungültige Einstellung: ' + e.message };
    broadcast();
    return;
  }
  ua = u;
  const mine = (fn) => (...a) => { if (ua === u) fn(...a); };
  u.on('connecting', mine(() => { if (reg.status !== 'registered') { reg = { status: 'connecting', error: '' }; broadcast(); } }));
  u.on('connected', mine(() => { reg = { status: 'connecting', error: 'Verbunden, Anmeldung läuft…' }; broadcast(); }));
  u.on('disconnected', mine(() => { reg = { status: 'failed', error: 'Gateway nicht erreichbar – neuer Versuch läuft automatisch.' }; broadcast(); }));
  u.on('registered', mine(() => { reg = { status: 'registered', error: '' }; broadcast(); }));
  u.on('unregistered', mine(() => { reg = { status: 'connecting', error: 'Abgemeldet' }; broadcast(); }));
  u.on('registrationFailed', mine((e) => {
    const auth = e.cause === JsSIP.C.causes.AUTHENTICATION_ERROR || e.cause === JsSIP.C.causes.REJECTED;
    reg = { status: 'failed', error: auth ? 'Anmeldung abgelehnt – Benutzername/Passwort prüfen.' : 'Anmeldung fehlgeschlagen: ' + e.cause };
    broadcast();
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (ua === u && u.isConnected()) u.register(); }, 30000);
  }));
  u.on('newRTCSession', mine(onNewSession));
  u.start();
}

// Wachhund: falls die Anmeldung unbemerkt verloren geht
setInterval(() => {
  if (ua && ua.isConnected() && !ua.isRegistered() && reg.status !== 'failed') ua.register();
}, 60000);

function freeSlot() {
  const used = new Set([...lines.values()].map((l) => l.slot));
  for (let i = 1; i <= config.lines; i++) if (!used.has(i)) return i;
  return 0;
}

function callOptions() {
  return {
    mediaConstraints: audioConstraints(),
    pcConfig: { iceServers: [] },
    rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false }
  };
}

function onNewSession(e) {
  const s = e.session;
  const incoming = e.originator === 'remote';
  const slot = freeSlot();
  if (incoming && (!slot || config.dnd)) {
    s.terminate({ status_code: 486, reason_phrase: 'Busy Here' });
    return;
  }
  const remote = s.remote_identity;
  const l = {
    id: nextId++,
    slot: slot || 99,
    session: s,
    number: remote && remote.uri ? decodeURIComponent(remote.uri.user || '') : '',
    name: incoming ? (remote && remote.display_name) || '' : pendingName,
    direction: incoming ? 'in' : 'out',
    state: incoming ? 'incoming' : 'dialing',
    createdAt: Date.now(),
    answeredAt: 0,
    held: false, remoteHeld: false, muted: false, earlyMedia: false,
    audio: null, remoteStream: null, localTrack: null, remoteSrc: null, dest: null
  };
  pendingName = '';
  if (l.name === l.number) l.name = '';
  lines.set(l.id, l);
  attach(l);
  if (incoming) toBackground({ type: 'incoming', line: publicLine(l) });
  updateTones();
  broadcast();
}

function attach(l) {
  const s = l.session;
  const hookPc = (pc) => {
    pc.addEventListener('track', (ev) => {
      const stream = ev.streams && ev.streams[0] ? ev.streams[0] : new MediaStream([ev.track]);
      l.remoteStream = stream;
      if (!l.audio) {
        l.audio = new Audio();
        l.audio.autoplay = true;
        document.body.appendChild(l.audio);
      }
      l.audio.srcObject = stream;
      applySink(l.audio, config.speakerId);
      l.audio.play().catch(() => {});
    });
  };
  if (s.connection) hookPc(s.connection);
  else s.on('peerconnection', (ev) => hookPc(ev.peerconnection));

  // ICE-Sammlung nicht ewig abwarten (VPN-Adapter etc. bremsen sonst bis zu 40 s)
  let iceTimer = null;
  s.on('icecandidate', (ev) => {
    clearTimeout(iceTimer);
    iceTimer = setTimeout(() => { try { ev.ready(); } catch (x) { /* */ } }, 700);
  });

  s.on('progress', (ev) => {
    if (l.direction === 'out') {
      l.state = 'ringback';
      if (ev.response && ev.response.body) l.earlyMedia = true;
      updateTones();
      broadcast();
    }
  });
  s.on('accepted', () => { markActive(l); });
  s.on('confirmed', () => { markActive(l); });
  s.on('hold', (ev) => { if (ev.originator === 'local') l.held = true; else l.remoteHeld = true; updateTones(); broadcast(); });
  s.on('unhold', (ev) => { if (ev.originator === 'local') l.held = false; else l.remoteHeld = false; updateTones(); broadcast(); });
  s.on('muted', () => { l.muted = true; broadcast(); });
  s.on('unmuted', () => { l.muted = false; broadcast(); });
  s.on('ended', (ev) => finish(l, ev.cause));
  s.on('failed', (ev) => finish(l, ev.cause));
}

function markActive(l) {
  if (l.state === 'active') return;
  l.state = 'active';
  l.answeredAt = l.answeredAt || Date.now();
  const pc = l.session.connection;
  const sender = pc && pc.getSenders().find((x) => x.track && x.track.kind === 'audio');
  if (sender) l.localTrack = sender.track;
  toBackground({ type: 'incoming-end', id: l.id });
  updateTones();
  broadcast();
}

function finish(l, cause) {
  if (!lines.has(l.id)) return;
  if (conf && conf.members.has(l.id)) leaveConference(l, true);
  lines.delete(l.id);
  if (l.audio) { l.audio.srcObject = null; l.audio.remove(); }
  if (l.remoteSrc) { try { l.remoteSrc.disconnect(); } catch (e) { /* */ } }
  toBackground({ type: 'incoming-end', id: l.id });
  const C = JsSIP.C.causes;
  const missed = l.direction === 'in' && !l.answeredAt && !l.rejected;
  toBackground({
    type: 'call-log',
    entry: {
      id: newId(), number: l.number, name: l.name, direction: l.direction,
      startedAt: l.createdAt, answeredAt: l.answeredAt, endedAt: Date.now(), missed, cause: cause || ''
    }
  });
  if (l.direction === 'out' && !l.answeredAt && cause && cause !== C.CANCELED) {
    const text = {
      [C.BUSY]: 'Besetzt', [C.REJECTED]: 'Abgelehnt', [C.NOT_FOUND]: 'Nummer nicht erreichbar',
      [C.UNAVAILABLE]: 'Nicht erreichbar', [C.USER_DENIED_MEDIA_ACCESS]: 'Kein Zugriff aufs Mikrofon',
      [C.CONNECTION_ERROR]: 'Keine Verbindung zum Gateway', [C.NO_ANSWER]: 'Keine Antwort'
    }[cause] || cause;
    toast(`${l.number}: ${text}`, 'warn');
  }
  updateTones();
  broadcast();
}

// ------------------------------------------------------------------ Aktionen

function get(id) {
  const l = lines.get(Number(id));
  if (!l) throw new Error('Leitung nicht gefunden');
  return l;
}

/** Alle anderen laufenden Gespräche halten (wie am Tischtelefon). */
function holdOthers(exceptId) {
  const keepConf = conf && conf.members.has(exceptId);
  for (const l of lines.values()) {
    if (l.id === exceptId || l.state !== 'active' || l.held) continue;
    if (keepConf && conf.members.has(l.id)) continue;
    try { l.session.hold(); } catch (e) { /* */ }
  }
}

function call(number, name) {
  number = cleanDial(number);
  if (!number) throw new Error('Keine Nummer');
  if (!ua || !ua.isRegistered()) throw new Error('Nicht angemeldet – Verbindung prüfen.');
  if (!freeSlot()) throw new Error('Alle Leitungen belegt');
  if (mic === 'denied' || mic === 'prompt') throw new Error('Bitte zuerst das Mikrofon freigeben.');
  holdOthers(-1);
  pendingName = name || '';
  ua.call(number, callOptions());
}

function answer(id) {
  const l = get(id);
  if (l.state !== 'incoming') return;
  if (mic === 'denied' || mic === 'prompt') throw new Error('Bitte zuerst das Mikrofon freigeben.');
  holdOthers(l.id);
  l.session.answer(callOptions());
}

function hangup(id) {
  const l = get(id);
  if (l.state === 'incoming') {
    l.rejected = true;
    l.session.terminate({ status_code: 486, reason_phrase: 'Busy Here' });
  } else {
    l.session.terminate();
  }
}

function hold(id, on) {
  const l = get(id);
  if (l.state !== 'active') return;
  const group = conf && conf.members.has(l.id) ? [...conf.members].map(get) : [l];
  if (on) group.forEach((g) => { if (!g.held) g.session.hold(); });
  else {
    holdOthers(l.id);
    group.forEach((g) => { if (g.held) g.session.unhold(); });
  }
}

function mute(id) {
  const l = get(id);
  if (conf && conf.members.has(l.id)) {
    conf.muted = !conf.muted;
    conf.gain.gain.value = conf.muted ? 0 : 1;
    broadcast();
    return;
  }
  if (l.session.isMuted().audio) l.session.unmute({ audio: true });
  else l.session.mute({ audio: true });
}

function dtmf(id, tones) {
  const l = get(id);
  if (l.state !== 'active') return;
  l.session.sendDTMF(String(tones), { transportType: 'RFC2833', duration: 120, interToneGap: 80 });
}

/** Nach erfolgreichem REFER legt der Vermittelnde selbst auf (RFC 5589). */
function referHandlers(label, ...toDrop) {
  const drop = () => setTimeout(() => {
    for (const l of toDrop) if (lines.has(l.id)) { try { l.session.terminate(); } catch (e) { /* */ } }
  }, 300);
  return {
    eventHandlers: {
      requestFailed: () => toast(`${label} fehlgeschlagen (Gegenstelle lehnt ab)`),
      failed: () => toast(`${label} fehlgeschlagen – Ziel nicht erreicht`),
      accepted: () => { toast(`${label} erfolgreich`, 'ok'); drop(); }
    }
  };
}

/** Blind weiterleiten: Gesprächspartner auf Leitung id wird an "target" übergeben. */
function transfer(id, target) {
  const l = get(id);
  const number = cleanDial(target);
  if (!number) throw new Error('Keine Zielnummer');
  if (l.state !== 'active') throw new Error('Nur aktive Gespräche können weitergeleitet werden');
  if (conf && conf.members.has(l.id)) leaveConference(l);
  l.session.refer(number, referHandlers('Weiterleiten', l));
}

/** Vermitteln: die Gesprächspartner von Leitung a und b miteinander verbinden, man selbst ist raus. */
function connectLines(aId, bId) {
  const a = get(aId);
  const b = get(bId);
  if (a.state !== 'active' || b.state !== 'active') throw new Error('Beide Leitungen müssen verbunden sein');
  if (conf) dissolveConference();
  a.session.refer(b.session.remote_identity.uri, Object.assign(referHandlers('Vermitteln', a, b), { replaces: b.session }));
}

// ---------- Konferenz (lokal gemischt) ----------

/** Eingehende Audiospur direkt vom Empfänger – bleibt auch nach Halten/Fortsetzen gültig */
function remoteTrack(l) {
  const pc = l.session.connection;
  const r = pc && pc.getReceivers().find((x) => x.track && x.track.kind === 'audio');
  return r ? r.track : null;
}

function senderOf(l) {
  const pc = l.session.connection;
  return pc && pc.getSenders().find((x) => !x.track || x.track.kind === 'audio');
}

async function startConference(ids) {
  const members = (ids && ids.length ? ids.map(get) : [...lines.values()]).filter((l) => l.state === 'active');
  if (members.length < 2) throw new Error('Für eine Konferenz braucht es mindestens zwei verbundene Gespräche');
  if (members.some((l) => !remoteTrack(l))) throw new Error('Audio noch nicht bereit – bitte kurz warten');
  const c = ctx();
  if (!conf) {
    const stream = await navigator.mediaDevices.getUserMedia(audioConstraints());
    const src = c.createMediaStreamSource(stream);
    const gain = c.createGain();
    src.connect(gain);
    conf = { members: new Set(), stream, src, gain, muted: false };
  }
  members.forEach((l) => conf.members.add(l.id));
  for (const l of members) {
    if (l.held) l.session.unhold();
    if (l.session.isMuted().audio) l.session.unmute({ audio: true });
  }
  rewire();
  broadcast();
}

function rewire() {
  const c = ctx();
  const members = [...conf.members].map((id) => lines.get(id)).filter(Boolean);
  try { conf.gain.disconnect(); } catch (e) { /* */ }
  for (const l of members) {
    if (!l.remoteSrc) l.remoteSrc = c.createMediaStreamSource(new MediaStream([remoteTrack(l)]));
    else { try { l.remoteSrc.disconnect(); } catch (e) { /* */ } }
    if (!l.dest) l.dest = c.createMediaStreamDestination();
  }
  for (const l of members) {
    conf.gain.connect(l.dest);
    for (const o of members) if (o !== l) o.remoteSrc.connect(l.dest);
    const sender = senderOf(l);
    const track = l.dest.stream.getAudioTracks()[0];
    if (sender && sender.track !== track) sender.replaceTrack(track).catch(() => {});
  }
}

function leaveConference(l, ended) {
  conf.members.delete(l.id);
  if (!ended && l.localTrack) {
    const sender = senderOf(l);
    if (sender) sender.replaceTrack(l.localTrack).catch(() => {});
  }
  if (l.remoteSrc) { try { l.remoteSrc.disconnect(); } catch (e) { /* */ } }
  if (conf.members.size < 2) dissolveConference();
  else rewire();
}

function dissolveConference() {
  if (!conf) return;
  const c = conf;
  conf = null;
  for (const id of c.members) {
    const l = lines.get(id);
    if (!l) continue;
    if (l.remoteSrc) { try { l.remoteSrc.disconnect(); } catch (e) { /* */ } }
    const sender = senderOf(l);
    if (sender && l.localTrack) sender.replaceTrack(l.localTrack).catch(() => {});
  }
  try { c.gain.disconnect(); c.src.disconnect(); } catch (e) { /* */ }
  c.stream.getTracks().forEach((t) => t.stop());
  // Wie am Tischtelefon: nach dem Trennen bleibt ein Gespräch aktiv, der Rest wird gehalten
  const rest = [...c.members].map((id) => lines.get(id)).filter((l) => l && l.state === 'active');
  rest.slice(1).forEach((l) => { try { l.session.hold(); } catch (e) { /* */ } });
  broadcast();
}

// ------------------------------------------------------------------ Nebenstellen-Monitor

function startMonitor() {
  if (monitorSrc) { monitorSrc.close(); monitorSrc = null; }
  if (!config.monitorUrl) { monitor = { status: 'off', error: '', calls: [] }; return; }
  let url;
  try {
    const u = new URL(config.monitorUrl);
    const token = u.searchParams.get('token');
    url = new URL('/events', u);
    if (token) url.searchParams.set('token', token);
  } catch (e) {
    monitor = { status: 'failed', error: 'Ungültige Monitor-Adresse', calls: [] };
    return;
  }
  monitor = { status: 'connecting', error: '', calls: [] };
  const src = new EventSource(url.toString());
  monitorSrc = src;
  src.addEventListener('state', (ev) => {
    if (monitorSrc !== src) return;
    try {
      const d = JSON.parse(ev.data);
      monitor = { status: d.connected ? 'ok' : 'failed', error: d.error || '', calls: d.calls || [] };
    } catch (e) { /* */ }
    broadcast();
  });
  // EventSource verbindet sich selbstständig neu
  src.onerror = () => {
    if (monitorSrc !== src) return;
    monitor = { status: 'failed', error: 'Monitor nicht erreichbar', calls: [] };
    broadcast();
  };
}

// ------------------------------------------------------------------ Konfiguration

function applyConfig(next) {
  const old = config;
  config = Object.assign({}, DEFAULT_SETTINGS, next || {});
  config.lines = Math.max(1, Math.min(8, Number(config.lines) || 3));
  const conn = ['wsUrl', 'user', 'password', 'displayName'];
  if (!ua || conn.some((k) => old[k] !== config[k])) startUA();
  if (!monitorSrc || old.monitorUrl !== config.monitorUrl) startMonitor();
  for (const l of lines.values()) applySink(l.audio, config.speakerId);
  broadcast();
}

// ------------------------------------------------------------------ Befehle

async function handle(msg) {
  switch (msg.cmd) {
    case 'hello': break;
    case 'config': applyConfig(msg.config); break;
    case 'call': call(msg.number, msg.name); break;
    case 'pickup': call(config.pickupCode || '*09', 'Heranholen'); break;
    case 'answer': answer(msg.id); break;
    case 'hangup': hangup(msg.id); break;
    case 'hold': hold(msg.id, true); break;
    case 'unhold': hold(msg.id, false); break;
    case 'mute': mute(msg.id); break;
    case 'dtmf': dtmf(msg.id, msg.tones); break;
    case 'transfer': transfer(msg.id, msg.target); break;
    case 'connect': connectLines(msg.a, msg.b); break;
    case 'conference': await startConference(msg.ids); break;
    case 'split': dissolveConference(); break;
    case 'mic-recheck': await checkMic(); break;
    case 'reconnect': startUA(); break;
    default: return;
  }
}

function run(msg) {
  Promise.resolve().then(() => handle(msg)).catch((e) => toast(e.message || String(e))).finally(broadcast);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ui') return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(run);
  port.postMessage({ type: 'state', state: snapshot() });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.target === 'engine') run(msg);
});

(async function init() {
  await checkMic();
  try {
    const s = await chrome.runtime.sendMessage({ type: 'get-config' });
    applyConfig(s);
  } catch (e) {
    applyConfig({});
  }
})();
