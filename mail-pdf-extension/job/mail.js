// Parsing .eml (RFC 822) and Outlook .msg files into one common structure:
// { subject, from: {name, address}, to: [], cc: [], date: Date|null, html, text,
//   attachments: [{ filename, mimeType, contentId, disposition, data: Uint8Array }] }

const MailParse = (() => {
  function toU8(content) {
    if (!content) return new Uint8Array(0);
    if (content instanceof Uint8Array) return content;
    if (content instanceof ArrayBuffer) return new Uint8Array(content);
    if (ArrayBuffer.isView(content)) return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    if (typeof content === 'string') return new TextEncoder().encode(content);
    return new Uint8Array(0);
  }

  function isMsg(bytes) {
    // OLE compound file signature D0 CF 11 E0 A1 B1 1A E1
    return bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  }

  async function parse(bytes) {
    bytes = toU8(bytes);
    return isMsg(bytes) ? parseMsg(bytes) : parseEml(bytes);
  }

  async function parseEml(bytes) {
    const email = await PostalMime.parse(bytes, { attachmentEncoding: 'arraybuffer' });
    const addr = (a) => (a ? { name: a.name || '', address: a.address || '' } : null);
    const flat = (list) => {
      const out = [];
      for (const a of list || []) {
        if (a.group) a.group.forEach((g) => out.push(addr(g)));
        else out.push(addr(a));
      }
      return out;
    };
    let date = email.date ? new Date(email.date) : null;
    if (date && isNaN(date)) date = null;
    return {
      subject: email.subject || '',
      from: addr(email.from),
      to: flat(email.to),
      cc: flat(email.cc),
      date,
      html: email.html || '',
      text: email.text || '',
      attachments: (email.attachments || []).map((a) => ({
        filename: a.filename || '',
        mimeType: (a.mimeType || 'application/octet-stream').toLowerCase(),
        contentId: (a.contentId || '').replace(/^<|>$/g, ''),
        disposition: a.disposition || 'attachment',
        data: toU8(a.content),
      })),
      raw: bytes,
    };
  }

  function parseMsg(bytes) {
    const reader = new MsgReader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const info = reader.getFileData();
    if (info.error) throw new Error('MSG-Datei konnte nicht gelesen werden: ' + info.error);
    const mail = msgFieldsToMail(reader, info);
    mail.raw = bytes;
    return mail;
  }

  function decodeMsgHtml(info) {
    if (info.bodyHtml) return info.bodyHtml;
    if (info.html && info.html.length) {
      const cp = info.internetCodepage;
      const enc = cp === 65001 ? 'utf-8' : cp === 1252 ? 'windows-1252' : cp === 28591 ? 'iso-8859-1' : cp ? 'windows-' + cp : 'utf-8';
      try { return new TextDecoder(enc).decode(toU8(info.html)); } catch (e) { return new TextDecoder('utf-8').decode(toU8(info.html)); }
    }
    return '';
  }

  function msgFieldsToMail(reader, info) {
    const recips = info.recipients || [];
    const person = (r) => ({ name: r.name || '', address: r.smtpAddress || r.email || '' });
    const dateStr = info.messageDeliveryTime || info.clientSubmitTime || info.creationTime;
    let date = dateStr ? new Date(dateStr) : null;
    if (date && isNaN(date)) date = null;

    const attachments = [];
    for (const att of info.attachments || []) {
      if (att.innerMsgContent && att.innerMsgContentFields) {
        attachments.push({
          filename: (att.innerMsgContentFields.subject || att.name || 'E-Mail') + '.msg',
          mimeType: 'application/x-mailpdf-inner-msg',
          contentId: '',
          disposition: 'attachment',
          data: new Uint8Array(0),
          inner: msgFieldsToMail(reader, att.innerMsgContentFields),
        });
        continue;
      }
      let file;
      try { file = reader.getAttachment(att); } catch (e) { continue; }
      if (!file || !file.content) continue;
      const name = att.fileName || att.fileNameShort || att.name || file.fileName || 'Anhang';
      attachments.push({
        filename: name,
        mimeType: (att.attachMimeTag || guessMime(name)).toLowerCase(),
        contentId: (att.pidContentId || '').replace(/^<|>$/g, ''),
        disposition: att.attachmentHidden ? 'inline' : 'attachment',
        data: toU8(file.content),
      });
    }

    return {
      subject: info.subject || '',
      from: { name: info.senderName || '', address: info.senderSmtpAddress || info.senderEmail || '' },
      to: recips.filter((r) => !r.recipType || r.recipType === 'to').map(person),
      cc: recips.filter((r) => r.recipType === 'cc').map(person),
      date,
      html: decodeMsgHtml(info),
      text: info.body || '',
      attachments,
    };
  }

  const EXT_MIME = {
    pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff',
    heic: 'image/heic', txt: 'text/plain', csv: 'text/csv', htm: 'text/html', html: 'text/html',
    eml: 'message/rfc822', msg: 'application/vnd.ms-outlook',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel', ods: 'application/vnd.oasis.opendocument.spreadsheet',
    json: 'application/json', xml: 'application/xml',
  };

  function ext(name) {
    const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  }

  function guessMime(name) {
    return EXT_MIME[ext(name)] || 'application/octet-stream';
  }

  return { parse, isMsg, ext, guessMime, toU8 };
})();
