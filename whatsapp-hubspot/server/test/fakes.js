// Nachbauten von HubSpot und WhatsApp für die Tests – es wird nichts nach außen geschickt.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openStore } from '../src/db.js'
import { normalizePhone } from '../src/phone.js'

export const silentLog = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return silentLog
  },
}

export function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-test-'))
  const store = openStore(path.join(dir, 'test.db'))
  return { store, dir }
}

export function testConfig(overrides = {}) {
  return {
    publicUrl: 'https://wa.example.de',
    hubspotClientSecret: 'client-secret',
    hubspotPortalId: '146305116',
    adminPassword: 'ein-langes-passwort',
    mediaSecret: 'medien-secret',
    countryCode: '49',
    timeZone: 'Europe/Berlin',
    autoCreateContacts: true,
    timeline: 'tag',
    timelineDelayMs: 0,
    nameInMessage: false,
    dailySendLimit: 200,
    maxMediaBytes: 1024 * 1024,
    ...overrides,
  }
}

export class FakeHubSpot {
  constructor(contacts = []) {
    this.contacts = new Map(contacts.map((c) => [String(c.id), { id: String(c.id), properties: { ...c.properties } }]))
    this.communications = new Map()
    this.calls = []
    this.nextId = 9000
    this.failNext = null
  }

  #maybeFail(name) {
    this.calls.push(name)
    if (this.failNext) {
      const e = this.failNext
      this.failNext = null
      throw e
    }
  }

  async getContact(id) {
    this.#maybeFail('getContact')
    const c = this.contacts.get(String(id))
    if (!c) throw Object.assign(new Error('nicht gefunden'), { status: 404 })
    return c
  }

  async findContactsByPhone(digits) {
    this.#maybeFail('findContactsByPhone')
    return [...this.contacts.values()].filter((c) =>
      ['phone', 'mobilephone', 'whatsapp_nummer'].some((p) => normalizePhone(c.properties[p]) === digits)
    )
  }

  async createContact(properties) {
    this.#maybeFail('createContact')
    const id = String(this.nextId++)
    this.contacts.set(id, { id, properties: { ...properties } })
    return { id }
  }

  async updateContact(id, properties) {
    this.#maybeFail('updateContact')
    const c = this.contacts.get(String(id))
    if (!c) throw Object.assign(new Error('nicht gefunden'), { status: 404 })
    Object.assign(c.properties, properties)
    return c
  }

  async createCommunication({ contactId, body, timestamp }) {
    this.#maybeFail('createCommunication')
    const id = String(this.nextId++)
    this.communications.set(id, { contactId: String(contactId), body, timestamp })
    return id
  }

  async updateCommunication(id, { body }) {
    this.#maybeFail('updateCommunication')
    const c = this.communications.get(String(id))
    if (!c) throw Object.assign(new Error('nicht gefunden'), { status: 404 })
    c.body = body
  }
}

export class FakeWhatsApp {
  constructor() {
    this.state = 'verbunden'
    this.me = '4930123456789'
    this.qr = null
    this.sent = []
    this.known = new Set()
    this.counter = 0
  }

  get connected() {
    return this.state === 'verbunden'
  }

  async exists(phone) {
    return this.known.has(phone)
  }

  async sendText(target, text) {
    const id = `OUT${++this.counter}`
    this.sent.push({ target, text, id })
    return { id, ts: Date.now(), status: 2 }
  }

  async logout() {
    this.state = 'qr'
  }
}
