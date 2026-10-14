import { DEFAULTS, loadSettings } from './defaults.js';

const $ = id => document.getElementById(id);
const tplList = $('templates');

function addTemplateRow(t = { id: '', name: '', text: '' }) {
  const div = document.createElement('div');
  div.className = 'tpl';
  div.dataset.id = t.id || 'tpl-' + Math.random().toString(36).slice(2, 9);
  div.innerHTML = `
    <div class="tpl-head">
      <input type="text" class="name" placeholder="Name des Knopfs">
      <button class="up" title="Nach oben">↑</button>
      <button class="del danger" title="Löschen">✕</button>
    </div>
    <textarea class="text" placeholder="Was soll die KI tun?"></textarea>`;
  div.querySelector('.name').value = t.name;
  div.querySelector('.text').value = t.text;
  div.querySelector('.del').addEventListener('click', () => div.remove());
  div.querySelector('.up').addEventListener('click', () => {
    if (div.previousElementSibling) tplList.insertBefore(div, div.previousElementSibling);
  });
  tplList.appendChild(div);
}

function fill(s) {
  $('provider').value = s.provider;
  $('url-claude').value = s.urls.claude;
  $('url-chatgpt').value = s.urls.chatgpt;
  $('panelWidth').value = s.panelWidth;
  $('maxMessages').value = s.maxMessages;
  $('maskData').checked = s.maskData;
  $('autoSend').checked = s.autoSend;
  $('toolbarEverywhere').checked = s.toolbarEverywhere;
  $('baseInstruction').value = s.baseInstruction;
  tplList.innerHTML = '';
  s.templates.forEach(addTemplateRow);
}

function collect() {
  const clampInt = (v, min, max, fallback) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    provider: $('provider').value,
    urls: {
      claude: $('url-claude').value.trim() || DEFAULTS.urls.claude,
      chatgpt: $('url-chatgpt').value.trim() || DEFAULTS.urls.chatgpt
    },
    panelWidth: clampInt($('panelWidth').value, 320, 1200, DEFAULTS.panelWidth),
    maxMessages: clampInt($('maxMessages').value, 5, 500, DEFAULTS.maxMessages),
    maskData: $('maskData').checked,
    autoSend: $('autoSend').checked,
    toolbarEverywhere: $('toolbarEverywhere').checked,
    baseInstruction: $('baseInstruction').value,
    templates: [...tplList.querySelectorAll('.tpl')]
      .map(div => ({
        id: div.dataset.id,
        name: div.querySelector('.name').value.trim(),
        text: div.querySelector('.text').value.trim()
      }))
      .filter(t => t.name && t.text)
  };
}

function isAllowedUrl(url, host) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === host;
  } catch {
    return false;
  }
}

async function save(settings) {
  if (!isAllowedUrl(settings.urls.claude, 'claude.ai') || !isAllowedUrl(settings.urls.chatgpt, 'chatgpt.com')) {
    $('saved').textContent = 'Adressen müssen mit https://claude.ai/ bzw. https://chatgpt.com/ beginnen.';
    $('saved').style.color = '#c62828';
    return false;
  }
  await chrome.storage.local.set({ settings });
  $('saved').style.color = '';
  $('saved').textContent = 'Gespeichert ✓';
  setTimeout(() => ($('saved').textContent = ''), 2500);
  return true;
}

$('addTpl').addEventListener('click', () => addTemplateRow());
$('save').addEventListener('click', () => save(collect()));

$('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(collect(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'whatsapp-ki-panel-einstellungen.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

$('import').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const merged = {
      ...DEFAULTS,
      ...data,
      urls: { ...DEFAULTS.urls, ...(data.urls || {}) },
      templates: Array.isArray(data.templates) ? data.templates : DEFAULTS.templates
    };
    if (await save(merged)) fill(merged);
  } catch {
    alert('Die Datei konnte nicht gelesen werden.');
  }
  e.target.value = '';
});

$('reset').addEventListener('click', async () => {
  if (!confirm('Alle Einstellungen und Vorlagen auf Standard zurücksetzen?')) return;
  await save(structuredClone(DEFAULTS));
  fill(DEFAULTS);
});

fill(await loadSettings());
