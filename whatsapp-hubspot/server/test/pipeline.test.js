import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Pipeline, splitName } from '../src/pipeline.js'
import { FakeHubSpot, silentLog, tempStore, testConfig } from './fakes.js'

const ANNA = { id: '42', properties: { firstname: 'Anna', mobilephone: '0170 1234567' } }
const T0 = Date.parse('2026-10-29T09:15:00Z')

function setup({ contacts = [ANNA], config = {} } = {}) {
  const { store } = tempStore()
  const hubspot = new FakeHubSpot(contacts)
  const pipeline = new Pipeline({ store, hubspot, config: testConfig(config), log: silentLog })
  return { store, hubspot, pipeline }
}

const incoming = (over = {}) => ({
  id: 'IN1',
  phone: '491701234567',
  lid: null,
  name: 'Anna B.',
  fromMe: false,
  type: 'text',
  text: 'Hallo, kurze Frage zur Police',
  ts: T0,
  source: 'live',
  ...over,
})

test('eingehende Nachricht landet beim richtigen Kontakt', async () => {
  const { store, hubspot, pipeline } = setup()
  await pipeline.handle(incoming())

  assert.equal(store.getChat('pn:491701234567').contact_id, '42')
  const props = hubspot.contacts.get('42').properties
  assert.equal(props.whatsapp_ungelesen, '1')
  assert.equal(props.whatsapp_wartet, 'true')
  assert.equal(props.whatsapp_nummer, '+491701234567')
  assert.equal(props.whatsapp_letzte_vorschau, 'Hallo, kurze Frage zur Police')
  assert.equal(props.whatsapp_letzte_nachricht, new Date(T0).toISOString())
  assert.equal(store.getMessage('IN1').hubspot_synced, 1)

  const [comm] = hubspot.communications.values()
  assert.equal(comm.contactId, '42')
  assert.match(comm.body, /10:15 · Anna B\.:<\/strong> Hallo, kurze Frage zur Police/)
})

test('ein Chronik-Eintrag pro Tag, der wächst', async () => {
  const { hubspot, pipeline } = setup()
  await pipeline.handle(incoming())
  await pipeline.handle(incoming({ id: 'OUT1', fromMe: true, name: null, text: 'Gerne, worum geht es?', ts: T0 + 60_000 }))
  assert.equal(hubspot.communications.size, 1)
  const [comm] = hubspot.communications.values()
  assert.match(comm.body, /Hallo, kurze Frage.*10:16 · Telefon:<\/strong> Gerne, worum geht es\?/)
  assert.equal(hubspot.contacts.get('42').properties.whatsapp_wartet, 'false')
  assert.equal(hubspot.contacts.get('42').properties.whatsapp_letzte_vorschau, 'Wir: Gerne, worum geht es?')

  // Nächster Tag: neuer Eintrag
  await pipeline.handle(incoming({ id: 'IN2', ts: T0 + 24 * 3600_000, text: 'Danke!' }))
  assert.equal(hubspot.communications.size, 2)
})

test('gelöschter Chronik-Eintrag wird neu angelegt', async () => {
  const { hubspot, pipeline } = setup()
  await pipeline.handle(incoming())
  hubspot.communications.clear()
  await pipeline.handle(incoming({ id: 'IN2', ts: T0 + 1000, text: 'noch was' }))
  assert.equal(hubspot.communications.size, 1)
  assert.match([...hubspot.communications.values()][0].body, /noch was/)
})

test('unbekannte Nummer: neuer Kontakt mit Namen aus WhatsApp', async () => {
  const { store, hubspot, pipeline } = setup({ contacts: [] })
  await pipeline.handle(incoming({ name: 'Max Peter Mustermann' }))
  const contactId = store.getChat('pn:491701234567').contact_id
  const props = hubspot.contacts.get(contactId).properties
  assert.equal(props.firstname, 'Max Peter')
  assert.equal(props.lastname, 'Mustermann')
  assert.equal(props.mobilephone, '+491701234567')
})

test('zwei schnelle Nachrichten einer neuen Nummer erzeugen nur einen Kontakt', async () => {
  const { hubspot, pipeline } = setup({ contacts: [] })
  await Promise.all([pipeline.handle(incoming()), pipeline.handle(incoming({ id: 'IN2', ts: T0 + 1 }))])
  assert.equal(hubspot.contacts.size, 1)
})

test('ohne automatisches Anlegen bleibt der Chat unzugeordnet', async () => {
  const { store, hubspot, pipeline } = setup({ contacts: [], config: { autoCreateContacts: false } })
  await pipeline.handle(incoming())
  assert.equal(hubspot.contacts.size, 0)
  assert.equal(store.unassignedChats().length, 1)
  assert.equal(store.getMessage('IN1').hubspot_synced, 1)
})

test('alter Verlauf wird nur lokal gespeichert', async () => {
  const { store, hubspot, pipeline } = setup()
  await pipeline.handle(incoming({ source: 'history' }))
  assert.ok(store.getMessage('IN1'))
  assert.deepEqual(hubspot.calls, [])
})

test('HubSpot-Störung: Nachricht wird später nachgeholt', async () => {
  const { store, hubspot, pipeline } = setup()
  hubspot.failNext = Object.assign(new Error('HubSpot 502'), { status: 502 })
  await pipeline.handle(incoming())
  assert.equal(store.getMessage('IN1').hubspot_synced, 0)
  await pipeline.retryUnsynced()
  assert.equal(store.getMessage('IN1').hubspot_synced, 1)
  assert.equal(hubspot.contacts.get('42').properties.whatsapp_ungelesen, '1')
})

test('Chronik-Modi "aus" und "nachricht"', async () => {
  const off = setup({ config: { timeline: 'aus' } })
  await off.pipeline.handle(incoming())
  assert.equal(off.hubspot.communications.size, 0)

  const each = setup({ config: { timeline: 'nachricht' } })
  await each.pipeline.handle(incoming())
  await each.pipeline.handle(incoming({ id: 'IN2', ts: T0 + 1000 }))
  assert.equal(each.hubspot.communications.size, 2)
})

test('Gelesen setzt den Zähler in HubSpot zurück', async () => {
  const { store, hubspot, pipeline } = setup()
  await pipeline.handle(incoming())
  await pipeline.markRead('42', store.chatsByContact('42'))
  assert.equal(hubspot.contacts.get('42').properties.whatsapp_ungelesen, '0')
  assert.equal(store.getChat('pn:491701234567').unread, 0)
})

test('HTML im Chat wird entschärft', async () => {
  const { hubspot, pipeline } = setup()
  await pipeline.handle(incoming({ text: '<script>alert(1)</script>' }))
  assert.match([...hubspot.communications.values()][0].body, /&lt;script&gt;/)
})

test('Namen zerlegen', () => {
  assert.deepEqual(splitName('Anna', '491'), { firstname: 'Anna' })
  assert.deepEqual(splitName('', '491701234567'), { firstname: 'WhatsApp', lastname: '+491701234567' })
})
