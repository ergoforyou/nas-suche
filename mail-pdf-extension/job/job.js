// Job window: shows progress, gets the mail source(s), builds the PDF and downloads it.

const params = new URLSearchParams(location.search);
const stepsEl = document.getElementById('steps');
const resultEl = document.getElementById('result');

let currentStep = null;
function step(text) {
  if (currentStep) currentStep.className = 'done';
  const li = document.createElement('li');
  li.className = 'active';
  li.textContent = text;
  stepsEl.appendChild(li);
  currentStep = li;
  document.getElementById('progress').hidden = false;
  return li;
}
function stepDone() {
  if (currentStep) currentStep.className = 'done';
  currentStep = null;
}
function stepError() {
  if (currentStep) currentStep.className = 'error';
  currentStep = null;
}

function showResult(kind, html) {
  resultEl.className = kind;
  resultEl.innerHTML = html;
  resultEl.hidden = false;
}

// ---------- file names / download ----------

function sanitizeFilePart(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
}

function stripPrefixes(subject) {
  let s = String(subject || '');
  let prev;
  do {
    prev = s;
    s = s.replace(/^\s*(\[[^\]]{1,20}\]|(AW|WG|RE|FW|FWD|Antw|Wtr|TR|RV|SV|VS)\s*(\[\d+\])?\s*:)\s*/i, '');
  } while (s !== prev);
  return s.trim();
}

function buildFilename(settings, mail) {
  const d = mail.date || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const sender = mail.from ? (mail.from.name || mail.from.address || '') : '';
  const subject = settings.stripPrefixes ? stripPrefixes(mail.subject) : mail.subject;
  let name = (settings.pattern || MAILPDF_DEFAULTS.pattern)
    .replace(/\{datum\}/gi, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
    .replace(/\{zeit\}/gi, `${pad(d.getHours())}${pad(d.getMinutes())}`)
    .replace(/\{absender\}/gi, sanitizeFilePart(sender))
    .replace(/\{betreff\}/gi, sanitizeFilePart(subject || 'ohne Betreff'));
  name = sanitizeFilePart(name).replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 150) || 'E-Mail';
  const folder = (settings.folder || '').split(/[\\/]+/).map(sanitizeFilePart).filter(Boolean).join('/');
  return (folder ? folder + '/' : '') + name + '.pdf';
}

function asciiFilename(name) {
  const map = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss', '€': 'EUR' };
  return name.replace(/[äöüÄÖÜß€]/g, (c) => map[c])
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_');
}

function download(bytes, filename, saveAs) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs, conflictAction: 'uniquify' }, (id) => {
      if (chrome.runtime.lastError || id == null) {
        URL.revokeObjectURL(url);
        return reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Download fehlgeschlagen'));
      }
      const listener = (delta) => {
        if (delta.id !== id || !delta.state) return;
        if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
          chrome.downloads.onChanged.removeListener(listener);
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          chrome.downloads.search({ id }, (items) => {
            const item = items && items[0];
            if (delta.state.current === 'complete') resolve({ id, path: item ? item.filename : filename });
            else reject(new Error('Download abgebrochen' + (item && item.error ? ` (${item.error})` : '')));
          });
        }
      };
      chrome.downloads.onChanged.addListener(listener);
    });
  });
}

// ---------- getting the source from the mail tab ----------

async function sourcesFromTab(tabId, mode, useTarget) {
  const ask = () => chrome.tabs.sendMessage(tabId, { type: 'MAILPDF_GET_SOURCES', mode, useTarget });
  let res;
  try {
    res = await ask();
  } catch (e) {
    // Tab was open before the extension was installed: inject scripts and retry.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/bridge-main.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
    res = await ask();
  }
  if (!res) throw new Error('Keine Antwort vom E-Mail-Tab. Bitte Seite neu laden (F5) und erneut versuchen.');
  if (!res.ok) {
    const err = new Error(res.error);
    err.details = res.details;
    throw err;
  }
  return { raws: res.sources.map((s) => base64ToBytes(s.base64)), separate: !!res.separate };
}

// ---------- an .eml the user downloaded from Outlook/Gmail ----------

const MAIL_TAB_PATTERNS = [
  'https://outlook.office.com/*', 'https://outlook.office365.com/*', 'https://outlook.live.com/*',
  'https://outlook.cloud.microsoft/*', 'https://mail.google.com/*',
];

function waitForDownload(id) {
  return new Promise((resolve) => {
    const check = () => chrome.downloads.search({ id }, ([item]) => {
      if (!item || item.state !== 'in_progress') resolve(item);
      else setTimeout(check, 300);
    });
    check();
  });
}

function readLocalFile(path) {
  const url = 'file:///' + path.replace(/\\/g, '/').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:');
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => (xhr.response && xhr.response.byteLength ? resolve(new Uint8Array(xhr.response)) : reject(new Error('Datei leer')));
    xhr.onerror = () => reject(new Error('Datei nicht lesbar'));
    xhr.send();
  });
}

async function rawFromDownload(id) {
  let [item] = await chrome.downloads.search({ id });
  if (!item) throw new Error('Download nicht gefunden.');
  const url = item.finalUrl || item.url;
  const errors = [];

  if (url.startsWith('data:')) return new Uint8Array(await (await fetch(url)).arrayBuffer());

  // 1. ask the mail tab to read the file it offered (blob: or https: URL)
  const tabs = await chrome.tabs.query({ url: MAIL_TAB_PATTERNS });
  const blobOrigin = url.startsWith('blob:') ? url.slice(5).replace(/^(https?:\/\/[^/]+).*$/, '$1') : null;
  tabs.sort((a, b) => Number(!!blobOrigin && !a.url.startsWith(blobOrigin)) - Number(!!blobOrigin && !b.url.startsWith(blobOrigin)));
  for (const tab of tabs) {
    if (blobOrigin && !tab.url.startsWith(blobOrigin)) continue;
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'MAILPDF_FETCH_URL', url });
      if (r && r.ok) return base64ToBytes(r.base64);
      errors.push(r ? r.error : 'keine Antwort');
    } catch (e) {
      errors.push(e.message);
    }
  }

  // 2. read the finished download from disk (needs "Zugriff auf Datei-URLs zulassen")
  item = await waitForDownload(id);
  if (item && item.state === 'complete' && await chrome.extension.isAllowedFileSchemeAccess()) {
    try { return await readLocalFile(item.filename); } catch (e) { errors.push(e.message); }
  }
  const err = new Error('Die heruntergeladene .eml-Datei konnte nicht gelesen werden. Bitte in chrome://extensions → Details dieser Erweiterung „Zugriff auf Datei-URLs zulassen“ einschalten – oder die Datei hier hineinziehen.');
  err.details = [`URL: ${url.slice(0, 60)}`, ...errors];
  throw err;
}

// ---------- main pipeline ----------

async function convert(rawList, settings) {
  const renderer = new PdfRenderer();
  const builder = new MailPdfBuilder(settings, renderer, (t) => {
    if (currentStep) currentStep.textContent = t;
  });
  try {
    step('E-Mail wird gelesen …');
    const mails = [];
    for (const raw of rawList) mails.push(await MailParse.parse(raw));
    stepDone();

    const out = await PDFLib.PDFDocument.create();
    for (let i = 0; i < mails.length; i++) {
      step(mails.length > 1 ? `E-Mail ${i + 1}/${mails.length} wird umgewandelt …` : 'E-Mail wird umgewandelt …');
      await builder.appendMail(out, mails[i], { depth: 0, numbered: true });
      stepDone();
    }
    if (settings.embedEml) {
      mails.forEach((m, i) => {
        if (!m.raw) return;
        const ext = MailParse.isMsg(m.raw) ? 'msg' : 'eml';
        out.attach(m.raw, `Original-E-Mail${mails.length > 1 ? '-' + (i + 1) : ''}.${ext}`, {
          mimeType: ext === 'msg' ? 'application/vnd.ms-outlook' : 'message/rfc822',
          description: 'Original-E-Mail',
        });
      });
    }
    step('PDF wird zusammengefügt …');
    const firstMail = mails[mails.length - 1];
    const bytes = await builder.finalize(out, firstMail);
    stepDone();
    return { bytes, mail: firstMail, pages: out.getPageCount() };
  } finally {
    await renderer.close();
  }
}

async function runAndSave(rawList, settings) {
  const { bytes, mail, pages } = await convert(rawList, settings);
  step('Wird gespeichert …');
  const filename = buildFilename(settings, mail);
  let dl;
  try {
    dl = await download(bytes, filename, settings.saveAs);
  } catch (e) {
    // Some systems reject non-ASCII file names: retry with ae/oe/ue/ss.
    if (!/invalid filename/i.test(e.message)) throw e;
    dl = await download(bytes, asciiFilename(filename), settings.saveAs);
  }
  stepDone();
  showResult('ok', `<p><strong>✓ PDF gespeichert</strong> (${pages} Seiten, ${formatSize(bytes.length)})</p>` +
    `<p><code>${escapeHtml(dl.path)}</code></p>` +
    `<p><button id="show">Im Ordner anzeigen</button> <button id="open">Öffnen</button></p>`);
  document.getElementById('show').onclick = () => chrome.downloads.show(dl.id);
  document.getElementById('open').onclick = () => chrome.downloads.open(dl.id);
  return dl;
}

function showError(err) {
  stepError();
  console.error(err);
  showResult('error', `<p><strong>Das hat leider nicht geklappt.</strong></p><p>${escapeHtml(err.message || String(err))}</p>` +
    (err.details ? `<details open><summary>Technische Details</summary><pre id="diag">${escapeHtml(err.details.join('\n'))}</pre>` +
      '<button id="copydiag">Details kopieren</button></details>' : '') +
    '<p class="hint">Alternative, die immer geht: In Outlook Rechtsklick auf die E-Mail → „Herunterladen“ → „Als EML herunterladen“ ' +
    '(Gmail: „⋮“ → „Nachricht herunterladen“). Daraus macht die Erweiterung automatisch die PDF. Oder die .eml-Datei unten ablegen.</p>');
  const copy = document.getElementById('copydiag');
  if (copy) {
    copy.onclick = () => navigator.clipboard.writeText(document.getElementById('diag').textContent)
      .then(() => { copy.textContent = 'Kopiert ✓'; });
  }
  showDropZone();
}

// ---------- drop zone ----------

function showDropZone() {
  const drop = document.getElementById('drop');
  drop.hidden = false;
  const zone = document.getElementById('dropzone');
  const input = document.getElementById('file');
  if (zone.dataset.ready) return;
  zone.dataset.ready = '1';

  const handle = async (files) => {
    files = [...files].filter((f) => /\.(eml|msg)$/i.test(f.name) || f.type === 'message/rfc822');
    if (!files.length) return;
    stepsEl.innerHTML = '';
    resultEl.hidden = true;
    drop.hidden = true;
    const settings = await mailPdfGetSettings();
    let okCount = 0;
    for (const f of files) {
      try {
        step(`${f.name}`);
        stepDone();
        await runAndSave([new Uint8Array(await f.arrayBuffer())], settings);
        okCount++;
      } catch (e) {
        showError(e);
      }
    }
    if (files.length > 1) {
      showResult(okCount === files.length ? 'ok' : 'error', `<p><strong>${okCount} von ${files.length} Dateien umgewandelt.</strong></p>`);
    }
    drop.hidden = false;
  };

  input.addEventListener('change', () => handle(input.files));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    handle(e.dataTransfer.files);
  });
}

// ---------- start ----------

(async () => {
  const downloadId = params.get('download') ? Number(params.get('download')) : null;
  if (downloadId != null) {
    const settings = await mailPdfGetSettings();
    try {
      step('Heruntergeladene E-Mail (.eml) wird gelesen …');
      const raw = await rawFromDownload(downloadId);
      stepDone();
      await runAndSave([raw], settings);
      if (settings.autoClose && !settings.saveAs) setTimeout(() => window.close(), 2500);
    } catch (e) {
      showError(e);
    }
    return;
  }
  const tabId = params.get('tab') ? Number(params.get('tab')) : null;
  if (tabId == null) {
    showDropZone();
    return;
  }
  const settings = await mailPdfGetSettings();
  try {
    step('E-Mail wird aus dem Postfach geladen …');
    const { raws, separate } = await sourcesFromTab(tabId, params.get('mode') || 'single', params.get('target') === '1');
    stepDone();
    if (separate) {
      for (let i = 0; i < raws.length; i++) {
        step(`E-Mail ${i + 1} von ${raws.length}`);
        stepDone();
        await runAndSave([raws[i]], settings);
      }
      showResult('ok', `<p><strong>✓ ${raws.length} PDFs gespeichert</strong></p>`);
    } else {
      await runAndSave(raws, settings);
    }
    if (settings.autoClose && !settings.saveAs) setTimeout(() => window.close(), 2500);
  } catch (e) {
    showError(e);
  }
})();
