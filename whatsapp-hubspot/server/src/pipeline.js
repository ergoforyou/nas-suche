// Verarbeitet jede Nachricht: lokal speichern, Kontakt in HubSpot finden (oder anlegen),
// Felder am Kontakt aktualisieren und – je nach Einstellung – einen Chronik-Eintrag schreiben.

import { formatPhone } from './phone.js'

const HOUR = 60 * 60 * 1000

export class Pipeline {
  constructor({ store, hubspot, config, log }) {
    this.store = store
    this.hubspot = hubspot
    this.config = config
    this.log = log
    this.resolving = new Map() // chatId -> laufende Kontaktsuche (verhindert doppelte Kontakte)
    this.timers = new Map() // chatId|Tag -> Zeitgeber für den Chronik-Eintrag
    this.flushing = new Map() // chatId|Tag -> laufendes Schreiben
    this.dayFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: config.timeZone, dateStyle: 'short' })
    this.timeFormat = new Intl.DateTimeFormat('de-DE', { timeZone: config.timeZone, hour: '2-digit', minute: '2-digit' })
  }

  dayKey(ts) {
    return this.dayFormat.format(ts)
  }

  // m: { id, phone, lid, name, fromMe, type, text, ts, status, sentBy, sentByEmail,
  //      mediaFile, mediaMime, mediaName, source }
  async handle(m) {
    const chat = this.store.upsertChat({ phone: m.phone, lid: m.lid, name: m.fromMe ? null : m.name })
    const isNew = this.store.saveMessage({ ...m, chatId: chat.id })
    if (!isNew || m.source === 'history') return { chat, isNew }
    if (m.fromMe) this.store.noteOutbound(chat.id)
    else this.store.noteInbound(chat.id)
    await this.sync(this.store.getMessage(m.id))
    return { chat: this.store.getChat(chat.id), isNew }
  }

  async sync(msg) {
    const chat = this.store.getChat(msg.chat_id)
    if (!chat) return
    try {
      const contactId = await this.resolveContact(chat, {
        create: !msg.from_me && this.config.autoCreateContacts,
      })
      if (contactId) {
        await this.updateContactFields(contactId, msg)
        await this.writeTimeline(chat.id, contactId, msg)
      }
      this.store.markSynced(msg.id)
    } catch (e) {
      // Kontakt wurde in HubSpot gelöscht oder zusammengeführt: beim nächsten Versuch neu suchen
      if (e.status === 404 && chat.contact_id) this.store.forgetContact(chat.contact_id)
      this.log.warn({ err: e.message, message: msg.id }, 'HubSpot-Abgleich fehlgeschlagen, neuer Versuch später')
    }
  }

  // Holt nach, was HubSpot noch nicht erreicht hat (z. B. weil HubSpot kurz nicht erreichbar war)
  async retryUnsynced() {
    for (const msg of this.store.unsyncedMessages(200)) await this.sync(msg)
  }

  async resolveContact(chat, { create }) {
    if (chat.contact_id) return chat.contact_id
    if (!chat.phone) return null
    if (this.resolving.has(chat.id)) return this.resolving.get(chat.id)
    const job = (async () => {
      const found = await this.hubspot.findContactsByPhone(chat.phone)
      let contactId = found[0]?.id || null
      if (found.length > 1) {
        this.log.warn({ phone: chat.phone, ids: found.map((c) => c.id) }, 'Mehrere Kontakte mit dieser Nummer, nehme den zuletzt geänderten')
      }
      if (!contactId && create) {
        const created = await this.hubspot.createContact({
          ...splitName(chat.name, chat.phone),
          mobilephone: formatPhone(chat.phone),
          whatsapp_nummer: formatPhone(chat.phone),
        })
        contactId = created.id
        this.log.info({ phone: chat.phone, contactId }, 'Neuen Kontakt aus WhatsApp angelegt')
      }
      if (contactId) this.store.setChatContact(chat.id, contactId)
      return contactId ? String(contactId) : null
    })()
    this.resolving.set(chat.id, job)
    try {
      return await job
    } finally {
      this.resolving.delete(chat.id)
    }
  }

  async updateContactFields(contactId, msg) {
    const chats = this.store.chatsByContact(contactId)
    const unread = chats.reduce((n, c) => n + c.unread, 0)
    const latest = Math.max(0, ...chats.map((c) => c.last_ts))
    const props = {
      whatsapp_ungelesen: String(unread),
      whatsapp_wartet: chats.some((c) => c.waiting) ? 'true' : 'false',
    }
    const chat = chats.find((c) => c.id === msg.chat_id)
    if (chat?.phone) props.whatsapp_nummer = formatPhone(chat.phone)
    if (msg.ts >= latest) {
      props.whatsapp_letzte_nachricht = new Date(msg.ts).toISOString()
      props.whatsapp_letzte_vorschau = `${msg.from_me ? 'Wir: ' : ''}${msg.text || ''}`.slice(0, 250)
    }
    await this.hubspot.updateContact(contactId, props)
  }

  // Jemand hat den Verlauf in HubSpot angesehen
  async markRead(contactId, chats) {
    const hadUnread = chats.some((c) => c.unread > 0)
    this.store.markRead(chats.map((c) => c.id))
    if (hadUnread) await this.hubspot.updateContact(contactId, { whatsapp_ungelesen: '0' })
  }

  async writeTimeline(chatId, contactId, msg) {
    const mode = this.config.timeline
    if (mode === 'aus') return
    if (mode === 'nachricht') {
      const chat = this.store.getChat(chatId)
      await this.hubspot.createCommunication({ contactId, body: this.render([msg], chat), timestamp: msg.ts })
      return
    }
    // Modus "tag": ein Eintrag pro Kunde und Tag, der mit jeder Nachricht ergänzt wird
    const day = this.dayKey(msg.ts)
    const key = `${chatId}|${day}`
    if (this.config.timelineDelayMs <= 0) return this.flushDay(chatId, contactId, day, msg.ts)
    clearTimeout(this.timers.get(key))
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key)
        this.flushDay(chatId, contactId, day, msg.ts).catch((e) =>
          this.log.warn({ err: e.message, chatId, day }, 'Chronik-Eintrag konnte nicht geschrieben werden')
        )
      }, this.config.timelineDelayMs)
    )
  }

  async flushDay(chatId, contactId, day, aroundTs) {
    const key = `${chatId}|${day}`
    const previous = this.flushing.get(key) || Promise.resolve()
    const job = previous
      .catch(() => {})
      .then(async () => {
        const chat = this.store.getChat(chatId)
        if (!chat) return
        const messages = this.store
          .messagesBetween(chatId, aroundTs - 36 * HOUR, aroundTs + 36 * HOUR)
          .filter((m) => this.dayKey(m.ts) === day)
        if (!messages.length) return
        const body = this.render(messages, chat)
        let commId = this.store.getTimelineEntry(chatId, day)
        if (commId) {
          try {
            await this.hubspot.updateCommunication(commId, { body })
            return
          } catch (e) {
            if (e.status !== 404) throw e
            commId = null // Eintrag wurde in HubSpot gelöscht: neu anlegen
          }
        }
        commId = await this.hubspot.createCommunication({ contactId, body, timestamp: messages[0].ts })
        this.store.setTimelineEntry(chatId, day, commId)
      })
    this.flushing.set(key, job)
    try {
      await job
    } finally {
      if (this.flushing.get(key) === job) this.flushing.delete(key)
    }
  }

  // Beim Herunterfahren alle wartenden Chronik-Einträge sofort schreiben
  async flushAll() {
    const pending = [...this.timers.entries()]
    this.timers.clear()
    for (const [, timer] of pending) clearTimeout(timer)
    await Promise.allSettled([...this.flushing.values()])
    for (const [key] of pending) {
      const [chatId, day] = key.split('|')
      const chat = this.store.getChat(chatId)
      if (!chat?.contact_id) continue
      const last = this.store.messagesForChats([chatId], { limit: 1 }).messages[0]
      if (last) await this.flushDay(chatId, chat.contact_id, day, last.ts).catch(() => {})
    }
  }

  render(messages, chat) {
    const lines = messages.map((m) => {
      const who = m.from_me ? m.sent_by || 'Telefon' : chat?.name || 'Kunde'
      const text = escapeHtml(m.text || '').replace(/\n/g, '<br>')
      return `<p><strong>${this.timeFormat.format(m.ts)} · ${escapeHtml(who)}:</strong> ${text}</p>`
    })
    return lines.join('')
  }
}

export function splitName(name, phone) {
  const clean = String(name || '').trim()
  if (!clean) return { firstname: 'WhatsApp', lastname: formatPhone(phone) }
  const parts = clean.split(/\s+/)
  if (parts.length === 1) return { firstname: parts[0] }
  return { firstname: parts.slice(0, -1).join(' '), lastname: parts.at(-1) }
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
