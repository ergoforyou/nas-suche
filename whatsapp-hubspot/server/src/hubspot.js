// Schlanker HubSpot-Client: Kontakte suchen/anlegen, Felder setzen, Chronik-Einträge schreiben.

import { nationalPart, normalizePhone } from './phone.js'

const COMMUNICATION_TO_CONTACT = 81
const PHONE_PROPERTIES = ['phone', 'mobilephone', 'whatsapp_nummer', 'hs_whatsapp_phone_number']

export const CONTACT_PROPERTIES = [
  { name: 'whatsapp_nummer', label: 'WhatsApp-Nummer', type: 'string', fieldType: 'text' },
  { name: 'whatsapp_letzte_nachricht', label: 'WhatsApp: letzte Nachricht', type: 'datetime', fieldType: 'date' },
  { name: 'whatsapp_letzte_vorschau', label: 'WhatsApp: letzte Nachricht (Text)', type: 'string', fieldType: 'textarea' },
  { name: 'whatsapp_ungelesen', label: 'WhatsApp: ungelesen', type: 'number', fieldType: 'number' },
  {
    name: 'whatsapp_wartet',
    label: 'WhatsApp: wartet auf Antwort',
    type: 'bool',
    fieldType: 'booleancheckbox',
    options: [
      { label: 'Ja', value: 'true', displayOrder: 0 },
      { label: 'Nein', value: 'false', displayOrder: 1 },
    ],
  },
]

export class HubSpotError extends Error {
  constructor(status, message, body) {
    super(`HubSpot ${status}: ${message}`)
    this.status = status
    this.body = body
  }
}

export class HubSpotClient {
  constructor({ token, countryCode = '49', fetchImpl = globalThis.fetch, baseUrl = 'https://api.hubapi.com', sleep }) {
    this.token = token
    this.countryCode = countryCode
    this.fetch = fetchImpl
    this.baseUrl = baseUrl
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  async request(method, path, body) {
    let lastError
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await this.fetch(this.baseUrl + path, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await res.text()
      let data = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = { message: text }
      }
      if (res.ok) return data
      lastError = new HubSpotError(res.status, data?.message || res.statusText, data)
      // Zu viele Anfragen oder Störung bei HubSpot: kurz warten und erneut versuchen
      if (res.status !== 429 && res.status < 500) throw lastError
      const retryAfter = Number(res.headers?.get?.('retry-after'))
      await this.sleep(retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt)
    }
    throw lastError
  }

  async getContact(id, properties = PHONE_PROPERTIES) {
    const query = new URLSearchParams({ properties: properties.join(',') })
    return this.request('GET', `/crm/v3/objects/contacts/${encodeURIComponent(id)}?${query}`)
  }

  // Telefonnummern eines Kontakts, vereinheitlicht und ohne Dubletten
  async contactPhones(id) {
    const contact = await this.getContact(id)
    const phones = PHONE_PROPERTIES.map((p) => normalizePhone(contact.properties?.[p], this.countryCode))
    return [...new Set(phones.filter(Boolean))]
  }

  // Sucht Kontakte zu einer Nummer. HubSpot speichert Nummern in beliebigen Formaten
  // ("0172/621…", "+49 172 621…"), stellt aber eine bereinigte Suchfassung ohne Vorwahl bereit.
  async findContactsByPhone(digits) {
    const plus = `+${digits}`
    const national = nationalPart(digits, this.countryCode)
    const groups = [
      { filters: [{ propertyName: 'whatsapp_nummer', operator: 'EQ', value: plus }] },
      { filters: [{ propertyName: 'whatsapp_nummer', operator: 'EQ', value: digits }] },
    ]
    if (national) {
      groups.push(
        { filters: [{ propertyName: 'hs_searchable_calculated_mobile_number', operator: 'EQ', value: national }] },
        { filters: [{ propertyName: 'hs_searchable_calculated_phone_number', operator: 'EQ', value: national }] }
      )
    }
    const data = await this.request('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: groups,
      properties: [...PHONE_PROPERTIES, 'firstname', 'lastname', 'lastmodifieddate'],
      sorts: [{ propertyName: 'lastmodifieddate', direction: 'DESCENDING' }],
      limit: 10,
    })
    const results = data?.results || []
    // Gegenprobe: passt eine der Nummern des Treffers wirklich?
    const verified = results.filter((c) =>
      PHONE_PROPERTIES.some((p) => normalizePhone(c.properties?.[p], this.countryCode) === digits)
    )
    return verified.length ? verified : results
  }

  async createContact(properties) {
    return this.request('POST', '/crm/v3/objects/contacts', { properties })
  }

  async updateContact(id, properties) {
    return this.request('PATCH', `/crm/v3/objects/contacts/${encodeURIComponent(id)}`, { properties })
  }

  async createCommunication({ contactId, body, timestamp }) {
    const data = await this.request('POST', '/crm/v3/objects/communications', {
      properties: {
        hs_communication_channel_type: 'WHATS_APP',
        hs_communication_logged_from: 'CRM',
        hs_communication_body: body,
        hs_timestamp: new Date(timestamp).toISOString(),
      },
      associations: [
        {
          to: { id: String(contactId) },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: COMMUNICATION_TO_CONTACT }],
        },
      ],
    })
    return data.id
  }

  async updateCommunication(id, { body }) {
    return this.request('PATCH', `/crm/v3/objects/communications/${encodeURIComponent(id)}`, {
      properties: { hs_communication_body: body },
    })
  }

  // Legt die Gruppe "WhatsApp" und die Kontakt-Felder an, falls sie noch fehlen
  async ensureSchema() {
    try {
      await this.request('POST', '/crm/v3/properties/contacts/groups', {
        name: 'whatsapp',
        label: 'WhatsApp',
        displayOrder: -1,
      })
    } catch (e) {
      if (e.status !== 409) throw e
    }
    const created = []
    for (const p of CONTACT_PROPERTIES) {
      try {
        await this.request('GET', `/crm/v3/properties/contacts/${p.name}`)
      } catch (e) {
        if (e.status !== 404) throw e
        await this.request('POST', '/crm/v3/properties/contacts', { ...p, groupName: 'whatsapp' })
        created.push(p.name)
      }
    }
    return created
  }
}
