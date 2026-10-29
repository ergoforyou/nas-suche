// HTTP-Schnittstelle: Karte in HubSpot (Verlauf/Senden), Medien-Links, Admin-Seite mit QR-Code.

import crypto from 'node:crypto'
import path from 'node:path'
import express from 'express'
import QRCode from 'qrcode'
import { formatPhone, normalizePhone } from './phone.js'
import { signMediaLink, verifyMediaLink, verifyV3 } from './signature.js'

const HOUR = 60 * 60 * 1000
const MAX_TEXT = 4096
// Reihenfolge = Vorrang beim Senden
const PHONE_FIELDS = ['whatsapp_nummer', 'mobilephone', 'hs_whatsapp_phone_number', 'phone']

export function createApp({ config, store, pipeline, whatsapp, hubspot, log, mediaDir, now = Date.now }) {
  const app = express()
  app.disable('x-powered-by')

  // ---------- Hilfsfunktionen ----------

  const phoneCache = new Map()
  async function contactPhones(contactId) {
    const hit = phoneCache.get(contactId)
    if (hit && now() - hit.at < 60_000) return hit.phones
    const contact = await hubspot.getContact(contactId, PHONE_FIELDS)
    const phones = [
      ...new Set(PHONE_FIELDS.map((f) => normalizePhone(contact.properties?.[f], config.countryCode)).filter(Boolean)),
    ]
    phoneCache.set(contactId, { phones, at: now() })
    return phones
  }

  async function chatsForContact(contactId) {
    const phones = await contactPhones(contactId)
    const byId = new Map()
    for (const c of [...store.chatsByPhones(phones), ...store.chatsByContact(contactId)]) byId.set(c.id, c)
    const chats = [...byId.values()].sort((a, b) => b.last_ts - a.last_ts)
    // Die Karte weiß, zu welchem Kontakt die Nummer gehört: noch nicht zugeordnete Chats verknüpfen
    for (const c of chats) {
      if (!c.contact_id) {
        store.setChatContact(c.id, contactId)
        c.contact_id = String(contactId)
      }
    }
    return { phones, chats }
  }

  function mediaUrl(id) {
    const expires = Math.ceil((now() + 6 * HOUR) / HOUR) * HOUR
    const sig = signMediaLink(config.mediaSecret, id, expires)
    return `${config.publicUrl}/medien/${encodeURIComponent(id)}?bis=${expires}&sig=${sig}`
  }

  function toCard(m) {
    return {
      id: m.id,
      eigene: Boolean(m.from_me),
      typ: m.type,
      text: m.text || '',
      zeit: m.ts,
      status: m.status,
      absender: m.from_me ? m.sent_by || 'Telefon' : null,
      chat: m.chat_id,
      medien: m.media_file
        ? {
            url: mediaUrl(m.id),
            mime: m.media_mime,
            name: m.media_name,
            bild: String(m.media_mime || '').startsWith('image/'),
          }
        : null,
    }
  }

  const contactIdOf = (body) => {
    const id = String(body?.contactId ?? '').trim()
    return /^\d+$/.test(id) ? id : null
  }

  // ---------- Schnittstelle für die HubSpot-Karte ----------

  const api = express.Router()
  api.use(
    express.json({
      type: () => true,
      limit: '256kb',
      verify: (req, _res, buf) => {
        req.rawBody = buf.toString('utf8')
      },
    })
  )
  api.use((req, res, next) => {
    const ok = verifyV3({
      secret: config.hubspotClientSecret,
      method: req.method,
      url: config.publicUrl + req.originalUrl,
      body: req.rawBody || '',
      timestamp: req.get('x-hubspot-request-timestamp'),
      signature: req.get('x-hubspot-signature-v3'),
      now: now(),
    })
    if (!ok) return res.status(401).json({ fehler: 'Anfrage ist nicht von eurer HubSpot-App signiert' })
    const portal = req.query.portalId ? String(req.query.portalId) : null
    if (config.hubspotPortalId && portal && portal !== config.hubspotPortalId) {
      return res.status(403).json({ fehler: 'Falsches HubSpot-Konto' })
    }
    req.hubspotUser = { id: req.query.userId || null, email: req.query.userEmail || null }
    next()
  })

  api.post('/verlauf', async (req, res, next) => {
    try {
      const contactId = contactIdOf(req.body)
      if (!contactId) return res.status(400).json({ fehler: 'contactId fehlt' })
      const before = Number(req.body.vor) || null
      const { phones, chats } = await chatsForContact(contactId)
      const { messages, hasMore } = store.messagesForChats(
        chats.map((c) => c.id),
        { before, limit: Math.min(Number(req.body.anzahl) || 40, 100) }
      )
      if (!before && chats.some((c) => c.unread > 0)) {
        await pipeline.markRead(contactId, chats).catch((e) => log.warn({ err: e.message }, 'Gelesen-Markierung fehlgeschlagen'))
      }
      res.json({
        verbunden: whatsapp.connected,
        status: whatsapp.state,
        nummern: phones.map(formatPhone),
        chats: chats.map((c) => ({ id: c.id, nummer: formatPhone(c.phone), name: c.name })),
        nachrichten: messages.map(toCard),
        mehr: hasMore,
      })
    } catch (e) {
      next(e)
    }
  })

  api.post('/senden', async (req, res, next) => {
    try {
      const contactId = contactIdOf(req.body)
      const text = String(req.body?.text || '').trim()
      if (!contactId) return res.status(400).json({ fehler: 'contactId fehlt' })
      if (!text) return res.status(400).json({ fehler: 'Die Nachricht ist leer' })
      if (text.length > MAX_TEXT) return res.status(400).json({ fehler: `Höchstens ${MAX_TEXT} Zeichen` })
      if (!whatsapp.connected) return res.status(503).json({ fehler: 'WhatsApp ist gerade nicht verbunden' })

      const { phones, chats } = await chatsForContact(contactId)
      let target = null
      if (req.body.chatId) {
        target = chats.find((c) => c.id === req.body.chatId)
        if (!target) return res.status(400).json({ fehler: 'Dieser Chat gehört nicht zum Kontakt' })
      } else if (req.body.nummer) {
        const wanted = normalizePhone(req.body.nummer, config.countryCode)
        if (!phones.includes(wanted)) return res.status(400).json({ fehler: 'Diese Nummer steht nicht am Kontakt' })
        target = chats.find((c) => c.phone === wanted) || { phone: wanted }
      } else {
        target = chats[0] || (phones[0] ? { phone: phones[0] } : null)
      }
      if (!target) return res.status(400).json({ fehler: 'Am Kontakt ist keine Telefonnummer eingetragen' })
      if (!target.id && !(await whatsapp.exists(target.phone))) {
        return res.status(422).json({ fehler: `${formatPhone(target.phone)} ist nicht bei WhatsApp` })
      }

      const day = pipeline.dayKey(now())
      if (store.sentOn(day) >= config.dailySendLimit) {
        return res.status(429).json({ fehler: `Tageslimit von ${config.dailySendLimit} Nachrichten erreicht` })
      }

      const sender = String(req.body.absender || '').trim().slice(0, 80) || req.hubspotUser.email || 'HubSpot'
      const finalText = config.nameInMessage ? `*${sender}:*\n${text}` : text

      // Chat vorab dem Kontakt zuordnen, damit nicht nach einem anderen Kontakt gesucht wird
      const chat = target.id ? target : store.upsertChat({ phone: target.phone })
      if (!chat.contact_id) store.setChatContact(chat.id, contactId)

      const sent = await whatsapp.sendText({ phone: chat.phone, lid: chat.lid }, finalText)
      store.countSend(day)
      await pipeline.handle({
        id: sent.id,
        phone: chat.phone,
        lid: chat.lid,
        name: null,
        fromMe: true,
        type: 'text',
        text: finalText,
        ts: sent.ts,
        status: sent.status,
        sentBy: sender,
        sentByEmail: req.hubspotUser.email,
        source: 'hubspot',
      })
      res.json({ nachricht: toCard(store.getMessage(sent.id)) })
    } catch (e) {
      next(e)
    }
  })

  app.use('/api/karte', api)

  // ---------- Medien (Bilder/Dateien) per signiertem Link ----------

  app.get('/medien/:id', (req, res) => {
    const { id } = req.params
    if (!verifyMediaLink(config.mediaSecret, id, req.query.bis, req.query.sig, now())) return res.status(403).end()
    const m = store.getMessage(id)
    if (!m?.media_file) return res.status(404).end()
    const file = path.join(mediaDir, path.basename(m.media_file))
    res.set('Cache-Control', 'private, max-age=3600')
    if (m.media_mime) res.type(m.media_mime)
    if (m.media_name) res.attachment(m.media_name)
    res.sendFile(file, (err) => {
      if (err && !res.headersSent) res.status(404).end()
    })
  })

  // ---------- Admin-Seite ----------

  const admin = express.Router()
  admin.use(express.urlencoded({ extended: false, limit: '16kb' }))
  admin.use((req, res, next) => {
    const header = req.get('authorization') || ''
    const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8')
    const pass = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : ''
    if (!safeEqual(pass, config.adminPassword)) {
      res.set('WWW-Authenticate', 'Basic realm="WhatsApp-Server", charset="UTF-8"')
      return res.status(401).send('Anmeldung erforderlich')
    }
    next()
  })
  const csrf = crypto.createHmac('sha256', config.adminPassword).update('admin-formular').digest('hex')
  const checkCsrf = (req, res, next) => (safeEqual(req.body?.token, csrf) ? next() : res.status(403).send('Ungültiges Formular'))

  admin.get('/', async (req, res) => {
    const qr = whatsapp.qr ? await QRCode.toDataURL(whatsapp.qr, { margin: 1, width: 320 }) : null
    const day = pipeline.dayKey(now())
    res.send(
      adminPage({
        state: whatsapp.state,
        me: whatsapp.me,
        qr,
        csrf,
        sentToday: store.sentOn(day),
        limit: config.dailySendLimit,
        unassigned: store.unassignedChats(30),
        timeZone: config.timeZone,
      })
    )
  })
  admin.post('/zuordnen', checkCsrf, (req, res) => {
    const contactId = contactIdOf(req.body)
    const chat = store.getChat(String(req.body.chatId || ''))
    if (!chat || !contactId) return res.status(400).send('Chat oder Kontakt-ID fehlt')
    store.setChatContact(chat.id, contactId)
    res.redirect(303, '/admin')
  })
  admin.post('/abmelden', checkCsrf, async (req, res) => {
    await whatsapp.logout()
    res.redirect(303, '/admin')
  })
  app.use('/admin', admin)

  app.get('/gesund', (req, res) => res.json({ ok: true, whatsapp: whatsapp.state }))

  app.use((err, req, res, _next) => {
    log.error({ err: err.message, pfad: req.path }, 'Fehler bei Anfrage')
    if (res.headersSent) return
    const status = err.status === 404 ? 404 : 500
    res.status(status).json({ fehler: status === 404 ? 'Kontakt nicht gefunden' : 'Interner Fehler – Details im Container-Protokoll' })
  })

  return app
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''))
  const y = Buffer.from(String(b ?? ''))
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y)
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function adminPage({ state, me, qr, csrf, sentToday, limit, unassigned, timeZone }) {
  const statusText = {
    verbunden: `Verbunden${me ? ' mit +' + esc(me) : ''}`,
    qr: 'Nicht verbunden – QR-Code scannen',
    getrennt: 'Getrennt – verbinde neu …',
    start: 'Startet …',
  }[state]
  const rows = unassigned
    .map(
      (c) => `<tr><td>${esc(c.name || '–')}</td><td>${c.phone ? '+' + esc(c.phone) : 'LID ' + esc(c.lid)}</td>
      <td>${new Date(c.last_ts).toLocaleString('de-DE', { timeZone })}</td>
      <td><form method="post" action="/admin/zuordnen"><input type="hidden" name="token" value="${csrf}">
      <input type="hidden" name="chatId" value="${esc(c.id)}"><input name="contactId" placeholder="HubSpot-Kontakt-ID" inputmode="numeric" required>
      <button>Zuordnen</button></form></td></tr>`
    )
    .join('')
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp-Server</title>${state === 'verbunden' ? '' : '<meta http-equiv="refresh" content="10">'}
<style>
  body{font:16px/1.5 system-ui,sans-serif;max-width:860px;margin:0 auto;padding:16px;color:#1f2933;background:#f7f8fa}
  h1{font-size:1.4rem} .card{background:#fff;border:1px solid #dde2e8;border-radius:8px;padding:16px;margin:16px 0}
  .ok{color:#137333;font-weight:600} .warn{color:#b3261e;font-weight:600}
  table{width:100%;border-collapse:collapse} td,th{padding:6px;border-bottom:1px solid #eef0f3;text-align:left;vertical-align:top}
  input{padding:4px 6px;width:11rem;max-width:100%} button{padding:4px 10px;cursor:pointer}
  ol{padding-left:1.2rem} img{display:block;margin:12px 0;max-width:100%}
</style></head><body>
<h1>WhatsApp ↔ HubSpot</h1>
<div class="card"><div class="${state === 'verbunden' ? 'ok' : 'warn'}">${statusText}</div>
<div>Heute aus HubSpot gesendet: ${sentToday} von höchstens ${limit}</div>
${qr ? `<ol><li>WhatsApp Business auf dem Firmen-Telefon öffnen</li><li>Einstellungen → Verknüpfte Geräte → Gerät hinzufügen</li><li>Diesen Code scannen (er erneuert sich, die Seite lädt alle 10 Sekunden neu)</li></ol><img src="${qr}" alt="QR-Code" width="320" height="320">` : ''}
${state === 'verbunden' ? `<form method="post" action="/admin/abmelden" onsubmit="return confirm('Server wirklich von WhatsApp abmelden?')"><input type="hidden" name="token" value="${csrf}"><button>Server von WhatsApp abmelden</button></form>` : ''}
</div>
<div class="card"><h2 style="font-size:1.1rem;margin-top:0">Chats ohne HubSpot-Kontakt</h2>
${rows ? `<table><tr><th>Name</th><th>Nummer</th><th>Zuletzt</th><th>Kontakt zuordnen</th></tr>${rows}</table>` : '<p>Alle Chats sind zugeordnet.</p>'}
<p style="font-size:.9rem;color:#52606d">Die Kontakt-ID steht in HubSpot in der Adresszeile des Kontakts (…/record/0-1/<b>12345</b>).</p></div>
</body></html>`
}
