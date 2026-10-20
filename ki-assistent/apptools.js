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
  {
    name: 'gedaechtnis_loeschen',
    description:
      'Löscht Einträge aus deinem Gedächtnis (Fakten über dein Gegenüber), deinem Selbstbild oder den offenen Themen. ' +
      'NUR, wenn dein Gegenüber ausdrücklich darum bittet („vergiss …“, „lösch das aus deinem Gedächtnis“, „das stimmt ' +
      'nicht mehr, streich das“) – nie von dir aus. Gib die betroffenen Einträge möglichst wörtlich so an, wie sie in ' +
      'deinem Gedächtnis/Selbstbild stehen; bei „alles über X“ alle passenden. Sag danach kurz, was gelöscht wurde ' +
      '(rückgängig machen geht unter ⚙ → Gedächtnis).',
    input_schema: {
      type: 'object',
      properties: {
        eintraege: { type: 'array', items: { type: 'string' }, description: 'Die zu löschenden Einträge (Wortlaut aus dem Gedächtnis)' },
        bereich: { type: 'string', enum: ['gedaechtnis', 'selbstbild', 'themen', 'alle'], description: 'Wo gesucht wird (Standard: alle)' },
      },
      required: ['eintraege'],
    },
  },
  {
    name: 'wetter',
    description:
      'Ruft das aktuelle Wetter und die Vorhersage (nächste Stunden und bis zu 7 Tage) für einen Ort ab – zuverlässiger ' +
      'als eine Internetsuche, nimm es für jede Wetterfrage. Ohne Ort gilt der aktuelle Standort des Nutzers. Fasse das ' +
      'Ergebnis in deiner Art kurz zusammen (Temperatur, Regen, Wind – was für die Frage zählt), lies keine Tabellen vor.',
    input_schema: {
      type: 'object',
      properties: {
        ort: { type: 'string', description: 'Ortsname, z. B. „Hannover“ (leer = aktueller Standort)' },
        tage: { type: 'integer', description: 'Vorhersage-Tage 1–7 (Standard 2: heute und morgen)' },
      },
    },
  },
  {
    name: 'nachrichten',
    description:
      'Holt die wichtigsten Nachrichten des Tages: lokal (zum Ort des Nutzers), Wetter, Wirtschaft, Deutschland, Welt ' +
      '(Quellen: tagesschau.de, Google News, Open-Meteo). Nimm es für „Was gibt es Neues?“, „Nachrichten“, ' +
      '„Tagesüberblick“, „Was ist heute los?“ oder Fragen nach aktuellen Meldungen eines Bereichs – statt einer ' +
      'Internetsuche. Fasse danach je Bereich das Wichtigste in deiner Art zusammen (wenige Sätze, ohne Aufzählung ' +
      'aller Titel); nenne bei Bedarf die Quelle. Ohne Ort gilt der aktuelle Standort.',
    input_schema: {
      type: 'object',
      properties: {
        bereiche: {
          type: 'array',
          items: { type: 'string', enum: ['lokal', 'wetter', 'wirtschaft', 'deutschland', 'welt'] },
          description: 'Welche Bereiche (leer = alle)',
        },
        ort: { type: 'string', description: 'Ort für Lokales und Wetter (leer = aktueller Standort)' },
        anzahl: { type: 'integer', description: 'Meldungen je Bereich (2–8, Standard 5)' },
      },
    },
  },
  {
    name: 'an_claude_uebergeben',
    desktopOnly: true, // nur am PC (Claude-App unter Windows)
    description:
      'Übergibt eine Aufgabe an die Claude-App des Nutzers auf diesem PC (Claude-Chat bzw. Claude Cowork): Der Text ' +
      'wird dort ins Eingabefeld eingefügt und abgeschickt, Claude erledigt die Arbeit dann selbst (mit Zugriff auf ' +
      'die Dateien und Verbindungen, die der Nutzer dort eingerichtet hat). Nutze es, wenn der Nutzer sagt „gib das ' +
      'an Claude/Cowork weiter“, „schick das an Claude“, „lass Claude … machen“ o. Ä. Formuliere die Aufgabe ' +
      'vollständig und für sich verständlich – Claude kennt dieses Gespräch nicht; übernimm die nötigen Angaben ' +
      'daraus. Die Antwort von Claude siehst du nicht; sag danach nur kurz, dass es übergeben ist.',
    input_schema: {
      type: 'object',
      properties: { aufgabe: { type: 'string', description: 'Die vollständige Aufgabe für Claude, so wie sie dort abgeschickt wird' } },
      required: ['aufgabe'],
    },
  },
];
const APP_TOOL_STATUS = { wissen_speichern: '💾 Speichere im Wissen …', wissen_suchen: '🔎 Schaue im gespeicherten Wissen nach …',
  selbst_notieren: '🪞 Notiere etwas über mich …',
  an_claude_uebergeben: '✳ Übergebe an Claude …',
  gedaechtnis_loeschen: '🗑 Vergesse …',
  wetter: '🌦 Schaue nach dem Wetter …',
  nachrichten: '📰 Schaue in die Nachrichten …',
};

module.exports = { APP_TOOLS, APP_TOOL_STATUS };
