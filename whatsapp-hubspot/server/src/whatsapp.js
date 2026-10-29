// WhatsApp-Anbindung als "verknüpftes Gerät" (wie WhatsApp Web) über die Bibliothek Baileys.
// Das Telefon mit WhatsApp Business bleibt das Hauptgerät, der Server liest und schreibt mit.

import fs from 'node:fs'
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from 'baileys'
import { messageContent, peerOf, timestampMs } from './extract.js'
import { lidFromJid, phoneFromJid } from './phone.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const digitsOf = (value, parse) => {
  if (!value) return null
  const s = String(value)
  return parse(s) || (/^\d{6,20}$/.test(s) ? s : null)
}

export class WhatsApp {
  // handlers: { message(norm, raw), status(id, status), lid(lid, phone), connection(state) }
  constructor({ authDir, log, syncFullHistory = true, handlers }) {
    this.authDir = authDir
    this.log = log
    this.syncFullHistory = syncFullHistory
    this.handlers = handlers
    this.state = 'start' // start | qr | verbunden | getrennt
    this.qr = null
    this.me = null
    this.sock = null
    this.stopped = false
    this.retryDelay = 3000
    this.queue = Promise.resolve()
    this.sentCache = new Map()
  }

  get connected() {
    return this.state === 'verbunden'
  }

  async start() {
    if (this.stopped) return
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir)
    let version
    try {
      ;({ version } = await fetchLatestBaileysVersion())
    } catch {
      // ohne Internet-Abfrage nimmt Baileys die eingebaute Version
    }
    const sock = makeWASocket({
      auth: state,
      ...(version ? { version } : {}),
      logger: this.log.child({ modul: 'baileys' }, { level: 'warn' }),
      // Als Desktop-App anmelden, damit WhatsApp den älteren Verlauf mitschickt
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: this.syncFullHistory,
      // Sonst gilt das Konto dauerhaft als "online" und das Telefon zeigt keine Benachrichtigungen mehr
      markOnlineOnConnect: false,
      getMessage: async (key) => this.sentCache.get(key.id),
    })
    this.sock = sock

    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', (u) => this.onConnection(sock, u))
    sock.ev.on('messages.upsert', ({ messages }) => this.enqueue(messages, 'live'))
    sock.ev.on('messaging-history.set', ({ messages, lidPnMappings }) => {
      for (const m of lidPnMappings || []) this.onLidMapping(m)
      this.enqueue(messages, 'history')
    })
    sock.ev.on('lid-mapping.update', (m) => this.onLidMapping(m))
    sock.ev.on('messages.update', (updates) => {
      for (const { key, update } of updates) {
        if (key?.id && typeof update?.status === 'number') this.safely(() => this.handlers.status?.(key.id, update.status))
      }
    })
  }

  // Fehler in unseren Handlern dürfen die WhatsApp-Verbindung nicht stören
  safely(fn) {
    try {
      fn()
    } catch (e) {
      this.log.error({ err: e.message }, 'Fehler bei der Verarbeitung eines WhatsApp-Ereignisses')
    }
  }

  onConnection(sock, { connection, lastDisconnect, qr }) {
    if (sock !== this.sock) return
    if (qr) {
      this.qr = qr
      this.setState('qr')
    }
    if (connection === 'open') {
      this.qr = null
      this.me = phoneFromJid(sock.user?.id) || null
      this.retryDelay = 3000
      this.setState('verbunden')
      this.log.info({ nummer: this.me }, 'WhatsApp verbunden')
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      this.setState('getrennt')
      if (code === DisconnectReason.loggedOut) {
        this.log.error('Gerät wurde am Telefon abgemeldet – neuen QR-Code unter /admin scannen')
        fs.rmSync(this.authDir, { recursive: true, force: true })
        this.retryDelay = 3000
      } else {
        this.log.warn({ code }, 'WhatsApp-Verbindung getrennt, verbinde neu')
      }
      if (this.stopped) return
      const delay = code === DisconnectReason.restartRequired ? 500 : this.retryDelay
      this.retryDelay = Math.min(this.retryDelay * 2, 60_000)
      setTimeout(() => this.start().catch((e) => this.log.error({ err: e.message }, 'Neustart fehlgeschlagen')), delay)
    }
  }

  setState(state) {
    this.state = state
    this.handlers.connection?.(state)
  }

  // Nachrichten nacheinander verarbeiten, damit die Reihenfolge stimmt
  enqueue(messages, source) {
    for (const raw of messages || []) {
      this.queue = this.queue
        .then(async () => {
          const norm = await this.normalize(raw, source)
          if (norm) await this.handlers.message(norm, raw)
        })
        .catch((e) => this.log.error({ err: e.message, id: raw?.key?.id }, 'Nachricht konnte nicht verarbeitet werden'))
    }
    return this.queue
  }

  async normalize(raw, source) {
    if (!raw?.message || !raw.key?.id) return null
    const peer = peerOf(raw.key)
    if (!peer) return null
    const content = messageContent(raw.message)
    if (!content) return null
    let phone = peer.phone
    if (!phone && peer.lid) phone = await this.phoneForLid(peer.lid)
    return {
      id: raw.key.id,
      phone,
      lid: peer.lid,
      name: raw.pushName || null,
      fromMe: Boolean(raw.key.fromMe),
      type: content.type,
      text: content.text,
      media: content.media,
      ts: timestampMs(raw.messageTimestamp),
      status: typeof raw.status === 'number' ? raw.status : null,
      source,
    }
  }

  async phoneForLid(lid) {
    try {
      const pn = await this.sock?.signalRepository?.lidMapping?.getPNForLID(`${lid}@lid`)
      return digitsOf(pn, phoneFromJid)
    } catch {
      return null
    }
  }

  onLidMapping({ lid, pn } = {}) {
    const l = digitsOf(lid, lidFromJid)
    const p = digitsOf(pn, phoneFromJid)
    if (l && p) this.safely(() => this.handlers.lid?.(l, p))
  }

  async exists(phone) {
    const [result] = (await this.sock.onWhatsApp(`${phone}@s.whatsapp.net`)) || []
    return Boolean(result?.exists)
  }

  async sendText({ phone, lid }, text) {
    if (!this.connected) throw new Error('WhatsApp ist gerade nicht verbunden')
    const jid = phone ? `${phone}@s.whatsapp.net` : `${lid}@lid`
    // Kurz "schreibt …" anzeigen – wie ein Mensch, nicht wie ein Automat
    try {
      await this.sock.sendPresenceUpdate('composing', jid)
      await sleep(600 + Math.floor(Math.random() * 900))
      await this.sock.sendPresenceUpdate('paused', jid)
    } catch {
      // nicht wichtig
    }
    const sent = await this.sock.sendMessage(jid, { text })
    this.remember(sent)
    return {
      id: sent.key.id,
      ts: timestampMs(sent.messageTimestamp),
      status: typeof sent.status === 'number' ? sent.status : 1,
    }
  }

  remember(sent) {
    if (!sent?.key?.id || !sent.message) return
    this.sentCache.set(sent.key.id, sent.message)
    if (this.sentCache.size > 500) this.sentCache.delete(this.sentCache.keys().next().value)
  }

  async downloadMedia(raw) {
    return downloadMediaMessage(
      raw,
      'buffer',
      {},
      { logger: this.log.child({ modul: 'medien' }, { level: 'warn' }), reuploadRequest: this.sock.updateMediaMessage }
    )
  }

  async logout() {
    try {
      await this.sock?.logout()
    } catch {
      // Verbindung war ggf. schon weg
    }
    fs.rmSync(this.authDir, { recursive: true, force: true })
  }

  stop() {
    this.stopped = true
    this.sock?.end(undefined)
  }
}
