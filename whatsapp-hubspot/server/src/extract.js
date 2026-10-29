// Reine Hilfsfunktionen, die aus einer WhatsApp-Nachricht (Baileys-Format) das Wesentliche holen.

import { lidFromJid, phoneFromJid } from './phone.js'

// Hüllen, in denen WhatsApp den eigentlichen Inhalt verpackt
const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
]

export function unwrapMessage(message) {
  let m = message
  for (let i = 0; i < 5 && m; i++) {
    const key = WRAPPERS.find((w) => m[w]?.message)
    if (!key) break
    m = m[key].message
  }
  return m || null
}

const MEDIA_TYPES = {
  imageMessage: { type: 'image', label: 'Bild' },
  videoMessage: { type: 'video', label: 'Video' },
  audioMessage: { type: 'audio', label: 'Sprachnachricht' },
  documentMessage: { type: 'document', label: 'Dokument' },
  stickerMessage: { type: 'sticker', label: 'Sticker' },
}

// Liefert { type, text, media } oder null, wenn die Nachricht nichts Anzeigbares enthält
// (Lesebestätigungen, Schlüsselaustausch, Reaktionen usw.)
export function messageContent(message) {
  const m = unwrapMessage(message)
  if (!m) return null

  const text = m.conversation || m.extendedTextMessage?.text
  if (text) return { type: 'text', text, media: null }

  for (const [field, info] of Object.entries(MEDIA_TYPES)) {
    const media = m[field]
    if (!media) continue
    const fileName = media.fileName || null
    const caption = media.caption || null
    let label = info.label
    if (info.type === 'audio' && media.ptt === false) label = 'Audio'
    const placeholder = fileName ? `[${label}: ${fileName}]` : `[${label}]`
    return {
      type: info.type,
      text: caption || placeholder,
      media: {
        field,
        mime: media.mimetype || null,
        fileName,
        size: Number(media.fileLength || 0) || null,
      },
    }
  }

  if (m.locationMessage || m.liveLocationMessage) {
    const loc = m.locationMessage || m.liveLocationMessage
    const where = [loc.name, loc.address].filter(Boolean).join(', ')
    const coords = `${loc.degreesLatitude},${loc.degreesLongitude}`
    return { type: 'location', text: `[Standort${where ? ': ' + where : ''}] https://maps.google.com/?q=${coords}`, media: null }
  }
  if (m.contactMessage) {
    return { type: 'contact', text: `[Kontakt: ${m.contactMessage.displayName || ''}]`, media: null }
  }
  if (m.contactsArrayMessage) {
    return { type: 'contact', text: `[Kontakte: ${m.contactsArrayMessage.displayName || ''}]`, media: null }
  }
  if (m.pollCreationMessage || m.pollCreationMessageV3) {
    const poll = m.pollCreationMessage || m.pollCreationMessageV3
    return { type: 'poll', text: `[Umfrage: ${poll.name || ''}]`, media: null }
  }
  return null
}

// Wer ist der Chatpartner? Gruppen, Status-Meldungen, Kanäle und Broadcasts lassen wir aus.
export function peerOf(key) {
  const jid = key?.remoteJid || ''
  if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return null
  const alt = key.remoteJidAlt || ''
  const phone = phoneFromJid(jid) || phoneFromJid(alt)
  const lid = lidFromJid(jid) || lidFromJid(alt)
  if (!phone && !lid) return null
  return { phone, lid }
}

export function timestampMs(messageTimestamp) {
  if (messageTimestamp === null || messageTimestamp === undefined) return Date.now()
  // Baileys liefert Sekunden, teils als Long-Objekt
  const seconds = Number(typeof messageTimestamp === 'object' ? messageTimestamp.toString() : messageTimestamp)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.now()
}

const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
}

export function extensionFor(mime, fileName) {
  const fromName = fileName && /\.([a-z0-9]{1,8})$/i.exec(fileName)?.[1]
  if (fromName) return fromName.toLowerCase()
  const base = String(mime || '').split(';')[0].trim()
  return EXTENSIONS[base] || 'bin'
}
