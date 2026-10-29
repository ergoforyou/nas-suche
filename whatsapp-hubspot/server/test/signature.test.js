import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { test } from 'node:test'
import { decodeForSignature, signMediaLink, signV3, verifyMediaLink, verifyV3 } from '../src/signature.js'

const secret = 'geheim-123'
const now = 1_761_750_000_000

test('Signatur v3 wie von HubSpot beschrieben', () => {
  const url = 'https://wa.example.de/api/karte/verlauf?userId=1&userEmail=erika%40example.de&portalId=146305116'
  const body = '{"contactId":"42"}'
  // Referenz von Hand: HubSpot dekodiert %40 zu @ vor dem Signieren
  const manual = crypto
    .createHmac('sha256', secret)
    .update(`POST${url.replace('%40', '@')}${body}${now}`)
    .digest('base64')
  assert.equal(signV3({ secret, method: 'POST', url, body, timestamp: now }), manual)
  assert.ok(verifyV3({ secret, method: 'POST', url, body, timestamp: now, signature: manual, now }))
  // So rechnet HubSpots Bibliothek @hubspot/api-client (URL unverändert)
  const raw = crypto.createHmac('sha256', secret).update(`POST${url}${body}${now}`).digest('base64')
  assert.ok(verifyV3({ secret, method: 'POST', url, body, timestamp: now, signature: raw, now }))
})

test('lehnt veränderte, alte oder fremde Anfragen ab', () => {
  const url = 'https://wa.example.de/api/karte/senden'
  const body = '{"contactId":"42","text":"Hallo"}'
  const signature = signV3({ secret, method: 'POST', url, body, timestamp: now })
  assert.ok(verifyV3({ secret, method: 'POST', url, body, timestamp: now, signature, now }))
  assert.equal(verifyV3({ secret, method: 'POST', url, body: body.replace('Hallo', 'Hi'), timestamp: now, signature, now }), false)
  assert.equal(verifyV3({ secret, method: 'POST', url, body, timestamp: now, signature, now: now + 6 * 60_000 }), false)
  assert.equal(verifyV3({ secret: 'anderes', method: 'POST', url, body, timestamp: now, signature, now }), false)
  assert.equal(verifyV3({ secret, method: 'POST', url, body, timestamp: now, signature: '', now }), false)
})

test('dekodiert nur die von HubSpot genannten Zeichen', () => {
  assert.equal(decodeForSignature('a%3Ab%2Fc%3fd%20e'), 'a:b/c?d%20e')
})

test('Medien-Links laufen ab', () => {
  const expires = now + 3600_000
  const sig = signMediaLink(secret, 'ABC', expires)
  assert.ok(verifyMediaLink(secret, 'ABC', expires, sig, now))
  assert.equal(verifyMediaLink(secret, 'ABD', expires, sig, now), false)
  assert.equal(verifyMediaLink(secret, 'ABC', expires, sig, expires + 1), false)
})
