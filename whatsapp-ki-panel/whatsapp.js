// Funktionen, die per chrome.scripting.executeScript in WhatsApp Web
// ausgeführt werden. Sie müssen in sich geschlossen sein (keine Imports).

export function readWhatsAppChat(maxMessages) {
  const main = document.querySelector('#main');
  if (!main) return { ok: false, error: 'In WhatsApp ist gerade kein Chat geöffnet.' };

  let contact = '';
  const header = main.querySelector('header');
  if (header) {
    const el = header.querySelector('span[dir="auto"][title]') || header.querySelector('span[dir="auto"]') || header.querySelector('[title]');
    contact = (el?.getAttribute('title') || el?.textContent || '').trim();
  }

  // Text inkl. Emojis (WhatsApp zeigt Emojis als <img alt="😀">).
  const textOf = el => {
    if (!el) return '';
    const c = el.cloneNode(true);
    c.querySelectorAll('.quoted-mention').forEach(q => q.remove());
    c.querySelectorAll('img[alt]').forEach(img => img.replaceWith(img.alt));
    c.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
    return c.textContent.trim();
  };

  const mediaLabel = row => {
    if (row.querySelector('[data-icon*="recalled"]')) return '[Nachricht wurde gelöscht]';
    if (row.querySelector('audio, [data-icon*="audio"], [data-icon*="ptt"]')) return '[Sprachnachricht]';
    if (row.querySelector('[data-icon*="video"], video')) return '[Video]';
    if (row.querySelector('[data-icon*="document"], [data-icon*="doc-"]')) return '[Dokument]';
    if (row.querySelector('img[src^="blob:"], img[src^="data:image"]')) return '[Bild]';
    if (row.querySelector('[data-icon*="location"]')) return '[Standort]';
    return '[Anhang]';
  };

  let rows = [...main.querySelectorAll('.message-in, .message-out')];
  if (!rows.length) {
    // Fallback, falls WhatsApp die Klassennamen ändert.
    rows = [...main.querySelectorAll('[data-pre-plain-text]')].map(el => el.closest('[role="row"]') || el);
  }

  const messages = rows.map(row => {
    const out = row.classList.contains('message-out') || !!row.querySelector('.message-out');
    const meta = row.querySelector('[data-pre-plain-text]');
    const pre = meta?.getAttribute('data-pre-plain-text') || '';
    const m = pre.match(/^\[([^\]]*)\]\s*(.*?):\s*$/);
    const stamp = m ? m[1].trim() : '';
    const sender = out ? 'Ich' : (m?.[2]?.trim() || contact || 'Kontakt');
    const textEl = meta?.querySelector('.selectable-text') || row.querySelector('span.selectable-text');
    const text = textOf(textEl) || mediaLabel(row);
    return { stamp, sender, text, out };
  });

  return {
    ok: true,
    contact: contact || 'Kontakt',
    total: messages.length,
    messages: messages.slice(-maxMessages)
  };
}

export function insertIntoWhatsApp(text) {
  const box = document.querySelector('#main footer div[contenteditable="true"]');
  if (!box) return { ok: false, error: 'Kein WhatsApp-Eingabefeld gefunden (ist ein Chat geöffnet?).' };
  box.focus();

  // Als Einfügen simulieren – so bleiben Zeilenumbrüche erhalten.
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));

  const probe = text.trim().slice(0, 20);
  if (!box.textContent.includes(probe)) document.execCommand('insertText', false, text);
  return { ok: box.textContent.length > 0 };
}
