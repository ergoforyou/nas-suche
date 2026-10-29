import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tempStore } from './fakes.js'

const msg = (over) => ({ id: 'M1', chatId: 'pn:491701234567', fromMe: false, type: 'text', text: 'Hallo', ts: 1000, source: 'live', ...over })

test('Chats per Nummer anlegen und wiederfinden', () => {
  const { store } = tempStore()
  const chat = store.upsertChat({ phone: '491701234567', name: 'Anna' })
  assert.equal(chat.id, 'pn:491701234567')
  assert.equal(store.upsertChat({ phone: '491701234567' }).name, 'Anna', 'Name bleibt erhalten')
  assert.deepEqual(store.chatsByPhones(['491701234567']).map((c) => c.id), ['pn:491701234567'])
})

test('Nachrichten nur einmal speichern, Absender aus HubSpot gewinnt', () => {
  const { store } = tempStore()
  store.upsertChat({ phone: '491701234567' })
  assert.equal(store.saveMessage(msg({ id: 'A', fromMe: true, sentBy: 'Erika Muster' })), true)
  // Das Echo derselben Nachricht kommt von WhatsApp noch einmal – ohne Absender
  assert.equal(store.saveMessage(msg({ id: 'A', fromMe: true })), false)
  assert.equal(store.getMessage('A').sent_by, 'Erika Muster')
  assert.equal(store.getChat('pn:491701234567').last_ts, 1000)
})

test('Status steigt nur', () => {
  const { store } = tempStore()
  store.upsertChat({ phone: '491701234567' })
  store.saveMessage(msg({ status: 2 }))
  assert.ok(store.updateStatus('M1', 4))
  assert.equal(store.updateStatus('M1', 3), false)
  assert.equal(store.getMessage('M1').status, 4)
})

test('LID-Chat wird mit dem Nummern-Chat zusammengeführt', () => {
  const { store } = tempStore()
  const lidChat = store.upsertChat({ lid: '777', name: 'Max' })
  assert.equal(lidChat.id, 'lid:777')
  store.saveMessage(msg({ id: 'L1', chatId: 'lid:777', ts: 500 }))
  store.noteInbound('lid:777')
  store.setChatContact('lid:777', '42')

  store.linkLid('777', '491701112233')
  assert.equal(store.getChat('lid:777'), null)
  const merged = store.getChat('pn:491701112233')
  assert.equal(merged.lid, '777')
  assert.equal(merged.contact_id, '42')
  assert.equal(merged.unread, 1)
  assert.equal(store.getMessage('L1').chat_id, 'pn:491701112233')
})

test('Blättern im Verlauf', () => {
  const { store } = tempStore()
  store.upsertChat({ phone: '491701234567' })
  for (let i = 1; i <= 5; i++) store.saveMessage(msg({ id: `M${i}`, ts: i * 1000 }))
  const first = store.messagesForChats(['pn:491701234567'], { limit: 2 })
  assert.deepEqual(first.messages.map((m) => m.id), ['M4', 'M5'])
  assert.equal(first.hasMore, true)
  const older = store.messagesForChats(['pn:491701234567'], { limit: 3, before: 4000 })
  assert.deepEqual(older.messages.map((m) => m.id), ['M1', 'M2', 'M3'])
  assert.equal(older.hasMore, false)
})

test('Ungelesen, Zuordnung und Tageszähler', () => {
  const { store } = tempStore()
  store.upsertChat({ phone: '491701234567' })
  store.saveMessage(msg())
  store.noteInbound('pn:491701234567')
  assert.equal(store.unassignedChats().length, 1)
  store.setChatContact('pn:491701234567', '42')
  assert.equal(store.unassignedChats().length, 0)
  assert.equal(store.chatsByContact('42')[0].unread, 1)
  store.markRead(['pn:491701234567'])
  assert.equal(store.getChat('pn:491701234567').unread, 0)
  store.countSend('2026-10-29')
  store.countSend('2026-10-29')
  assert.equal(store.sentOn('2026-10-29'), 2)
  assert.equal(store.sentOn('2026-10-30'), 0)
})
