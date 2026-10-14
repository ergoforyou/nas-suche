// Werkzeugleiste auf claude.ai / chatgpt.com. Holt den offenen WhatsApp-Chat,
// trägt den fertigen Prompt ins Eingabefeld ein und bringt Antworten zurück
// nach WhatsApp.
(async () => {
  if (window.top !== window) return;

  const info = await chrome.runtime.sendMessage({ type: 'hello' }).catch(() => null);
  if (!info?.show) return;

  const isChatGPT = location.hostname.endsWith('chatgpt.com');

  const EDITOR_SELECTORS = isChatGPT
    ? ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]', 'textarea']
    : ['div.ProseMirror[contenteditable="true"]', '[data-testid="chat-input"] [contenteditable="true"]', 'div[contenteditable="true"]', 'textarea'];

  const SEND_SELECTORS = isChatGPT
    ? ['#composer-submit-button', 'button[data-testid="send-button"]']
    : ['button[aria-label="Send message"]', 'button[aria-label="Nachricht senden"]', 'button[aria-label*="Send" i]', 'button[aria-label*="senden" i]'];

  const ASSISTANT_SELECTORS = isChatGPT
    ? ['[data-message-author-role="assistant"]']
    : ['.font-claude-response', '.font-claude-message', '[data-testid="assistant-message"]'];

  const first = selectors => {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const editorText = el => (el.tagName === 'TEXTAREA' ? el.value : el.innerText);

  // ---------- Text ins KI-Eingabefeld ----------

  function insertIntoEditor(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, (el.value ? el.value + '\n' : '') + text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    document.execCommand('insertText', false, text);
    if (editorText(el).includes(text.trim().slice(0, 30))) return;

    // Fallback: als Einfügen (Strg+V) simulieren.
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }

  async function clickSend() {
    for (let i = 0; i < 20; i++) {
      const btn = first(SEND_SELECTORS);
      if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
        btn.click();
        return true;
      }
      await sleep(150);
    }
    return false;
  }

  function lastAnswerOrSelection() {
    const selected = window.getSelection()?.toString().trim();
    if (selected && !root.contains(window.getSelection().anchorNode)) return { text: selected, source: 'markierter Text' };
    for (const sel of ASSISTANT_SELECTORS) {
      const all = document.querySelectorAll(sel);
      if (all.length) return { text: all[all.length - 1].innerText.trim(), source: 'letzte KI-Antwort' };
    }
    return null;
  }

  // ---------- Oberfläche ----------

  const root = document.createElement('div');
  root.id = 'wa-ki-toolbar-root';
  const shadow = root.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
      .wrap { position: fixed; z-index: 2147483647; top: 64px; right: 12px; }
      .pill {
        display: flex; align-items: center; gap: 6px; border: 0; cursor: pointer;
        background: #25d366; color: #fff; font-size: 13px; font-weight: 600;
        padding: 6px 12px; border-radius: 999px; box-shadow: 0 2px 8px rgba(0,0,0,.25);
      }
      .card {
        width: min(400px, calc(100vw - 24px)); background: #fff; color: #111b21;
        border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.25); overflow: hidden;
        font-size: 13px; border: 1px solid #d1d7db;
      }
      .head {
        display: flex; align-items: center; gap: 6px; padding: 6px 8px;
        background: #008069; color: #fff; cursor: move; user-select: none;
      }
      .head .title { font-weight: 600; flex: 1; }
      .head button { background: transparent; border: 0; color: #fff; cursor: pointer; font-size: 15px; padding: 2px 6px; border-radius: 6px; }
      .head button:hover { background: rgba(255,255,255,.15); }
      .seg { display: flex; border: 1px solid rgba(255,255,255,.6); border-radius: 6px; overflow: hidden; }
      .seg button { font-size: 11px; padding: 2px 8px; border-radius: 0; }
      .seg button.on { background: #fff; color: #008069; }
      .body { padding: 8px; display: flex; flex-direction: column; gap: 8px; }
      .chips { display: flex; flex-wrap: wrap; gap: 6px; }
      .chip {
        border: 1px solid #25d366; background: #e7fce3; color: #0a5c36; cursor: pointer;
        padding: 4px 10px; border-radius: 999px; font-size: 12px;
      }
      .chip:hover { background: #d0f5c9; }
      .row { display: flex; gap: 6px; }
      input {
        flex: 1; border: 1px solid #d1d7db; border-radius: 8px; padding: 6px 8px; font-size: 13px; color: #111b21; background: #fff;
      }
      .btn {
        border: 0; border-radius: 8px; padding: 6px 10px; cursor: pointer; font-size: 13px;
        background: #008069; color: #fff;
      }
      .btn.secondary { background: #f0f2f5; color: #111b21; border: 1px solid #d1d7db; width: 100%; }
      .btn:disabled, .chip:disabled { opacity: .5; cursor: progress; }
      .status { font-size: 12px; color: #54656f; min-height: 16px; }
      .status.err { color: #c62828; }
      .hidden { display: none !important; }
    </style>
    <div class="wrap">
      <button class="pill" part="pill">💬 WhatsApp-KI</button>
      <div class="card hidden">
        <div class="head">
          <span class="title">💬 WhatsApp-KI</span>
          <div class="seg">
            <button data-provider="claude">Claude</button>
            <button data-provider="chatgpt">ChatGPT</button>
          </div>
          <button class="opt" title="Einstellungen & Vorlagen">⚙</button>
          <button class="min" title="Einklappen">–</button>
        </div>
        <div class="body">
          <div class="chips"></div>
          <div class="row">
            <input class="extra" placeholder="Eigene Anweisung … (Enter = mit Chat senden)">
            <button class="btn go" title="Mit Chatverlauf senden">➤</button>
          </div>
          <button class="btn secondary back" title="Markierten Text oder die letzte KI-Antwort ins WhatsApp-Eingabefeld übernehmen">⬅ Markierten Text in WhatsApp einfügen</button>
          <div class="status"></div>
        </div>
      </div>
    </div>`;
  document.documentElement.appendChild(root);

  const $ = sel => shadow.querySelector(sel);
  const wrap = $('.wrap');
  const pill = $('.pill');
  const card = $('.card');
  const chips = $('.chips');
  const extra = $('.extra');
  const status = $('.status');

  function setStatus(text, isError = false) {
    status.textContent = text;
    status.classList.toggle('err', isError);
  }

  async function setOpen(open) {
    pill.classList.toggle('hidden', open);
    card.classList.toggle('hidden', !open);
    await chrome.storage.local.set({ toolbarOpen: open });
  }

  function renderTemplates(templates) {
    chips.innerHTML = '';
    for (const t of templates) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = t.name;
      b.addEventListener('click', () => run(t.id));
      chips.appendChild(b);
    }
  }

  function renderProvider(provider) {
    shadow.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.provider === provider));
  }

  async function run(templateId) {
    const buttons = shadow.querySelectorAll('.chip, .go');
    buttons.forEach(b => (b.disabled = true));
    setStatus('Lese WhatsApp-Chat …');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'buildPrompt', templateId, extra: extra.value });
      if (!res?.ok) return setStatus(res?.error || 'Fehler beim Lesen des Chats.', true);

      try { await navigator.clipboard.writeText(res.prompt); } catch { /* egal */ }

      const editor = first(EDITOR_SELECTORS);
      if (!editor) return setStatus('Eingabefeld nicht gefunden – Text ist in der Zwischenablage (Strg+V).', true);
      insertIntoEditor(editor, res.prompt);
      extra.value = '';

      const sent = res.autoSend ? (await sleep(300), await clickSend()) : false;
      setStatus(`Chat mit ${res.contact} (${res.count} Nachrichten) ${sent ? 'gesendet' : 'eingefügt'}.`);
    } catch (e) {
      setStatus(String(e?.message || e), true);
    } finally {
      buttons.forEach(b => (b.disabled = false));
    }
  }

  // Ereignisse
  pill.addEventListener('click', () => setOpen(true));
  $('.min').addEventListener('click', () => setOpen(false));
  $('.opt').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openOptions' }));
  $('.go').addEventListener('click', () => run(null));
  extra.addEventListener('keydown', e => {
    e.stopPropagation(); // Tastenkürzel der Seite nicht auslösen
    if (e.key === 'Enter') run(null);
  });
  shadow.querySelectorAll('.seg button').forEach(b =>
    b.addEventListener('click', () => {
      if (b.dataset.provider === info.provider) return;
      chrome.runtime.sendMessage({ type: 'switchProvider', provider: b.dataset.provider });
    })
  );
  $('.back').addEventListener('mousedown', e => e.preventDefault()); // Markierung nicht verlieren
  $('.back').addEventListener('click', async () => {
    const found = lastAnswerOrSelection();
    if (!found?.text) return setStatus('Bitte erst einen Text in der KI-Antwort markieren.', true);
    const res = await chrome.runtime.sendMessage({ type: 'toWhatsApp', text: found.text });
    if (res?.ok) setStatus(`${found.source} in WhatsApp eingefügt – bitte prüfen und selbst senden.`);
    else setStatus(res?.error || 'Einfügen in WhatsApp fehlgeschlagen.', true);
  });

  // Verschieben per Maus (Position wird gemerkt)
  function applyPos(pos) {
    if (!pos) return;
    const x = Math.min(Math.max(0, pos.x), window.innerWidth - 60);
    const y = Math.min(Math.max(0, pos.y), window.innerHeight - 40);
    Object.assign(wrap.style, { left: x + 'px', top: y + 'px', right: 'auto' });
  }
  function makeDraggable(handle) {
    handle.addEventListener('mousedown', e => {
      if (e.target.closest('button') && e.target !== pill) return;
      const rect = wrap.getBoundingClientRect();
      const dx = e.clientX - rect.left;
      const dy = e.clientY - rect.top;
      let moved = false;
      const onMove = ev => {
        moved = true;
        applyPos({ x: ev.clientX - dx, y: ev.clientY - dy });
      };
      const onUp = ev => {
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('mouseup', onUp, true);
        if (moved) {
          chrome.storage.local.set({ toolbarPos: { x: ev.clientX - dx, y: ev.clientY - dy } });
          if (handle === pill) pill.addEventListener('click', ev2 => ev2.stopImmediatePropagation(), { capture: true, once: true });
        }
      };
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
    });
  }
  makeDraggable($('.head'));
  makeDraggable(pill);

  // Start
  renderTemplates(info.templates);
  renderProvider(info.provider);
  const { toolbarOpen = true, toolbarPos } = await chrome.storage.local.get(['toolbarOpen', 'toolbarPos']);
  applyPos(toolbarPos);
  await setOpen(toolbarOpen);

  // Vorlagen live aktualisieren, wenn sie in den Einstellungen geändert werden.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const fresh = await chrome.runtime.sendMessage({ type: 'hello' }).catch(() => null);
    if (fresh) {
      info.provider = fresh.provider;
      renderTemplates(fresh.templates);
      renderProvider(fresh.provider);
    }
  });
})();
