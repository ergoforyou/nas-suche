// Trägt die öffentliche Adresse des NAS-Dienstes in die Karte ein
// (HubSpot erlaubt Aufrufe und Fenster nur zu fest eingetragenen Adressen).
//   node adresse-setzen.mjs https://ergoforyou-sign.tail1234.ts.net
import { readFileSync, writeFileSync } from 'node:fs';

const eingabe = (process.argv[2] || '').trim().replace(/\/+$/, '');
let adresse;
try {
  const url = new URL(eingabe);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) throw new Error();
  adresse = url.origin;
} catch {
  console.error(`Bitte die öffentliche Adresse des NAS-Dienstes angeben, z. B. https://ergoforyou-sign.tail1234.ts.net (bekommen: "${eingabe}")`);
  process.exit(1);
}

const appDatei = new URL('./src/app/app-hsmeta.json', import.meta.url);
const app = JSON.parse(readFileSync(appDatei, 'utf8'));
app.config.permittedUrls.fetch = [adresse];
app.config.permittedUrls.iframe = [adresse];
writeFileSync(appDatei, JSON.stringify(app, null, 2) + '\n');

writeFileSync(
  new URL('./src/app/cards/nas.ts', import.meta.url),
  `// Wird vor dem Hochladen von \`node adresse-setzen.mjs <Adresse>\` geschrieben.\nexport const NAS_ADRESSE = '${adresse}';\n`,
);
console.log(`Karte zeigt auf ${adresse}`);
