import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extensionFor, messageContent, peerOf, timestampMs } from '../src/extract.js'

test('Text aus einfachen und erweiterten Nachrichten', () => {
  assert.deepEqual(messageContent({ conversation: 'Hallo' }), { type: 'text', text: 'Hallo', media: null })
  assert.equal(messageContent({ extendedTextMessage: { text: 'mit Link' } }).text, 'mit Link')
})

test('packt verschachtelte Nachrichten aus', () => {
  const m = { ephemeralMessage: { message: { viewOnceMessageV2: { message: { conversation: 'innen' } } } } }
  assert.equal(messageContent(m).text, 'innen')
})

test('Medien mit Bildunterschrift oder Platzhalter', () => {
  const img = messageContent({ imageMessage: { mimetype: 'image/jpeg', caption: 'Schaden vorne', fileLength: '2048' } })
  assert.equal(img.type, 'image')
  assert.equal(img.text, 'Schaden vorne')
  assert.deepEqual(img.media, { field: 'imageMessage', mime: 'image/jpeg', fileName: null, size: 2048 })

  const doc = messageContent({ documentMessage: { mimetype: 'application/pdf', fileName: 'Police.pdf' } })
  assert.equal(doc.text, '[Dokument: Police.pdf]')
  assert.equal(messageContent({ audioMessage: { ptt: true } }).text, '[Sprachnachricht]')
})

test('ignoriert Technisches', () => {
  assert.equal(messageContent({ protocolMessage: { type: 0 } }), null)
  assert.equal(messageContent({ reactionMessage: { text: '👍' } }), null)
  assert.equal(messageContent(null), null)
})

test('Standort wird zum Kartenlink', () => {
  const loc = messageContent({ locationMessage: { degreesLatitude: 53.4, degreesLongitude: 11.18, name: 'Büro' } })
  assert.match(loc.text, /Standort: Büro.*maps\.google\.com\/\?q=53\.4,11\.18/)
})

test('Chatpartner: Nummer, LID oder gar nicht', () => {
  assert.deepEqual(peerOf({ remoteJid: '491701234567@s.whatsapp.net' }), { phone: '491701234567', lid: null })
  assert.deepEqual(peerOf({ remoteJid: '987654@lid', remoteJidAlt: '491701234567@s.whatsapp.net' }), {
    phone: '491701234567',
    lid: '987654',
  })
  assert.deepEqual(peerOf({ remoteJid: '987654@lid' }), { phone: null, lid: '987654' })
  assert.equal(peerOf({ remoteJid: '1234-5678@g.us' }), null)
  assert.equal(peerOf({ remoteJid: 'status@broadcast' }), null)
  assert.equal(peerOf({ remoteJid: '123@newsletter' }), null)
})

test('Zeitstempel und Dateiendungen', () => {
  assert.equal(timestampMs(1761750000), 1761750000000)
  assert.equal(timestampMs({ toString: () => '1761750000' }), 1761750000000)
  assert.equal(extensionFor('image/jpeg'), 'jpg')
  assert.equal(extensionFor('audio/ogg; codecs=opus'), 'ogg')
  assert.equal(extensionFor('application/x-foo', 'Vertrag.DOCX'), 'docx')
  assert.equal(extensionFor('application/x-foo'), 'bin')
})
