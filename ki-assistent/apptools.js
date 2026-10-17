// Werkzeuge der App selbst (laufen in der Oberfläche) – gemeinsam für Chat (PC/Handy) und Echtzeit-Gespräch.
const APP_TOOLS = [
  {
    name: 'wissen_speichern',
    description:
      'Speichert ein Rechercheergebnis, eine Zusammenfassung oder andere wichtige Informationen dauerhaft im ' +
      '„Gespeicherten Wissen“ des Nutzers (bleibt nach dem Gespräch erhalten, ist später wieder abrufbar und lässt ' +
      'sich aufs Handy übertragen). Nutze es, wenn der Nutzer sagt „speicher das“, „merk dir das Ergebnis“, „leg das ' +
      'ab“ o. Ä., oder biete es nach einer längeren Recherche an. Formuliere den Inhalt vollständig und für sich ' +
      'verständlich (mit Quellen/Links, Zahlen, Datum), nicht nur „siehe oben“.',
    input_schema: {
      type: 'object',
      properties: {
        titel: { type: 'string', description: 'Kurzer, aussagekräftiger Titel' },
        inhalt: { type: 'string', description: 'Der vollständige zu speichernde Inhalt (Markdown erlaubt)' },
      },
      required: ['titel', 'inhalt'],
    },
  },
  {
    name: 'wissen_suchen',
    description:
      'Durchsucht das „Gespeicherte Wissen“ des Nutzers (früher gespeicherte Rechercheergebnisse und Notizen). ' +
      'Leerer Suchbegriff listet die zuletzt gespeicherten Einträge.',
    input_schema: { type: 'object', properties: { suchbegriff: { type: 'string' } }, required: ['suchbegriff'] },
  },
  {
    name: 'selbst_notieren',
    description:
      'Schreibt eine Notiz über DICH SELBST in dein Selbstbild (bleibt dauerhaft, steht dir in jedem Gespräch zur ' +
      'Verfügung). Nutze es, wenn du etwas über dich lernst: dein Gegenüber korrigiert oder lobt dich, bremst dich, ' +
      'wünscht sich einen anderen Stil, oder dir fällt selbst auf, was du künftig anders oder genauso machen willst. ' +
      'Kurz, in Ich-Form, z. B. „Ich fasse Recherchen besser in drei Sätzen zusammen statt in langen Listen.“ ' +
      'Nicht für Fakten über den Nutzer (die lernt das Gedächtnis von selbst) und nicht für Rechercheergebnisse ' +
      '(dafür wissen_speichern). Keine Kundendaten, keine Namen Dritter, nichts Vertrauliches.',
    input_schema: {
      type: 'object',
      properties: {
        eintrag: { type: 'string', description: 'Die Notiz in Ich-Form, ein bis zwei Sätze' },
        art: { type: 'string', enum: ['erfahrung', 'vorsatz', 'staerke', 'schwaeche', 'vorliebe'], description: 'Art der Notiz' },
      },
      required: ['eintrag'],
    },
  },
];
const APP_TOOL_STATUS = { wissen_speichern: '💾 Speichere im Wissen …', wissen_suchen: '🔎 Schaue im gespeicherten Wissen nach …',
  selbst_notieren: '🪞 Notiere etwas über mich …',
};

module.exports = { APP_TOOLS, APP_TOOL_STATUS };
