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
    name: 'gedaechtnis_durchsuchen',
    description:
      'Durchsucht ALLES, was du weißt, nach Bedeutung (versteht auch Umschreibungen): Notizen deines Gegenübers, dein ' +
      'eigenes Notizbuch, frühere Gespräche, gespeichertes Wissen, gelernte Fakten und – im Bereich Dienstlich – das ' +
      'Firmenwissen. Nutze es bei „Weißt du noch …“, „Was hatten wir zu … besprochen?“, „Hab ich dir mal von … ' +
      'erzählt?“ oder wenn dir zu einer Frage etwas fehlen könnte, das ihr schon mal hattet. Jeder Treffer nennt die Quelle.',
    input_schema: {
      type: 'object',
      properties: {
        suche: { type: 'string', description: 'Worum es geht – in eigenen Worten, gern als ganzer Satz' },
        anzahl: { type: 'integer', description: 'höchstens so viele Treffer (Standard 6, max. 10)' },
      },
      required: ['suche'],
    },
  },
  {
    name: 'app_hilfe',
    description:
      'Was kann die App, und wie geht etwas? Nutze es, wenn dein Gegenüber fragt, was du alles kannst, wie eine Funktion ' +
      'geht oder wo etwas eingestellt wird („Was kannst du?“, „Wie stelle ich einen Timer?“, „Wo ändere ich die ' +
      'Stimme?“). Ohne frage: Überblick nach Gruppen. Antworte danach kurz in deiner Art mit zwei, drei passenden ' +
      'Beispielen statt einer langen Liste.',
    input_schema: { type: 'object', properties: { frage: { type: 'string', description: 'Worum es geht (leer = Überblick)' } } },
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
    name: 'video_abspielen',
    privatOnly: true,
    description:
      'Spielt eines deiner Videos mit Ton auf der Bühne ab, wenn dein Gegenüber darum bittet („Spiel mir das Video vom ' +
      'Geburtstag“, „Zeig mal den Tanz“). Welche Videos es gibt, steht im Zusammenhang unter „Deine Videos“. name: der ' +
      'Name oder ein Stichwort daraus. Das Video startet, sobald du fertig gesprochen hast – kündige es höchstens mit ' +
      'einem kurzen Satz an und sprich nicht über das Werkzeug.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Name des Videos oder Stichwort' } },
      required: ['name'],
    },
  },
  {
    name: 'handy_steuern',
    privatOnly: true,
    mobileOnly: true, // nur in der Android-App
    description:
      'Führt auf dem Handy etwas aus, wenn dein Gegenüber darum bittet: App öffnen („Öffne Spotify“), ein passendes ' +
      'YouTube-Video suchen und gleich abspielen (youtube mit suche – du bekommst Titel und weitere Treffer zurück und ' +
      'nennst kurz, was läuft), Spotify-Suche, Navigation ' +
      'starten, Karte, Webseite, Wecker oder Timer in der Uhr-App, Musik steuern (play/pause/weiter/zurück), ' +
      'Lautstärke, Taschenlampe, Einstellungen (WLAN, Bluetooth, Ton, Akku …), Kamera, Text an die Claude-App übergeben ' +
      '(an_claude, wie am PC), teilen. Anruf (anrufen), SMS und WhatsApp werden nur VORBEREITET – gewählt bzw. gesendet ' +
      'wird erst, wenn dein Gegenüber selbst tippt; sag das in einem kurzen Satz. Statt einer Nummer geht auch ein Name ' +
      '(kontakt) – die Nummer kommt dann aus dem Adressbuch; passen mehrere, frag kurz nach. Für eigene Erinnerungen ' +
      'weiter erinnerung_setzen nehmen. Sprich nicht über das Werkzeug.',
    input_schema: {
      type: 'object',
      properties: {
        aktion: {
          type: 'string',
          enum: ['app_oeffnen', 'apps', 'youtube', 'spotify', 'kontakt_suchen', 'navigation', 'karte', 'webseite', 'wecker', 'timer', 'musik', 'lautstaerke', 'taschenlampe', 'einstellungen', 'kamera', 'an_claude', 'teilen', 'anrufen', 'sms', 'whatsapp'],
        },
        app: { type: 'string', description: 'app_oeffnen: Name der App' },
        suche: { type: 'string', description: 'youtube/spotify: wonach gesucht werden soll (z. B. „Entspannungsmusik zum Arbeiten“)' },
        video: { type: 'string', description: 'youtube: Kennung eines Videos aus einer früheren Suche (zum Abspielen eines bestimmten)' },
        ziel: { type: 'string', description: 'navigation/karte: Adresse oder Ort' },
        modus: { type: 'string', description: 'navigation: auto, zu_fuss, rad' },
        url: { type: 'string', description: 'webseite' },
        nummer: { type: 'string', description: 'anrufen/sms/whatsapp: Telefonnummer (falls genannt)' },
        kontakt: { type: 'string', description: 'anrufen/sms/whatsapp/kontakt_suchen: Name aus dem Adressbuch (statt Nummer)' },
        text: { type: 'string', description: 'an_claude/teilen/sms/whatsapp: der Text; wecker/timer: Beschriftung' },
        stunde: { type: 'integer', description: 'wecker: Stunde 0–23' },
        minute: { type: 'integer', description: 'wecker: Minute 0–59' },
        sekunden: { type: 'integer', description: 'timer: Dauer in Sekunden' },
        befehl: { type: 'string', description: 'musik: play, pause, weiter, zurueck' },
        wert: { type: 'integer', description: 'lautstaerke: 0–100 (oder richtung)' },
        richtung: { type: 'string', description: 'lautstaerke: lauter / leiser' },
        an: { type: 'boolean', description: 'taschenlampe: an (true) oder aus (false)' },
        bereich: { type: 'string', description: 'einstellungen: wlan, bluetooth, ton, akku, standort, display, nicht stören' },
      },
      required: ['aktion'],
    },
  },
  {
    name: 'notiz_anlegen',
    privatOnly: true,
    description:
      'Legt eine Notiz im Second Brain deines Gegenübers an (persönliche Wissensablage in Ordnern: eingang, projekte, ' +
      'themen, personen, tagebuch, archiv). Für Gedanken, Ideen, Pläne, Infos über Menschen, Projektnotizen und offene ' +
      'Punkte („Ich muss noch …“ → offen: true). Ohne Ordner landet sie im Eingang und wird später einsortiert. Für ' +
      'Rechercheergebnisse weiter wissen_speichern, für Erinnerungen zu einer Uhrzeit erinnerung_setzen. Mit notizbuch: ' +
      '"eigenes" schreibst du in dein EIGENES Notizbuch (was du dir selbst merken oder vornehmen willst).',
    input_schema: {
      type: 'object',
      properties: {
        notizbuch: { type: 'string', enum: ['gegenueber', 'eigenes'], description: 'eigenes = dein eigenes Notizbuch; sonst das deines Gegenübers' },
        titel: { type: 'string', description: 'Kurzer, treffender Titel' },
        text: { type: 'string', description: 'Inhalt (Markdown erlaubt), vollständig und für sich verständlich' },
        ordner: { type: 'string', enum: ['eingang', 'projekte', 'themen', 'personen', 'tagebuch', 'archiv'] },
        projekt: { type: 'string', description: 'Name des Projekts, falls es zu einem gehört' },
        tags: { type: 'array', items: { type: 'string' }, description: '2–5 kurze Stichworte' },
        offen: { type: 'boolean', description: 'true = noch zu erledigen (offener Punkt)' },
        faellig: { type: 'string', description: 'optional: Fälligkeit YYYY-MM-DD' },
        schritte: { type: 'array', items: { type: 'string' }, description: 'Vorhaben: Arbeitsschritte (im eigenen Notizbuch arbeitest du sie in ruhigen Minuten selbst ab)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'notizen_suchen',
    privatOnly: true,
    description:
      'Sucht im Second Brain (Notizen deines Gegenübers): per Stichwort, in einem Ordner oder nur offene Punkte ' +
      '(nur_offen). Ohne Suchbegriff: die neuesten. Nutze es bei „Was hatte ich zu … notiert?“, „Was ist noch offen?“, ' +
      '„Was weiß ich über …?“.',
    input_schema: {
      type: 'object',
      properties: {
        notizbuch: { type: 'string', enum: ['gegenueber', 'eigenes'], description: 'eigenes = dein eigenes Notizbuch; sonst das deines Gegenübers' },
        suche: { type: 'string' },
        ordner: { type: 'string', enum: ['eingang', 'projekte', 'themen', 'personen', 'tagebuch', 'archiv'] },
        nur_offen: { type: 'boolean' },
        anzahl: { type: 'integer', description: 'höchstens so viele (Standard 6, max. 10)' },
      },
    },
  },
  {
    name: 'notiz_lesen',
    privatOnly: true,
    description: 'Liest eine Notiz aus dem Second Brain vollständig (id aus notizen_suchen oder der Titel).',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, titel: { type: 'string' }, notizbuch: { type: 'string', enum: ['gegenueber', 'eigenes'] } } },
  },
  {
    name: 'notiz_aendern',
    privatOnly: true,
    description:
      'Ändert eine Notiz im Second Brain: Text ergänzen (text_anhaengen) oder ersetzen, Titel, Ordner, Projekt, ' +
      'Stichworte, als erledigt abhaken (erledigt: true) oder wieder öffnen. id aus notizen_suchen oder der Titel.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        notizbuch: { type: 'string', enum: ['gegenueber', 'eigenes'], description: 'eigenes = dein eigenes Notizbuch; sonst das deines Gegenübers' },
        titel: { type: 'string', description: 'neuer Titel (bzw. zum Finden, wenn keine id)' },
        text: { type: 'string', description: 'ersetzt den ganzen Text' },
        text_anhaengen: { type: 'string', description: 'wird unten angefügt' },
        ordner: { type: 'string', enum: ['eingang', 'projekte', 'themen', 'personen', 'tagebuch', 'archiv'] },
        projekt: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        offen: { type: 'boolean' },
        erledigt: { type: 'boolean' },
        faellig: { type: 'string' },
        schritt_erledigt: { description: 'Schritt abhaken: Nummer (ab 1) oder ein Stück seines Texts' },
        schritte_neu: { type: 'array', items: { type: 'string' } },
        verarbeitet: { type: 'boolean', description: 'Eintrag aus dem Zwischenspeicher ist bearbeitet (wird abgehakt)' },
        loeschen: { type: 'boolean', description: 'Notiz löschen (nur nach Bestätigung)' },
        antwort: { type: 'string', description: 'Antwort deines Gegenübers auf eine Rückfrage zum Vorhaben' },
      },
    },
  },
  {
    name: 'erinnerung_setzen',
    privatOnly: true,
    description:
      'Stellt eine Erinnerung oder einen Timer auf dem Gerät (ohne Google, auch offline): „Erinnere mich in 20 Minuten an ' +
      'den Rückruf“, „Weck mich um 6:30“, „Morgen um 9 an den Zahnarzt erinnern“. Entweder in_minuten oder zeitpunkt ' +
      '(Ortszeit YYYY-MM-DDTHH:MM). Sag danach kurz, wann du erinnerst. Handy: statt einer Zeit auch an einem gemerkten ' +
      'Ort – „Erinnere mich an Milch, wenn ich beim Supermarkt bin“ → ort: „Supermarkt“ (Orte siehe orte_verwalten).',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Woran erinnert werden soll (kurz)' },
        in_minuten: { type: 'number', description: 'In wie vielen Minuten (für Timer)' },
        zeitpunkt: { type: 'string', description: 'Ortszeit YYYY-MM-DDTHH:MM' },
        ort: { type: 'string', description: 'Name eines gemerkten Orts (statt Zeit): erinnert beim Ankommen dort' },
      },
      required: ['text'],
    },
  },
  {
    name: 'orte_verwalten',
    privatOnly: true,
    mobileOnly: true,
    description:
      'Gemerkte Orte für Erinnerungen an Orten (bleiben nur auf dem Handy): „Merk dir diesen Ort als Supermarkt“ → ' +
      'aktion hier_merken mit name (nimmt den aktuellen Standort); „Welche Orte kennst du?“ → liste; löschen mit name.',
    input_schema: {
      type: 'object',
      properties: { aktion: { type: 'string', enum: ['hier_merken', 'liste', 'loeschen'] }, name: { type: 'string' } },
      required: ['aktion'],
    },
  },
  {
    name: 'erinnerungen_verwalten',
    privatOnly: true,
    description: 'Zeigt die gestellten Erinnerungen/Timer oder löscht eine (aktion „liste“ oder „loeschen“ mit text bzw. „alle“).',
    input_schema: {
      type: 'object',
      properties: { aktion: { type: 'string', enum: ['liste', 'loeschen'] }, text: { type: 'string' } },
      required: ['aktion'],
    },
  },
  {
    name: 'verkehr',
    description:
      'Aktuelle Verkehrslage auf einer deutschen Autobahn (Autobahn GmbH): Staus, Unfälle, Sperrungen und Baustellen mit ' +
      'Sperrung. Nimm es für Fragen wie „Ist die A2 frei?“, „Stau auf der A7 bei Hannover?“ – statt einer Internetsuche. ' +
      'Für Stadt- und Landstraßen gibt es hier nichts. Fasse kurz zusammen, was für die Fahrt zählt (im Auto höchstens ' +
      'zwei Sätze).',
    input_schema: {
      type: 'object',
      properties: {
        autobahn: { type: 'string', description: 'z. B. „A2“' },
        ort: { type: 'string', description: 'Optional: Ort oder Anschlussstelle, um die Meldungen einzugrenzen (z. B. „Hannover“)' },
      },
      required: ['autobahn'],
    },
  },
  {
    name: 'gespraeche_suchen',
    description:
      'Durchsucht deine Erinnerung an frühere Gespräche mit deinem Gegenüber (Zusammenfassungen: Thema, Ergebnis, was ' +
      'offen blieb). Nimm es, wenn dein Gegenüber fragt „Was hatten wir … besprochen?“, „Weißt du noch …?“, oder wenn ' +
      'ein früheres Gespräch für die Antwort wichtig ist. Optional mit Zeitraum. Erzähl danach in deiner Art („da hatten ' +
      'wir doch am … “), lies keine Liste vor.',
    input_schema: {
      type: 'object',
      properties: {
        suchbegriff: { type: 'string', description: 'Worum es ging (leer = die letzten Gespräche)' },
        von: { type: 'string', description: 'Frühestes Datum YYYY-MM-DD (optional)' },
        bis: { type: 'string', description: 'Spätestes Datum YYYY-MM-DD (optional)' },
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
  gespraeche_suchen: '💭 Erinnere mich …',
  verkehr: '🚗 Schaue nach dem Verkehr …',
  erinnerung_setzen: '⏰ Stelle die Erinnerung …',
  orte_verwalten: '📍 Merke mir den Ort …',
  video_abspielen: '🎬 Hole das Video …',
  notiz_anlegen: '🧠 Lege die Notiz ab …',
  notizen_suchen: '🧠 Schaue in deine Notizen …',
  notiz_lesen: '🧠 Lese die Notiz …',
  notiz_aendern: '🧠 Ändere die Notiz …',
  handy_steuern: '📱 Mache das auf dem Handy …',
  erinnerungen_verwalten: '⏰ Schaue in die Erinnerungen …',
  nachrichten: '📰 Schaue in die Nachrichten …',
};

module.exports = { APP_TOOLS, APP_TOOL_STATUS };
