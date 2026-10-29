// Startpunkt: Einstellungen laden, Speicher öffnen, WhatsApp verbinden, Webserver starten.

import fs from 'node:fs'
import path from 'node:path'
import pino from 'pino'
import { createApp } from './app.js'
import { loadConfig, validateConfig } from './config.js'
import { openStore } from './db.js'
import { extensionFor } from './extract.js'
import { HubSpotClient } from './hubspot.js'
import { Pipeline } from './pipeline.js'
import { WhatsApp } from './whatsapp.js'

const config = loadConfig()
const log = pino({ level: config.logLevel })

const problems = validateConfig(config)
if (problems.length) {
  for (const p of problems) log.error(p)
  log.error('Bitte die .env-Datei ergänzen und den Container neu starten.')
  process.exit(1)
}

const mediaDir = path.resolve(config.dataDir, 'medien')
fs.mkdirSync(mediaDir, { recursive: true })

const store = openStore(path.join(config.dataDir, 'whatsapp.db'))
const hubspot = new HubSpotClient({ token: config.hubspotToken, countryCode: config.countryCode })
const pipeline = new Pipeline({ store, hubspot, config, log })

async function saveMedia(norm, raw) {
  if (!norm.media || norm.source === 'history') return {}
  if (store.getMessage(norm.id)?.media_file) return {}
  if (norm.media.size && norm.media.size > config.maxMediaBytes) {
    log.info({ id: norm.id, size: norm.media.size }, 'Datei zu groß, wird nicht gespeichert')
    return {}
  }
  try {
    const buffer = await whatsapp.downloadMedia(raw)
    if (buffer.length > config.maxMediaBytes) return {}
    const file = `${norm.id.replace(/[^A-Za-z0-9_-]/g, '')}.${extensionFor(norm.media.mime, norm.media.fileName)}`
    fs.writeFileSync(path.join(mediaDir, file), buffer)
    return { mediaFile: file, mediaMime: norm.media.mime, mediaName: norm.media.fileName }
  } catch (e) {
    log.warn({ err: e.message, id: norm.id }, 'Datei konnte nicht geladen werden')
    return {}
  }
}

const whatsapp = new WhatsApp({
  authDir: path.join(config.dataDir, 'anmeldung'),
  log,
  syncFullHistory: config.syncFullHistory,
  handlers: {
    message: async (norm, raw) => pipeline.handle({ ...norm, ...(await saveMedia(norm, raw)) }),
    status: (id, status) => store.updateStatus(id, status),
    lid: (lid, phone) => store.linkLid(lid, phone),
  },
})

let schemaReady = false
async function ensureSchema() {
  try {
    const created = await hubspot.ensureSchema()
    if (created.length) log.info({ felder: created }, 'Kontakt-Felder in HubSpot angelegt')
    schemaReady = true
  } catch (e) {
    log.error({ err: e.message }, 'Kontakt-Felder konnten nicht geprüft werden – stimmen Token und Berechtigungen?')
  }
}
await ensureSchema()

const app = createApp({ config, store, pipeline, whatsapp, hubspot, log, mediaDir })
const server = app.listen(config.port, () => log.info(`Webserver läuft auf Port ${config.port}`))

whatsapp.start().catch((e) => log.error({ err: e.message }, 'WhatsApp konnte nicht starten'))

const retry = setInterval(async () => {
  if (!schemaReady) await ensureSchema()
  pipeline.retryUnsynced().catch((e) => log.warn({ err: e.message }, 'Nachholen fehlgeschlagen'))
}, 5 * 60 * 1000)

let stopping = false
async function shutdown(signal) {
  if (stopping) return
  stopping = true
  log.info(`${signal} empfangen, fahre herunter`)
  clearInterval(retry)
  whatsapp.stop()
  await pipeline.flushAll().catch(() => {})
  server.close()
  store.close()
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
