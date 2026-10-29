// Prüft, ob eine Anfrage wirklich von eurer HubSpot-App kommt (Signatur v3).
// HubSpot signiert: Methode + URL + Rohdaten des Bodys + Zeitstempel, mit dem Client-Secret der App.

import crypto from 'node:crypto'

const MAX_AGE_MS = 5 * 60 * 1000

// HubSpot dekodiert vor dem Signieren nur diese Zeichen in der URL
const DECODE = {
  '%3A': ':', '%2F': '/', '%3F': '?', '%40': '@', '%21': '!', '%24': '$',
  '%27': "'", '%28': '(', '%29': ')', '%2A': '*', '%2C': ',', '%3B': ';',
}

export function decodeForSignature(url) {
  return url.replace(/%(3A|2F|3F|40|21|24|27|28|29|2A|2C|3B)/gi, (m) => DECODE[m.toUpperCase()])
}

export function signV3({ secret, method, url, body = '', timestamp, decode = true }) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${method}${decode ? decodeForSignature(url) : url}${body}${timestamp}`)
    .digest('base64')
}

// Laut Dokumentation signiert HubSpot die teilweise dekodierte URL, HubSpots eigene
// Bibliothek prüft die URL unverändert – wir akzeptieren beide Schreibweisen.
export function verifyV3({ secret, method, url, body = '', timestamp, signature, now = Date.now() }) {
  const ts = Number(timestamp)
  if (!secret || !signature || !ts || Math.abs(now - ts) > MAX_AGE_MS) return false
  const got = Buffer.from(String(signature))
  return [true, false].some((decode) => {
    const expected = Buffer.from(signV3({ secret, method, url, body, timestamp, decode }))
    return got.length === expected.length && crypto.timingSafeEqual(got, expected)
  })
}

// Signierte Links für Bilder und Dateien, die in der Karte angezeigt werden
export function signMediaLink(secret, id, expires) {
  return crypto.createHmac('sha256', secret).update(`media:${id}:${expires}`).digest('base64url')
}

export function verifyMediaLink(secret, id, expires, sig, now = Date.now()) {
  if (!secret || !sig || !(Number(expires) > now)) return false
  const expected = Buffer.from(signMediaLink(secret, id, expires))
  const got = Buffer.from(String(sig))
  return got.length === expected.length && crypto.timingSafeEqual(got, expected)
}
