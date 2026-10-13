// Builds one PDF from a parsed e-mail: cover page(s) with header + body,
// followed by every attachment converted to PDF pages.

const { PDFDocument, StandardFonts, rgb } = PDFLib;

const MAX_DEPTH = 3;
const SHEET_ROW_LIMIT = 2000;

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
}

function formatDateLong(d) {
  if (!d) return '';
  return d.toLocaleString('de-DE', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatPerson(p) {
  if (!p) return '';
  if (p.name && p.address && p.name !== p.address) return `${p.name} <${p.address}>`;
  return p.name || p.address || '';
}

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function decodeText(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { return new TextDecoder('windows-1252').decode(bytes); }
}

function winAnsiSafe(s) {
  return String(s || '').replace(/[‘’]/g, "'").replace(/[“”„]/g, '"')
    .replace(/[–—]/g, '-').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}

function classify(att) {
  const e = MailParse.ext(att.filename);
  const m = att.mimeType || '';
  if (att.inner) return 'mail';
  if (m === 'application/pdf' || e === 'pdf') return 'pdf';
  if (m === 'message/rfc822' || e === 'eml') return 'mail';
  if (m === 'application/vnd.ms-outlook' || e === 'msg') return 'mail';
  if (e === 'docx' || e === 'docm' || m.includes('wordprocessingml')) return 'docx';
  if (['xlsx', 'xlsm', 'xls', 'ods'].includes(e) || m.includes('spreadsheetml') || m === 'application/vnd.ms-excel') return 'sheet';
  if (['tif', 'tiff', 'heic', 'heif'].includes(e) || /image\/(tiff|heic|heif)/.test(m)) return 'other';
  if (m.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(e)) return 'image';
  if (m === 'text/html' || e === 'html' || e === 'htm') return 'html';
  if (m.startsWith('text/') || ['txt', 'csv', 'log', 'json', 'xml', 'md', 'ics', 'vcf'].includes(e)) return 'text';
  return 'other';
}

// ---------- HTML preparation ----------

function sanitizeHtml(html, cidMap, usedCids) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  doc.querySelectorAll('script, iframe, frame, frameset, object, embed, applet, base, meta, link, noscript, form input[type=password]')
    .forEach((el) => el.remove());

  const resolveCid = (val) => {
    const m = /^cid:(.+)$/i.exec(String(val || '').trim());
    if (!m) return null;
    const key = decodeURIComponent(m[1]).replace(/^<|>$/g, '').toLowerCase();
    const hit = cidMap.get(key);
    if (hit) usedCids.add(key);
    return hit ? hit.url : null;
  };
  const fixCssUrls = (css) => css.replace(/url\(\s*(['"]?)cid:([^'")]+)\1\s*\)/gi, (all, q, id) => {
    const u = resolveCid('cid:' + id);
    return u ? `url("${u}")` : 'none';
  });

  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) { el.removeAttribute(attr.name); continue; }
      if (['href', 'src', 'background', 'action', 'xlink:href', 'formaction'].includes(name)) {
        const v = attr.value.trim();
        if (/^(javascript|vbscript):/i.test(v)) { el.removeAttribute(attr.name); continue; }
        if (/^cid:/i.test(v)) {
          const u = resolveCid(v);
          if (u) el.setAttribute(attr.name, u); else el.removeAttribute(attr.name);
        }
      }
      if (name === 'style' && /cid:/i.test(attr.value)) el.setAttribute('style', fixCssUrls(attr.value));
    }
  });

  const css = [...doc.querySelectorAll('style')].map((s) => fixCssUrls(s.textContent)).join('\n');
  doc.querySelectorAll('style').forEach((s) => s.remove());
  const bodyStyle = doc.body ? doc.body.getAttribute('style') || '' : '';
  return { css, body: doc.body ? doc.body.innerHTML : '', bodyStyle };
}

function htmlDocument({ title, css = '', body, remoteImages = true, landscape = false }) {
  const img = remoteImages ? 'img-src * data: blob:;' : 'img-src data: blob:;';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline' *; font-src * data:; ${img}">
<title>${escapeHtml(title)}</title>
<style>
  @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { font: 13px/1.45 "Segoe UI", Calibri, Arial, sans-serif; color: #111; overflow-wrap: anywhere; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  img { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  table { max-width: 100%; }
  #mp-head { all: initial; display: block; font: 12px/1.45 "Segoe UI", Calibri, Arial, sans-serif; color: #111; border: 1px solid #c9ced6; border-radius: 6px; padding: 10px 14px; margin: 0 0 16px; background: #f6f7f9 !important; }
  #mp-head #mp-subject { display: block; font-size: 17px; font-weight: 700; margin: 0 0 8px; color: #111; }
  #mp-head table { border-collapse: collapse; width: 100%; font: inherit; }
  #mp-head th { text-align: left; vertical-align: top; color: #555; font-weight: 600; padding: 2px 12px 2px 0; width: 70px; white-space: nowrap; font-size: 12px; }
  #mp-head td { padding: 2px 0; font-size: 12px; color: #111; overflow-wrap: anywhere; }
  #mp-head ol { margin: 0; padding-left: 18px; }
  #mp-head .mp-status { color: #555; }
  #mp-head .mp-warn { color: #a15c00; }
  #mp-foot { all: initial; display: block; margin-top: 18px; font: 9.5px "Segoe UI", Arial, sans-serif; color: #888; }
  .mp-plain { white-space: pre-wrap; font: 13px/1.5 "Segoe UI", Calibri, Arial, sans-serif; }
  .mp-sheet h2 { font: 600 14px "Segoe UI", Arial, sans-serif; margin: 0 0 8px; }
  .mp-sheet + .mp-sheet { page-break-before: always; }
  .mp-sheet table { border-collapse: collapse; font: 10px "Segoe UI", Arial, sans-serif; }
  .mp-sheet td, .mp-sheet th { border: 1px solid #ccc; padding: 2px 4px; vertical-align: top; }
  .mp-docx { font: 12.5px/1.45 Calibri, "Segoe UI", Arial, sans-serif; }
  .mp-docx table { border-collapse: collapse; }
  .mp-docx td, .mp-docx th { border: 1px solid #bbb; padding: 3px 6px; vertical-align: top; }
  .mp-note { font: 14px/1.5 "Segoe UI", Arial, sans-serif; border: 1px solid #c9ced6; border-radius: 8px; padding: 18px; margin-top: 40px; background: #f6f7f9; }
</style>
<style>${css}</style>
</head><body>${body}</body></html>`;
}

// ---------- Builder ----------

class MailPdfBuilder {
  constructor(settings, renderer, log) {
    this.settings = settings;
    this.renderer = renderer;
    this.log = log || (() => {});
  }

  /** Appends one e-mail (cover + attachments) to `out`. */
  async appendMail(out, mail, { depth = 0, numbered = true } = {}) {
    const cidMap = new Map();
    for (const a of mail.attachments) {
      if (!a.data || !a.data.length || !/^image\//.test(a.mimeType)) continue;
      const entry = { url: `data:${a.mimeType};base64,${bytesToBase64(a.data)}` };
      if (a.contentId) cidMap.set(a.contentId.toLowerCase(), entry);
      if (a.filename && !cidMap.has(a.filename.toLowerCase())) cidMap.set(a.filename.toLowerCase(), entry);
    }
    const usedCids = new Set();
    let bodyPart;
    if (mail.html && mail.html.trim()) {
      bodyPart = sanitizeHtml(mail.html, cidMap, usedCids);
    } else {
      bodyPart = { css: '', body: `<div class="mp-plain">${escapeHtml(mail.text || '')}</div>`, bodyStyle: '' };
    }

    // Attachments that are only embedded pictures of the text (logos, signatures) are skipped.
    const atts = mail.attachments.filter((a) => {
      const cid = (a.contentId || '').toLowerCase();
      const fn = (a.filename || '').toLowerCase();
      if ((cid && usedCids.has(cid)) || (fn && usedCids.has(fn))) return false;
      if (a.disposition === 'inline' && cid && /^image\//.test(a.mimeType) && !a.filename) return false;
      return true;
    });

    const parts = [];
    for (let i = 0; i < atts.length; i++) {
      const att = atts[i];
      const name = att.filename || `Anhang ${i + 1}`;
      this.log(`Anhang ${i + 1}/${atts.length}: ${name}`);
      let part;
      try {
        part = await this.convertAttachment(att, name, depth);
      } catch (e) {
        console.error(e);
        part = { doc: null, status: 'Umwandlung fehlgeschlagen – als Datei eingebettet', warn: true, embed: true };
      }
      part.att = att;
      part.name = name;
      part.pages = part.doc ? part.doc.getPageCount() : 0;
      parts.push(part);
    }

    // Cover page(s): render, and if the page count changes the numbering, render once more.
    const startPage = out.getPageCount() + 1;
    let coverPages = 1;
    let coverDoc = null;
    for (let pass = 0; pass < 2; pass++) {
      const html = this.coverHtml(mail, bodyPart, parts, numbered ? startPage + coverPages : null);
      coverDoc = await PDFDocument.load(await this.renderer.render(html));
      if (coverDoc.getPageCount() === coverPages || !numbered) break;
      coverPages = coverDoc.getPageCount();
    }
    await copyAll(out, coverDoc);

    for (const p of parts) {
      if (p.doc) await copyAll(out, p.doc);
      if (p.embed || this.settings.embedOriginals) {
        if (p.att.data && p.att.data.length) {
          await out.attach(p.att.data, p.name, {
            mimeType: p.att.mimeType || 'application/octet-stream',
            description: `Original-Anhang: ${p.name}`,
            creationDate: mail.date || new Date(),
            modificationDate: mail.date || new Date(),
          });
        }
      }
    }
  }

  coverHtml(mail, bodyPart, parts, firstAttPage) {
    const rows = [];
    rows.push(['Von', escapeHtml(formatPerson(mail.from))]);
    if (mail.to.length) rows.push(['An', escapeHtml(mail.to.map(formatPerson).join('; '))]);
    if (mail.cc.length) rows.push(['Cc', escapeHtml(mail.cc.map(formatPerson).join('; '))]);
    if (mail.date) rows.push(['Datum', escapeHtml(formatDateLong(mail.date))]);
    if (parts.length) {
      let page = firstAttPage;
      const items = parts.map((p) => {
        let where = '';
        if (p.pages) {
          if (page != null) {
            where = p.pages > 1 ? `Seite ${page}–${page + p.pages - 1}` : `Seite ${page}`;
            page += p.pages;
          } else {
            where = p.pages > 1 ? `${p.pages} Seiten` : '1 Seite';
          }
        }
        const status = [where, p.status].filter(Boolean).join(' · ');
        return `<li>${escapeHtml(p.name)} <span class="mp-status">(${formatSize(p.att.data ? p.att.data.length : 0)})</span>` +
          (status ? ` → <span class="${p.warn ? 'mp-warn' : 'mp-status'}">${escapeHtml(status)}</span>` : '') + '</li>';
      });
      rows.push([`Anhänge (${parts.length})`, `<ol>${items.join('')}</ol>`]);
    }
    const head = `<div id="mp-head"><span id="mp-subject">${escapeHtml(mail.subject || '(kein Betreff)')}</span>` +
      `<table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table></div>`;
    const foot = `<div id="mp-foot">Archiviert am ${escapeHtml(new Date().toLocaleString('de-DE'))}</div>`;
    const body = `${head}<div id="mp-body" style="${escapeHtml(bodyPart.bodyStyle)}">${bodyPart.body}</div>${foot}`;
    return htmlDocument({ title: mail.subject, css: bodyPart.css, body, remoteImages: this.settings.loadRemoteImages });
  }

  async convertAttachment(att, name, depth) {
    const kind = classify(att);
    const data = att.data;
    if (!att.inner && (!data || !data.length)) return { doc: null, status: 'leer', warn: true };

    switch (kind) {
      case 'pdf': return this.pdfPart(data);
      case 'image': return { doc: await this.imagePart(att, name), status: '' };
      case 'docx': {
        const r = await mammoth.convertToHtml({ arrayBuffer: sliceBuffer(data) });
        const html = htmlDocument({ title: name, body: `<div class="mp-docx">${r.value}</div>`, remoteImages: false });
        return { doc: await PDFDocument.load(await this.renderer.render(html)), status: 'aus Word umgewandelt' };
      }
      case 'sheet': return this.sheetPart(data, name);
      case 'text': {
        const html = htmlDocument({ title: name, body: `<pre style="font:11px/1.4 Consolas,monospace">${escapeHtml(decodeText(data))}</pre>`, remoteImages: false });
        return { doc: await PDFDocument.load(await this.renderer.render(html)), status: '' };
      }
      case 'html': {
        const b = sanitizeHtml(decodeText(data), new Map(), new Set());
        const html = htmlDocument({ title: name, css: b.css, body: b.body, remoteImages: this.settings.loadRemoteImages });
        return { doc: await PDFDocument.load(await this.renderer.render(html)), status: '' };
      }
      case 'mail': {
        if (depth >= MAX_DEPTH) return { doc: null, status: 'zu tief verschachtelt – als Datei eingebettet', warn: true, embed: true };
        const inner = att.inner || await MailParse.parse(data);
        const sub = await PDFDocument.create();
        await this.appendMail(sub, inner, { depth: depth + 1, numbered: false });
        return { doc: sub, status: 'weitergeleitete E-Mail' };
      }
      default:
        return { doc: null, status: 'nicht umwandelbar – als Datei in der PDF eingebettet (Büroklammer)', warn: true, embed: true };
    }
  }

  async pdfPart(data) {
    let doc = null;
    try {
      doc = await PDFDocument.load(data, { ignoreEncryption: true, updateMetadata: false });
    } catch (e) { doc = null; }
    if (doc && !doc.isEncrypted) return { doc, status: '' };
    // Protected or damaged PDF: let pdf.js draw the pages as images.
    try {
      const raster = await rasterizePdf(data);
      return { doc: raster, status: 'geschützte PDF – als Bild eingefügt, Original eingebettet', embed: true };
    } catch (e) {
      console.error(e);
      return { doc: null, status: 'PDF nicht lesbar – als Datei eingebettet', warn: true, embed: true };
    }
  }

  async imagePart(att, name) {
    const blob = new Blob([att.data], { type: att.mimeType && att.mimeType.startsWith('image/') ? att.mimeType : MailParse.guessMime(name) });
    let jpeg; let w; let h;
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      const maxSide = 2480;
      const f = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
      w = Math.max(1, Math.round(bmp.width * f));
      h = Math.max(1, Math.round(bmp.height * f));
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      jpeg = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer());
    } catch (e) {
      // e.g. SVG: let the browser render it in an HTML page
      const html = htmlDocument({ title: name, body: `<img src="data:${blob.type};base64,${bytesToBase64(att.data)}">`, remoteImages: false });
      return PDFDocument.load(await this.renderer.render(html));
    }
    const doc = await PDFDocument.create();
    const img = await doc.embedJpg(jpeg);
    const landscape = w > h * 1.1;
    const [pw, ph] = landscape ? [841.89, 595.28] : [595.28, 841.89];
    const page = doc.addPage([pw, ph]);
    const margin = 28;
    const top = 22;
    const s = Math.min((pw - 2 * margin) / w, (ph - 2 * margin - top) / h, 1.5);
    const dw = w * s; const dh = h * s;
    page.drawImage(img, { x: (pw - dw) / 2, y: margin + (ph - 2 * margin - top - dh) / 2, width: dw, height: dh });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText(winAnsiSafe(name).slice(0, 110), { x: margin, y: ph - margin - 8, size: 8, font, color: rgb(0.45, 0.45, 0.45) });
    return doc;
  }

  async sheetPart(data, name) {
    const wb = XLSX.read(data, { type: 'array', cellDates: true });
    const sections = [];
    let truncated = false;
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      if (!ws || !ws['!ref']) continue;
      const range = XLSX.utils.decode_range(ws['!ref']);
      if (range.e.r - range.s.r + 1 > SHEET_ROW_LIMIT) {
        range.e.r = range.s.r + SHEET_ROW_LIMIT - 1;
        ws['!ref'] = XLSX.utils.encode_range(range);
        truncated = true;
      }
      const full = XLSX.utils.sheet_to_html(ws, { header: '', footer: '' });
      const table = new DOMParser().parseFromString(full, 'text/html').querySelector('table');
      if (!table) continue;
      sections.push(`<div class="mp-sheet"><h2>${escapeHtml(name)} – ${escapeHtml(sheetName)}</h2>${table.outerHTML}</div>`);
    }
    if (!sections.length) return { doc: null, status: 'leere Tabelle – als Datei eingebettet', warn: true, embed: true };
    const html = htmlDocument({ title: name, body: sections.join(''), remoteImages: false, landscape: true });
    const doc = await PDFDocument.load(await this.renderer.render(html, { landscape: true, minScale: 0.3 }));
    return {
      doc,
      status: truncated ? `aus Excel umgewandelt (gekürzt auf ${SHEET_ROW_LIMIT} Zeilen, Original eingebettet)` : 'aus Excel umgewandelt',
      warn: truncated,
      embed: truncated,
    };
  }

  /** Page numbers, metadata, optional original .eml; returns the final bytes. */
  async finalize(out, firstMail) {
    if (this.settings.pageNumbers) {
      const font = await out.embedFont(StandardFonts.Helvetica);
      const pages = out.getPages();
      pages.forEach((page, i) => {
        if (page.getRotation().angle % 360 !== 0) return;
        const box = page.getCropBox();
        const text = `Seite ${i + 1} von ${pages.length}`;
        const size = 7.5;
        const tw = font.widthOfTextAtSize(text, size);
        page.drawText(text, { x: box.x + box.width - 24 - tw, y: box.y + 11, size, font, color: rgb(0.5, 0.5, 0.5) });
      });
    }
    if (firstMail) {
      out.setTitle(firstMail.subject || 'E-Mail');
      out.setAuthor(formatPerson(firstMail.from));
      out.setSubject(`E-Mail${firstMail.date ? ' vom ' + firstMail.date.toLocaleString('de-DE') : ''}`);
      if (firstMail.date) out.setCreationDate(firstMail.date);
    }
    out.setCreator('E-Mail → PDF (Chrome-Erweiterung)');
    out.setProducer('E-Mail → PDF / pdf-lib');
    out.setModificationDate(new Date());
    return out.save();
  }
}

async function copyAll(out, src) {
  const pages = await out.copyPages(src, src.getPageIndices());
  pages.forEach((p) => out.addPage(p));
}

function sliceBuffer(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

let pdfjsPromise = null;
async function rasterizePdf(data) {
  if (!pdfjsPromise) {
    pdfjsPromise = import(chrome.runtime.getURL('lib/pdf.min.mjs')).then((m) => {
      m.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');
      return m;
    });
  }
  const pdfjs = await pdfjsPromise;
  const src = await pdfjs.getDocument({ data: data.slice(), isEvalSupported: false }).promise;
  const doc = await PDFDocument.create();
  for (let n = 1; n <= src.numPages; n++) {
    const page = await src.getPage(n);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 2 });
    const canvas = new OffscreenCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const jpg = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })).arrayBuffer());
    const img = await doc.embedJpg(jpg);
    const p = doc.addPage([vp1.width, vp1.height]);
    p.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
  }
  await src.destroy();
  return doc;
}
