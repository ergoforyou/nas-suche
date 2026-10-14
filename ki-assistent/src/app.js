import { Avatar, detectFace, loadImage } from './avatar.js';
import { SpeechInput } from './stt.js';
import { SpeechOutput, SentenceSplitter, PIPER_VOICES } from './tts.js';

const $ = (id) => document.getElementById(id);
const desktop = window.desktop;

// ---------------------------------------------------------------- Daten
const DEFAULT_AVATAR = {
  image: 'default-avatar.svg',
  mouth: { x: 0.5, y: 0.4625, w: 0.1 },
  eyes: [
    { x: 0.4367, y: 0.3625, r: 0.03 },
    { x: 0.5633, y: 0.3625, r: 0.03 },
  ],
  motion: 1,
};

const newId = () => Math.random().toString(36).slice(2, 10);

function defaultPersona() {
  return {
    id: newId(),
    name: 'Max',
    prompt:
      'Du bist Max, ein freundlicher, hilfsbereiter Assistent, der hinter seinem Schreibtisch sitzt. ' +
      'Du sprichst locker, aber kompetent, und duzt dein Gegenüber.',
    greeting: 'Hallo! Ich bin Max. Was kann ich für dich tun?',
    avatar: structuredClone(DEFAULT_AVATAR),
    voice: { engine: 'piper', piperVoice: 'de_DE-thorsten-medium', systemVoice: '', rate: 1 },
  };
}

const DEFAULT_SETTINGS = {
  baseUrl: 'http://localhost:1234',
  model: '',
  temperature: 0.7,
  historyLimit: 20,
  speak: true,
  sttModel: 'onnx-community/whisper-base',
  sttLang: 'german',
  handsFree: false,
  sensitivity: 0.015,
  alwaysOnTop: false,
  stageHeight: null,
};

const SPEECH_RULES =
  'Deine Antworten werden laut vorgelesen. Antworte deshalb natürlich und gesprächig, meist in ' +
  'wenigen Sätzen, ohne Markdown, Listen, Tabellen oder Emojis – außer du wirst ausdrücklich darum gebeten.';

const state = {
  settings: { ...DEFAULT_SETTINGS },
  personas: [],
  activeId: null,
  history: {},
  busy: false,
  currentChatId: null,
};

const persona = () => state.personas.find((p) => p.id === state.activeId) ?? state.personas[0];
const history = () => (state.history[persona().id] ??= []);

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    desktop.saveData({
      settings: state.settings,
      personas: state.personas,
      activeId: state.activeId,
      history: state.history,
    });
  }, 300);
}

function friendlyError(e) {
  const msg = String(e?.message ?? e);
  if (/fetch|network|ERR_/i.test(msg)) {
    return 'Modell-Download fehlgeschlagen. Beim ersten Benutzen wird einmalig eine Internetverbindung benötigt.';
  }
  return msg;
}

// ---------------------------------------------------------------- Bausteine
const avatar = new Avatar($('avatar'));
const status = (text) => ($('status').textContent = text ?? '');

const tts = new SpeechOutput({
  onLevel: (v) => avatar.setLevel(v),
  onSpeakingChange: (on) => {
    avatar.speaking = on;
    updateBadge();
    if (!on) maybeListenHandsFree();
  },
  onStatus: (text) => status(/fehler/i.test(text) && /fetch/i.test(text) ? friendlyError(text) : text),
});

const stt = new SpeechInput({
  onLevel: (v) => {
    $('micMeter').style.width = Math.min(100, (v / (state.settings.sensitivity * 4)) * 100) + '%';
  },
});

function applyVoice() {
  const p = persona();
  tts.configure({ ...p.voice });
  stt.model = state.settings.sttModel;
  stt.language = state.settings.sttLang;
}

function applyPersona() {
  const p = persona();
  $('titleName').textContent = p.name || 'KI-Assistent';
  document.title = p.name || 'KI-Assistent';
  avatar.setConfig(p.avatar).catch((e) => status(e.message));
  applyVoice();
  renderChat();
}

// ---------------------------------------------------------------- Chat-Anzeige
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function formatText(text) {
  return escapeHtml(text)
    .replace(/```([\s\S]*?)```/g, '<code>$1</code>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}

function addBubble(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = formatText(text);
  $('chat').appendChild(div);
  $('chat').scrollTop = $('chat').scrollHeight;
  return div;
}

function renderChat() {
  $('chat').innerHTML = '';
  const h = history();
  if (!h.length && persona().greeting) addBubble('assistant', persona().greeting);
  for (const m of h) addBubble(m.role, m.content);
}

function updateBadge() {
  const b = $('stateBadge');
  let text = '';
  b.className = 'state-badge';
  if (stt.listening) {
    text = '● hört zu …';
    b.classList.add('listening');
  } else if (state.transcribing) text = 'versteht …';
  else if (avatar.thinking) text = 'denkt nach …';
  else if (avatar.speaking) text = 'spricht …';
  else if (state.settings.handsFree) text = 'bereit – sprich einfach';
  b.textContent = text;
  b.hidden = !text;
  avatar.listening = stt.listening;
  $('btnMic').classList.toggle('listening', stt.listening);
  $('btnMic').classList.toggle('busy', !!state.transcribing);
  $('btnMic').classList.toggle('handsfree', state.settings.handsFree);
}

// ---------------------------------------------------------------- LM Studio
function buildMessages() {
  const p = persona();
  const sys = `${p.prompt || ''}\n\nDein Name ist ${p.name}. ${SPEECH_RULES}`.trim();
  const h = history().slice(-state.settings.historyLimit);
  return [{ role: 'system', content: sys }, ...h];
}

/** Entfernt <think>…</think>-Abschnitte von Reasoning-Modellen aus dem Stream. */
class ThinkFilter {
  constructor() {
    this.inThink = false;
    this.buf = '';
  }
  push(text) {
    this.buf += text;
    let out = '';
    for (;;) {
      if (this.inThink) {
        const end = this.buf.indexOf('</think>');
        if (end < 0) {
          this.buf = this.buf.slice(-8);
          return out;
        }
        this.buf = this.buf.slice(end + 8);
        this.inThink = false;
      } else {
        const start = this.buf.indexOf('<think>');
        if (start < 0) {
          // mögliche angefangene Tags zurückhalten
          const keep = this.buf.lastIndexOf('<');
          if (keep >= 0 && keep > this.buf.length - 8) {
            out += this.buf.slice(0, keep);
            this.buf = this.buf.slice(keep);
          } else {
            out += this.buf;
            this.buf = '';
          }
          return out;
        }
        out += this.buf.slice(0, start);
        this.buf = this.buf.slice(start + 7);
        this.inThink = true;
      }
    }
  }
  flush() {
    const rest = this.inThink ? '' : this.buf;
    this.buf = '';
    return rest;
  }
}

async function ensureModel() {
  if (state.settings.model) return state.settings.model;
  const models = await desktop.listModels(state.settings.baseUrl);
  const chat = models.filter((m) => !/embed/i.test(m));
  if (!chat.length) throw new Error('In LM Studio ist kein Modell geladen.');
  state.settings.model = chat[0];
  save();
  return chat[0];
}

async function send(text) {
  text = text.trim();
  if (!text || state.busy) return;
  tts.stop();
  state.busy = true;
  setBusyUi(true);

  history().push({ role: 'user', content: text });
  addBubble('user', text);
  save();

  const bubble = addBubble('assistant', '');
  bubble.classList.add('typing');
  avatar.thinking = true;
  updateBadge();

  let answer = '';
  const think = new ThinkFilter();
  const speak = state.settings.speak;
  const splitter = new SentenceSplitter((s) => speak && tts.enqueue(s));

  const finish = (error) => {
    const rest = think.flush();
    answer += rest;
    splitter.push(rest);
    splitter.flush();
    bubble.classList.remove('typing');
    avatar.thinking = false;
    answer = answer.trim();
    if (answer) {
      bubble.innerHTML = formatText(answer);
      history().push({ role: 'assistant', content: answer });
      save();
    } else bubble.remove();
    if (error) addBubble('error', error);
    state.busy = false;
    state.currentChatId = null;
    setBusyUi(false);
    updateBadge();
    maybeListenHandsFree();
  };

  let model;
  try {
    model = await ensureModel();
  } catch (e) {
    return finish(
      `Keine Verbindung zu LM Studio (${state.settings.baseUrl}). Läuft der lokale Server? – ${e.message}`,
    );
  }

  const id = newId();
  state.currentChatId = id;
  desktop.chat(
    { id, baseUrl: state.settings.baseUrl, model, messages: buildMessages(), temperature: state.settings.temperature },
    (ev) => {
      if (ev.type === 'delta') {
        const visible = think.push(ev.payload);
        if (!visible) return;
        if (avatar.thinking && visible.trim()) avatar.thinking = false;
        answer += visible;
        bubble.innerHTML = formatText(answer.trimStart());
        $('chat').scrollTop = $('chat').scrollHeight;
        splitter.push(visible);
        updateBadge();
      } else if (ev.type === 'error') finish(ev.payload);
      else finish();
    },
  );
}

function setBusyUi(busy) {
  $('btnSend').hidden = busy;
  $('btnStop').hidden = !busy && !tts.speaking;
}

function stopAll() {
  if (state.currentChatId) desktop.abortChat(state.currentChatId);
  tts.stop();
  stt.cancel();
  $('btnStop').hidden = true;
}

// ---------------------------------------------------------------- Spracheingabe
// Typische Whisper-"Halluzinationen" bei Stille herausfiltern.
const NOISE = [/^untertitel/i, /^vielen dank( fürs zuschauen)?[.!]*$/i, /^\W*$/, /^\[.*\]$/, /^\(.*\)$/, /amara\.org/i];

async function listenOnce({ handsFree = false } = {}) {
  if (state.micActive) return;
  state.micActive = true;
  try {
    const p = stt.listen({ waitForSpeech: handsFree, threshold: state.settings.sensitivity });
    updateBadge();
    const audio = await p;
    updateBadge();
    if (!audio || audio.length < 16000 * 0.35) return;
    state.transcribing = true;
    updateBadge();
    const text = await stt.transcribe(audio, progressStatus('Spracherkennung'));
    status('');
    state.transcribing = false;
    updateBadge();
    if (!text || NOISE.some((r) => r.test(text.trim()))) return;
    await send(text);
  } catch (e) {
    state.transcribing = false;
    updateBadge();
    addBubble('error', `Mikrofon/Spracherkennung: ${friendlyError(e)}`);
    if (state.settings.handsFree) setHandsFree(false);
  } finally {
    state.micActive = false;
    updateBadge();
    maybeListenHandsFree();
  }
}

function maybeListenHandsFree() {
  if (!state.settings.handsFree) return;
  setTimeout(() => {
    if (state.settings.handsFree && !state.busy && !tts.speaking && !state.micActive) {
      listenOnce({ handsFree: true });
    }
  }, 350);
}

function setHandsFree(on) {
  state.settings.handsFree = on;
  $('sHandsFree').checked = on;
  save();
  if (on) maybeListenHandsFree();
  else stt.cancel();
  updateBadge();
}

function progressStatus(label) {
  const files = {};
  return (p) => {
    if (p.status === 'progress' && p.file) {
      files[p.file] = p.progress ?? 0;
      const vals = Object.values(files);
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      status(`${label}: Modell wird geladen … ${Math.round(avg)} % (nur beim ersten Mal)`);
    } else if (p.status === 'ready') status('');
  };
}

$('btnMic').onclick = () => {
  if (stt.listening) return stt.stop();
  if (state.micActive) return;
  tts.stop();
  listenOnce();
};

// ---------------------------------------------------------------- Eingabe & Fenster
const input = $('input');
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const t = input.value;
    input.value = '';
    autoGrow();
    send(t);
  }
});
const autoGrow = () => {
  input.style.height = 'auto';
  input.style.height = Math.min(140, input.scrollHeight) + 'px';
};
input.addEventListener('input', autoGrow);
$('btnSend').onclick = () => {
  const t = input.value;
  input.value = '';
  autoGrow();
  send(t);
};
$('btnStop').onclick = stopAll;
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.code === 'Space') {
    e.preventDefault();
    $('btnMic').click();
  }
  if (e.key === 'Escape') {
    if (!$('drawer').hidden) $('drawer').hidden = true;
    else stopAll();
  }
});
setInterval(() => {
  $('btnStop').hidden = !(state.busy || tts.speaking);
}, 250);

$('btnMin').onclick = () => desktop.minimize();
$('btnClose').onclick = () => desktop.close();
$('btnPin').onclick = () => {
  state.settings.alwaysOnTop = !state.settings.alwaysOnTop;
  desktop.setAlwaysOnTop(state.settings.alwaysOnTop);
  $('btnPin').classList.toggle('active', state.settings.alwaysOnTop);
  save();
};

// Bühnenhöhe per Ziehen ändern
$('stageResize').addEventListener('pointerdown', (e) => {
  const startY = e.clientY;
  const startH = $('stage').getBoundingClientRect().height;
  const move = (ev) => {
    const h = Math.max(120, Math.min(window.innerHeight - 200, startH + ev.clientY - startY));
    document.documentElement.style.setProperty('--stage-h', h + 'px');
    state.settings.stageHeight = h;
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    save();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

// ---------------------------------------------------------------- Einstellungen
$('btnSettings').onclick = () => {
  $('drawer').hidden = !$('drawer').hidden;
  if (!$('drawer').hidden) fillSettings();
};
$('btnCloseDrawer').onclick = () => ($('drawer').hidden = true);
$('tabs').onclick = (e) => {
  const tab = e.target.dataset?.tab;
  if (!tab) return;
  for (const b of $('tabs').children) b.classList.toggle('active', b.dataset.tab === tab);
  for (const t of document.querySelectorAll('.tab')) t.hidden = t.dataset.tab !== tab;
  if (tab === 'avatar') drawMarkers();
  if (tab === 'conn') refreshModels();
};

function fillSettings() {
  const p = persona();
  const s = state.settings;
  const sel = $('personaSelect');
  sel.innerHTML = '';
  for (const q of state.personas) sel.add(new Option(q.name || 'Ohne Namen', q.id, false, q.id === p.id));
  $('pName').value = p.name;
  $('pPrompt').value = p.prompt;
  $('pGreeting').value = p.greeting;

  $('avMouthW').value = p.avatar.mouth?.w ?? 0.1;
  $('avEyeR').value = p.avatar.eyes?.[0]?.r ?? 0.03;
  $('avMotion').value = p.avatar.motion ?? 1;

  $('vSpeak').checked = s.speak;
  $('vEngine').value = p.voice.engine;
  $('vPiper').innerHTML = '';
  for (const [id, label] of PIPER_VOICES) $('vPiper').add(new Option(label, id, false, id === p.voice.piperVoice));
  fillSystemVoices();
  $('vRate').value = p.voice.rate;
  toggleEngineFields();

  $('sModel').value = s.sttModel;
  $('sLang').value = s.sttLang;
  $('sHandsFree').checked = s.handsFree;
  $('sSens').value = s.sensitivity;

  $('cUrl').value = s.baseUrl;
  $('cTemp').value = s.temperature;
  $('cHistory').value = s.historyLimit;
  drawMarkers();
}

function fillSystemVoices() {
  const voices = SpeechOutput.systemVoices();
  const sel = $('vSystem');
  sel.innerHTML = '';
  const sorted = [...voices].sort((a, b) => (b.lang.startsWith('de') ? 1 : 0) - (a.lang.startsWith('de') ? 1 : 0));
  for (const v of sorted) sel.add(new Option(`${v.name} (${v.lang})`, v.name, false, v.name === persona().voice.systemVoice));
  if (!voices.length) sel.add(new Option('Keine Systemstimmen gefunden', ''));
}
speechSynthesis.onvoiceschanged = () => !$('drawer').hidden && fillSystemVoices();

function toggleEngineFields() {
  const piper = $('vEngine').value === 'piper';
  $('vPiperWrap').hidden = !piper;
  $('vSystemWrap').hidden = piper;
}

// Persona-Felder
$('personaSelect').onchange = (e) => {
  stopAll();
  state.activeId = e.target.value;
  save();
  applyPersona();
  fillSettings();
};
$('pName').oninput = (e) => {
  persona().name = e.target.value;
  $('titleName').textContent = e.target.value || 'KI-Assistent';
  $('personaSelect').selectedOptions[0].text = e.target.value || 'Ohne Namen';
  save();
};
$('pPrompt').oninput = (e) => {
  persona().prompt = e.target.value;
  save();
};
$('pGreeting').oninput = (e) => {
  persona().greeting = e.target.value;
  save();
};
$('personaNew').onclick = () => {
  const p = defaultPersona();
  p.name = 'Neue Persona';
  p.prompt = 'Du bist ein hilfsbereiter Assistent.';
  p.greeting = 'Hallo!';
  state.personas.push(p);
  state.activeId = p.id;
  save();
  applyPersona();
  fillSettings();
};
$('personaCopy').onclick = () => {
  const p = structuredClone(persona());
  p.id = newId();
  p.name += ' (Kopie)';
  state.personas.push(p);
  state.activeId = p.id;
  save();
  applyPersona();
  fillSettings();
};
$('personaDelete').onclick = () => {
  if (state.personas.length < 2) return alert('Die letzte Persona kann nicht gelöscht werden.');
  if (!confirm(`Persona „${persona().name}“ wirklich löschen?`)) return;
  delete state.history[persona().id];
  state.personas = state.personas.filter((p) => p.id !== state.activeId);
  state.activeId = state.personas[0].id;
  save();
  applyPersona();
  fillSettings();
};
$('personaExport').onclick = () => {
  const p = structuredClone(persona());
  delete p.id;
  const blob = new Blob([JSON.stringify({ kiAssistentPersona: 1, ...p }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(p.name || 'persona').replace(/[^\w\-äöüÄÖÜß ]/g, '')}.persona.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('personaImport').onclick = () => $('personaImportFile').click();
$('personaImportFile').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.kiAssistentPersona) throw new Error('Keine gültige Persona-Datei');
    delete data.kiAssistentPersona;
    const p = { ...defaultPersona(), ...data, id: newId() };
    state.personas.push(p);
    state.activeId = p.id;
    save();
    applyPersona();
    fillSettings();
  } catch (err) {
    alert(`Import fehlgeschlagen: ${err.message}`);
  }
};
$('clearHistory').onclick = () => {
  if (!confirm('Gesprächsverlauf dieser Persona löschen?')) return;
  stopAll();
  state.history[persona().id] = [];
  save();
  renderChat();
};

// Avatar-Editor
let markMode = null;
let markerImg = null;
let markerImgSrc = null;

async function drawMarkers() {
  const p = persona();
  const c = $('markerCanvas');
  if (markerImgSrc !== p.avatar.image) {
    markerImg = await loadImage(p.avatar.image).catch(() => null);
    markerImgSrc = p.avatar.image;
  }
  if (!markerImg) return;
  const w = c.clientWidth || 400;
  const h = Math.round((w * markerImg.height) / markerImg.width);
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.drawImage(markerImg, 0, 0, w, h);
  g.lineWidth = 2;
  const m = p.avatar.mouth;
  if (m) {
    g.strokeStyle = '#ff6b6b';
    g.beginPath();
    g.ellipse(m.x * w, m.y * h, (m.w * w) / 2, Math.max(3, m.w * w * 0.18), 0, 0, Math.PI * 2);
    g.stroke();
  }
  g.strokeStyle = '#5bd3f5';
  for (const e of p.avatar.eyes ?? []) {
    g.beginPath();
    g.ellipse(e.x * w, e.y * h, e.r * w, e.r * w * 0.7, 0, 0, Math.PI * 2);
    g.stroke();
  }
}

function avatarChanged() {
  save();
  avatar.setConfig(persona().avatar).catch((e) => status(e.message));
  drawMarkers();
}

for (const b of document.querySelectorAll('[data-mark]')) {
  b.onclick = () => {
    markMode = markMode === b.dataset.mark ? null : b.dataset.mark;
    for (const o of document.querySelectorAll('[data-mark]')) o.classList.toggle('active', o.dataset.mark === markMode);
  };
}
$('markerCanvas').onclick = (e) => {
  if (!markMode) return;
  const r = e.target.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  const av = persona().avatar;
  if (markMode === 'mouth') av.mouth = { x, y, w: av.mouth?.w ?? 0.1 };
  else {
    const i = markMode === 'eye0' ? 0 : 1;
    av.eyes ??= [];
    const rr = av.eyes[0]?.r ?? av.eyes[1]?.r ?? 0.03;
    av.eyes[i] = { x, y, r: rr };
    av.eyes = av.eyes.filter(Boolean);
  }
  // nach dem Setzen automatisch zum nächsten Punkt springen
  const order = ['mouth', 'eye0', 'eye1'];
  const next = order[order.indexOf(markMode) + 1] ?? null;
  markMode = next;
  for (const o of document.querySelectorAll('[data-mark]')) o.classList.toggle('active', o.dataset.mark === markMode);
  avatarChanged();
};
$('avMouthW').oninput = (e) => {
  const av = persona().avatar;
  av.mouth = { ...(av.mouth ?? { x: 0.5, y: 0.5 }), w: +e.target.value };
  avatarChanged();
};
$('avEyeR').oninput = (e) => {
  for (const eye of persona().avatar.eyes ?? []) eye.r = +e.target.value;
  avatarChanged();
};
$('avMotion').oninput = (e) => {
  persona().avatar.motion = +e.target.value;
  avatar.motion = +e.target.value;
  save();
};

/** Bild verkleinern (max. 1024 px) und als Data-URL speichern. */
async function readImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const s = Math.min(1, 1024 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * s);
    c.height = Math.round(img.height * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return file.type === 'image/png' || file.type === 'image/webp'
      ? c.toDataURL('image/png')
      : c.toDataURL('image/jpeg', 0.92);
  } finally {
    URL.revokeObjectURL(url);
  }
}

$('avUpload').onclick = () => $('avFile').click();
$('avFile').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const av = persona().avatar;
  av.image = await readImage(file);
  av.mouthImage = null;
  av.eyesImage = null;
  const face = await detectFace(av.image);
  if (face) {
    av.mouth = face.mouth;
    av.eyes = face.eyes;
    status('Gesicht erkannt – Markierungen bei Bedarf korrigieren.');
  } else {
    av.mouth = null;
    av.eyes = [];
    markMode = 'mouth';
    for (const o of document.querySelectorAll('[data-mark]')) o.classList.toggle('active', o.dataset.mark === markMode);
    status('Bitte jetzt im Bild auf den Mund klicken, danach auf beide Augen.');
  }
  avatarChanged();
};
$('avDefault').onclick = () => {
  persona().avatar = structuredClone(DEFAULT_AVATAR);
  fillSettings();
  avatarChanged();
};
$('avAuto').onclick = async () => {
  const face = await detectFace(persona().avatar.image);
  if (!face) return status('Automatische Erkennung nicht möglich – bitte manuell markieren.');
  Object.assign(persona().avatar, face);
  avatarChanged();
};
$('avMouthUp').onclick = () => $('avMouthFile').click();
$('avEyesUp').onclick = () => $('avEyesFile').click();
$('avMouthFile').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  persona().avatar.mouthImage = await readImage(f);
  avatarChanged();
};
$('avEyesFile').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  persona().avatar.eyesImage = await readImage(f);
  avatarChanged();
};
$('avMouthClear').onclick = () => {
  persona().avatar.mouthImage = null;
  avatarChanged();
};
$('avEyesClear').onclick = () => {
  persona().avatar.eyesImage = null;
  avatarChanged();
};
const testPhrase = () => persona().greeting || `Hallo, ich bin ${persona().name}. So klinge ich.`;
$('avTest').onclick = () => {
  tts.stop();
  tts.enqueue(testPhrase());
};

// Stimme
$('vSpeak').onchange = (e) => {
  state.settings.speak = e.target.checked;
  if (!e.target.checked) tts.stop();
  save();
};
$('vEngine').onchange = (e) => {
  persona().voice.engine = e.target.value;
  toggleEngineFields();
  applyVoice();
  save();
};
$('vPiper').onchange = (e) => {
  persona().voice.piperVoice = e.target.value;
  applyVoice();
  save();
};
$('vSystem').onchange = (e) => {
  persona().voice.systemVoice = e.target.value;
  applyVoice();
  save();
};
$('vRate').oninput = (e) => {
  persona().voice.rate = +e.target.value;
  applyVoice();
  save();
};
$('vTest').onclick = () => {
  tts.stop();
  tts.enqueue(testPhrase());
};

// Spracherkennung
$('sModel').onchange = (e) => {
  state.settings.sttModel = e.target.value;
  applyVoice();
  save();
};
$('sLang').onchange = (e) => {
  state.settings.sttLang = e.target.value;
  applyVoice();
  save();
};
$('sHandsFree').onchange = (e) => setHandsFree(e.target.checked);
$('sSens').oninput = (e) => {
  state.settings.sensitivity = +e.target.value;
  save();
};
$('sPreload').onclick = async () => {
  try {
    status('Lade Spracherkennung …');
    await stt.preload(progressStatus('Spracherkennung'));
    status('Lade Stimme …');
    await tts.preload((p) => p.total && status(`Stimme wird geladen … ${Math.round((p.loaded / p.total) * 100)} %`));
    status('Sprachmodelle sind bereit – ab jetzt funktioniert alles offline.');
  } catch (e) {
    status(friendlyError(e));
  }
};

// Verbindung
$('cUrl').onchange = (e) => {
  state.settings.baseUrl = e.target.value.trim() || DEFAULT_SETTINGS.baseUrl;
  state.settings.model = '';
  save();
  refreshModels();
};
$('cModel').onchange = (e) => {
  state.settings.model = e.target.value;
  save();
};
$('cTemp').oninput = (e) => {
  state.settings.temperature = +e.target.value;
  save();
};
$('cHistory').onchange = (e) => {
  state.settings.historyLimit = Math.max(2, Math.min(100, +e.target.value || 20));
  save();
};
$('cRefresh').onclick = () => refreshModels();

async function refreshModels() {
  const sel = $('cModel');
  $('cInfo').textContent = 'Verbinde …';
  try {
    const models = await desktop.listModels(state.settings.baseUrl);
    sel.innerHTML = '';
    for (const m of models) sel.add(new Option(m, m, false, m === state.settings.model));
    if (!state.settings.model && models[0]) {
      state.settings.model = models.find((m) => !/embed/i.test(m)) ?? models[0];
      sel.value = state.settings.model;
      save();
    }
    $('cInfo').textContent = models.length
      ? `✔ Verbunden – ${models.length} Modell(e) verfügbar.`
      : 'Verbunden, aber kein Modell geladen.';
  } catch (e) {
    sel.innerHTML = '';
    if (state.settings.model) sel.add(new Option(state.settings.model, state.settings.model));
    $('cInfo').textContent = `✖ Keine Verbindung: ${e.message}`;
  }
}

// ---------------------------------------------------------------- Start
async function init() {
  const data = (await desktop.loadData()) ?? {};
  state.settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) };
  state.personas = data.personas?.length ? data.personas : [defaultPersona()];
  state.activeId = data.activeId ?? state.personas[0].id;
  if (!state.personas.some((p) => p.id === state.activeId)) state.activeId = state.personas[0].id;
  state.history = data.history ?? {};

  if (state.settings.stageHeight) {
    document.documentElement.style.setProperty('--stage-h', state.settings.stageHeight + 'px');
  }
  $('btnPin').classList.toggle('active', state.settings.alwaysOnTop);
  applyPersona();
  updateBadge();
  save();

  desktop
    .listModels(state.settings.baseUrl)
    .then(() => status(''))
    .catch(() =>
      status('LM Studio nicht erreichbar – bitte LM Studio starten und den lokalen Server aktivieren (⚙ → Verbindung).'),
    );
  if (state.settings.handsFree) maybeListenHandsFree();
}

// Für Fehlersuche in den DevTools
window.__app = { avatar, tts, stt, state };

init();
