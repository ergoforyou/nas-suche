'use strict';
// Übergabe von Dateien aus dem Datei-Explorer an Webseiten (WhatsApp, Gmail, Drive, Claude …):
// Die Seite bekommt beim Loslassen echte Dateien – als hätte man sie aus dem Explorer gezogen.
(() => {
  if (window.__ergoforyouExplorerBridge) return;
  window.__ergoforyouExplorerBridge = true;
  const T = 'application/x-dateiexplorer';
  let box = null, label = null, hideTimer = null;

  const ours = (e) => e.dataTransfer && Array.prototype.includes.call(e.dataTransfer.types || [], T);

  // sinnvolles Ziel unter dem Mauszeiger (nicht das winzigste Element)
  function targetAt(x, y) {
    let el = document.elementFromPoint(x, y);
    if (!el) return null;
    let t = el;
    while (t && t !== document.body && t.parentElement) {
      const r = t.getBoundingClientRect();
      if ((r.width >= 160 && r.height >= 36) || t.isContentEditable || t.tagName === 'TEXTAREA' ||
          (t.tagName === 'INPUT' && t.type === 'file')) break;
      t = t.parentElement;
    }
    return t || el;
  }

  function show(x, y) {
    const t = targetAt(x, y);
    if (!t) return;
    if (!box) {
      box = document.createElement('div');
      box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:3px solid #1F6FB2;' +
        'background:rgba(31,111,178,.10);border-radius:8px;box-sizing:border-box;transition:all .06s';
      label = document.createElement('div');
      label.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:#1F6FB2;color:#fff;' +
        'font:600 13px/1.3 "Segoe UI",system-ui,sans-serif;padding:5px 10px;border-radius:6px;white-space:nowrap;' +
        'box-shadow:0 2px 8px rgba(0,0,0,.25)';
      label.textContent = 'Loslassen = Datei hier einfügen (Datei-Explorer)';
    }
    if (!box.isConnected) document.documentElement.append(box, label);
    const r = t.getBoundingClientRect();
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    Object.assign(label.style, { left: Math.max(4, x + 14) + 'px', top: Math.max(4, y + 16) + 'px' });
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 400);
  }

  function hide() {
    clearTimeout(hideTimer);
    if (box) box.remove();
    if (label) label.remove();
  }

  let toastEl = null, toastTimer = null;
  function toast(text, keep) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed;z-index:2147483647;left:50%;bottom:28px;transform:translateX(-50%);' +
        'background:#102A43;color:#fff;font:600 14px/1.4 "Segoe UI",system-ui,sans-serif;padding:10px 18px;' +
        'border-radius:8px;border-left:6px solid #FFBE28;box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:80vw';
    }
    toastEl.textContent = text;
    if (!toastEl.isConnected) document.documentElement.append(toastEl);
    clearTimeout(toastTimer);
    if (!keep) toastTimer = setTimeout(() => toastEl.remove(), 4500);
  }

  addEventListener('dragenter', (e) => { if (ours(e)) e.preventDefault(); }, true);
  addEventListener('dragover', (e) => {
    if (!ours(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    show(e.clientX, e.clientY);
  }, true);

  function bytes(b64) {
    const s = atob(b64);
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }

  function fileInputNear(el) {
    for (let t = el, i = 0; t && i < 6; t = t.parentElement, i++) {
      if (t.tagName === 'INPUT' && t.type === 'file') return t;
      if (t.tagName === 'LABEL' && t.control && t.control.type === 'file') return t.control;
      const inp = t.querySelector && t.querySelector(':scope > input[type=file]');
      if (inp) return inp;
    }
    return null;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function deliver(target, x, y, dt) {
    const fire = (el, type) => el.dispatchEvent(new DragEvent(type, {
      bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt,
    }));
    fire(target, 'dragenter');
    fire(target, 'dragover');
    await sleep(80); // manche Seiten blenden erst jetzt ihre Ablagefläche ein
    const t2 = document.elementFromPoint(x, y) || target;
    if (t2 !== target) { fire(t2, 'dragenter'); fire(t2, 'dragover'); }
    if (!fire(t2, 'drop')) return true; // Seite hat die Dateien angenommen
    const inp = fileInputNear(t2) || fileInputNear(target);
    if (inp) {
      inp.files = dt.files;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    const ed = t2.closest && t2.closest('[contenteditable]:not([contenteditable=false]),textarea');
    if (ed) {
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      if (!ed.dispatchEvent(ev)) return true;
    }
    fire(t2, 'dragleave');
    return false;
  }

  addEventListener('drop', async (e) => {
    if (!ours(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    hide();
    let info = {};
    try { info = JSON.parse(e.dataTransfer.getData(T) || '{}'); } catch (err) { /* leer */ }
    const x = e.clientX, y = e.clientY;
    const target = document.elementFromPoint(x, y) || document.body;
    const items = (info.items || []).filter((i) => !i.dir);
    if (!items.length) {
      toast('Ordner können nicht an Webseiten übergeben werden – bitte die Dateien darin auswählen.');
      return;
    }
    toast(items.length === 1 ? `Übergebe „${items[0].name}“ …` : `Übergebe ${items.length} Dateien …`, true);
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'fetchFiles', paths: items.map((i) => i.path) });
    } catch (err) {
      res = { error: 'Die Erweiterung wurde aktualisiert – bitte diese Seite einmal neu laden (F5).' };
    }
    if (!res || res.error) {
      toast((res && res.error) || 'Übergabe fehlgeschlagen.');
      return;
    }
    const dt = new DataTransfer();
    for (const f of res.files) dt.items.add(new File([bytes(f.data)], f.name, { type: f.type || '' }));
    const ok = await deliver(target, x, y, dt);
    toast(ok ? (res.files.length === 1 ? `„${res.files[0].name}“ übergeben.` : `${res.files.length} Dateien übergeben.`)
      : 'Diese Stelle nimmt keine Dateien an – bitte direkt auf das Eingabefeld bzw. die Ablagefläche ziehen.');
  }, true);
})();
