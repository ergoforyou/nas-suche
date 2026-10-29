// Lokaler Speicher auf der NAS (SQLite). Hier liegt der komplette Verlauf –
// HubSpot bekommt nur Kennzahlen und, je nach Einstellung, einen Eintrag in der Chronik.

import Database from 'better-sqlite3'

const SCHEMA = [
  `CREATE TABLE chats (
     id TEXT PRIMARY KEY,           -- "pn:491761234567" oder "lid:123456789"
     phone TEXT,                    -- Ziffern mit Ländervorwahl
     lid TEXT,                      -- anonyme WhatsApp-Kennung, falls bekannt
     name TEXT,                     -- Profilname aus WhatsApp
     contact_id TEXT,               -- HubSpot-Kontakt
     last_ts INTEGER NOT NULL DEFAULT 0,
     unread INTEGER NOT NULL DEFAULT 0,
     waiting INTEGER NOT NULL DEFAULT 0  -- letzte Nachricht kam vom Kunden
   )`,
  'CREATE INDEX chats_phone ON chats(phone)',
  'CREATE INDEX chats_lid ON chats(lid)',
  'CREATE INDEX chats_contact ON chats(contact_id)',
  `CREATE TABLE messages (
     id TEXT PRIMARY KEY,           -- WhatsApp-Nachrichten-ID
     chat_id TEXT NOT NULL,
     from_me INTEGER NOT NULL,
     type TEXT NOT NULL,
     text TEXT,
     media_file TEXT,
     media_mime TEXT,
     media_name TEXT,
     ts INTEGER NOT NULL,
     status INTEGER,                -- 1 wartet, 2 gesendet, 3 zugestellt, 4 gelesen
     sent_by TEXT,                  -- Name in HubSpot, "Telefon" oder NULL (Kunde)
     sent_by_email TEXT,
     source TEXT NOT NULL,          -- live | history | hubspot
     hubspot_synced INTEGER NOT NULL DEFAULT 0
   )`,
  'CREATE INDEX messages_chat_ts ON messages(chat_id, ts)',
  'CREATE INDEX messages_unsynced ON messages(hubspot_synced, source)',
  `CREATE TABLE timeline (
     chat_id TEXT NOT NULL,
     day TEXT NOT NULL,
     comm_id TEXT NOT NULL,
     PRIMARY KEY (chat_id, day)
   )`,
  'CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)',
]

export function openStore(file) {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  if (db.pragma('user_version', { simple: true }) === 0) {
    db.transaction(() => {
      for (const sql of SCHEMA) db.exec(sql)
      db.pragma('user_version = 1')
    })()
  }
  return new Store(db)
}

export class Store {
  constructor(db) {
    this.db = db
    this.q = {
      chat: db.prepare('SELECT * FROM chats WHERE id = ?'),
      chatByLid: db.prepare("SELECT * FROM chats WHERE lid = ? ORDER BY id LIKE 'pn:%' DESC LIMIT 1"),
      insertChat: db.prepare(
        `INSERT INTO chats (id, phone, lid, name) VALUES (@id, @phone, @lid, @name)
         ON CONFLICT(id) DO UPDATE SET lid = COALESCE(excluded.lid, chats.lid),
                                       name = COALESCE(excluded.name, chats.name)`
      ),
      message: db.prepare('SELECT * FROM messages WHERE id = ?'),
      upsertMessage: db.prepare(
        `INSERT INTO messages (id, chat_id, from_me, type, text, media_file, media_mime, media_name,
                               ts, status, sent_by, sent_by_email, source)
         VALUES (@id, @chat_id, @from_me, @type, @text, @media_file, @media_mime, @media_name,
                 @ts, @status, @sent_by, @sent_by_email, @source)
         ON CONFLICT(id) DO UPDATE SET
           sent_by = COALESCE(excluded.sent_by, messages.sent_by),
           sent_by_email = COALESCE(excluded.sent_by_email, messages.sent_by_email),
           status = MAX(COALESCE(messages.status, 0), COALESCE(excluded.status, 0)),
           media_file = COALESCE(messages.media_file, excluded.media_file)`
      ),
      touchChat: db.prepare('UPDATE chats SET last_ts = MAX(last_ts, ?) WHERE id = ?'),
      status: db.prepare('UPDATE messages SET status = ? WHERE id = ? AND COALESCE(status, 0) < ?'),
      media: db.prepare('UPDATE messages SET media_file = ? WHERE id = ?'),
      setContact: db.prepare('UPDATE chats SET contact_id = ? WHERE id = ?'),
      clearContact: db.prepare('UPDATE chats SET contact_id = NULL WHERE contact_id = ?'),
      byContact: db.prepare('SELECT * FROM chats WHERE contact_id = ? ORDER BY last_ts DESC'),
      inbound: db.prepare('UPDATE chats SET unread = unread + 1, waiting = 1 WHERE id = ?'),
      outbound: db.prepare('UPDATE chats SET waiting = 0 WHERE id = ?'),
      read: db.prepare('UPDATE chats SET unread = 0 WHERE id = ?'),
      unsynced: db.prepare(
        "SELECT * FROM messages WHERE hubspot_synced = 0 AND source != 'history' ORDER BY ts LIMIT ?"
      ),
      synced: db.prepare('UPDATE messages SET hubspot_synced = 1 WHERE id = ?'),
      timelineGet: db.prepare('SELECT comm_id FROM timeline WHERE chat_id = ? AND day = ?'),
      timelineSet: db.prepare(
        'INSERT INTO timeline (chat_id, day, comm_id) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET comm_id = excluded.comm_id'
      ),
      kvGet: db.prepare('SELECT value FROM kv WHERE key = ?'),
      kvSet: db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT DO UPDATE SET value = excluded.value'),
      unassigned: db.prepare(
        'SELECT * FROM chats WHERE contact_id IS NULL AND last_ts > 0 ORDER BY last_ts DESC LIMIT ?'
      ),
    }
  }

  close() {
    this.db.close()
  }

  getChat(id) {
    return this.q.chat.get(id) || null
  }

  // Chat zu einer Nummer und/oder LID holen oder anlegen. Taucht zu einer bisher nur
  // per LID bekannten Person die Telefonnummer auf, werden beide Chats zusammengeführt.
  upsertChat({ phone = null, lid = null, name = null }) {
    return this.db.transaction(() => {
      if (!phone && !lid) throw new Error('Chat braucht Telefonnummer oder LID')
      const lidChat = lid ? this.q.chatByLid.get(lid) : null
      if (phone) {
        const id = `pn:${phone}`
        this.q.insertChat.run({ id, phone, lid, name })
        if (lidChat && lidChat.id !== id) this.#merge(lidChat, id)
        return this.getChat(id)
      }
      if (lidChat) {
        if (name) this.q.insertChat.run({ id: lidChat.id, phone: lidChat.phone, lid, name })
        return this.getChat(lidChat.id)
      }
      const id = `lid:${lid}`
      this.q.insertChat.run({ id, phone: null, lid, name })
      return this.getChat(id)
    })()
  }

  // WhatsApp hat uns die Telefonnummer zu einer LID verraten
  linkLid(lid, phone) {
    const lidChat = this.q.chatByLid.get(lid)
    if (!lidChat || lidChat.id === `pn:${phone}`) return null
    return this.upsertChat({ phone, lid, name: lidChat.name })
  }

  #merge(from, toId) {
    const to = this.getChat(toId)
    this.db.prepare('UPDATE messages SET chat_id = ? WHERE chat_id = ?').run(toId, from.id)
    this.db
      .prepare('UPDATE OR IGNORE timeline SET chat_id = ? WHERE chat_id = ?')
      .run(toId, from.id)
    this.db.prepare('DELETE FROM timeline WHERE chat_id = ?').run(from.id)
    this.db
      .prepare(
        `UPDATE chats SET last_ts = MAX(last_ts, ?), unread = unread + ?, waiting = MAX(waiting, ?),
                          contact_id = COALESCE(contact_id, ?), name = COALESCE(name, ?)
         WHERE id = ?`
      )
      .run(from.last_ts, from.unread, from.waiting, from.contact_id, from.name, to.id)
    this.db.prepare('DELETE FROM chats WHERE id = ?').run(from.id)
  }

  // Speichert eine Nachricht. Gibt true zurück, wenn sie neu war.
  saveMessage(m) {
    return this.db.transaction(() => {
      const existed = Boolean(this.q.message.get(m.id))
      this.q.upsertMessage.run({
        id: m.id,
        chat_id: m.chatId,
        from_me: m.fromMe ? 1 : 0,
        type: m.type || 'text',
        text: m.text ?? null,
        media_file: m.mediaFile ?? null,
        media_mime: m.mediaMime ?? null,
        media_name: m.mediaName ?? null,
        ts: m.ts,
        status: m.status ?? null,
        sent_by: m.sentBy ?? null,
        sent_by_email: m.sentByEmail ?? null,
        source: m.source || 'live',
      })
      this.q.touchChat.run(m.ts, m.chatId)
      return !existed
    })()
  }

  getMessage(id) {
    return this.q.message.get(id) || null
  }

  updateStatus(id, status) {
    return this.q.status.run(status, id, status).changes > 0
  }

  setMediaFile(id, file) {
    this.q.media.run(file, id)
  }

  // Neueste Nachrichten mehrerer Chats, älteste zuerst. "before" blättert zurück.
  messagesForChats(chatIds, { before = null, limit = 40 } = {}) {
    if (!chatIds.length) return { messages: [], hasMore: false }
    const marks = chatIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE chat_id IN (${marks}) ${before ? 'AND ts < ?' : ''}
         ORDER BY ts DESC, rowid DESC LIMIT ?`
      )
      .all(...chatIds, ...(before ? [before] : []), limit + 1)
    const hasMore = rows.length > limit
    return { messages: rows.slice(0, limit).reverse(), hasMore }
  }

  messagesBetween(chatId, fromTs, toTs) {
    return this.db
      .prepare('SELECT * FROM messages WHERE chat_id = ? AND ts >= ? AND ts < ? ORDER BY ts, rowid')
      .all(chatId, fromTs, toTs)
  }

  chatsByPhones(phones) {
    if (!phones.length) return []
    const marks = phones.map(() => '?').join(',')
    return this.db.prepare(`SELECT * FROM chats WHERE phone IN (${marks}) ORDER BY last_ts DESC`).all(...phones)
  }

  chatsByContact(contactId) {
    return this.q.byContact.all(String(contactId))
  }

  setChatContact(chatId, contactId) {
    this.q.setContact.run(contactId === null ? null : String(contactId), chatId)
  }

  forgetContact(contactId) {
    this.q.clearContact.run(String(contactId))
  }

  noteInbound(chatId) {
    this.q.inbound.run(chatId)
  }

  noteOutbound(chatId) {
    this.q.outbound.run(chatId)
  }

  markRead(chatIds) {
    for (const id of chatIds) this.q.read.run(id)
  }

  unsyncedMessages(limit = 100) {
    return this.q.unsynced.all(limit)
  }

  markSynced(id) {
    this.q.synced.run(id)
  }

  getTimelineEntry(chatId, day) {
    return this.q.timelineGet.get(chatId, day)?.comm_id || null
  }

  setTimelineEntry(chatId, day, commId) {
    this.q.timelineSet.run(chatId, day, String(commId))
  }

  getValue(key) {
    return this.q.kvGet.get(key)?.value ?? null
  }

  setValue(key, value) {
    this.q.kvSet.run(key, String(value))
  }

  // Zählt gesendete Nachrichten pro Tag (Schutz gegen versehentlichen Massenversand)
  countSend(day) {
    const key = `sent:${day}`
    const n = Number(this.getValue(key) || 0) + 1
    this.setValue(key, n)
    return n
  }

  sentOn(day) {
    return Number(this.getValue(`sent:${day}`) || 0)
  }

  unassignedChats(limit = 50) {
    return this.q.unassigned.all(limit)
  }
}
