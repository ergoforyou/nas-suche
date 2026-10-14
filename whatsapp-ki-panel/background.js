// Hintergrund-Script: öffnet das KI-Fenster neben WhatsApp, liest den Chat aus
// und baut daraus den Prompt für Claude bzw. ChatGPT.
import { loadSettings, saveSettings } from './defaults.js';
import { readWhatsAppChat, insertIntoWhatsApp } from './whatsapp.js';

async function getPanelWindowId() {
  const { panelWin } = await chrome.storage.session.get('panelWin');
  if (!panelWin) return null;
  try {
    await chrome.windows.get(panelWin);
    return panelWin;
  } catch {
    await chrome.storage.session.remove('panelWin');
    return null;
  }
}

async function findWhatsAppTab() {
  const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  return tabs.find(t => t.active) || tabs[0] || null;
}

// Öffnet Claude/ChatGPT als kleines Fenster rechts neben WhatsApp
// (oder holt es nach vorne, wenn es schon offen ist).
async function openPanelWindow() {
  const existing = await getPanelWindowId();
  if (existing) {
    await chrome.windows.update(existing, { focused: true });
    return;
  }

  const settings = await loadSettings();
  const panelWidth = settings.panelWidth;
  let bounds = { width: panelWidth, height: 800 };

  const waTab = await findWhatsAppTab();
  if (waTab) {
    const win = await chrome.windows.get(waTab.windowId);
    const { left, top, width, height } = win;
    if (width >= panelWidth + 400) {
      // WhatsApp schmaler machen und das KI-Fenster in den frei gewordenen Platz setzen.
      if (win.state !== 'normal') await chrome.windows.update(win.id, { state: 'normal' });
      await chrome.windows.update(win.id, { left, top, width: width - panelWidth, height });
      bounds = { left: left + width - panelWidth, top, width: panelWidth, height };
    } else {
      bounds = { left: left + width, top, width: panelWidth, height };
    }
  }

  const url = settings.urls[settings.provider] || settings.urls.claude;
  let created;
  try {
    created = await chrome.windows.create({ url, type: 'popup', ...bounds });
  } catch {
    // Position läge außerhalb des Bildschirms -> Chrome die Position wählen lassen.
    created = await chrome.windows.create({ url, type: 'popup', width: panelWidth, height: bounds.height });
  }
  await chrome.storage.session.set({ panelWin: created.id });
}

chrome.action.onClicked.addListener(() => openPanelWindow());

function maskSensitive(text) {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[E-Mail]')
    .replace(/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?\b/g, '[IBAN]')
    .replace(/(?:\+|\b0)\d[\d\s/-]{6,}\d/g, '[Telefonnummer]');
}

async function buildPrompt({ templateId, extra }) {
  const settings = await loadSettings();
  const waTab = await findWhatsAppTab();
  if (!waTab) return { ok: false, error: 'WhatsApp Web ist nicht geöffnet.' };

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: waTab.id },
    func: readWhatsAppChat,
    args: [settings.maxMessages]
  });
  const chat = injection?.result;
  if (!chat?.ok) return { ok: false, error: chat?.error || 'Chat konnte nicht gelesen werden.' };
  if (!chat.messages.length) return { ok: false, error: 'Im geöffneten Chat wurden keine Nachrichten gefunden.' };

  const template = settings.templates.find(t => t.id === templateId);
  let task = template ? template.text : '';
  if (extra?.trim()) task = task ? `${task}\n\nZusätzlicher Wunsch: ${extra.trim()}` : extra.trim();
  if (!task) task = 'Schlage mir eine passende Antwort auf die letzte Nachricht vor.';
  task = task.replaceAll('{{KONTAKT}}', chat.contact);

  let lines = chat.messages
    .map(m => `${m.stamp ? `[${m.stamp}] ` : ''}${m.sender}: ${m.text}`)
    .join('\n');
  if (settings.maskData) lines = maskSensitive(lines);

  const prompt = [
    settings.baseInstruction.trim(),
    '',
    '## Aufgabe',
    task,
    '',
    `## WhatsApp-Verlauf mit ${chat.contact} (letzte ${chat.messages.length} Nachrichten)`,
    '"""',
    lines,
    '"""'
  ].join('\n');

  return { ok: true, prompt, contact: chat.contact, count: chat.messages.length, autoSend: settings.autoSend };
}

async function sendToWhatsApp(text) {
  const waTab = await findWhatsAppTab();
  if (!waTab) return { ok: false, error: 'WhatsApp Web ist nicht geöffnet.' };
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: waTab.id },
    func: insertIntoWhatsApp,
    args: [text]
  });
  const result = injection?.result || { ok: false, error: 'Einfügen fehlgeschlagen.' };
  if (result.ok) {
    await chrome.windows.update(waTab.windowId, { focused: true });
    await chrome.tabs.update(waTab.id, { active: true });
  }
  return result;
}

async function handleMessage(msg, sender) {
  switch (msg?.type) {
    case 'hello': {
      const settings = await loadSettings();
      const panelWin = await getPanelWindowId();
      const isPanel = !!sender.tab && sender.tab.windowId === panelWin;
      return {
        show: isPanel || settings.toolbarEverywhere,
        isPanel,
        provider: settings.provider,
        templates: settings.templates.map(({ id, name }) => ({ id, name }))
      };
    }
    case 'buildPrompt':
      return buildPrompt(msg);
    case 'toWhatsApp':
      return sendToWhatsApp(msg.text);
    case 'switchProvider': {
      const settings = await saveSettings({ provider: msg.provider });
      if (sender.tab) await chrome.tabs.update(sender.tab.id, { url: settings.urls[msg.provider] });
      return { ok: true };
    }
    case 'openPanel':
      await openPanelWindow();
      return { ok: true };
    case 'openOptions':
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    default:
      return { ok: false, error: 'Unbekannte Anfrage.' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
