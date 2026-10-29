import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatPhone, lidFromJid, nationalPart, normalizePhone, phoneFromJid } from '../src/phone.js'

test('bringt die Formate aus HubSpot auf eine Nummer', () => {
  // So stehen Nummern tatsächlich in eurem HubSpot
  for (const input of ['0170 1234567', '+49 170 1234567', '+491701234567', '0049 170 1234567', '+49 (0) 170 1234567', '0170/1234567']) {
    assert.equal(normalizePhone(input), '491701234567', input)
  }
  assert.equal(normalizePhone('0172/7654321'), '491727654321')
  assert.equal(normalizePhone('01514 4433221'), '4915144433221')
  assert.equal(normalizePhone('+49 1729876543'), '491729876543')
})

test('lässt ausländische Nummern in Ruhe', () => {
  assert.equal(normalizePhone('+43 660 1234567'), '436601234567')
  assert.equal(normalizePhone('0043 660 1234567'), '436601234567')
})

test('verwirft Unsinn', () => {
  assert.equal(normalizePhone(''), null)
  assert.equal(normalizePhone(null), null)
  assert.equal(normalizePhone('abc'), null)
  assert.equal(normalizePhone('123'), null)
})

test('liest WhatsApp-Adressen', () => {
  assert.equal(phoneFromJid('491701234567@s.whatsapp.net'), '491701234567')
  assert.equal(phoneFromJid('491701234567:12@s.whatsapp.net'), '491701234567')
  assert.equal(phoneFromJid('123456789@lid'), null)
  assert.equal(lidFromJid('123456789:3@lid'), '123456789')
  assert.equal(normalizePhone('491701234567@s.whatsapp.net'), '491701234567')
})

test('Hilfsformate', () => {
  assert.equal(nationalPart('491701234567'), '1701234567')
  assert.equal(nationalPart('436601234567'), null)
  assert.equal(formatPhone('491701234567'), '+491701234567')
})
