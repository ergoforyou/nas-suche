// Firmenwissen: eigene Dokumente (Preislisten, AGB, Leistungsbeschreibungen, Abläufe …) lokal durchsuchbar machen.
// Die Dokumente werden auf dem Rechner in Abschnitte zerlegt und verschlagwortet. Bei einer Frage gehen nur die
// passendsten Abschnitte mit an das Sprachmodell – nie die ganzen Dokumente.
import JSZip from 'jszip';

const TEXT = /\.(txt|md|csv|tsv|json|log|xml|ya?ml)$/i;
const HTML = /\.html?$/i;
export const KB_ACCEPT = '.pdf,.docx,.xlsx,.pptx,.odt,.txt,.md,.csv,.tsv,.json,.html,.htm,.xml';

const decodeXml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&');
const stripTags = (s) => decodeXml(s.replace(/<[^>]+>/g, ''));

/** Text aus einer Datei lesen (PDF, Word, Excel, PowerPoint, OpenDocument-Text, Text, HTML). */
export async function extractText(file) {
  const name = file.name ?? '';
  if (TEXT.test(name)) return file.text();
  if (HTML.test(name)) {
    const doc = new DOMParser().parseFromString(await file.text(), 'text/html');
    doc.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
    return doc.body?.innerText ?? doc.body?.textContent ?? '';
  }
  if (/\.pdf$/i.test(name)) return pdfText(await file.arrayBuffer());
  if (/\.(docx|xlsx|pptx|odt)$/i.test(name)) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const read = (p) => zip.file(p)?.async('string') ?? Promise.resolve('');
    if (/\.docx$/i.test(name)) {
      const xml = await read('word/document.xml');
      return xml
        .split(/<\/w:p>/)
        .map((p) => stripTags(p.replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n')))
        .filter((p) => p.trim())
        .join('\n');
    }
    if (/\.odt$/i.test(name)) {
      const xml = await read('content.xml');
      return xml
        .split(/<\/text:(?:p|h)>/)
        .map(stripTags)
        .filter((p) => p.trim())
        .join('\n');
    }
    if (/\.pptx$/i.test(name)) {
      const slides = Object.keys(zip.files)
        .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
        .sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
      const out = [];
      for (const [i, p] of slides.entries()) {
        const xml = await read(p);
        const paras = xml.split(/<\/a:p>/).map(stripTags).filter((t) => t.trim());
        if (paras.length) out.push(`Folie ${i + 1}:\n${paras.join('\n')}`);
      }
      return out.join('\n\n');
    }
    // Excel: Zeilen als „Wert | Wert | …“, je Tabellenblatt
    const shared = [];
    const sst = await read('xl/sharedStrings.xml');
    for (const si of sst.split(/<\/si>/)) if (si.includes('<si')) shared.push(stripTags(si.replace(/<rPh[\s\S]*?<\/rPh>/g, '')));
    const wb = await read('xl/workbook.xml');
    const names = [...wb.matchAll(/<sheet[^>]*name="([^"]*)"/g)].map((m) => decodeXml(m[1]));
    const sheets = Object.keys(zip.files)
      .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
      .sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
    const out = [];
    for (const [i, p] of sheets.entries()) {
      const xml = await read(p);
      const rows = [];
      for (const row of xml.split(/<\/row>/)) {
        const cells = [...row.matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(([, attrs, inner = '']) => {
          const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
          if (/t="s"/.test(attrs) && v != null) return shared[+v] ?? '';
          if (/t="inlineStr"/.test(attrs)) return stripTags(inner);
          return v != null ? decodeXml(v) : '';
        });
        if (cells.some((c) => c.trim())) rows.push(cells.join(' | '));
      }
      if (rows.length) out.push(`Tabelle „${names[i] ?? i + 1}“:\n${rows.join('\n')}`);
    }
    return out.join('\n\n');
  }
  throw new Error('Dateiformat wird nicht unterstützt');
}

let pdfjs = null;
async function pdfText(buf) {
  if (!pdfjs) {
    // zur Laufzeit aus dem Programmordner laden (nicht ins Hauptskript gebündelt)
    const base = new URL('wasm/pdf/', location.href).href;
    pdfjs = await import(/* @vite-ignore */ `${base}pdf.min.js`);
    pdfjs.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.js`;
  }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let line = '';
    const lines = [];
    for (const it of tc.items) {
      line += it.str;
      if (it.hasEOL) {
        lines.push(line);
        line = '';
      } else if (it.str && !line.endsWith(' ')) line += ' ';
    }
    if (line.trim()) lines.push(line);
    pages.push(lines.join('\n'));
  }
  await doc.destroy();
  return pages.join('\n\n');
}

/** Text in Abschnitte von ca. 900–1400 Zeichen teilen (an Absätzen, mit etwas Überlappung). */
export function chunkText(text, size = 1200) {
  const paras = String(text)
    .replace(/\r/g, '')
    .split(/\n\s*\n|\n(?=[A-ZÄÖÜ0-9•\-–*#])/)
    .map((p) => p.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length > size) {
      chunks.push(cur);
      // Überlappung: letzter Satz des vorigen Abschnitts
      const tail = cur.slice(-160);
      cur = (tail.includes('. ') ? tail.slice(tail.indexOf('. ') + 2) : '') + '\n' + p;
    } else cur = cur ? `${cur}\n${p}` : p;
    while (cur.length > size * 1.6) {
      chunks.push(cur.slice(0, size));
      cur = cur.slice(size - 150);
    }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

// ---- Suche: BM25 mit einfacher deutscher Wortstamm-Kürzung
const STOP = new Set(
  'der die das den dem des ein eine einer eines einem einen und oder aber auch als an auf aus bei bis da dass du er es für hat haben hast ich ihr im in ist ja kann mit mir nach nicht noch nur ob sie sind so über um und uns vom von vor was wie wir wird zu zum zur sich sein seine bitte mal gibt gib welche welcher welches wann wo wer the a an of to is are for on in'.split(
    ' ',
  ),
);
export function terms(text) {
  return (
    String(text)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/ß/g, 'ss')
      .match(/[a-z0-9]{2,}/g) ?? []
  )
    .filter((w) => !STOP.has(w))
    .map((w) => (w.length > 5 ? w.replace(/(ungen|ung|en|er|es|em|e|n|s)$/, '') : w));
}

/** Suchindex aus allen Abschnitten bauen. */
export function buildIndex(kb) {
  const docs = [];
  const df = new Map();
  for (const d of kb.docs ?? []) {
    d.chunks.forEach((text, i) => {
      const tf = new Map();
      // Dokumentname zählt mit (Fragen nennen oft „Preisliste“, „AGB“ …)
      const ts = terms(`${d.name} ${text}`);
      for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
      docs.push({ doc: d, i, text, tf, len: ts.length });
    });
  }
  const avg = docs.reduce((a, d) => a + d.len, 0) / Math.max(1, docs.length);
  return { docs, df, avg, n: docs.length };
}

/** Die passendsten Abschnitte zu einer Frage (höchstens k, nur mit genug Übereinstimmung). */
export function searchIndex(index, query, k = 5) {
  if (!index?.n) return [];
  const q = [...new Set(terms(query))];
  if (!q.length) return [];
  const K1 = 1.4;
  const B = 0.75;
  const scored = [];
  for (const d of index.docs) {
    let s = 0;
    let hits = 0;
    let rare = 0;
    for (const t of q) {
      const f = d.tf.get(t);
      if (!f) continue;
      hits++;
      const df = index.df.get(t);
      const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
      rare = Math.max(rare, idf);
      s += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / index.avg));
    }
    if (s > 0) scored.push({ ...d, score: s, hits, rare });
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]?.score ?? 0;
  // schwache Treffer weglassen (sonst landen Zufallstreffer im Prompt)
  // ein einzelnes Treffer-Wort zählt nur, wenn es selten ist (z. B. „Zahlungsfrist“, nicht „Euro“)
  return scored.filter((d) => d.score >= Math.max(0.6, best * 0.35) && (d.hits >= 2 || d.rare > 0.9)).slice(0, k);
}

/** Text für den Systemprompt aus den Treffern. */
export function kbPrompt(hits, lang = 'de') {
  if (!hits.length) return '';
  const parts = hits.map((h, n) => `[${n + 1}] ${h.doc.name} (Abschnitt ${h.i + 1}):\n${h.text}`);
  return lang === 'en'
    ? 'Excerpts from internal company documents that may help with this question (use them if relevant, ' +
        'name the document as source, do not invent facts beyond them):\n\n' +
        parts.join('\n\n')
    : 'Auszüge aus internen Firmendokumenten, die zur Frage passen könnten. Nutze sie, wenn sie passen, nenne das ' +
        'Dokument als Quelle (z. B. „laut Preisliste“) und erfinde nichts darüber hinaus:\n\n' +
        parts.join('\n\n');
}
