import { Avatar, avatarState, detectFace, loadImage } from './avatar.js';
import { SpeechInput } from './stt.js';
import { SpeechOutput, SentenceSplitter, PIPER_VOICES, DEFAULT_VOICES } from './tts.js';
import { removeBackground, hasUniformBorder, hasTransparency, applyAlpha, borderColor } from './cutout.js';
import { computeVideoMask } from './videomask.js';
import { renderMarkdown, addCopyButtons } from './markdown.js';
import { FloatingAvatar, OutputWindow } from './windows.js';
import { RubberBand } from './rubberband.js';
import { buildDepthMap, imageKey } from './parallax.js';
import { detectFaceRig, markersFromRig } from './facerig.js';
import { debugVoice, synthesize, piperState } from './piper.js';

const $ = (id) => document.getElementById(id);
const desktop = window.desktop;
const MOBILE = desktop.platform === 'android';
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '';
// Versionsnummer gut sichtbar in der Titelleiste (zum Unterscheiden der Testversionen)
document.getElementById('titleVersion').textContent = APP_VERSION ? `v${APP_VERSION}` : '';
// "lokal" = Ausgabe ganz ohne Cloud-Funktionen, "cloud" = mit Claude/ChatGPT/OpenAI-Stimme
const EDITION = desktop.edition ?? 'cloud';
const LOCAL_ONLY = EDITION === 'lokal';

// ---------------------------------------------------------------- Daten
const DEFAULT_AVATAR = {
  image: 'default-figur.svg',
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
    language: 'de',
    style: 'ausfuehrlich',
    memoryOn: true,
    memory: [],
    avatar: structuredClone(DEFAULT_AVATAR),
    voice: {
      engine: 'piper',
      de: DEFAULT_VOICES.de,
      en: DEFAULT_VOICES.en,
      systemVoice: '',
      rate: 1,
      server: { voice: '', exaggeration: 0.6, cfg: 0.5, temperature: 0.8 },
      cloud: { voice: 'nova', instructions: 'Sprich natürlich, warm und lebendig – wie im persönlichen Gespräch.' },
    },
  };
}

/** Ältere gespeicherte Personas auf den aktuellen Stand bringen. */
function migratePersona(p) {
  const d = defaultPersona();
  p.language ??= 'de';
  p.style ??= 'gespraech';
  p.memoryOn ??= true;
  p.memory ??= [];
  p.voice = { ...d.voice, ...(p.voice ?? {}) };
  p.voice.server = { ...d.voice.server, ...(p.voice.server ?? {}) };
  p.voice.cloud = { ...d.voice.cloud, ...(p.voice.cloud ?? {}) };
  if (p.voice.piperVoice) {
    const lang = p.voice.piperVoice.startsWith('en') ? 'en' : 'de';
    p.voice[lang] = p.voice.piperVoice;
    delete p.voice.piperVoice;
  }
  p.avatar ??= structuredClone(DEFAULT_AVATAR);
  return p;
}

const DEFAULT_SETTINGS = {
  baseUrl: 'http://localhost:1234',
  model: '',
  temperature: 0.7,
  historyLimit: 20,
  speak: true,
  maxSentences: 0,
  sttModel: 'onnx-community/whisper-base',
  sttEngine: desktop.transcribeCloud ? 'cloud' : 'local', // Android: Cloud-Erkennung ist dort deutlich schneller
  sttLang: 'persona',
  handsFree: false,
  sensitivity: 0.015,
  pipOnLeave: true, // Android: beim Verlassen der App als Bild-im-Bild weiterlaufen
  bargeIn: true, // Live-Gespräch: dazwischenreden erlaubt
  livePauseMs: 800, // so lange Stille, bis mein Satz als fertig gilt
  alwaysOnTop: false,
  stageHeight: null,
  floating: false,
  outputOpen: false,
  offline: false,
  memoryLearn: true,
  ttsServerUrl: 'http://localhost:8004',
  floatingSize: 0.4,
  provider: desktop.platform === 'android' ? 'anthropic' : 'lmstudio', // 'lmstudio' | 'anthropic' | 'openai'
  claudeModel: 'claude-haiku-5-5',
  claudeEffort: 'low',
  openaiModel: '',
  cloudTtsModel: 'gpt-4o-mini-tts',
  claudeWeb: true, // Internetsuche (nur Claude)
  claudeFiles: true, // Dateien erstellen und bearbeiten (nur Claude)
};

const CLAUDE_MODELS = [
  ['claude-haiku-5-5', 'Claude Haiku 5.5 – schnell & günstig (empfohlen)'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5 – ausgewogen'],
  ['claude-opus-5-5', 'Claude Opus 5.5 – am leistungsfähigsten'],
];
const PROVIDER_NAMES = { lmstudio: 'LM Studio', anthropic: 'Claude', openai: 'ChatGPT' };

const RULES = {
  de: {
    lang: 'Antworte immer auf Deutsch – auch wenn die Frage oder Fachbegriffe englisch sind.',
    gespraech:
      'Deine Antworten werden laut vorgelesen. Antworte natürlich und gesprächig, meist in wenigen Sätzen, ' +
      'ohne Markdown, Listen, Tabellen oder Emojis – außer du wirst ausdrücklich darum gebeten.',
    ausfuehrlich:
      'Beginne mit ein bis zwei Sätzen, die die Antwort gesprochen gut verständlich zusammenfassen (sie werden ' +
      'vorgelesen). Danach darfst du ausführlich werden und Markdown verwenden (Überschriften, Listen, Tabellen, ' +
      'Codeblöcke), wenn es der Übersicht dient.',
    name: (n) => `Dein Name ist ${n}.`,
    memory: (items) =>
      `Was du aus früheren Gesprächen über dein Gegenüber weißt (dein Gedächtnis):\n${items}\n` +
      'Nutze dieses Wissen natürlich, wenn es passt, ohne es aufzuzählen.',
  },
  en: {
    lang: 'Always answer in English.',
    gespraech:
      'Your answers are read aloud. Reply naturally and conversationally, usually in a few sentences, ' +
      'without Markdown, lists, tables or emojis unless explicitly asked.',
    ausfuehrlich:
      'Start with one or two sentences that summarise the answer in a way that sounds good when read aloud. ' +
      'After that you may go into detail and use Markdown (headings, lists, tables, code blocks) where helpful.',
    name: (n) => `Your name is ${n}.`,
    memory: (items) =>
      `What you remember about the user from earlier conversations (your memory):\n${items}\n` +
      'Use this knowledge naturally when relevant, without listing it.',
  },
};

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
  if (/fetch|network|ERR_|503|Offline|unavailable|trying to load file/i.test(msg)) {
    return state.settings.offline
      ? 'Offline-Modus ist aktiv und das Modell ist noch nicht heruntergeladen (⚙ → Verbindung).'
      : 'Das Sprachmodell konnte nicht heruntergeladen werden – der Download-Server (Hugging Face) war nicht ' +
          'erreichbar. Bitte in ein paar Minuten noch einmal versuchen. Danach liegt es dauerhaft auf dem Rechner.';
  }
  return msg;
}

// ---------------------------------------------------------------- Bausteine
const avatar = new Avatar($('avatar'), { useLayout: true });
const status = (text) => ($('status').textContent = text ?? '');

const tts = new SpeechOutput({
  onLevel: (v) => {
    avatarState.level = v;
    if (v < 0.02) avatarState.shape *= 0.8;
  },
  onSpeakingChange: (on) => {
    avatarState.speaking = on;
    if (!on) state.lastSpeakEnd = Date.now();
    if (on) showTiming();
    updateBadge();
    if (!on) maybeListenHandsFree();
  },
  onStatus: (text) => {
    if (!text && $('status').textContent.startsWith('⏱')) return; // Zeitmessung stehen lassen
    const isError = /fehler|übersprungen/i.test(text);
    const msg = isError && /fetch|503|Offline/i.test(text) ? friendlyError(text) : text;
    status(msg);
    if (isError && !state.ttsErrorShown) {
      state.ttsErrorShown = true;
      addBubble('error', `Sprachausgabe: ${msg} – Tipp: ⚙ → Sprache → „▶ Stimme testen“ oder Engine „Systemstimme“.`);
    }
  },
});
tts.onShape = (v) => (avatarState.shape = avatarState.shape * 0.5 + v * 0.5);

const stt = new SpeechInput({
  onLevel: (v) => {
    $('micMeter').style.width = Math.min(100, (v / (state.settings.sensitivity * 4)) * 100) + '%';
  },
});

// Figur im Chatfenster: anklicken = Rahmen zum Verschieben/Skalieren, Doppelklick = sprechen
new RubberBand($('stage'), avatar, {
  kind: 'layout',
  onActivate: () => toggleMic(),
  onChange: (layout) => {
    persona().avatar.stage = { ...layout };
    save();
  },
  onRotating: (yaw, key) => (key === 'turnYaw' ? setTurnYaw(yaw, false) : setVrmYaw(yaw, false)),
  onRotate: (yaw, key) => (key === 'turnYaw' ? setTurnYaw(yaw) : setVrmYaw(yaw)),
});

/** Leichte Drehung der Bild-Figur überall übernehmen. */
function setTurnYaw(yaw, persist = true) {
  persona().avatar.turnYaw = yaw;
  avatar.turnYaw = yaw;
  if (floating.avatar) floating.avatar.turnYaw = yaw;
  $('avTurnYaw').value = yaw;
  $('avTurnYawVal').textContent = `${yaw}°`;
  if (persist) save();
}

/** Drehung der 3D-Figur überall übernehmen (Chatfenster, freie Figur, Regler). */
function setVrmYaw(yaw, persist = true) {
  persona().avatar.vrmYaw = yaw;
  avatar.vrmYaw = yaw;
  if (floating.avatar) floating.avatar.vrmYaw = yaw;
  $('avVrmYaw').value = yaw;
  $('avVrmYawVal').textContent = `${yaw}°`;
  if (persist) save();
}

const floating = new FloatingAvatar({
  onActivate: () => toggleMic(),
  onRotate: (yaw, key) => (key === 'turnYaw' ? setTurnYaw(yaw) : setVrmYaw(yaw)),
  onClosed: () => setFloating(false, { fromWindow: true }),
});
const output = new OutputWindow();

function applyVoice() {
  const p = persona();
  tts.configure({
    // Android: kein Chatterbox-Server und keine Systemstimmen – dann Piper
    engine: MOBILE && ['server', 'system'].includes(p.voice.engine) ? 'piper' : p.voice.engine,
    voices: { de: p.voice.de, en: p.voice.en },
    language: p.language,
    systemVoice: p.voice.systemVoice,
    rate: p.voice.rate,
    maxSentences: state.settings.maxSentences,
    server: { url: state.settings.ttsServerUrl, ...p.voice.server },
    cloud: { model: state.settings.cloudTtsModel, ...p.voice.cloud },
  });
  stt.model = state.settings.sttModel;
  // Whisper bekommt immer eine feste Sprache – ohne Angabe übersetzt es teils ins Englische.
  stt.language = ['german', 'english'].includes(state.settings.sttLang)
    ? state.settings.sttLang
    : p.language === 'en'
      ? 'english'
      : 'german';
}

function applyAvatar() {
  const cfg = persona().avatar;
  avatar.setConfig(cfg).catch((e) => status(e.message));
  if (floating.isOpen) floating.setConfig(cfg).catch((e) => status(e.message));
}

function applyPersona() {
  const p = persona();
  $('titleName').textContent = p.name || 'KI-Assistent';
  document.title = p.name || 'KI-Assistent';
  applyAvatar();
  applyVoice();
  renderChat();
  output.setHistory(history());
}

// ---------------------------------------------------------------- Chat-Anzeige
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fillBubble(div, role, text) {
  if (role === 'assistant') {
    div.classList.add('md');
    div.innerHTML = renderMarkdown(text);
    addCopyButtons(div);
  } else {
    div.innerHTML = escapeHtml(text);
  }
}

function addBubble(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  fillBubble(div, role, text);
  $('chat').appendChild(div);
  $('chat').scrollTop = $('chat').scrollHeight;
  return div;
}

function renderChat() {
  $('chat').innerHTML = '';
  const h = history();
  if (!h.length && persona().greeting) addBubble('assistant', persona().greeting);
  for (const m of h) decorateBubble(addBubble(m.role, m.content), m);
}

/** Anhänge und erstellte Dateien unter einer Chatblase anzeigen. */
function decorateBubble(div, m) {
  if (m.attachments?.length) {
    const line = document.createElement('div');
    line.className = 'attach-line';
    line.textContent = m.attachments.map((a) => `📎 ${a.name}`).join('   ');
    div.appendChild(line);
  }
  if (m.files?.length) div.appendChild(fileList(m.files));
}

function fileList(files) {
  const box = document.createElement('div');
  box.className = 'file-list';
  for (const f of files) {
    const row = document.createElement('div');
    const open = document.createElement('button');
    open.textContent = `📄 ${f.name}`;
    open.title = 'Datei öffnen';
    open.onclick = async () => {
      const err = await desktop.openFile(f.path);
      if (err) status(err);
    };
    const dir = document.createElement('button');
    dir.textContent = 'Im Ordner zeigen';
    dir.onclick = () => desktop.exportShow(f.path);
    row.append(open, dir);
    box.appendChild(row);
  }
  return box;
}

// ---------------------------------------------------------------- Anhänge (nur mit Claude)
// Die Dateien bleiben nur im Arbeitsspeicher und gehen ausschließlich mit der Nachricht an Claude.
const ATTACH_MAX = 30 * 1024 * 1024;
const TEXT_FILE = /\.(txt|md|csv|json|xml|html?|log|ya?ml)$/i;
const OFFICE_FILE = /\.(xlsx|xlsm|xls|docx|pptx|odt|ods)$/i;
const attachmentData = new Map(); // Schlüssel -> Bytes
let pendingAttachments = [];
const attachAllowed = () => !LOCAL_ONLY && state.settings.provider === 'anthropic';

async function addAttachments(list) {
  if (!attachAllowed()) {
    status('Dateien anhängen geht mit Claude (⚙ → Verbindung → KI-Anbieter).');
    return;
  }
  for (const f of list) {
    if (f.size > ATTACH_MAX) {
      status(`„${f.name}“ ist zu groß (höchstens 30 MB).`);
      continue;
    }
    const mime = f.type || (/\.pdf$/i.test(f.name) ? 'application/pdf' : 'application/octet-stream');
    const text = TEXT_FILE.test(f.name) || mime.startsWith('text/');
    if (!text && mime !== 'application/pdf' && !/^image\/(png|jpeg|gif|webp)$/.test(mime)) {
      if (!OFFICE_FILE.test(f.name)) {
        status(`„${f.name}“: Dieses Dateiformat kann Claude nicht lesen.`);
        continue;
      }
      if (!state.settings.claudeFiles) {
        status(`„${f.name}“: Für Office-Dateien bitte ⚙ → Verbindung → „Dateien erstellen und bearbeiten“ einschalten.`);
        continue;
      }
    }
    const key = newId();
    attachmentData.set(key, new Uint8Array(await f.arrayBuffer()));
    pendingAttachments.push({ key, name: f.name, mime, size: f.size, ...(text ? { text: true } : {}) });
  }
  renderPending();
}

function renderPending() {
  const box = $('attachments');
  box.innerHTML = '';
  box.hidden = !pendingAttachments.length;
  for (const a of pendingAttachments) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = `📎 ${a.name}`;
    const x = document.createElement('button');
    x.textContent = '✕';
    x.title = 'Entfernen';
    x.onclick = () => {
      pendingAttachments = pendingAttachments.filter((p) => p !== a);
      attachmentData.delete(a.key);
      renderPending();
    };
    chip.appendChild(x);
    box.appendChild(chip);
  }
}

function updateBadge() {
  const b = $('stateBadge');
  let text = '';
  b.className = 'state-badge';
  if (stt.listening) {
    text = '● hört zu …';
    b.classList.add('listening');
  } else if (state.transcribing) text = 'versteht …';
  else if (avatarState.thinking) text = 'denkt nach …';
  else if (avatarState.speaking) text = '';
  else if (state.hearing) text = '● ich höre dich …';
  else if (state.settings.handsFree) text = 'Live – sprich einfach';
  b.textContent = text;
  b.hidden = !text;
  avatarState.listening = stt.listening;
  floating.setBadge(text, stt.listening);
  $('btnMic').classList.toggle('listening', stt.listening);
  $('btnMic').classList.toggle('busy', !!state.transcribing);
  $('btnMic').classList.toggle('handsfree', state.settings.handsFree);
}

// ---------------------------------------------------------------- LM Studio
function buildMessages() {
  const p = persona();
  const r = RULES[p.language] ?? RULES.de;
  const parts = [p.prompt?.trim()];
  if (p.style !== 'frei') parts.push(r.name(p.name), r[p.style] ?? r.gespraech);
  if (p.memoryOn && p.memory?.length) parts.push(r.memory(p.memory.map((m) => `- ${m.text}`).join('\n')));
  if (p.style !== 'frei') parts.push(r.lang);
  const sys = parts.filter(Boolean).join('\n\n');
  const withFiles = attachAllowed();
  const h = history()
    .slice(-state.settings.historyLimit)
    .map((m) => {
      let content = m.content;
      if (m.files?.length) content += `\n\n(Erstellte Dateien: ${m.files.map((f) => f.name).join(', ')})`;
      if (!m.attachments?.length) return { role: m.role, content };
      if (!withFiles) return { role: m.role, content: `${content}\n\n(Anhang: ${m.attachments.map((a) => a.name).join(', ')})`.trim() };
      return { role: m.role, content, attachments: m.attachments.map((a) => ({ ...a, data: attachmentData.get(a.key) })) };
    });
  return sys ? [{ role: 'system', content: sys }, ...h] : h;
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

/** Anfrageparameter für den gewählten KI-Anbieter. */
function llmParams(model) {
  const s = state.settings;
  if (s.provider === 'anthropic') return { provider: 'anthropic', model, effort: s.claudeEffort };
  if (s.provider === 'openai') return { provider: 'openai', model, effort: s.claudeEffort };
  return { provider: 'lmstudio', baseUrl: s.baseUrl, model, temperature: s.temperature };
}

async function ensureModel() {
  const s = state.settings;
  if (s.provider === 'anthropic') return s.claudeModel || CLAUDE_MODELS[0][0];
  if (s.provider === 'openai') {
    if (s.openaiModel) return s.openaiModel;
    const models = await desktop.openaiModels();
    s.openaiModel = models.find((m) => /mini/i.test(m)) ?? models[0];
    if (!s.openaiModel) throw new Error('Keine Chat-Modelle für diesen Schlüssel gefunden.');
    save();
    return s.openaiModel;
  }
  if (state.settings.model) return state.settings.model;
  const models = await desktop.listModels(state.settings.baseUrl);
  const chat = models.filter((m) => !/embed/i.test(m));
  if (!chat.length) throw new Error('In LM Studio ist kein Modell geladen.');
  state.settings.model = chat[0];
  save();
  return chat[0];
}

// ---------------------------------------------------------------- Neuer Chat
// Leert nur den Gesprächsverlauf – Persona, Gedächtnis, Avatar und Stimme bleiben.
let chatSerial = 0; // neuer Claude-Arbeitsbereich pro Chat
let undoChat = null;
function newChat() {
  if (state.busy) stopAll();
  tts.stop();
  const p = persona();
  const old = history();
  if (!old.length) return status('Neuer Chat – der Verlauf ist schon leer.');
  undoChat = { id: p.id, history: old };
  state.history[p.id] = [];
  chatSerial++;
  pendingAttachments = [];
  renderPending();
  save();
  renderChat();
  output.setHistory([]);
  const note = addBubble('note', 'Neuer Chat – Persona und Gedächtnis bleiben erhalten. ');
  const undo = document.createElement('button');
  undo.textContent = 'Rückgängig';
  undo.onclick = () => {
    if (!undoChat || undoChat.id !== persona().id || history().length) return note.remove();
    state.history[undoChat.id] = undoChat.history;
    undoChat = null;
    save();
    renderChat();
    output.setHistory(history());
  };
  note.appendChild(undo);
}
// Sprachbefehl: einfach „Neuer Chat“ sagen
const NEW_CHAT_COMMAND = /^(neuer chat|neues gespräch|new chat)[.!]?$/i;

async function send(text) {
  text = text.trim();
  if (NEW_CHAT_COMMAND.test(text) && !pendingAttachments.length) return newChat();
  if ((!text && !pendingAttachments.length) || state.busy) return;
  tts.stop();
  tts.newTurn();
  cancelLearning();
  state.ttsErrorShown = false;
  state.busy = true;
  setBusyUi(true);

  const attachments = pendingAttachments;
  pendingAttachments = [];
  renderPending();
  const entry = { role: 'user', content: text, ...(attachments.length ? { attachments } : {}) };
  history().push(entry);
  decorateBubble(addBubble('user', text), entry);
  save();
  output.begin(text || attachments.map((a) => a.name).join(', '));

  const bubble = addBubble('assistant', '');
  bubble.classList.add('typing');
  avatarState.thinking = true;
  updateBadge();

  let answer = '';
  let sources = [];
  const created = [];
  const think = new ThinkFilter();
  const speak = state.settings.speak;
  state.spoken = '';
  const splitter = new SentenceSplitter((s) => {
    if (!speak) return;
    state.spoken = (state.spoken + ' ' + s).slice(-1500); // für den Echo-Filter im Live-Gespräch
    tts.enqueue(s);
  });

  // Darstellung gedrosselt aktualisieren (Markdown neu rendern ist nicht gratis)
  let renderTimer = null;
  const render = () => {
    renderTimer = null;
    fillBubble(bubble, 'assistant', answer.trimStart());
    $('chat').scrollTop = $('chat').scrollHeight;
    output.update(answer);
  };

  const finish = (error) => {
    clearTimeout(renderTimer);
    const rest = think.flush();
    answer += rest;
    splitter.push(rest);
    splitter.flush();
    bubble.classList.remove('typing');
    avatarState.thinking = false;
    answer = answer.trim();
    // Quellen der Internetsuche anhängen (werden nicht vorgelesen)
    if (answer && sources.length) {
      answer += '\n\n**Quellen:**\n' + sources.map((q) => `- [${q.title.replace(/[[\]]/g, '')}](${q.url})`).join('\n');
    }
    if (answer || created.length) {
      const entry = { role: 'assistant', content: answer, ...(created.length ? { files: created } : {}) };
      fillBubble(bubble, 'assistant', answer);
      decorateBubble(bubble, entry);
      history().push(entry);
      save();
    } else bubble.remove();
    status('');
    output.update(answer, true);
    if (answer && !error) scheduleLearning(text, answer);
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
      state.settings.provider === 'lmstudio'
        ? `Keine Verbindung zu LM Studio (${state.settings.baseUrl}). Läuft der lokale Server? – ${e.message}`
        : `${PROVIDER_NAMES[state.settings.provider]}: ${e.message}`,
    );
  }

  const id = newId();
  state.currentChatId = id;
  desktop.chat(
    {
      id,
      ...llmParams(model),
      ...(state.settings.provider === 'anthropic'
        ? { web: state.settings.claudeWeb, files: state.settings.claudeFiles, conversation: `${persona().id}:${chatSerial}` }
        : {}),
      messages: buildMessages(),
    },
    (ev) => {
      if (ev.type === 'delta') {
        const visible = think.push(ev.payload);
        if (!visible) return;
        if (state.timing && !state.timing.answer) state.timing.answer = performance.now();
        if (avatarState.thinking && visible.trim()) {
          avatarState.thinking = false;
          updateBadge();
        }
        answer += visible;
        splitter.push(visible);
        renderTimer ??= setTimeout(render, 60);
      } else if (ev.type === 'status') status(ev.payload);
      else if (ev.type === 'sources') sources = ev.payload;
      else if (ev.type === 'file') {
        created.push(ev.payload);
        status(`Datei erstellt: ${ev.payload.name}`);
      } else if (ev.type === 'error') finish(ev.payload);
      else finish();
    },
  );
}

// ---------------------------------------------------------------- Gedächtnis
const LEARN_PROMPT = {
  de:
    'Du pflegst das Langzeitgedächtnis eines persönlichen Assistenten. Lies den Gesprächsausschnitt und gib NUR neue, ' +
    'dauerhaft nützliche Fakten über den Nutzer zurück (z. B. Name, Beruf, Firma, Projekte, Vorlieben, Abneigungen, ' +
    'wichtige Termine, Absprachen, ausdrückliche Bitten wie „merk dir …“). Keine Allgemeinwissen-Fakten, nichts über den ' +
    'Assistenten selbst, nichts Vorübergehendes, nichts schon Bekanntes. Jeder Fakt als kurzer, eigenständiger Satz in ' +
    'der dritten Person. Antworte ausschließlich mit einem JSON-Array von Strings, z. B. ["Jens arbeitet bei ergoforyou."]. ' +
    'Wenn es nichts Neues gibt: []',
  en:
    'You maintain the long-term memory of a personal assistant. Read the excerpt and return ONLY new, lastingly useful ' +
    'facts about the user (name, job, company, projects, preferences, dislikes, important dates, agreements, explicit ' +
    '"remember that…" requests). No general knowledge, nothing about the assistant, nothing temporary, nothing already ' +
    'known. Each fact as a short standalone sentence in third person. Reply only with a JSON array of strings, or [] if ' +
    'there is nothing new.',
};

let learnTimer = null;
function cancelLearning() {
  clearTimeout(learnTimer);
  if (state.learnId) desktop.abortChat(state.learnId);
  state.learnId = null;
}

function scheduleLearning(question, answer) {
  const p = persona();
  if (!p.memoryOn || !state.settings.memoryLearn) return;
  cancelLearning();
  learnTimer = setTimeout(() => learn(p, question, answer).catch(() => {}), 1200);
}

function addMemory(p, text) {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length < 3 || t.length > 300) return false;
  const norm = (x) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (p.memory.some((m) => norm(m.text) === norm(t))) return false;
  p.memory.push({ id: newId(), text: t, created: Date.now() });
  // Gedächtnis begrenzen: älteste Einträge fallen heraus
  if (p.memory.length > 60) p.memory.splice(0, p.memory.length - 60);
  return true;
}

async function learn(p, question, answer) {
  const model = await ensureModel();
  const known = p.memory.map((m) => `- ${m.text}`).join('\n') || '(noch nichts)';
  const lang = p.language === 'en' ? 'en' : 'de';
  const excerpt =
    lang === 'en'
      ? `Known facts:\n${known}\n\nExcerpt:\nUser: ${question}\nAssistant: ${answer.slice(0, 2500)}`
      : `Bekannte Fakten:\n${known}\n\nGesprächsausschnitt:\nNutzer: ${question}\nAssistent: ${answer.slice(0, 2500)}`;
  const id = newId();
  state.learnId = id;
  const raw = await new Promise((resolve) => {
    let out = '';
    desktop.chat(
      {
        id,
        ...llmParams(model),
        ...(state.settings.provider === 'lmstudio' ? { temperature: 0 } : {}),
        messages: [
          { role: 'system', content: LEARN_PROMPT[lang] },
          { role: 'user', content: excerpt },
        ],
      },
      (ev) => {
        if (ev.type === 'delta') out += ev.payload;
        else if (ev.type === 'done' || ev.type === 'error') resolve(ev.type === 'done' ? out : '');
      },
    );
  });
  if (state.learnId !== id) return; // abgebrochen
  state.learnId = null;
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return;
  let facts;
  try {
    facts = JSON.parse(m[0]);
  } catch {
    return;
  }
  const added = (Array.isArray(facts) ? facts : []).filter((f) => typeof f === 'string' && addMemory(p, f));
  if (!added.length) return;
  save();
  if (p === persona()) {
    const note = addBubble('note', `💾 Gemerkt: ${added.join(' · ')}`);
    note.title = 'Im Gedächtnis gespeichert (⚙ → Gedächtnis)';
    renderMemory();
  }
}

function renderMemory() {
  const p = persona();
  const list = $('mList');
  if (!list) return;
  list.innerHTML = '';
  $('mOn').checked = !!p.memoryOn;
  $('mLearn').checked = !!state.settings.memoryLearn;
  $('mCount').textContent = p.memory.length ? `(${p.memory.length})` : '';
  if (!p.memory.length) {
    list.innerHTML = '<p class="hint">Noch keine Erinnerungen.</p>';
    return;
  }
  [...p.memory].reverse().forEach((m) => {
    const row = document.createElement('div');
    row.className = 'memory-row';
    const input = document.createElement('input');
    input.value = m.text;
    input.title = new Date(m.created).toLocaleString('de-DE');
    input.onchange = () => {
      m.text = input.value.trim();
      if (!m.text) p.memory.splice(p.memory.indexOf(m), 1);
      save();
      renderMemory();
    };
    const del = document.createElement('button');
    del.textContent = '🗑';
    del.title = 'Vergessen';
    del.onclick = () => {
      p.memory.splice(p.memory.indexOf(m), 1);
      save();
      renderMemory();
    };
    row.append(input, del);
    list.appendChild(row);
  });
}

$('mOn').onchange = (e) => {
  persona().memoryOn = e.target.checked;
  save();
};
$('mLearn').onchange = (e) => {
  state.settings.memoryLearn = e.target.checked;
  save();
};
const addMemoryFromInput = () => {
  if (addMemory(persona(), $('mNew').value)) {
    $('mNew').value = '';
    save();
    renderMemory();
  }
};
$('mAdd').onclick = addMemoryFromInput;
$('mNew').onkeydown = (e) => e.key === 'Enter' && addMemoryFromInput();
$('mClear').onclick = () => {
  if (!confirm(`Alle ${persona().memory.length} Erinnerungen von „${persona().name}“ löschen?`)) return;
  persona().memory = [];
  save();
  renderMemory();
};

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
const NOISE = [
  /^untertitel/i,
  /^vielen dank( fürs zuschauen)?[.!]*$/i,
  /^thanks? (you )?for watching/i,
  /^thank you[.!]*$/i,
  /^\W*$/,
  /^\[.*\]$/,
  /^\(.*\)$/,
  /amara\.org/i,
];

// ---- Live-Gespräch: Dazwischenreden und Echo-Schutz
const liveBargeIn = () => state.settings.handsFree && state.settings.bargeIn;

/** Avatar verstummt und die laufende Antwort wird abgebrochen, weil ich zu sprechen beginne. */
function interrupt() {
  if (state.currentChatId) desktop.abortChat(state.currentChatId);
  tts.stop();
  status('Unterbrochen – ich höre zu …');
}

/**
 * Hat das Mikrofon nur den Avatar selbst gehört (Lautsprecher ohne Kopfhörer)?
 * Nur prüfen, wenn das „Sprechen“ begann, während der Avatar redete – und dann Wortpaare vergleichen,
 * nicht einzelne Wörter (sonst würden normale Fragen wie „Wie geht es dir?“ fälschlich verworfen).
 */
function isEcho(text) {
  if (!state.spoken) return false;
  const words = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
  const pairs = (w) => w.slice(1).map((x, i) => w[i] + ' ' + x);
  const heard = pairs(words(text));
  if (heard.length < 2) return false;
  const said = new Set(pairs(words(state.spoken.slice(-600))));
  return heard.filter((p) => said.has(p)).length / heard.length >= 0.6;
}

const waitIdle = async (ms) => {
  for (const end = Date.now() + ms; state.busy && Date.now() < end; ) await new Promise((r) => setTimeout(r, 50));
};

/** Spracherkennung; scheitert der Download des gewählten Modells, mit einem kleineren weiterversuchen. */
const STT_FALLBACKS = ['onnx-community/whisper-base', 'onnx-community/whisper-tiny'];
async function transcribeWithFallback(audio) {
  if (state.settings.sttEngine === 'cloud' && desktop.transcribeCloud) {
    try {
      return await desktop.transcribeCloud(audio, stt.language);
    } catch (e) {
      status(`Cloud-Spracherkennung: ${e.message} – nutze Whisper auf dem Gerät.`);
    }
  }
  try {
    return await stt.transcribe(audio, progressStatus('Spracherkennung'));
  } catch (e) {
    if (!/unavailable|trying to load file|fetch|network|503/i.test(String(e?.message ?? e))) throw e;
    for (const m of STT_FALLBACKS.filter((m) => m !== stt.model)) {
      const wanted = stt.model;
      try {
        stt.model = m;
        const text = await stt.transcribe(audio, progressStatus('Spracherkennung'));
        status(`Hinweis: „${wanted.split('/').pop()}“ ließ sich nicht laden – nutze vorerst „${m.split('/').pop()}“.`);
        return text;
      } catch {
        stt.model = wanted;
      }
    }
    throw e;
  }
}

async function listenOnce({ handsFree = false } = {}) {
  if (state.micActive) return;
  state.micActive = true;
  let interrupted = false;
  let duringSpeech = false; // begann ich zu sprechen, während der Avatar redete?
  try {
    // Während der Avatar spricht, muss es lauter und länger sein (sonst unterbricht er sich durch sein Echo selbst)
    const live = handsFree && liveBargeIn();
    const p = stt.listen({
      waitForSpeech: handsFree,
      threshold: () => state.settings.sensitivity * (live && tts.speaking ? 2.5 : 1),
      // während der Avatar spricht keine Absenkung der Schwelle (sonst unterbricht ihn sein eigenes Echo)
      adaptive: () => !(live && tts.speaking),
      // im Freihand-Modus mindestens ~¼ s Stimme, damit Tastenklicks nichts auslösen
      startMs: () => (!handsFree ? 0 : tts.speaking ? 300 : 200),
      silenceMs: handsFree ? state.settings.livePauseMs : 1100,
      onSpeechStart: () => {
        duringSpeech = tts.speaking || Date.now() - (state.lastSpeakEnd ?? 0) < 1000;
        if (handsFree) {
          state.hearing = true;
          updateBadge();
        }
        if (live && (tts.speaking || state.busy)) {
          interrupted = true;
          interrupt();
        }
      },
    });
    updateBadge();
    const audio = await p;
    state.timing = { spoke: performance.now() };
    state.hearing = false;
    updateBadge();
    if (!audio || audio.length < 16000 * 0.35) return;
    state.transcribing = true;
    updateBadge();
    const text = await transcribeWithFallback(audio);
    state.timing.heard = performance.now();
    status('');
    state.transcribing = false;
    updateBadge();
    if (!text || NOISE.some((r) => r.test(text.trim()))) {
      if (handsFree && audio.length > 16000) status('Nicht verstanden – bitte noch einmal sagen.');
      return;
    }
    if (handsFree && duringSpeech && isEcho(text)) return;
    if (interrupted) await waitIdle(2500);
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
    // Live-Gespräch hört auch zu, während der Avatar denkt oder spricht
    const free = liveBargeIn() || (!state.busy && !tts.speaking);
    if (state.settings.handsFree && free && !state.micActive) {
      listenOnce({ handsFree: true });
    }
  }, 350);
}

/** Zeitmessung eines Sprach-Durchgangs anzeigen: wo hängt es? */
function showTiming() {
  const t = state.timing;
  if (!t?.heard || !t.answer || t.shown) return;
  t.shown = true;
  const s = (a, b) => ((b - a) / 1000).toFixed(1).replace('.', ',') + ' s';
  const now = performance.now();
  status(`⏱ Erkennen ${s(t.spoke, t.heard)} · erste Worte ${s(t.heard, t.answer)} · Stimme ${s(t.answer, now)} · gesamt ${s(t.spoke, now)}`);
}

function setHandsFree(on) {
  state.settings.handsFree = on;
  $('sHandsFree').checked = on;
  $('btnLive').classList.toggle('active', on);
  $('btnLive').title = on ? 'Live-Gespräch beenden' : 'Live-Gespräch starten – einfach losreden, dazwischenreden erlaubt';
  if (on) {
    status('Live-Gespräch läuft – sprich einfach. Zum Beenden 📞 erneut drücken.');
    stt.warmup(progressStatus('Spracherkennung')).then(() => status(''));
  }
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

function toggleMic() {
  if (stt.listening) return stt.stop();
  if (state.micActive) return;
  tts.stop();
  listenOnce();
}
$('btnMic').onclick = toggleMic;

// ---------------------------------------------------------------- Freischwebende Figur & Ausgabefenster
async function setFloating(on, { fromWindow = false } = {}) {
  state.settings.floating = on;
  document.body.classList.toggle('floating', on);
  $('btnFloat').classList.toggle('active', on);
  $('avFloating').checked = on;
  save();
  if (on) {
    try {
      const av = persona().avatar;
      if (!av.original && !hasTransparency(await imageToCanvas(av.image, 256))) {
        const keep = editIndex;
        editIndex = -1;
        await cutoutAvatar('auto');
        editIndex = keep;
      }
      await floating.open(persona().avatar);
      updateBadge();
    } catch (e) {
      status(`Figur konnte nicht geöffnet werden: ${e.message}`);
      setFloating(false);
    }
  } else if (!fromWindow) {
    floating.close();
  }
}

async function openOutput() {
  try {
    await output.open();
    state.settings.outputOpen = true;
    save();
  } catch (e) {
    status(`Ausgabefenster: ${e.message}`);
  }
}

$('btnFloat').onclick = () => setFloating(!state.settings.floating);
$('btnOutput').onclick = () => (output.isOpen ? output.win.focus() : openOutput());
setInterval(() => {
  if (state.settings.outputOpen && !output.isOpen && output.win) {
    // vom Benutzer geschlossen
    output.win = null;
    state.settings.outputOpen = false;
    save();
  }
}, 1000);

desktop.onCommand((cmd) => {
  if (cmd === 'mic') toggleMic();
  if (cmd === 'output') openOutput();
  if (cmd === 'dock') setFloating(false);
  if (cmd === 'newchat') newChat();
});

// ---------------------------------------------------------------- Eingabe & Fenster
const input = $('input');
const autoGrow = () => {
  input.style.height = 'auto';
  input.style.height = Math.min(140, input.scrollHeight) + 'px';
};
const submit = () => {
  const t = input.value;
  input.value = '';
  autoGrow();
  send(t);
};
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
});
input.addEventListener('input', autoGrow);
$('btnSend').onclick = submit;
$('btnAttach').onclick = () => $('fileAttach').click();
$('fileAttach').onchange = (e) => {
  addAttachments([...e.target.files]);
  e.target.value = '';
};
// Dateien ins Fenster ziehen (sonst würde Electron die Datei als Seite öffnen)
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length && !e.target.closest?.('.drawer')) addAttachments([...e.dataTransfer.files]);
});
$('btnStop').onclick = stopAll;
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.code === 'Space') {
    e.preventDefault();
    toggleMic();
  }
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    newChat();
  }
  if (e.key === 'Escape') {
    if (!$('drawer').hidden) {
      $('drawer').hidden = true;
      previewEdited();
    } else stopAll();
  }
});
setInterval(() => {
  $('btnStop').hidden = !(state.busy || tts.speaking);
}, 250);

$('btnNewChat').onclick = newChat;
// Android: Bild-im-Bild (Figur schwebt über anderen Apps)
$('avPip').onchange = (e) => {
  state.settings.pipOnLeave = e.target.checked;
  save();
  desktop.pipSetEnabled?.(e.target.checked);
};
$('avPipNow').onclick = () => desktop.pipEnter?.();
$('btnPip').onclick = () => desktop.pipEnter?.();
$('btnMin').onclick = () => desktop.minimize();
$('btnClose').onclick = () => desktop.close();
$('btnQuit').onclick = () => desktop.quit();
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
  if (!$('drawer').hidden) {
    fillSettings();
    loadPresets();
    renderMemory();
  }
  previewEdited();
};
$('btnCloseDrawer').onclick = () => {
  $('drawer').hidden = true;
  previewEdited();
};
$('tabs').onclick = (e) => {
  const tab = e.target.dataset?.tab;
  if (!tab) return;
  for (const b of $('tabs').children) b.classList.toggle('active', b.dataset.tab === tab);
  for (const t of document.querySelectorAll('.tab')) t.hidden = t.dataset.tab !== tab;
  if (tab === 'avatar') drawMarkers();
  if (tab === 'memory') renderMemory();
  if (tab === 'conn') {
    if (state.settings.provider === 'lmstudio') refreshModels();
    if (state.settings.provider === 'openai') refreshOpenaiModels();
    refreshModelInfo();
  }
};

function fillSelect(sel, options, value) {
  sel.innerHTML = '';
  for (const [id, label] of options) sel.add(new Option(label, id, false, id === value));
}

function fillSettings() {
  const p = persona();
  const s = state.settings;
  const sel = $('personaSelect');
  sel.innerHTML = '';
  for (const q of state.personas) sel.add(new Option(q.name || 'Ohne Namen', q.id, false, q.id === p.id));
  $('pName').value = p.name;
  $('pPrompt').value = p.prompt;
  $('pGreeting').value = p.greeting;
  $('pLang').value = p.language;
  $('pStyle').value = p.style;

  $('avFloating').checked = s.floating;
  $('avFloatSize').value = s.floatingSize;
  $('avFloatSizeVal').textContent = `${Math.round(s.floatingSize * 100)} %`;
  $('avMouthW').value = target().mouth?.w ?? 0.1;
  $('avEyeR').value = target().eyes?.[0]?.r ?? 0.03;
  $('avMotion').value = p.avatar.motion ?? 1;
  $('avIdleHead').value = p.avatar.idleHead ?? 0.25;
  $('avVrmOff').hidden = !p.avatar.vrm;
  fillRigInfo();
  $('avTurnYaw').value = p.avatar.turnYaw ?? 0;
  $('avTurnYawVal').textContent = `${p.avatar.turnYaw ?? 0}°`;
  $('avTurnAuto').checked = !!p.avatar.turnAuto;
  $('avDepthInfo').textContent = depthValid(p.avatar)
    ? `✔ Tiefe vorhanden (${p.avatar.depthSource === 'KI' ? 'KI' : 'aus dem Umriss'})`
    : 'Tiefe wird beim ersten Drehen automatisch berechnet.';
  renderMorphList();
  $('avVrmOpts').hidden = !p.avatar.vrm;
  $('avVrmYaw').value = p.avatar.vrmYaw ?? 0;
  $('avVrmYawVal').textContent = `${p.avatar.vrmYaw ?? 0}°`;
  $('avVrmFraming').value = p.avatar.vrmFraming ?? 'brust';
  $('avMouthState').textContent = target().mouthImage ? '✔ vorhanden' : '– automatisch (Mund wird aus dem Bild geöffnet)';
  $('avEyesState').textContent = target().eyesImage ? '✔ vorhanden' : '– automatisch (Lider werden gezeichnet)';
  $('avVrmInfo').textContent = p.avatar.vrm
    ? `Aktiv: 3D-Figur „${p.avatar.vrmName ?? 'VRM'}“ – Bild, Mund-/Augenmarkierung und Posen werden solange nicht benutzt.`
    : '';
  $('avOpen').value = target().mouthOpen ?? 1;
  $('avFlip').checked = !!p.avatar.flip;
  $('avRestore').disabled = !target().original;
  renderPoseList();

  $('vSpeak').checked = s.speak;
  $('vEngine').value = p.voice.engine;
  fillSelect($('vPiperDe'), PIPER_VOICES.de, p.voice.de);
  fillSelect($('vPiperEn'), PIPER_VOICES.en, p.voice.en);
  fillSystemVoices();
  $('vRate').value = p.voice.rate;
  $('vSrvUrl').value = s.ttsServerUrl;
  $('vSrvExag').value = p.voice.server.exaggeration;
  $('vSrvCfg').value = p.voice.server.cfg;
  $('vSrvTemp').value = p.voice.server.temperature;
  $('vMax').value = s.maxSentences;
  toggleEngineFields();

  $('sModel').value = s.sttModel;
  $('sLang').value = ['german', 'english'].includes(s.sttLang) ? s.sttLang : 'persona';
  $('sHandsFree').checked = s.handsFree;
  $('avPip').checked = s.pipOnLeave;
  $('appVersion').textContent = `KI-Assistent ${APP_VERSION}${MOBILE ? ' (Android)' : ''}`;
  $('sEngineWrap').hidden = !desktop.transcribeCloud;
  $('sEngine').value = s.sttEngine;
  $('sBargeIn').checked = s.bargeIn;
  $('sLivePause').value = String(s.livePauseMs);
  $('sSens').value = s.sensitivity;

  $('cUrl').value = s.baseUrl;
  $('cTemp').value = s.temperature;
  $('cHistory').value = s.historyLimit;
  $('cOffline').checked = s.offline;
  $('cProvider').value = s.provider;
  if (!LOCAL_ONLY) {
    const knownModel = CLAUDE_MODELS.some(([id]) => id === s.claudeModel);
    fillSelect($('cClaudeModel'), knownModel ? CLAUDE_MODELS : [...CLAUDE_MODELS, [s.claudeModel, s.claudeModel]], s.claudeModel);
    $('cClaudeEffort').value = s.claudeEffort;
    $('cClaudeWeb').checked = s.claudeWeb;
    $('cClaudeFiles').checked = s.claudeFiles;
  }
  toggleProviderFields();
  refreshKeys();
  if (!LOCAL_ONLY) {
    $('vCloudVoice').value = p.voice.cloud?.voice ?? 'nova';
    $('vCloudStyle').value = p.voice.cloud?.instructions ?? '';
    fillCloudTtsModels();
  }
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
if (globalThis.speechSynthesis) speechSynthesis.onvoiceschanged = () => !$('drawer').hidden && fillSystemVoices();

function toggleEngineFields() {
  const engine = $('vEngine').value;
  $('vPiperWrap').hidden = engine !== 'piper';
  $('vSystemWrap').hidden = engine !== 'system';
  $('vServerWrap').hidden = engine !== 'server';
  if ($('vCloudWrap')) $('vCloudWrap').hidden = engine !== 'cloud';
  if (engine === 'cloud') refreshKeys();
  if (engine === 'server') refreshServer();
}

// ---- Lokaler Sprach-Server (Chatterbox)
async function refreshServer() {
  const url = state.settings.ttsServerUrl;
  const sel = $('vSrvVoice');
  const current = persona().voice.server.voice;
  $('vSrvInfo').textContent = 'Verbinde …';
  try {
    const info = await desktop.ttsServerInfo(url);
    sel.innerHTML = '';
    sel.add(new Option('Standardstimme des Servers', '', false, !current));
    const addGroup = (label, items, prefix) => {
      if (!items.length) return;
      const g = document.createElement('optgroup');
      g.label = label;
      for (const f of items) g.appendChild(new Option(f.replace(/\.(wav|mp3)$/i, ''), `${prefix}:${f}`, false, `${prefix}:${f}` === current));
      sel.appendChild(g);
    };
    addGroup('Eigene Stimmen (geklont)', info.references ?? [], 'clone');
    addGroup(
      'Mitgelieferte Stimmen',
      (info.predefined ?? []).map((v) => (typeof v === 'string' ? v : v.filename ?? v.name ?? Object.values(v)[0])),
      'predefined',
    );
    const modelText = info.model ? JSON.stringify(info.model) : '';
    const multi = /multilingual/i.test(modelText);
    $('vSrvMulti').hidden = multi || !info.model;
    $('vSrvInfo').textContent =
      `✔ Verbunden.` +
      (info.model ? (multi ? ' Mehrsprachiges Modell aktiv (Deutsch möglich).' : ' Achtung: Es ist ein englisches Modell aktiv – für Deutsch bitte „Mehrsprachiges Modell aktivieren“.') : '');
  } catch (e) {
    sel.innerHTML = '';
    if (current) sel.add(new Option(current.split(':').pop(), current, false, true));
    $('vSrvMulti').hidden = true;
    $('vSrvInfo').textContent =
      '✖ Sprach-Server nicht erreichbar. Läuft Chatterbox? Zum Einrichten: „Chatterbox installieren / starten …“.';
  }
}

$('vSrvUrl').onchange = (e) => {
  state.settings.ttsServerUrl = e.target.value.trim() || DEFAULT_SETTINGS.ttsServerUrl;
  applyVoice();
  save();
  refreshServer();
};
$('vSrvConnect').onclick = refreshServer;
$('vCloudVoice').onchange = (e) => {
  persona().voice.cloud.voice = e.target.value;
  applyVoice();
  save();
};
$('vCloudStyle').oninput = (e) => {
  persona().voice.cloud.instructions = e.target.value;
  applyVoice();
  save();
};
// Bekannte OpenAI-Sprachmodelle; weitere (neuere, größere) kommen aus dem eigenen Konto dazu
const CLOUD_TTS_MODELS = {
  'gpt-4o-mini-tts': 'gpt-4o-mini-tts – schnell & günstig, Sprechstil steuerbar (Standard)',
  'tts-1-hd': 'tts-1-hd – klassisch, beste Klangqualität, ohne Sprechstil',
  'tts-1': 'tts-1 – klassisch, sehr schnell, ohne Sprechstil',
};
function fillCloudTtsModels(extra = []) {
  const sel = $('vCloudModel');
  const ids = [...new Set([...Object.keys(CLOUD_TTS_MODELS), ...extra, state.settings.cloudTtsModel].filter(Boolean))];
  sel.innerHTML = '';
  for (const id of ids) sel.add(new Option(CLOUD_TTS_MODELS[id] ?? `${id} – aus deinem OpenAI-Konto`, id));
  sel.value = state.settings.cloudTtsModel;
  $('vCloudModelInfo').textContent = /^tts-1/.test(sel.value)
    ? 'Hinweis: Dieses Modell beachtet den Sprechstil nicht; neue Stimmen wie Ballad/Verse fallen auf Nova zurück.'
    : '';
}
async function refreshCloudTtsModels() {
  try {
    const ids = await desktop.openaiTtsModels();
    fillCloudTtsModels(ids);
    status(`${ids.length} Sprachmodelle im OpenAI-Konto gefunden.`);
  } catch (e) {
    status(`Modelle konnten nicht geladen werden: ${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
  }
}
$('vCloudModelRefresh').onclick = refreshCloudTtsModels;
$('vCloudModel').onchange = (e) => {
  state.settings.cloudTtsModel = e.target.value || DEFAULT_SETTINGS.cloudTtsModel;
  fillCloudTtsModels([...$('vCloudModel').options].map((o) => o.value));
  applyVoice();
  save();
};
$('vSrvSetup').onclick = () => desktop.openTtsScripts();
$('vSrvMulti').onclick = async () => {
  $('vSrvMulti').disabled = true;
  $('vSrvInfo').textContent = 'Stelle auf das mehrsprachige Modell um … beim ersten Mal wird es geladen (einige GB, kann dauern).';
  try {
    await desktop.ttsServerMultilingual(state.settings.ttsServerUrl);
  } catch (e) {
    status(`Umstellen fehlgeschlagen: ${e.message}`);
  } finally {
    $('vSrvMulti').disabled = false;
    refreshServer();
  }
};
$('vSrvVoice').onchange = (e) => {
  persona().voice.server.voice = e.target.value;
  applyVoice();
  save();
};
for (const [id, key] of [['vSrvExag', 'exaggeration'], ['vSrvCfg', 'cfg'], ['vSrvTemp', 'temperature']]) {
  $(id).oninput = (e) => {
    persona().voice.server[key] = +e.target.value;
    applyVoice();
    save();
  };
}

/** Float32-Mono als 16-Bit-WAV kodieren. */
function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Uint8Array(buf);
}

async function uploadVoice(name, bytes) {
  const res = await desktop.ttsServerUpload(state.settings.ttsServerUrl, name, bytes);
  const saved = res?.uploaded_files?.[0] ?? name;
  persona().voice.server.voice = `clone:${saved}`;
  applyVoice();
  save();
  await refreshServer();
  status(`Stimme „${saved}“ gespeichert und für ${persona().name} ausgewählt. Mit „▶ Stimme testen“ anhören.`);
}

const slug = (t) => (t || 'stimme').toLowerCase().replace(/[^a-z0-9äöüß]+/gi, '-').replace(/^-|-$/g, '');
const REC_TEXT = {
  de: 'Hallo, schön, dass du da bist. Ich freue mich wirklich, heute mit dir zu sprechen. Lass uns gemeinsam überlegen, wie wir dein Projekt Schritt für Schritt voranbringen können – ganz in Ruhe und mit einem Lächeln.',
  en: 'Hello, it is great to have you here. I am really looking forward to talking with you today. Let us think together about how we can move your project forward, step by step, calmly and with a smile.',
};

$('vRecord').onclick = async () => {
  let stream;
  let ctx;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
    ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(proc);
    proc.connect(ctx.destination);
    $('vRecText').textContent = REC_TEXT[persona().language] ?? REC_TEXT.de;
    $('vRecBox').hidden = false;
    $('vRecord').disabled = true;
    const t0 = Date.now();
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        const sec = (Date.now() - t0) / 1000;
        $('vRecTime').textContent = `● ${sec.toFixed(0)} s`;
        if (sec >= 25) finish();
      }, 200);
      const finish = () => {
        clearInterval(timer);
        resolve();
      };
      $('vRecStop').onclick = finish;
    });
    proc.disconnect();
    const len = chunks.reduce((n, c) => n + c.length, 0);
    if (len < ctx.sampleRate * 4) throw new Error('Die Aufnahme war zu kurz – bitte mindestens 5 Sekunden sprechen.');
    const all = new Float32Array(len);
    let off = 0;
    for (const c of chunks) {
      all.set(c, off);
      off += c.length;
    }
    // Lautstärke angleichen
    let peak = 0;
    for (const x of all) peak = Math.max(peak, Math.abs(x));
    if (peak > 0) for (let i = 0; i < all.length; i++) all[i] = (all[i] / peak) * 0.9;
    status('Stimme wird zum Sprach-Server übertragen …');
    await uploadVoice(`${slug(persona().name)}-${Date.now()}.wav`, encodeWav(all, ctx.sampleRate));
  } catch (e) {
    status(`Aufnahme: ${e.message}`);
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
    ctx?.close();
    $('vRecBox').hidden = true;
    $('vRecord').disabled = false;
  }
};
$('vUpload').onclick = () => $('vUploadFile').click();
$('vUploadFile').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    await uploadVoice(f.name.replace(/[^\w.\-äöüß]+/gi, '_'), new Uint8Array(await f.arrayBuffer()));
  } catch (err) {
    status(`Hochladen fehlgeschlagen: ${err.message}`);
  }
};

// Persona-Felder
const personaField = (id, key, after) => {
  $(id).oninput = (e) => {
    persona()[key] = e.target.value;
    after?.(e.target.value);
    save();
  };
};
$('personaSelect').onchange = (e) => {
  stopAll();
  state.activeId = e.target.value;
  save();
  applyPersona();
  fillSettings();
};
personaField('pName', 'name', (v) => {
  $('titleName').textContent = v || 'KI-Assistent';
  $('personaSelect').selectedOptions[0].text = v || 'Ohne Namen';
});
personaField('pPrompt', 'prompt');
personaField('pGreeting', 'greeting');
$('pLang').onchange = (e) => {
  persona().language = e.target.value;
  applyVoice();
  save();
};
// Systemprompts aus LM Studio (Presets und Chats)
let presets = [];
async function loadPresets() {
  presets = (await desktop.lmStudioPrompts().catch(() => [])) ?? [];
  const sel = $('pPreset');
  sel.innerHTML = '';
  if (!presets.length) {
    sel.add(new Option('Keine Systemprompts in LM Studio gefunden', ''));
    return;
  }
  sel.add(new Option(`– ${presets.length} gefunden, bitte wählen –`, ''));
  for (const source of ['Preset', 'Chat']) {
    const group = document.createElement('optgroup');
    group.label = source === 'Preset' ? 'Presets' : 'Chats';
    presets.forEach((p, i) => {
      if (p.source !== source) return;
      const preview = p.systemPrompt.replace(/\s+/g, ' ').slice(0, 60);
      group.appendChild(new Option(`${p.name} – ${preview}${p.systemPrompt.length > 60 ? '…' : ''}`, String(i)));
    });
    if (group.children.length) sel.appendChild(group);
  }
}
const selectedPreset = () => presets[+$('pPreset').value] ?? null;
function applyPreset(target, preset) {
  target.prompt = preset.systemPrompt;
  target.style = 'frei';
  if (typeof preset.temperature === 'number') state.settings.temperature = preset.temperature;
}
$('pPresetLoad').onclick = loadPresets;
$('pPresetApply').onclick = () => {
  const preset = selectedPreset();
  if (!preset) return status('Bitte zuerst einen Systemprompt auswählen.');
  const p = persona();
  if (p.prompt?.trim() && p.prompt !== preset.systemPrompt && !confirm('Den aktuellen Systemprompt ersetzen?')) return;
  applyPreset(p, preset);
  save();
  fillSettings();
  status(`Systemprompt übernommen: „${preset.name}“.`);
};
$('pPresetNew').onclick = () => {
  const preset = selectedPreset();
  if (!preset) return status('Bitte zuerst einen Systemprompt auswählen.');
  const p = structuredClone(persona());
  p.id = newId();
  p.name = preset.name.slice(0, 40);
  p.greeting = '';
  p.memory = [];
  applyPreset(p, preset);
  switchTo(p);
  status(`Neue Persona „${p.name}“ angelegt – Avatar und Stimme wurden von der bisherigen übernommen.`);
};

$('pStyle').onchange = (e) => {
  persona().style = e.target.value;
  save();
};
const switchTo = (p) => {
  state.personas.push(p);
  state.activeId = p.id;
  save();
  applyPersona();
  fillSettings();
};
$('personaNew').onclick = () => {
  const p = defaultPersona();
  // Technik der aktuellen Persona übernehmen (Stimme, Sprache, Stil) – neu sind nur Name, Text, Figur, Gedächtnis
  const cur = persona();
  p.voice = structuredClone(cur.voice);
  p.language = cur.language;
  p.style = cur.style;
  p.name = 'Neue Persona';
  p.prompt = 'Du bist ein hilfsbereiter Assistent.';
  p.greeting = 'Hallo!';
  switchTo(p);
};
$('personaCopy').onclick = () => {
  const p = structuredClone(persona());
  p.id = newId();
  p.name += ' (Kopie)';
  p.memory = [];
  switchTo(p);
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
  // Das Gedächtnis ist privat und wird nicht mit exportiert
  delete p.memory;
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
    switchTo(migratePersona({ ...defaultPersona(), ...data, id: newId() }));
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
  output.setHistory([]);
};

// ---------------------------------------------------------------- Avatar-Editor
// Bearbeitet wird entweder das Grundbild (editIndex = -1) oder eine Pose.
let editIndex = -1;
const target = () => (editIndex >= 0 ? persona().avatar.poses?.[editIndex] : null) ?? persona().avatar;
let markMode = null;
let markerImg = null;
let markerImgSrc = null;

function setMarkMode(mode) {
  markMode = mode;
  for (const o of document.querySelectorAll('[data-mark]')) o.classList.toggle('active', o.dataset.mark === markMode);
}

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
  const mask = await getMaskCanvas();
  if (mask) {
    // Maske rot eingefärbt darüberlegen
    const tint = document.createElement('canvas');
    tint.width = w;
    tint.height = h;
    const tg = tint.getContext('2d');
    tg.drawImage(mask, 0, 0, w, h);
    tg.globalCompositeOperation = 'source-in';
    tg.fillStyle = 'rgba(255, 60, 90, 0.55)';
    tg.fillRect(0, 0, w, h);
    g.drawImage(tint, 0, 0);
  }
  g.lineWidth = 2;
  const m = p.avatar.mouthMask ? null : p.avatar.mouth;
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
  applyAvatar();
  ensureFaceRig();
  renderPoseList();
  drawMarkers();
  $('avRestore').disabled = !target().original;
}

for (const b of document.querySelectorAll('[data-mark]')) {
  b.onclick = () => setMarkMode(markMode === b.dataset.mark ? null : b.dataset.mark);
}
// ---- Lippen-Maske malen
let maskCanvas = null; // Maske in Bildauflösung (max. 1024 px)
let maskFor = null;

async function getMaskCanvas(create = false) {
  const av = target();
  const key = av.image + '|' + (av.mouthMask ?? '');
  if (maskCanvas && maskFor === key) return maskCanvas;
  if (!av.mouthMask && !create) return null;
  const img = markerImg ?? (await loadImage(av.image));
  const s = Math.min(1, 1024 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * s);
  c.height = Math.round(img.height * s);
  if (av.mouthMask) c.getContext('2d').drawImage(await loadImage(av.mouthMask), 0, 0, c.width, c.height);
  maskCanvas = c;
  maskFor = key;
  return c;
}

/** Mund-Markierung aus der Maske ableiten (Mitte und Breite). */
function mouthFromMask(c) {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width;
  let x1 = -1;
  let y0 = c.height;
  let y1 = -1;
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++)
      if (d[(y * c.width + x) * 4 + 3] > 64) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  return { x: (x0 + x1) / 2 / c.width, y: (y0 + y1) / 2 / c.height, w: (x1 - x0 + 1) / c.width };
}

let painting = false;
$('markerCanvas').addEventListener('pointerdown', async (e) => {
  if (markMode !== 'paint' && markMode !== 'erase') return;
  painting = true;
  e.target.setPointerCapture(e.pointerId);
  await getMaskCanvas(true);
  paintAt(e);
});
$('markerCanvas').addEventListener('pointermove', (e) => painting && paintAt(e));
$('markerCanvas').addEventListener('pointerup', async () => {
  if (!painting) return;
  painting = false;
  const av = target();
  const derived = mouthFromMask(maskCanvas);
  av.mouthMask = derived ? maskCanvas.toDataURL('image/png') : null;
  if (derived) av.mouth = derived;
  maskFor = av.image + '|' + (av.mouthMask ?? '');
  avatarChanged();
});

function paintAt(e) {
  if (!maskCanvas) return;
  const r = e.target.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * maskCanvas.width;
  const y = ((e.clientY - r.top) / r.height) * maskCanvas.height;
  const size = (+$('avBrush').value / r.width) * maskCanvas.width;
  const g = maskCanvas.getContext('2d');
  g.globalCompositeOperation = markMode === 'erase' ? 'destination-out' : 'source-over';
  g.fillStyle = '#ff0000';
  g.beginPath();
  g.arc(x, y, size / 2, 0, Math.PI * 2);
  g.fill();
  drawMarkers();
}

$('avMaskClear').onclick = () => {
  target().mouthMask = null;
  maskCanvas = null;
  avatarChanged();
};
$('avOpen').oninput = (e) => {
  target().mouthOpen = +e.target.value;
  avatarChanged();
};

/** Maske bei Zuschnitt/Wiederherstellen mitverschieben. */
async function remapMask(av, from, to, outW, outH) {
  if (!av.mouthMask) return;
  const img = await loadImage(av.mouthMask);
  const c = document.createElement('canvas');
  c.width = outW;
  c.height = outH;
  const sx = outW / to.w;
  const sy = outH / to.h;
  c.getContext('2d').drawImage(img, (from.x - to.x) * sx, (from.y - to.y) * sy, from.w * sx, from.h * sy);
  av.mouthMask = c.toDataURL('image/png');
}

$('markerCanvas').onclick = (e) => {
  if (!markMode || markMode === 'paint' || markMode === 'erase') return;
  const r = e.target.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  const av = target();
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
  setMarkMode(order[order.indexOf(markMode) + 1] ?? null);
  avatarChanged();
};
$('avMouthW').oninput = (e) => {
  const av = target();
  av.mouth = { ...(av.mouth ?? { x: 0.5, y: 0.5 }), w: +e.target.value };
  avatarChanged();
};
$('avEyeR').oninput = (e) => {
  for (const eye of target().eyes ?? []) eye.r = +e.target.value;
  avatarChanged();
};
$('avFlip').onchange = (e) => {
  persona().avatar.flip = e.target.checked;
  if (floating.avatar) floating.avatar.flip = e.target.checked;
  avatar.flip = e.target.checked;
  save();
};
$('avResetPos').onclick = () => {
  persona().avatar.stage = null;
  avatar.layout = { x: 0, y: 0, scale: 1 };
  save();
};
$('avIdleHead').oninput = (e) => {
  persona().avatar.idleHead = +e.target.value;
  avatar.idleHead = +e.target.value;
  if (floating.avatar) floating.avatar.idleHead = +e.target.value;
  save();
};
$('avMotion').oninput = (e) => {
  persona().avatar.motion = +e.target.value;
  avatar.motion = +e.target.value;
  if (floating.avatar) floating.avatar.motion = +e.target.value;
  save();
};

async function imageToCanvas(src, max = 1024) {
  const img = await loadImage(src);
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * s);
  c.height = Math.round(img.height * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/** Bild verkleinern (max. 1024 px) und als Data-URL speichern. */
async function readImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const c = await imageToCanvas(url);
    return file.type === 'image/png' || file.type === 'image/webp' || file.type === 'image/svg+xml'
      ? c.toDataURL('image/png')
      : c.toDataURL('image/jpeg', 0.92);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Markierungen zwischen Originalbild und zugeschnittenem Bild umrechnen
function remapMarkers(av, from, to) {
  // from/to: { x, y, w, h } Ausschnitt in Original-Pixeln
  const mx = (x) => (x * from.w + from.x - to.x) / to.w;
  const my = (y) => (y * from.h + from.y - to.y) / to.h;
  const sx = from.w / to.w;
  if (av.mouth) av.mouth = { x: mx(av.mouth.x), y: my(av.mouth.y), w: av.mouth.w * sx };
  av.eyes = (av.eyes ?? []).map((e) => ({ x: mx(e.x), y: my(e.y), r: e.r * sx }));
}

// ---- 3D-Figur (VRM)
$('avVrm').onclick = () => $('avVrmFile').click();
$('avVrmFile').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 150 * 1024 * 1024) return status('Die VRM-Datei ist zu groß (max. 150 MB).');
  await useVrm(new Uint8Array(await file.arrayBuffer()), file.name);
};

/** VRM-Daten speichern und als 3D-Figur der aktuellen Persona verwenden. Wirft bei Ladefehlern. */
async function useVrm(bytes, name) {
  status('3D-Figur wird geladen …');
  const av = persona().avatar;
  const old = av.vrm;
  av.vrm = await desktop.saveMedia(bytes, 'vrm');
  av.vrmName = name;
  try {
    await avatar.setConfig(av);
    if (old) desktop.deleteMedia(old);
    status('3D-Figur geladen.');
  } catch (err) {
    desktop.deleteMedia(av.vrm);
    if (old) av.vrm = old;
    else delete av.vrm;
    status(`Die Figur konnte nicht geladen werden: ${err.message}`);
    throw err;
  } finally {
    fillSettings();
    avatarChanged();
  }
}

// 3D-Figur aus Bildern (bild2vrm): Bilder werden wie beim Avatar-Bild freigestellt –
// vorhandene Transparenz, sonst einfarbiger Hintergrund, sonst KI.
async function prepareFigureImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const canvas = await imageToCanvas(url, 2048);
    if (hasTransparency(canvas)) return canvas;
    if (hasUniformBorder(canvas, +$('avTol').value)) {
      const { canvas: out, removed } = removeBackground(canvas, { tolerance: +$('avTol').value });
      if (removed >= 0.02) return out;
    }
    const imageData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const rgba = await stt.removeBackground(imageData, progressStatus('Freistellen'));
    return applyAlpha(canvas, rgba).canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}
$('avVrmCreate').onclick = async () => {
  const [{ openBild2VrmDialog }, { detectFigure }] = await Promise.all([import('./bild2vrm-dialog.js'), import('./bild2vrm-detect.js')]);
  openBild2VrmDialog({ prepare: prepareFigureImage, onCreated: useVrm, detect: detectFigure, defaultName: persona().name || 'Meine Figur' });
};
$('avVrmYaw').oninput = (e) => setVrmYaw(+e.target.value);

// ---- Bild-Figur leicht drehen (Tiefenkarte)
const depthValid = (av) => !!av.depth && av.depthFor === imageKey(av.image);
let depthJob = null;
async function ensureDepth({ force = false } = {}) {
  const av = persona().avatar;
  if (!force && depthValid(av)) return true;
  if (depthJob) return depthJob;
  depthJob = (async () => {
    try {
      $('avDepthInfo').textContent = 'Tiefe wird berechnet … (beim ersten Mal wird ein KI-Modell geladen, ca. 25 MB)';
      const img = await imageToCanvas(av.image);
      const { url, source } = await buildDepthMap(img, (id) => stt.estimateDepth(id, progressStatus('Tiefenschätzung')));
      av.depth = url;
      av.depthFor = imageKey(av.image);
      av.depthSource = source;
      status(source === 'KI' ? 'Tiefe per KI berechnet.' : 'KI-Tiefe nicht verfügbar – nutze Tiefe aus dem Umriss.');
      fillSettings();
      avatarChanged();
      return true;
    } catch (e) {
      status(`Tiefe konnte nicht berechnet werden: ${e.message}`);
      return false;
    } finally {
      depthJob = null;
    }
  })();
  return depthJob;
}
$('avTurnYaw').oninput = (e) => {
  setTurnYaw(+e.target.value);
  ensureDepth();
};
$('avTurnAuto').onchange = (e) => {
  persona().avatar.turnAuto = e.target.checked;
  avatar.turnAuto = e.target.checked;
  if (floating.avatar) floating.avatar.turnAuto = e.target.checked;
  save();
  if (e.target.checked) ensureDepth();
};
$('avDepthCalc').onclick = () => ensureDepth({ force: true });
$('avVrmFraming').onchange = (e) => {
  persona().avatar.vrmFraming = e.target.value;
  avatar.vrmFraming = e.target.value;
  if (floating.avatar) floating.avatar.vrmFraming = e.target.value;
  save();
};
$('avVrmOff').onclick = () => {
  const av = persona().avatar;
  if (av.vrm) desktop.deleteMedia(av.vrm);
  delete av.vrm;
  delete av.vrmName;
  fillSettings();
  avatarChanged();
};

// ---- Bewegungsbilder (Morphing im Leerlauf)
function renderMorphList() {
  const av = persona().avatar;
  const list = $('avMorphList');
  list.innerHTML = '';
  (av.morphs ?? []).forEach((src, i) => {
    const row = document.createElement('div');
    row.className = 'pose-row';
    const img = document.createElement('img');
    img.src = src;
    const label = document.createElement('span');
    label.textContent = `Bewegungsbild ${i + 1}`;
    label.style.flex = '1';
    const play = document.createElement('button');
    play.textContent = '▶';
    play.title = 'Übergang ansehen';
    play.onclick = () => {
      avatar.previewMorph(i);
      floating.avatar?.previewMorph(i);
    };
    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = 'Entfernen';
    del.onclick = () => {
      av.morphs.splice(i, 1);
      renderMorphList();
      avatarChanged();
    };
    row.append(img, label, play, del);
    list.appendChild(row);
  });
  $('avMorphAdd').disabled = (av.morphs?.length ?? 0) >= 4;
}
$('avMorphAdd').onclick = () => $('avMorphFile').click();
$('avMorphFile').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  const av = persona().avatar;
  av.morphs ??= [];
  for (const f of files) {
    if (av.morphs.length >= 4) break;
    status('Bewegungsbild wird vorbereitet …');
    av.morphs.push(await alignToBase(av, await readImage(f)));
  }
  renderMorphList();
  avatarChanged();
  status('Bewegungsbild hinzugefügt – mit ▶ den Übergang ansehen.');
};

$('avUpload').onclick = () => $('avFile').click();
$('avFile').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const av = target();
  if (file.type.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(file.name)) {
    if (editIndex < 0) return status('Videos bitte als Pose hinzufügen (⚙ → Avatar → „＋ Pose hinzufügen“).');
    if (file.size > 60 * 1024 * 1024) return status('Das Video ist zu groß (max. 60 MB). Kurze Clips von 2–5 Sekunden reichen.');
    status('Video wird gespeichert …');
    if (av.video) desktop.deleteMedia(av.video);
    av.video = await desktop.saveMedia(new Uint8Array(await file.arrayBuffer()), file.name.split('.').pop());
    av.image = null;
    av.keyTol ??= 30;
    av.loop ??= false;
    if (av.mask) desktop.deleteMedia(av.mask);
    av.mask = null;
    // Greenscreen -> schnelles Farbverfahren, sonst (z. B. weiße Wand) KI-Freistellung
    av.cutMode = (await isGreenScreen(av.video)) ? 'color' : 'ai';
    delete av.key;
    avatarChanged();
    previewEdited();
    if (av.cutMode === 'ai') await computeMaskFor(av);
    else status('Video-Pose hinzugefügt – Greenscreen erkannt, wird live entfernt.');
    return;
  }
  av.video = null;
  av.image = await readImage(file);
  av.original = null;
  av.crop = null;
  av.mouthMask = null;
  av.mouthImage = null;
  av.eyesImage = null;
  av.mouth = null;
  av.eyes = [];
  avatarChanged();
  await cutoutAvatar('auto');
  if (editIndex >= 0 && (await copyMarkersFromMain(av))) {
    status('Pose hinzugefügt – Mund und Augen wurden vom Grundbild übernommen. Bei Bedarf korrigieren.');
    avatarChanged();
    return;
  }
  const face = await detectFace(av.image);
  if (face) {
    av.mouth = face.mouth;
    av.eyes = face.eyes;
    status('Gesicht erkannt – Markierungen bei Bedarf korrigieren.');
  } else {
    setMarkMode('paint');
    status('Bitte die Lippen ausmalen (🖌) oder die Mundmitte anklicken, danach beide Augen anklicken.');
  }
  avatarChanged();
};

/**
 * Figur freistellen. mode: 'auto' (einfarbig -> Farbe, sonst KI), 'color' oder 'ai'.
 * Das Original bleibt erhalten; Markierungen und Lippen-Maske werden mitverschoben.
 */
async function cutoutAvatar(mode = 'auto') {
  const av = target();
  const buttons = [$('avCutout'), $('avCutoutAi')];
  buttons.forEach((b) => (b.disabled = true));
  try {
    const src = av.original ?? av.image;
    const canvas = await imageToCanvas(src);
    if (mode === 'auto' && hasTransparency(canvas)) return false;
    const useColor = mode === 'color' || (mode === 'auto' && hasUniformBorder(canvas, +$('avTol').value));
    let result;
    if (useColor) {
      result = removeBackground(canvas, { tolerance: +$('avTol').value });
    } else {
      status('Figur wird per KI freigestellt …');
      const imageData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      const rgba = await stt.removeBackground(imageData, progressStatus('Freistellen'));
      result = applyAlpha(canvas, rgba);
    }
    const { canvas: out, crop, removed } = result;
    if (removed < 0.02) {
      status(
        useColor
          ? 'Kein einfarbiger Hintergrund gefunden – „✨ Freistellen mit KI“ versuchen.'
          : 'Die KI hat keinen Hintergrund gefunden.',
      );
      return false;
    }
    const full = { x: 0, y: 0, w: canvas.width, h: canvas.height };
    await remapMask(av, av.crop ?? full, crop, out.width, out.height);
    remapMarkers(av, av.crop ?? full, crop);
    av.original ??= src;
    av.crop = crop;
    av.image = out.toDataURL('image/png');
    status(
      `Hintergrund entfernt (${useColor ? 'Farbverfahren' : 'KI'}). Passt es nicht: ` +
        (useColor ? 'Toleranz ändern oder „✨ Freistellen mit KI“.' : '„Original wiederherstellen“.'),
    );
    avatarChanged();
    return true;
  } catch (err) {
    status(`Freistellen fehlgeschlagen: ${friendlyError(err)}`);
    return false;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

// ---- Video-Freistellung
async function videoFirstFrame(url) {
  const v = document.createElement('video');
  v.muted = true;
  v.src = url;
  await new Promise((resolve, reject) => {
    v.onloadeddata = resolve;
    v.onerror = () => reject(new Error('Video konnte nicht geladen werden'));
  });
  const c = document.createElement('canvas');
  c.width = 160;
  c.height = Math.max(2, Math.round((160 * v.videoHeight) / v.videoWidth));
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  v.src = '';
  return c;
}

async function isGreenScreen(url) {
  try {
    const c = await videoFirstFrame(url);
    const [r, g, b] = borderColor(c.getContext('2d').getImageData(0, 0, c.width, c.height).data, c.width, c.height);
    return g > r + 30 && g > b + 30;
  } catch {
    return false;
  }
}

/** Video einmal Bild für Bild per KI freistellen und die Masken speichern. */
async function computeMaskFor(pose) {
  try {
    status('Video wird per KI freigestellt … (einmalig)');
    const t0 = performance.now();
    const bytes = await computeVideoMask(
      pose.video,
      (img) => stt.removeBackground(img, progressStatus('Freistellen')),
      (done, total) => status(`Video wird per KI freigestellt … ${done} / ${total} Bilder`),
    );
    if (pose.mask) desktop.deleteMedia(pose.mask);
    pose.mask = await desktop.saveMedia(bytes, 'mask');
    pose.cutMode = 'ai';
    save();
    applyAvatar();
    previewEdited();
    renderPoseList();
    status(`Video freigestellt (${((performance.now() - t0) / 1000).toFixed(0)} s). Passt es nicht: Freistell-Art in der Posen-Liste ändern.`);
  } catch (e) {
    status(`KI-Freistellen fehlgeschlagen: ${friendlyError(e)} – Freistell-Art „Einfarbige Wand“ versuchen.`);
  }
}

// ---- Posen
/** Markierungen und Lippen-Maske des Grundbilds auf eine Pose übertragen (gleicher Bildausschnitt angenommen). */
async function copyMarkersFromMain(pose) {
  const main = persona().avatar;
  if (!main.mouth && !main.mouthMask) return false;
  const mainOrig = await imageToCanvas(main.original ?? main.image);
  const poseOrig = await imageToCanvas(pose.original ?? pose.image);
  // beide Originale auf gleiche Größe beziehen
  const sx = poseOrig.width / mainOrig.width;
  const sy = poseOrig.height / mainOrig.height;
  const mainCrop = main.crop ?? { x: 0, y: 0, w: mainOrig.width, h: mainOrig.height };
  const from = { x: mainCrop.x * sx, y: mainCrop.y * sy, w: mainCrop.w * sx, h: mainCrop.h * sy };
  const to = pose.crop ?? { x: 0, y: 0, w: poseOrig.width, h: poseOrig.height };
  pose.mouth = main.mouth ? { ...main.mouth } : null;
  pose.eyes = (main.eyes ?? []).map((e) => ({ ...e }));
  pose.mouthMask = main.mouthMask ?? null;
  pose.mouthOpen = main.mouthOpen;
  const img = await imageToCanvas(pose.image);
  await remapMask(pose, from, to, img.width, img.height);
  remapMarkers(pose, from, to);
  return true;
}

const TRIGGERS = [
  ['speak', 'beim Sprechen'],
  ['think', 'beim Nachdenken'],
  ['listen', 'beim Zuhören'],
  ['idle', 'in Ruhe, ab und zu'],
];

function setEditIndex(i) {
  editIndex = i;
  maskCanvas = null;
  setMarkMode(null);
  fillSettings();
  drawMarkers();
  previewEdited();
}

/** Im Editor die gerade bearbeitete Pose anzeigen. */
function previewEdited() {
  const poses = persona().avatar.poses ?? [];
  let layer = null;
  const usable = (p) => p.image || p.video;
  if (editIndex >= 0 && usable(poses[editIndex] ?? {})) layer = 1 + poses.slice(0, editIndex).filter(usable).length;
  const drawerOpen = !$('drawer').hidden;
  avatar.previewPose(drawerOpen ? layer ?? (editIndex >= 0 ? null : 0) : null);
  floating.avatar?.previewPose(drawerOpen ? layer ?? (editIndex >= 0 ? null : 0) : null);
}

function renderPoseList() {
  const list = $('poseList');
  if (!list) return;
  const poses = (persona().avatar.poses ??= []);
  list.innerHTML = '';
  poses.forEach((pose, i) => {
    const row = document.createElement('div');
    row.className = 'pose-row' + (i === editIndex ? ' editing' : '');
    let img;
    if (pose.video) {
      img = document.createElement('video');
      img.src = pose.video;
      img.muted = true;
      img.loop = true;
      img.autoplay = true;
      img.playsInline = true;
    } else {
      img = document.createElement('img');
      if (pose.image) img.src = pose.image;
    }
    const name = document.createElement('input');
    name.value = pose.name ?? `Pose ${i + 1}`;
    name.oninput = () => {
      pose.name = name.value;
      save();
    };
    const trig = document.createElement('select');
    for (const [v, label] of TRIGGERS) trig.add(new Option(label, v, false, v === (pose.trigger ?? 'speak')));
    trig.onchange = () => {
      pose.trigger = trig.value;
      save();
      applyAvatar();
    };
    const edit = document.createElement('button');
    edit.textContent = '✎';
    edit.title = 'Diese Pose bearbeiten (Mund, Augen, Freistellen)';
    edit.onclick = () => setEditIndex(i);
    const del = document.createElement('button');
    del.textContent = '🗑';
    del.title = 'Pose löschen';
    del.onclick = () => {
      if (!confirm(`Pose „${pose.name ?? i + 1}“ löschen?`)) return;
      if (pose.video) desktop.deleteMedia(pose.video);
      if (pose.mask) desktop.deleteMedia(pose.mask);
      poses.splice(i, 1);
      if (editIndex >= poses.length) editIndex = -1;
      setEditIndex(editIndex === i ? -1 : editIndex > i ? editIndex - 1 : editIndex);
      avatarChanged();
    };
    row.append(img, name, trig, edit, del);
    list.appendChild(row);
    if (pose.video) {
      const opts = document.createElement('div');
      opts.className = 'pose-opts';
      const check = (label, key) => {
        const l = document.createElement('label');
        const c = document.createElement('input');
        c.type = 'checkbox';
        c.checked = !!pose[key];
        c.onchange = () => {
          pose[key] = c.checked;
          save();
          applyAvatar();
          previewEdited();
        };
        l.append(c, label);
        return l;
      };
      const tol = document.createElement('label');
      const r = document.createElement('input');
      r.type = 'range';
      r.min = 5;
      r.max = 80;
      r.value = pose.keyTol ?? 30;
      r.onchange = () => {
        pose.keyTol = +r.value;
        save();
        applyAvatar();
        previewEdited();
      };
      tol.append('Toleranz', r);
      const modeLabel = document.createElement('label');
      const mode = document.createElement('select');
      const current = pose.cutMode ?? (pose.key ? 'color' : 'none');
      for (const [v, label] of [
        ['ai', 'KI (beste Qualität)'],
        ['flood', 'Einfarbige Wand'],
        ['color', 'Greenscreen'],
        ['none', 'nicht freistellen'],
      ])
        mode.add(new Option(label, v, false, v === current));
      mode.onchange = async () => {
        pose.cutMode = mode.value;
        delete pose.key;
        save();
        if (pose.cutMode === 'ai' && !pose.mask) await computeMaskFor(pose);
        applyAvatar();
        previewEdited();
        renderPoseList();
      };
      modeLabel.append('Freistellen', mode);
      opts.append(check('Schleife', 'loop'), modeLabel);
      if (current === 'flood' || current === 'color') opts.append(tol);
      if (current === 'ai') {
        const redo = document.createElement('button');
        redo.textContent = pose.mask ? 'KI neu berechnen' : 'KI-Freistellung berechnen';
        redo.onclick = () => computeMaskFor(pose);
        opts.append(redo);
      }
      list.appendChild(opts);
    }
  });
  $('editInfo').textContent =
    editIndex >= 0
      ? poses[editIndex]?.video
        ? `Du bearbeitest: ${poses[editIndex]?.name ?? 'Pose'} (Video) – Abspielart und Freistellen direkt in der Liste oben.`
        : `Du bearbeitest: ${poses[editIndex]?.name ?? 'Pose'} – Freistellen, Mund und Augen gelten für diese Pose.`
      : poses.length
        ? 'Du bearbeitest: Grundbild.'
        : '';
}

$('poseAdd').onclick = () => {
  const poses = (persona().avatar.poses ??= []);
  poses.push({ id: newId(), name: `Pose ${poses.length + 1}`, trigger: 'speak', image: null });
  editIndex = poses.length - 1;
  renderPoseList();
  $('avFile').click();
};
$('poseEditMain').onclick = () => setEditIndex(-1);

$('avCutout').onclick = () => cutoutAvatar('color');
$('avCutoutAi').onclick = () => cutoutAvatar('ai');
$('avRestore').onclick = async () => {
  const av = target();
  if (!av.original) return;
  const canvas = await imageToCanvas(av.original);
  const full = { x: 0, y: 0, w: canvas.width, h: canvas.height };
  await remapMask(av, av.crop, full, canvas.width, canvas.height);
  remapMarkers(av, av.crop, full);
  av.image = av.original;
  av.original = null;
  av.crop = null;
  avatarChanged();
};
$('avDefault').onclick = () => {
  if (editIndex >= 0) return status('Die Standard-Figur ersetzt nur das Grundbild – bitte zuerst „Grundbild bearbeiten“ wählen.');
  persona().avatar = { ...structuredClone(DEFAULT_AVATAR), poses: persona().avatar.poses ?? [] };
  fillSettings();
  avatarChanged();
};
$('avAuto').onclick = async () => {
  // Erst die genaue Gesichtserkennung (MediaPipe), sonst die einfache des Browsers
  try {
    const img = await imageToCanvas(target().image);
    const rig = await detectFaceRig(img);
    if (rig) {
      Object.assign(target(), markersFromRig(rig));
      avatarChanged();
      return status('Augen und Mund automatisch gesetzt.');
    }
  } catch (e) {
    console.warn('Gesichtserkennung:', e);
  }
  const face = await detectFace(target().image);
  if (!face) return status('Automatische Erkennung nicht möglich – bitte manuell markieren.');
  Object.assign(target(), face);
  avatarChanged();
};

// ---- Gesichts-Rig: einmal pro Grundbild Gesichtspunkte erkennen (lokal, MediaPipe)
let rigJob = null;
async function ensureFaceRig({ force = false } = {}) {
  const av = persona().avatar;
  if (av.vrm || av.faceRigOn === false || !av.image) return;
  const key = imageKey(av.image);
  if (!force && av.faceRigFor === key) return;
  if (rigJob) return rigJob;
  rigJob = (async () => {
    try {
      $('avRigInfo').textContent = 'Gesicht wird erkannt …';
      const rig = await detectFaceRig(await imageToCanvas(av.image));
      av.faceRig = rig;
      av.faceRigFor = key;
      // Markierungen für Mund/Augen setzen, falls noch keine da sind
      if (rig && (!av.mouth || !av.eyes?.length)) Object.assign(av, markersFromRig(rig));
      save();
      applyAvatar();
      drawMarkers();
      status(rig ? 'Gesicht erkannt: Blinzeln, Blick, Brauen und Mundform sind jetzt lebendig.' : '');
    } catch (e) {
      console.warn('Gesichtserkennung:', e);
    } finally {
      rigJob = null;
      $('avRigInfo') && fillRigInfo();
    }
  })();
  return rigJob;
}
function fillRigInfo() {
  const av = persona().avatar;
  const ok = av.faceRig && av.faceRigFor === imageKey(av.image ?? '');
  $('avRigOn').checked = av.faceRigOn !== false;
  $('avRigInfo').textContent =
    av.faceRigOn === false
      ? 'aus'
      : ok
        ? '✔ Gesicht erkannt'
        : av.faceRigFor === imageKey(av.image ?? '')
          ? 'Kein Gesicht gefunden (sehr stilisiert oder seitlich?) – es bleibt bei der einfachen Animation.'
          : 'wird beim nächsten Bild automatisch erkannt';
}
$('avRigOn').onchange = (e) => {
  persona().avatar.faceRigOn = e.target.checked;
  save();
  applyAvatar();
  if (e.target.checked) ensureFaceRig();
  fillRigInfo();
};
$('avRigRedo').onclick = () => ensureFaceRig({ force: true });
$('avFloating').onchange = (e) => setFloating(e.target.checked);
$('avFloatSize').oninput = (e) => {
  state.settings.floatingSize = +e.target.value;
  $('avFloatSizeVal').textContent = `${Math.round(state.settings.floatingSize * 100)} %`;
  if (floating.isOpen && floating.avatar) desktop.avatarSetSize(state.settings.floatingSize, floating.avatar.w / floating.avatar.h);
  save();
};
$('avMouthUp').onclick = () => $('avMouthFile').click();
$('avEyesUp').onclick = () => $('avEyesFile').click();
/**
 * Zusatzbild (Mund offen / Augen zu) an das Avatar-Bild anpassen: gleicher Zuschnitt und – wenn das
 * Avatar-Bild freigestellt ist – dieselbe Freistellung (Umriss des Grundbilds).
 */
async function alignToBase(av, src) {
  if (!av.original || !av.crop) return src;
  const orig = await imageToCanvas(av.original);
  const extra = await imageToCanvas(src);
  const base = await imageToCanvas(av.image, 4096);
  const c = document.createElement('canvas');
  c.width = base.width;
  c.height = base.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  // Zusatzbild auf die Größe des Originals bringen und genauso zuschneiden
  const sx = c.width / av.crop.w;
  const sy = c.height / av.crop.h;
  g.drawImage(extra, -av.crop.x * sx, -av.crop.y * sy, orig.width * sx, orig.height * sy);
  const d = g.getImageData(0, 0, c.width, c.height);
  const alpha = base.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.data.length; i += 4) d.data[i] = alpha[i];
  g.putImageData(d, 0, 0);
  return c.toDataURL('image/png');
}

const extraImage = (key) => async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const av = target();
  av[key] = await alignToBase(av, await readImage(f));
  fillSettings();
  avatarChanged();
};
$('avMouthFile').onchange = extraImage('mouthImage');
$('avEyesFile').onchange = extraImage('eyesImage');
$('avMouthClear').onclick = () => {
  target().mouthImage = null;
  fillSettings();
  avatarChanged();
};
$('avEyesClear').onclick = () => {
  target().eyesImage = null;
  fillSettings();
  avatarChanged();
};
const testPhrase = () =>
  persona().greeting ||
  (persona().language === 'en' ? `Hi, I am ${persona().name}. This is my voice.` : `Hallo, ich bin ${persona().name}. So klinge ich.`);
const speakTest = () => {
  tts.stop();
  tts.newTurn();
  state.ttsErrorShown = false;
  tts.enqueue(testPhrase());
};
$('avTest').onclick = speakTest;

// ---------------------------------------------------------------- Stimme
const voiceField = (id, key, numeric) => {
  $(id).onchange = $(id).oninput = (e) => {
    persona().voice[key] = numeric ? +e.target.value : e.target.value;
    if (key === 'engine') toggleEngineFields();
    applyVoice();
    save();
  };
};
voiceField('vEngine', 'engine');
voiceField('vPiperDe', 'de');
voiceField('vPiperEn', 'en');
voiceField('vSystem', 'systemVoice');
voiceField('vRate', 'rate', true);
$('vSpeak').onchange = (e) => {
  state.settings.speak = e.target.checked;
  if (!e.target.checked) tts.stop();
  save();
};
$('vMax').onchange = (e) => {
  state.settings.maxSentences = Math.max(0, Math.min(50, +e.target.value || 0));
  applyVoice();
  save();
};
$('vTest').onclick = speakTest;

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
$('sEngine').onchange = (e) => {
  state.settings.sttEngine = e.target.value;
  save();
};
$('btnLive').onclick = () => setHandsFree(!state.settings.handsFree);
$('sBargeIn').onchange = (e) => {
  state.settings.bargeIn = e.target.checked;
  save();
  if (state.settings.handsFree) {
    stt.cancel();
    maybeListenHandsFree();
  }
};
$('sLivePause').onchange = (e) => {
  state.settings.livePauseMs = +e.target.value;
  save();
};
$('sSens').oninput = (e) => {
  state.settings.sensitivity = +e.target.value;
  save();
};
$('sPreload').onclick = async () => {
  try {
    status('Lade Spracherkennung …');
    await stt.preload(progressStatus('Spracherkennung'));
    status('Lade Stimmen …');
    await tts.preload(
      ({ loaded, total }) => total && status(`Stimme wird geladen … ${Math.round((loaded / total) * 100)} %`),
    );
    status('Sprachmodelle sind bereit – ab jetzt funktioniert alles offline.');
    refreshModelInfo();
  } catch (e) {
    status(friendlyError(e));
  }
};

// ---------------------------------------------------------------- Verbindung & Datenschutz
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

// ---- KI-Anbieter (LM Studio lokal oder Cloud)
function toggleProviderFields() {
  if (LOCAL_ONLY) return;
  const p = state.settings.provider;
  $('cLocalWrap').hidden = p !== 'lmstudio';
  $('cClaudeWrap').hidden = p !== 'anthropic';
  $('cOpenaiWrap').hidden = p !== 'openai';
  $('cCloudHint').hidden = p === 'lmstudio';
  $('btnAttach').hidden = p !== 'anthropic';
}

async function refreshKeys() {
  if (LOCAL_ONLY) return {};
  const k = await desktop.keyStatus();
  const txt = (on) => (on ? `✔ Schlüssel hinterlegt${k.encrypted ? ' (verschlüsselt)' : ''}` : 'Kein Schlüssel hinterlegt');
  $('cClaudeKeyInfo').textContent = txt(k.anthropic);
  $('cOpenaiKeyInfo').textContent = txt(k.openai);
  // gespeicherter Schlüssel: Feld bleibt leer (er wird nie angezeigt), aber nicht wie „fehlt“ aussehen
  $('cClaudeKey').placeholder = k.anthropic ? '•••••••• gespeichert – nur zum Ändern neu eingeben' : 'sk-ant-…';
  $('cOpenaiKey').placeholder = k.openai ? '•••••••• gespeichert – nur zum Ändern neu eingeben' : 'sk-…';
  $('cClaudeKeyDel').hidden = !k.anthropic;
  $('cOpenaiKeyDel').hidden = !k.openai;
  $('vCloudKeyInfo').textContent = k.openai ? '' : 'Für die OpenAI-Stimme bitte unter ⚙ → Verbindung einen OpenAI-Schlüssel hinterlegen.';
  return k;
}

async function refreshOpenaiModels() {
  const sel = $('cOpenaiModel');
  try {
    const models = await desktop.openaiModels();
    sel.innerHTML = '';
    for (const m of models) sel.add(new Option(m, m, false, m === state.settings.openaiModel));
    if (!state.settings.openaiModel && models.length) {
      state.settings.openaiModel = models.find((m) => /mini/i.test(m)) ?? models[0];
      sel.value = state.settings.openaiModel;
      save();
    }
    $('cOpenaiInfo').textContent = `✔ ${models.length} Modelle verfügbar.`;
  } catch (e) {
    sel.innerHTML = '';
    if (state.settings.openaiModel) sel.add(new Option(state.settings.openaiModel, state.settings.openaiModel));
    $('cOpenaiInfo').textContent = `✖ ${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`;
  }
}

$('cProvider').onchange = (e) => {
  state.settings.provider = e.target.value;
  save();
  toggleProviderFields();
  if (e.target.value === 'lmstudio') refreshModels();
  if (e.target.value === 'openai') refreshOpenaiModels();
};
const saveKey = (provider, inputId) => async () => {
  if (!$(inputId).value.trim()) return status('Bitte erst einen Schlüssel eintragen – der gespeicherte bleibt so lange erhalten.');
  await desktop.setKey(provider, $(inputId).value);
  $(inputId).value = '';
  await refreshKeys();
  if (provider === 'openai') refreshOpenaiModels();
  status('API-Schlüssel gespeichert.');
};
$('cClaudeKeySave').onclick = saveKey('anthropic', 'cClaudeKey');
const deleteKey = (provider, name) => async () => {
  if (!confirm(`${name}-Schlüssel wirklich von diesem Rechner entfernen?`)) return;
  await desktop.setKey(provider, '');
  await refreshKeys();
  status('Schlüssel entfernt.');
};
$('cClaudeKeyDel').onclick = deleteKey('anthropic', 'Claude');
$('cOpenaiKeyDel').onclick = deleteKey('openai', 'OpenAI');
$('cOpenaiKeySave').onclick = saveKey('openai', 'cOpenaiKey');
$('cClaudeModel').onchange = (e) => {
  state.settings.claudeModel = e.target.value;
  save();
};
// Weitere Claude-Modelle aus dem Konto (z. B. neuere oder größere als die fest eingetragenen)
$('cClaudeRefresh').onclick = async () => {
  try {
    const list = await desktop.anthropicModels();
    const known = new Set(CLAUDE_MODELS.map(([id]) => id));
    const extra = list.filter((m) => !known.has(m.id)).map((m) => [m.id, `${m.name} – aus deinem Konto`]);
    fillSelect($('cClaudeModel'), [...CLAUDE_MODELS, ...extra], state.settings.claudeModel);
    status(`${list.length} Claude-Modelle im Konto gefunden.`);
  } catch (e) {
    status(`Modelle konnten nicht geladen werden: ${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
  }
};
$('cClaudeWeb').onchange = (e) => {
  state.settings.claudeWeb = e.target.checked;
  save();
};
$('cClaudeFiles').onchange = (e) => {
  state.settings.claudeFiles = e.target.checked;
  save();
};
$('cClaudeEffort').onchange = (e) => {
  state.settings.claudeEffort = e.target.value;
  save();
};
$('cOpenaiModel').onchange = (e) => {
  state.settings.openaiModel = e.target.value;
  save();
};
$('cOpenaiRefresh').onclick = refreshOpenaiModels;
$('cOffline').onchange = (e) => {
  state.settings.offline = e.target.checked;
  desktop.setOffline(e.target.checked);
  save();
};
$('cOpenModels').onclick = () => desktop.openModelDir();

async function refreshModelInfo() {
  const { dir, bytes } = await desktop.modelInfo();
  $('cModels').textContent = `Gespeicherte Sprachmodelle: ${(bytes / 1048576).toFixed(0)} MB in ${dir}`;
}

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
  if (!['german', 'english'].includes(state.settings.sttLang)) state.settings.sttLang = 'persona';
  state.personas = data.personas?.length ? data.personas.map(migratePersona) : [defaultPersona()];
  state.activeId = data.activeId ?? state.personas[0].id;
  if (!state.personas.some((p) => p.id === state.activeId)) state.activeId = state.personas[0].id;
  state.history = data.history ?? {};
  applyEdition();
  if (!LOCAL_ONLY) $('btnAttach').hidden = state.settings.provider !== 'anthropic';
  desktop.setOffline(state.settings.offline);

  if (state.settings.stageHeight) {
    document.documentElement.style.setProperty('--stage-h', state.settings.stageHeight + 'px');
  }
  $('btnPin').classList.toggle('active', state.settings.alwaysOnTop);
  applyPersona();
  updateBadge();
  save();
  if (state.settings.floating) setFloating(true);
  if (state.settings.outputOpen) openOutput();

  if (state.settings.provider !== 'lmstudio') {
    const keys = await desktop.keyStatus();
    if (!keys[state.settings.provider]) status(`Für ${PROVIDER_NAMES[state.settings.provider]} ist noch kein API-Schlüssel hinterlegt (⚙ → Verbindung).`);
  } else desktop
    .listModels(state.settings.baseUrl)
    .then(() => status(''))
    .catch(() =>
      status('LM Studio nicht erreichbar – bitte LM Studio starten und den lokalen Server aktivieren (⚙ → Verbindung).'),
    );
  if (state.settings.handsFree) setHandsFree(true);
}

/** Selbsttest der Sprachkette (wird vom automatischen Windows-Test aufgerufen). */
async function selfTest() {
  const steps = {};
  const withTimeout = (name, promise, ms = 150000) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Zeitüberschreitung bei: ${name}`)), ms)),
    ]).finally(() => (steps[name] = Math.round(performance.now() - t0)));
  const t0 = performance.now();
  try {
    const text = 'Hallo, das ist ein kurzer Test der Sprachausgabe.';
    const res = await withTimeout('Piper', synthesize(text, DEFAULT_VOICES.de));
    const off = new OfflineAudioContext(1, Math.ceil((res.audio.length / res.sampleRate) * 16000), 16000);
    const buf = off.createBuffer(1, res.audio.length, res.sampleRate);
    buf.copyToChannel(Float32Array.from(res.audio), 0);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(off.destination);
    src.start();
    const audio = (await off.startRendering()).getChannelData(0).slice();
    stt.language = 'german';
    const heard = await withTimeout('Whisper', stt.transcribe(audio));
    applyVoice();
    // zweiter Satz: zeigt die Geschwindigkeit, wenn alles geladen ist
    const t1 = performance.now();
    await withTimeout('Piper 2. Satz', synthesize('Und noch ein zweiter Satz, ganz ohne Ladezeit.', DEFAULT_VOICES.de));
    return {
      // mindestens zwei der drei Wörter erkannt (Whisper tiny verschluckt gelegentlich Wortgrenzen)
      ok: [/hallo/i, /te[sx]t/i, /sprach/i].filter((r) => r.test(heard)).length >= 2,
      isolated: self.crossOriginIsolated,
      samples: res.audio.length,
      secondSentenceMs: Math.round(performance.now() - t1),
      steps,
      heard,
    };
  } catch (e) {
    return { ok: false, isolated: self.crossOriginIsolated, steps, piper: piperState.step, error: String(e?.message ?? e) };
  }
}

/** Lokale Ausgabe: alle Cloud-Optionen aus der Oberfläche entfernen. */
function applyEdition() {
  if (!LOCAL_ONLY) return;
  for (const sel of ['#cProvider option:not([value="lmstudio"])', '#vEngine option[value="cloud"]']) {
    document.querySelectorAll(sel).forEach((o) => o.remove());
  }
  for (const id of ['cKeysWrap', 'cClaudeWrap', 'cOpenaiWrap', 'cCloudHint', 'vCloudWrap', 'btnAttach', 'fileAttach']) $(id)?.remove();
  const prov = $('cProvider').closest('label');
  if (prov) prov.hidden = true;
  if (state.settings.provider !== 'lmstudio') state.settings.provider = 'lmstudio';
  for (const p of state.personas) if (p.voice?.engine === 'cloud') p.voice.engine = 'piper';
}

// Für Fehlersuche und den automatischen Selbsttest
window.__app = {
  edition: EDITION,
  avatar,
  tts,
  stt,
  state,
  floating,
  output,
  setFloating,
  openOutput,
  floatingReady: () => !!floating.avatar?.ready,
  debugVoice,
  selfTest,
  computeVideoMask,
  outputReady: () => output.isOpen && !!output.win.document.getElementById('content'),
};

init().then(() => {
  if (MOBILE) desktop.pipSetEnabled?.(state.settings.pipOnLeave);
  ensureFaceRig();
  // Spracherkennung im Hintergrund vorwärmen, damit der erste gesprochene Satz nicht warten muss
  if (!state.settings.offline && state.settings.handsFree) setTimeout(() => stt.warmup().catch(() => {}), 3000);
});
