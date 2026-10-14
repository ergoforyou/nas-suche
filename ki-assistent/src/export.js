// Antworten als fertige Dokumente speichern – komplett lokal, ohne Internet:
//  - Word (.docx) über die Bibliothek "docx"
//  - PDF über die Druckfunktion der App (Hauptprozess, printToPDF)
import { marked } from 'marked';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ShadingType,
  LevelFormat,
  AlignmentType,
  BorderStyle,
} from 'docx';
import { renderMarkdown } from './markdown.js';

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

const decode = (t) =>
  String(t ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

/** Inline-Markdown (fett, kursiv, Code, Links) in Word-Textabschnitte umwandeln. */
function runs(tokens, style = {}) {
  const out = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'strong':
        out.push(...runs(t.tokens, { ...style, bold: true }));
        break;
      case 'em':
        out.push(...runs(t.tokens, { ...style, italics: true }));
        break;
      case 'del':
        out.push(...runs(t.tokens, { ...style, strike: true }));
        break;
      case 'codespan':
        out.push(new TextRun({ ...style, text: decode(t.text), font: 'Consolas', shading: { type: ShadingType.CLEAR, fill: 'EEEEEE' } }));
        break;
      case 'link':
        out.push(...runs(t.tokens, { ...style, color: '1F5FBF', underline: {} }));
        if (t.href && !/^#/.test(t.href)) out.push(new TextRun({ ...style, text: ` (${t.href})`, color: '777777' }));
        break;
      case 'br':
        out.push(new TextRun({ ...style, break: 1 }));
        break;
      case 'text':
        if (t.tokens?.length) out.push(...runs(t.tokens, style));
        else out.push(new TextRun({ ...style, text: decode(t.text) }));
        break;
      default:
        if (t.text) out.push(new TextRun({ ...style, text: decode(t.text) }));
    }
  }
  return out;
}

/** Block-Markdown in Word-Absätze, Listen und Tabellen umwandeln. */
function blocks(tokens, ctx = { level: 0 }) {
  const out = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'heading':
        out.push(new Paragraph({ heading: HEADINGS[Math.min(5, t.depth - 1)], children: runs(t.tokens) }));
        break;
      case 'paragraph':
        out.push(new Paragraph({ children: runs(t.tokens), spacing: { after: 120 } }));
        break;
      case 'list':
        for (const item of t.items) {
          // erster Textblock des Eintrags als Listenpunkt, verschachtelte Listen eingerückt
          const [first, ...rest] = item.tokens;
          const inline = first?.type === 'text' || first?.type === 'paragraph' ? runs(first.tokens ?? [first]) : [];
          out.push(
            new Paragraph({
              children: inline,
              ...(t.ordered
                ? { numbering: { reference: 'nummern', level: Math.min(ctx.level, 2) } }
                : { bullet: { level: Math.min(ctx.level, 2) } }),
            }),
          );
          const nested = inline.length ? rest : item.tokens;
          if (nested.length) out.push(...blocks(nested, { level: ctx.level + 1 }));
        }
        break;
      case 'code':
        for (const line of t.text.split('\n')) {
          out.push(
            new Paragraph({
              children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 19 })],
              shading: { type: ShadingType.CLEAR, fill: 'F3F3F3' },
              spacing: { after: 0 },
            }),
          );
        }
        out.push(new Paragraph({ children: [] }));
        break;
      case 'blockquote':
        for (const p of blocks(t.tokens, ctx)) out.push(p);
        break;
      case 'table': {
        const cell = (c, header) =>
          new TableCell({
            children: [new Paragraph({ children: runs(c.tokens, header ? { bold: true } : {}) })],
            ...(header ? { shading: { type: ShadingType.CLEAR, fill: 'E8ECF2' } } : {}),
          });
        out.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({ tableHeader: true, children: t.header.map((c) => cell(c, true)) }),
              ...t.rows.map((r) => new TableRow({ children: r.map((c) => cell(c, false)) })),
            ],
          }),
        );
        out.push(new Paragraph({ children: [] }));
        break;
      }
      case 'hr':
        out.push(new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BBBBBB', space: 4 } } }));
        break;
      case 'text':
        out.push(new Paragraph({ children: runs(t.tokens ?? [t]) }));
        break;
      default:
        break;
    }
  }
  return out;
}

/** Antwort als Word-Datei (.docx) erzeugen. */
export async function toDocx({ title, question, answer }) {
  const children = [];
  if (title) children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] }));
  if (question) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: 'Frage: ', bold: true, color: '666666' }), new TextRun({ text: question, color: '666666' })],
        spacing: { after: 240 },
      }),
    );
  }
  children.push(...blocks(marked.lexer(answer)));
  const doc = new Document({
    creator: 'KI-Assistent',
    title: title || 'Antwort',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: {
      config: [
        {
          reference: 'nummern',
          levels: [0, 1, 2].map((level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children }],
  });
  return new Uint8Array(await (await Packer.toBlob(doc)).arrayBuffer());
}

/** Druckfertiges HTML für die PDF-Ausgabe (helles Layout, A4). */
export function toPrintHtml({ title, question, answer }) {
  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${esc(title || 'Antwort')}</title>
<style>
  body { font: 11pt/1.55 "Segoe UI", Calibri, Arial, sans-serif; color: #1d1f24; margin: 0; }
  h1.title { font-size: 20pt; margin: 0 0 4pt; }
  .question { color: #666; margin: 0 0 16pt; padding-bottom: 8pt; border-bottom: 1px solid #ddd; }
  h1, h2, h3 { line-height: 1.25; margin: 16pt 0 6pt; page-break-after: avoid; }
  h1 { font-size: 17pt; } h2 { font-size: 14pt; } h3 { font-size: 12pt; }
  p { margin: 6pt 0; }
  ul, ol { padding-left: 18pt; }
  code { font-family: Consolas, monospace; font-size: 9.5pt; background: #f1f1f1; padding: 0 3pt; border-radius: 3pt; }
  pre { background: #f5f5f5; border: 1px solid #e1e1e1; border-radius: 4pt; padding: 8pt 10pt; white-space: pre-wrap; page-break-inside: avoid; }
  pre code { background: none; padding: 0; }
  pre .copy { display: none; }
  table { border-collapse: collapse; width: 100%; margin: 8pt 0; page-break-inside: avoid; }
  th, td { border: 1px solid #ccc; padding: 4pt 7pt; text-align: left; vertical-align: top; }
  th { background: #eef1f6; }
  blockquote { margin: 8pt 0; padding: 2pt 10pt; border-left: 3pt solid #8fb2ea; color: #555; }
  a { color: #1f5fbf; }
  img { display: none; }
</style></head><body>
${title ? `<h1 class="title">${esc(title)}</h1>` : ''}
${question ? `<div class="question"><b>Frage:</b> ${esc(question)}</div>` : ''}
${renderMarkdown(answer)}
</body></html>`;
}

/** Dateiname aus der Frage ableiten. */
export function fileBase(question) {
  const base = String(question || 'Antwort')
    .replace(/[\\/:*?"<>|\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return base || 'Antwort';
}
