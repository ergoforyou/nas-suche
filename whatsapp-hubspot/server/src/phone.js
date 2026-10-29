// Telefonnummern vereinheitlichen. Intern arbeiten wir mit reinen Ziffern inklusive
// Ländervorwahl, so wie WhatsApp sie benutzt: "0176 123 45 67" -> "491761234567".

export function normalizePhone(input, countryCode = '49') {
  if (input === null || input === undefined) return null
  let raw = String(input).trim()
  if (!raw) return null
  // WhatsApp-Adressen wie "491761234567:12@s.whatsapp.net"
  if (raw.includes('@')) raw = raw.split('@')[0].split(':')[0]
  // "+49 (0) 176 ..." – die (0) gehört nicht zur internationalen Nummer
  raw = raw.replace(/\(\s*0\s*\)/g, '')

  const international = raw.startsWith('+')
  let digits = raw.replace(/\D/g, '')
  if (!digits) return null

  if (!international) {
    if (digits.startsWith('00')) digits = digits.slice(2)
    else if (digits.startsWith('0')) digits = countryCode + digits.slice(1)
    else if (!digits.startsWith(countryCode) && digits.length <= 11) digits = countryCode + digits
  }
  // "49 0176 ..." -> "49176 ..."
  if (digits.startsWith(countryCode + '0')) digits = countryCode + digits.slice(countryCode.length + 1)

  if (digits.length < 8 || digits.length > 15) return null
  return digits
}

// Nummer ohne Ländervorwahl (für die HubSpot-Suche), nur wenn sie zur Standard-Vorwahl gehört
export function nationalPart(digits, countryCode = '49') {
  if (!digits || !digits.startsWith(countryCode)) return null
  return digits.slice(countryCode.length)
}

export function formatPhone(digits) {
  return digits ? `+${digits}` : ''
}

// Ziffern aus einer WhatsApp-Adresse, falls es eine Telefonnummern-Adresse ist
export function phoneFromJid(jid) {
  if (!jid || typeof jid !== 'string') return null
  if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@c.us')) return null
  const user = jid.split('@')[0].split(':')[0]
  return /^\d{8,15}$/.test(user) ? user : null
}

export function lidFromJid(jid) {
  if (!jid || typeof jid !== 'string' || !jid.endsWith('@lid')) return null
  return jid.split('@')[0].split(':')[0]
}
