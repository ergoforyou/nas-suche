import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HubSpotClient } from '../src/hubspot.js'

// Simuliert die HubSpot-API: eine Liste vorbereiteter Antworten, alle Anfragen werden mitgeschrieben
function fakeFetch(responses) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers })
    const [status, data, headers = {}] = responses.shift() || [200, {}]
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      text: async () => (data === undefined ? '' : JSON.stringify(data)),
    }
  }
  fn.calls = calls
  return fn
}

const client = (fetchImpl) => new HubSpotClient({ token: 'pat-test', fetchImpl, sleep: async () => {} })

test('Suche nach Nummer nutzt die bereinigten Telefonfelder und prüft gegen', async () => {
  const fetch = fakeFetch([
    [200, {
      results: [
        { id: '1', properties: { mobilephone: '0170 1234567' } },
        { id: '2', properties: { phone: '+49 30 1234567' } }, // falscher Treffer
      ],
    }],
  ])
  const found = await client(fetch).findContactsByPhone('491701234567')
  assert.deepEqual(found.map((c) => c.id), ['1'])
  const { url, body, headers } = fetch.calls[0]
  assert.equal(url, 'https://api.hubapi.com/crm/v3/objects/contacts/search')
  assert.equal(headers.Authorization, 'Bearer pat-test')
  const filters = body.filterGroups.map((g) => `${g.filters[0].propertyName}=${g.filters[0].value}`)
  assert.deepEqual(filters, [
    'whatsapp_nummer=+491701234567',
    'whatsapp_nummer=491701234567',
    'hs_searchable_calculated_mobile_number=1701234567',
    'hs_searchable_calculated_phone_number=1701234567',
  ])
})

test('wiederholt bei 429 und 5xx, gibt bei 4xx sofort auf', async () => {
  const fetch = fakeFetch([[429, { message: 'zu viele' }, { 'retry-after': '1' }], [502, {}], [200, { id: '5' }]])
  assert.deepEqual(await client(fetch).createContact({ firstname: 'A' }), { id: '5' })
  assert.equal(fetch.calls.length, 3)

  const bad = fakeFetch([[400, { message: 'Property values were not valid' }]])
  await assert.rejects(client(bad).createContact({}), (e) => e.status === 400 && /not valid/.test(e.message))
  assert.equal(bad.calls.length, 1)
})

test('Chronik-Eintrag als WhatsApp-Nachricht am Kontakt', async () => {
  const fetch = fakeFetch([[201, { id: '777' }]])
  const id = await client(fetch).createCommunication({ contactId: '42', body: '<p>Hallo</p>', timestamp: 0 })
  assert.equal(id, '777')
  const { body } = fetch.calls[0]
  assert.equal(body.properties.hs_communication_channel_type, 'WHATS_APP')
  assert.equal(body.properties.hs_communication_logged_from, 'CRM')
  assert.deepEqual(body.associations[0], {
    to: { id: '42' },
    types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 81 }],
  })
})

test('Felder werden nur angelegt, wenn sie fehlen', async () => {
  const fetch = fakeFetch([
    [409, { message: 'Gruppe existiert' }],
    [200, {}], // whatsapp_nummer vorhanden
    [404, {}], [201, {}], // whatsapp_letzte_nachricht fehlt -> anlegen
    [200, {}],
    [200, {}],
    [200, {}],
  ])
  const created = await client(fetch).ensureSchema()
  assert.deepEqual(created, ['whatsapp_letzte_nachricht'])
  const createCall = fetch.calls.find((c) => c.method === 'POST' && c.url.endsWith('/crm/v3/properties/contacts'))
  assert.equal(createCall.body.groupName, 'whatsapp')
  assert.equal(createCall.body.type, 'datetime')
})

test('Telefonnummern eines Kontakts ohne Dubletten', async () => {
  const fetch = fakeFetch([[200, { id: '42', properties: { phone: '0170/1234567', mobilephone: '+49 170 1234567', whatsapp_nummer: null } }]])
  assert.deepEqual(await client(fetch).contactPhones('42'), ['491701234567'])
})
