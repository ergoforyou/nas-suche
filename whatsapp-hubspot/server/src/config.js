// Liest die Einstellungen aus den Umgebungsvariablen (.env) und prüft die Pflichtwerte.

const TIMELINE_MODES = ['aus', 'tag', 'nachricht']

export function loadConfig(env = process.env) {
  const config = {
    port: Number(env.PORT || 3000),
    dataDir: env.DATA_DIR || '/data',
    publicUrl: String(env.PUBLIC_URL || '').replace(/\/+$/, ''),
    hubspotToken: env.HUBSPOT_TOKEN || '',
    hubspotClientSecret: env.HUBSPOT_CLIENT_SECRET || '',
    hubspotPortalId: String(env.HUBSPOT_PORTAL_ID || '').trim(),
    adminPassword: env.ADMIN_PASSWORT || '',
    mediaSecret: env.MEDIEN_SCHLUESSEL || env.HUBSPOT_CLIENT_SECRET || '',
    countryCode: String(env.LANDESVORWAHL || '49').replace(/\D/g, ''),
    timeZone: env.ZEITZONE || 'Europe/Berlin',
    autoCreateContacts: env.AUTO_ANLEGEN !== 'false',
    timeline: (env.TIMELINE || 'tag').toLowerCase(),
    timelineDelayMs: Number(env.TIMELINE_VERZOEGERUNG_SEK ?? 60) * 1000,
    nameInMessage: env.NAME_IN_NACHRICHT === 'true',
    dailySendLimit: Number(env.MAX_NACHRICHTEN_PRO_TAG || 200),
    maxMediaBytes: Number(env.MAX_MEDIEN_MB || 25) * 1024 * 1024,
    syncFullHistory: env.VERLAUF_IMPORT !== 'false',
    logLevel: env.LOG_LEVEL || 'info',
  }
  return config
}

export function validateConfig(config) {
  const problems = []
  if (!/^https:\/\/[^/]+$/.test(config.publicUrl)) {
    problems.push('PUBLIC_URL muss die öffentliche HTTPS-Adresse ohne Pfad sein, z. B. https://wa.eure-firma.de')
  }
  if (!config.hubspotToken) problems.push('HUBSPOT_TOKEN fehlt (Zugriffstoken der HubSpot-App)')
  if (!config.hubspotClientSecret) problems.push('HUBSPOT_CLIENT_SECRET fehlt (Client-Secret der HubSpot-App)')
  if (config.adminPassword.length < 12) problems.push('ADMIN_PASSWORT fehlt oder ist kürzer als 12 Zeichen')
  if (!config.countryCode) problems.push('LANDESVORWAHL ist ungültig')
  if (!TIMELINE_MODES.includes(config.timeline)) {
    problems.push(`TIMELINE muss einer dieser Werte sein: ${TIMELINE_MODES.join(', ')}`)
  }
  if (!(config.dailySendLimit > 0)) problems.push('MAX_NACHRICHTEN_PRO_TAG muss größer als 0 sein')
  return problems
}
