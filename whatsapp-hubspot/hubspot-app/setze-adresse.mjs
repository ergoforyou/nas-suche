// Trägt die öffentliche Adresse eures WhatsApp-Servers in die HubSpot-App ein.
// Aufruf:  node setze-adresse.mjs https://wa.eure-firma.de

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const adresse = String(process.argv[2] || '').replace(/\/+$/, '')
if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(adresse)) {
  console.error('Bitte die HTTPS-Adresse ohne Pfad angeben, z. B.: node setze-adresse.mjs https://wa.eure-firma.de')
  process.exit(1)
}

const hier = path.dirname(fileURLToPath(import.meta.url))
const appDatei = path.join(hier, 'src/app/app-hsmeta.json')
const kartenDatei = path.join(hier, 'src/app/cards/einstellungen.js')

const app = JSON.parse(fs.readFileSync(appDatei, 'utf8'))
app.config.permittedUrls.fetch = [adresse]
app.config.permittedUrls.img = [adresse]
fs.writeFileSync(appDatei, JSON.stringify(app, null, 2) + '\n')

const karte = fs.readFileSync(kartenDatei, 'utf8').replace(/export const SERVER = '[^']*'/, `export const SERVER = '${adresse}'`)
fs.writeFileSync(kartenDatei, karte)

console.log(`Adresse gesetzt: ${adresse}`)
console.log('Jetzt hochladen mit:  hs project upload')
