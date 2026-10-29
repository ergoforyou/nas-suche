import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import { createApp } from '../src/app.js'
import { Pipeline } from '../src/pipeline.js'
import { signV3 } from '../src/signature.js'
import { FakeHubSpot, FakeWhatsApp, silentLog, tempStore, testConfig } from './fakes.js'

const servers = []
after(() => servers.forEach((s) => s.close()))

const ANNA = { id: '42', properties: { firstname: 'Anna', mobilephone: '0170 1234567' } }
const NEU = { id: '43', properties: { firstname: 'Neu', mobilephone: '0170 1112233' } }
const QUERY = '?userId=7&userEmail=erika%40example.de&appId=1&portalId=146305116'

async function setup(configOverrides = {}) {
  const { store, dir } = tempStore()
  const config = testConfig(configOverrides)
  const hubspot = new FakeHubSpot([ANNA, NEU])
  const whatsapp = new FakeWhatsApp()
  const pipeline = new Pipeline({ store, hubspot, config, log: silentLog })
  const mediaDir = path.join(dir, 'medien')
  fs.mkdirSync(mediaDir)
  const app = createApp({ config, store, pipeline, whatsapp, hubspot, log: silentLog, mediaDir })
  const server = app.listen(0)
  servers.push(server)
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`

  async function hubspotPost(pfad, body, { query = QUERY, secret = config.hubspotClientSecret } = {}) {
    const raw = JSON.stringify(body)
    const timestamp = Date.now()
    const signature = signV3({ secret, method: 'POST', url: config.publicUrl + pfad + query, body: raw, timestamp })
    const res = await fetch(base + pfad + query, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-HubSpot-Signature-v3': signature,
        'X-HubSpot-Request-Timestamp': String(timestamp),
      },
      body: raw,
    })
    return { status: res.status, data: await res.json() }
  }

  const auth = 'Basic ' + Buffer.from(`admin:${config.adminPassword}`).toString('base64')
  return { store, hubspot, whatsapp, pipeline, base, hubspotPost, auth, mediaDir, config }
}

async function seedAnna(t) {
  await t.pipeline.handle({
    id: 'IN1', phone: '491701234567', lid: null, name: 'Anna', fromMe: false,
    type: 'text', text: 'Hallo!', ts: Date.now() - 60_000, source: 'live',
  })
}

test('ohne HubSpot-Signatur kein Zugriff', async () => {
  const t = await setup()
  const res = await fetch(`${t.base}/api/karte/verlauf`, { method: 'POST', body: '{"contactId":"42"}' })
  assert.equal(res.status, 401)
  const forged = await t.hubspotPost('/api/karte/verlauf', { contactId: '42' }, { secret: 'falsch' })
  assert.equal(forged.status, 401)
})

test('fremdes HubSpot-Konto wird abgewiesen', async () => {
  const t = await setup()
  const res = await t.hubspotPost('/api/karte/verlauf', { contactId: '42' }, { query: '?portalId=999' })
  assert.equal(res.status, 403)
})

test('Verlauf für die Karte und Gelesen-Markierung', async () => {
  const t = await setup()
  await seedAnna(t)
  assert.equal(t.hubspot.contacts.get('42').properties.whatsapp_ungelesen, '1')

  const { status, data } = await t.hubspotPost('/api/karte/verlauf', { contactId: '42' })
  assert.equal(status, 200)
  assert.equal(data.verbunden, true)
  assert.deepEqual(data.nummern, ['+491701234567'])
  assert.equal(data.nachrichten.length, 1)
  assert.equal(data.nachrichten[0].text, 'Hallo!')
  assert.equal(data.nachrichten[0].eigene, false)
  assert.equal(t.hubspot.contacts.get('42').properties.whatsapp_ungelesen, '0')
})

test('Senden aus HubSpot mit Absendername', async () => {
  const t = await setup()
  await seedAnna(t)
  const { status, data } = await t.hubspotPost('/api/karte/senden', { contactId: '42', text: 'Hallo Anna, gern!', absender: 'Erika Muster' })
  assert.equal(status, 200, JSON.stringify(data))
  assert.deepEqual(t.whatsapp.sent[0].target, { phone: '491701234567', lid: null })
  assert.equal(t.whatsapp.sent[0].text, 'Hallo Anna, gern!')
  assert.equal(data.nachricht.absender, 'Erika Muster')
  assert.equal(t.store.getMessage(data.nachricht.id).sent_by_email, 'erika@example.de')
  assert.equal(t.hubspot.contacts.get('42').properties.whatsapp_wartet, 'false')
})

test('Name vor die Nachricht setzen, wenn eingestellt', async () => {
  const t = await setup({ nameInMessage: true })
  await seedAnna(t)
  await t.hubspotPost('/api/karte/senden', { contactId: '42', text: 'Hallo', absender: 'Erika Muster' })
  assert.equal(t.whatsapp.sent[0].text, '*Erika Muster:*\nHallo')
})

test('erste Nachricht an eine neue Nummer prüft, ob sie WhatsApp hat', async () => {
  const t = await setup()
  const missing = await t.hubspotPost('/api/karte/senden', { contactId: '43', text: 'Hallo' })
  assert.equal(missing.status, 422)
  assert.match(missing.data.fehler, /\+491701112233 ist nicht bei WhatsApp/)

  t.whatsapp.known.add('491701112233')
  const ok = await t.hubspotPost('/api/karte/senden', { contactId: '43', text: 'Hallo' })
  assert.equal(ok.status, 200)
  assert.equal(t.store.getChat('pn:491701112233').contact_id, '43')
})

test('Fehlerfälle beim Senden', async () => {
  const t = await setup({ dailySendLimit: 1 })
  await seedAnna(t)
  assert.equal((await t.hubspotPost('/api/karte/senden', { contactId: '42', text: '  ' })).status, 400)
  assert.equal((await t.hubspotPost('/api/karte/senden', { contactId: '42', text: 'x', nummer: '0151 999999' })).status, 400)
  assert.equal((await t.hubspotPost('/api/karte/senden', { contactId: '42', text: 'eins' })).status, 200)
  const limit = await t.hubspotPost('/api/karte/senden', { contactId: '42', text: 'zwei' })
  assert.equal(limit.status, 429)
  t.whatsapp.state = 'getrennt'
  assert.equal((await t.hubspotPost('/api/karte/senden', { contactId: '42', text: 'drei' })).status, 503)
})

test('unbekannter Kontakt ergibt 404', async () => {
  const t = await setup()
  const res = await t.hubspotPost('/api/karte/verlauf', { contactId: '999' })
  assert.equal(res.status, 404)
})

test('Medien nur mit gültigem Link', async () => {
  const t = await setup()
  fs.writeFileSync(path.join(t.mediaDir, 'IMG1.jpg'), Buffer.from([0xff, 0xd8, 0xff]))
  await t.pipeline.handle({
    id: 'IMG1', phone: '491701234567', lid: null, name: 'Anna', fromMe: false, type: 'image',
    text: '[Bild]', ts: Date.now(), source: 'live', mediaFile: 'IMG1.jpg', mediaMime: 'image/jpeg',
  })
  const { data } = await t.hubspotPost('/api/karte/verlauf', { contactId: '42' })
  const url = new URL(data.nachrichten[0].medien.url)
  assert.equal(url.origin, 'https://wa.example.de')
  assert.equal(data.nachrichten[0].medien.bild, true)

  const ok = await fetch(t.base + url.pathname + url.search)
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('content-type'), 'image/jpeg')
  const bad = await fetch(t.base + url.pathname + url.search.replace(/sig=./, 'sig=X'))
  assert.equal(bad.status, 403)
})

test('Admin-Seite: Passwort, Status und Zuordnen', async () => {
  const t = await setup({ autoCreateContacts: false })
  await t.pipeline.handle({
    id: 'X1', phone: '491559998877', lid: null, name: 'Fremd', fromMe: false,
    type: 'text', text: 'Hi', ts: Date.now(), source: 'live',
  })
  assert.equal((await fetch(`${t.base}/admin`)).status, 401)
  const page = await fetch(`${t.base}/admin`, { headers: { Authorization: t.auth } })
  const html = await page.text()
  assert.equal(page.status, 200)
  assert.match(html, /Verbunden mit \+4930123456789/)
  assert.match(html, /Fremd/)
  const token = /name="token" value="([a-f0-9]+)"/.exec(html)[1]

  const post = (body) =>
    fetch(`${t.base}/admin/zuordnen`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Authorization: t.auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    })
  assert.equal((await post({ token: 'falsch', chatId: 'pn:491559998877', contactId: '42' })).status, 403)
  assert.equal((await post({ token, chatId: 'pn:491559998877', contactId: '42' })).status, 303)
  assert.equal(t.store.getChat('pn:491559998877').contact_id, '42')
})

test('Gesundheitsprüfung', async () => {
  const t = await setup()
  const res = await fetch(`${t.base}/gesund`)
  assert.deepEqual(await res.json(), { ok: true, whatsapp: 'verbunden' })
})
