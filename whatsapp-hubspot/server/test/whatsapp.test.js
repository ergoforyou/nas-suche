import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadConfig, validateConfig } from '../src/config.js'
import { WhatsApp } from '../src/whatsapp.js'
import { silentLog } from './fakes.js'

function transport(sock = {}) {
  const seen = { messages: [], statuses: [], lids: [], states: [] }
  const wa = new WhatsApp({
    authDir: '/tmp/gibt-es-nicht',
    log: silentLog,
    handlers: {
      message: async (m) => {
        await new Promise((r) => setTimeout(r, Math.random() * 5))
        seen.messages.push(m)
      },
      status: (id, s) => seen.statuses.push([id, s]),
      lid: (lid, pn) => seen.lids.push([lid, pn]),
      connection: (s) => seen.states.push(s),
    },
  })
  wa.sock = sock
  return { wa, seen }
}

const raw = ({ key, ...over } = {}) => ({
  key: { remoteJid: '491701234567@s.whatsapp.net', fromMe: false, id: 'A1', ...key },
  message: { conversation: 'Hallo' },
  pushName: 'Anna',
  messageTimestamp: 1761750000,
  ...over,
})

test('Nachricht wird vereinheitlicht', async () => {
  const { wa } = transport()
  const m = await wa.normalize(raw(), 'live')
  assert.deepEqual(m, {
    id: 'A1', phone: '491701234567', lid: null, name: 'Anna', fromMe: false, type: 'text',
    text: 'Hallo', media: null, ts: 1761750000000, status: null, source: 'live',
  })
})

test('LID-Absender: Nummer aus der Zuordnungstabelle von WhatsApp', async () => {
  const { wa } = transport({
    signalRepository: { lidMapping: { getPNForLID: async (lid) => (lid === '555@lid' ? '491701112233:0@s.whatsapp.net' : null) } },
  })
  const m = await wa.normalize(raw({ key: { remoteJid: '555@lid', id: 'B1' } }), 'live')
  assert.equal(m.phone, '491701112233')
  assert.equal(m.lid, '555')
})

test('Gruppen, leere und technische Nachrichten werden übersprungen', async () => {
  const { wa } = transport()
  assert.equal(await wa.normalize(raw({ key: { remoteJid: '123-456@g.us' } }), 'live'), null)
  assert.equal(await wa.normalize(raw({ message: null }), 'live'), null)
  assert.equal(await wa.normalize(raw({ message: { protocolMessage: {} } }), 'live'), null)
})

test('Reihenfolge bleibt erhalten, Fehler stoppen die Warteschlange nicht', async () => {
  const { wa, seen } = transport()
  const batch = [1, 2, 3, 4, 5].map((i) => raw({ key: { id: `M${i}` } }))
  batch.splice(2, 0, { key: { remoteJid: 'kaputt' } })
  await wa.enqueue(batch, 'live')
  assert.deepEqual(seen.messages.map((m) => m.id), ['M1', 'M2', 'M3', 'M4', 'M5'])
})

test('LID-Zuordnungen in beiden Schreibweisen', () => {
  const { wa, seen } = transport()
  wa.onLidMapping({ lid: '155566677788899@lid', pn: '491701112233@s.whatsapp.net' })
  wa.onLidMapping({ lid: '155566677788800', pn: '491701112234' })
  wa.onLidMapping({ lid: '155566677788811@lid' })
  assert.deepEqual(seen.lids, [['155566677788899', '491701112233'], ['155566677788800', '491701112234']])
})

test('Senden nur bei Verbindung, mit kurzem "schreibt …"', async () => {
  const calls = []
  const { wa } = transport({
    sendPresenceUpdate: async (state, jid) => calls.push(['presence', state, jid]),
    sendMessage: async (jid, content) => {
      calls.push(['send', jid, content.text])
      return { key: { id: 'S1' }, message: { conversation: content.text }, messageTimestamp: 1761750000, status: 1 }
    },
  })
  await assert.rejects(wa.sendText({ phone: '491701234567' }, 'x'), /nicht verbunden/)
  wa.state = 'verbunden'
  const sent = await wa.sendText({ phone: '491701234567' }, 'Hallo')
  assert.deepEqual(sent, { id: 'S1', ts: 1761750000000, status: 1 })
  assert.deepEqual(calls.map((c) => c.slice(0, 2)), [
    ['presence', 'composing'],
    ['presence', 'paused'],
    ['send', '491701234567@s.whatsapp.net'],
  ])
  assert.deepEqual(wa.sentCache.get('S1'), { conversation: 'Hallo' })
})

test('Einstellungen: Pflichtwerte werden geprüft', () => {
  assert.ok(validateConfig(loadConfig({})).length >= 4)
  const ok = loadConfig({
    PUBLIC_URL: 'https://wa.example.de/',
    HUBSPOT_TOKEN: 'pat',
    HUBSPOT_CLIENT_SECRET: 'sec',
    ADMIN_PASSWORT: 'mindestens-12-zeichen',
  })
  assert.equal(ok.publicUrl, 'https://wa.example.de')
  assert.deepEqual(validateConfig(ok), [])
  assert.equal(ok.timeline, 'tag')
  assert.ok(validateConfig({ ...ok, timeline: 'jede' }).some((p) => p.includes('TIMELINE')))
  assert.ok(validateConfig({ ...ok, publicUrl: 'http://wa.example.de' }).some((p) => p.includes('PUBLIC_URL')))
})
