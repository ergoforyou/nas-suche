/* Telefonbuch-Import/-Export: FRITZ!Box-XML, CSV, vCard */
'use strict';

const NUMBER_LABELS = { mobile: 'Mobil', home: 'Festnetz', work: 'Geschäftlich', other: 'Sonstige' };

function contactFrom(name, company, numbers, note) {
  const nums = numbers.map((n) => ({ type: n.type || 'other', number: String(n.number || '').trim() })).filter((n) => n.number);
  if (!nums.length || !(name || company)) return null;
  return { id: newId(), name: (name || '').trim(), company: (company || '').trim(), numbers: nums, note: note || '' };
}

/** FRITZ!Box-Export (Telefonie > Telefonbuch > Sichern) */
function parseFritzXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('XML nicht lesbar');
  const map = { mobile: 'mobile', home: 'home', work: 'work', fax_work: 'other', intern: 'other', memo: 'other' };
  return [...doc.querySelectorAll('contact')].map((c) => {
    const name = c.querySelector('person > realName')?.textContent || '';
    const numbers = [...c.querySelectorAll('telephony > number')].map((n) => ({
      type: map[n.getAttribute('type')] || 'other', number: n.textContent
    }));
    return contactFrom(name, '', numbers);
  }).filter(Boolean);
}

function splitCsvLine(line, sep) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** CSV mit Kopfzeile; erkennt Spalten wie Name, Vorname, Firma, Mobil, Telefon … */
function parseCsv(text) {
  const rows = text.replace(/^﻿/, '').split(/\r?\n/).filter((r) => r.trim());
  if (!rows.length) return [];
  const sep = (rows[0].match(/;/g) || []).length >= (rows[0].match(/,/g) || []).length ? ';' : ',';
  const head = splitCsvLine(rows[0], sep).map((h) => h.toLowerCase());
  const find = (...keys) => head.findIndex((h) => keys.some((k) => h.includes(k)));
  const iFirst = find('vorname', 'first');
  const iLast = find('nachname', 'last', 'surname');
  let iName = head.findIndex((h) => h === 'name' || h === 'anzeigename' || h === 'display name');
  if (iName < 0 && iFirst < 0 && iLast < 0) iName = 0;
  const iCompany = find('firma', 'company', 'organization', 'organisation', 'unternehmen');
  const iNote = find('notiz', 'note', 'bemerkung');
  const numCols = head.map((h, i) => ({ h, i })).filter(({ h }) => /tel|phone|mobil|handy|nummer|number|fon/.test(h));
  const typeOf = (h) => (/mobil|handy|cell|mobile/.test(h) ? 'mobile' : /gesch|work|büro|buero|business|firma/.test(h) ? 'work' : /priv|home|festnetz/.test(h) ? 'home' : 'other');
  return rows.slice(1).map((r) => {
    const c = splitCsvLine(r, sep);
    const name = iName >= 0 ? c[iName] : [c[iFirst], c[iLast]].filter(Boolean).join(' ');
    const numbers = numCols.map(({ h, i }) => ({ type: typeOf(h), number: c[i] }));
    return contactFrom(name, iCompany >= 0 ? c[iCompany] : '', numbers, iNote >= 0 ? c[iNote] : '');
  }).filter(Boolean);
}

/** vCard 2.1/3.0/4.0 (Outlook, Google, iPhone) */
function parseVcf(text) {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  return unfolded.split(/BEGIN:VCARD/i).slice(1).map((card) => {
    let name = '';
    let company = '';
    const numbers = [];
    for (const line of card.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const key = line.slice(0, idx).toUpperCase();
      const val = line.slice(idx + 1).trim();
      if (key.startsWith('FN')) name = val;
      else if (key.startsWith('N') && !key.startsWith('NOTE') && !name) name = val.split(';').slice(0, 2).reverse().join(' ').trim();
      else if (key.startsWith('ORG')) company = val.split(';')[0];
      else if (key.startsWith('TEL')) {
        const t = /CELL/.test(key) ? 'mobile' : /WORK/.test(key) ? 'work' : /HOME/.test(key) ? 'home' : 'other';
        numbers.push({ type: t, number: val.replace(/^tel:/i, '') });
      }
    }
    return contactFrom(name, company, numbers);
  }).filter(Boolean);
}

function parsePhonebookFile(name, text) {
  const n = name.toLowerCase();
  if (n.endsWith('.xml') || text.trimStart().startsWith('<')) return parseFritzXml(text);
  if (n.endsWith('.vcf') || /BEGIN:VCARD/i.test(text)) return parseVcf(text);
  return parseCsv(text);
}

function exportCsv(book) {
  const esc = (s) => /[;"\n]/.test(s) ? '"' + String(s).replace(/"/g, '""') + '"' : String(s || '');
  const rows = [['Name', 'Firma', 'Mobil', 'Festnetz', 'Geschäftlich', 'Sonstige', 'Notiz']];
  for (const e of book) {
    const by = (t) => e.numbers.filter((n) => n.type === t).map((n) => n.number).join(' / ');
    rows.push([e.name, e.company, by('mobile'), by('home'), by('work'), by('other'), e.note]);
  }
  return '﻿' + rows.map((r) => r.map(esc).join(';')).join('\r\n');
}
