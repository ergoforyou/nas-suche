// Standard-Einstellungen. Alles davon ist in den Einstellungen änderbar und
// lässt sich als JSON exportieren/importieren, damit das ganze Team dieselben
// Vorlagen nutzt.
export const DEFAULTS = {
  provider: 'claude',
  // Hier kann auch ein Claude-Projekt (https://claude.ai/project/...) oder ein
  // eigener GPT (https://chatgpt.com/g/...) eingetragen werden – dann gelten
  // automatisch dessen hinterlegte Anweisungen.
  urls: {
    claude: 'https://claude.ai/new',
    chatgpt: 'https://chatgpt.com/'
  },
  maxMessages: 40,
  maskData: true,
  autoSend: true,
  // Werkzeugleiste auch in normalen Claude-/ChatGPT-Tabs anzeigen
  // (sonst nur im angedockten KI-Fenster).
  toolbarEverywhere: false,
  panelWidth: 460,
  baseInstruction:
`Du bist mein Schreibassistent für WhatsApp-Nachrichten an Kunden und Bekannte.
- Schreibe auf Deutsch, natürlich und menschlich – wie eine echte WhatsApp-Nachricht, ohne Floskeln, ohne Betreff, ohne Markdown.
- Übernimm die Anrede (Du/Sie) und den Ton aus dem bisherigen Verlauf.
- Mache keine verbindlichen Zusagen zu Leistungen, Preisen oder Terminen, die nicht im Verlauf stehen. Markiere solche Stellen mit [prüfen].
- "Ich" im Verlauf bin ich selbst, alle anderen Namen sind meine Gesprächspartner.`,
  templates: [
    {
      id: 'antwort',
      name: 'Antwort vorschlagen',
      text: 'Schlage mir 2 passende Antworten auf die letzte(n) Nachricht(en) von {{KONTAKT}} vor. Gib nur die fertigen Antworttexte aus, jeweils mit "Variante 1:" / "Variante 2:" davor.'
    },
    {
      id: 'kurz',
      name: 'Kurz & locker',
      text: 'Formuliere eine kurze, lockere Antwort (1–2 Sätze) an {{KONTAKT}}. Nur den Antworttext ausgeben.'
    },
    {
      id: 'foermlich',
      name: 'Förmlich (Sie)',
      text: 'Formuliere eine höfliche, professionelle Antwort an {{KONTAKT}} in der Sie-Form. Nur den Antworttext ausgeben.'
    },
    {
      id: 'zusammenfassung',
      name: 'Zusammenfassen',
      text: 'Fasse den Verlauf mit {{KONTAKT}} in Stichpunkten zusammen: Worum geht es, was wurde vereinbart, was ist offen und was muss ich noch tun?'
    },
    {
      id: 'kontext',
      name: 'Nur Kontext',
      text: 'Hier ist der Chatverlauf mit {{KONTAKT}} als Kontext. Antworte nur mit "Verstanden" und warte auf meine nächste Anweisung.'
    }
  ]
};

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = settings || {};
  return {
    ...DEFAULTS,
    ...s,
    urls: { ...DEFAULTS.urls, ...(s.urls || {}) },
    templates: Array.isArray(s.templates) ? s.templates : DEFAULTS.templates
  };
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}
