// Ergoforyou Sign – Karte in der rechten Seitenleiste von Kontakt und Deal.
// Spricht über hubspot.fetch (von HubSpot unterschrieben) mit dem NAS-Dienst;
// das eigentliche Anfordern läuft im Fenster („Studio“) vom NAS.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Divider,
  Flex,
  LoadingSpinner,
  StatusTag,
  Text,
  hubspot,
} from '@hubspot/ui-extensions';
import type { CrmContext, ExtensionPointApiActions } from '@hubspot/ui-extensions';
import { NAS_ADRESSE } from './nas.ts';

type Person = { rolle: string; name: string; status: string; link: string };
type Auftrag = {
  id: string;
  titel: string;
  status: string;
  status_text: string;
  erstellt: string;
  erstellt_von: string;
  fertig: string;
  anzahl: number;
  unterschrieben: number;
  personen: Person[];
  pdf: string;
  hubspot_fehler: string;
};
type Antwort = { ok: boolean; version: string; studio: string; auftraege: Auftrag[]; hinweis: string };
type Props = { context: CrmContext; actions: ExtensionPointApiActions<'crm.record.sidebar'> };

const FARBE: Record<string, 'success' | 'warning' | 'info' | 'default' | 'danger'> = {
  unterschrieben: 'success',
  teilweise: 'warning',
  geoeffnet: 'warning',
  offen: 'info',
  abgelaufen: 'default',
  widerrufen: 'default',
};
const SICHTBAR = 4;

hubspot.extend<'crm.record.sidebar'>(({ context, actions }) => <Karte context={context} actions={actions} />);

function Karte({ context, actions }: Props) {
  const [daten, setDaten] = useState<Antwort | null>(null);
  const [fehler, setFehler] = useState('');
  const [laedt, setLaedt] = useState(true);
  const [alle, setAlle] = useState(false);
  const laufend = useRef(false);

  const laden = useCallback(async () => {
    if (laufend.current) return;
    laufend.current = true;
    setLaedt(true);
    const von = [context.user?.firstName, context.user?.lastName].filter(Boolean).join(' ') || context.user?.email || '';
    const adresse =
      `${NAS_ADRESSE}/hs/karte?objekt=${encodeURIComponent(context.crm.objectTypeId)}` +
      `&id=${encodeURIComponent(String(context.crm.objectId))}&von=${encodeURIComponent(von)}`;
    try {
      const antwort = await hubspot.fetch(adresse, { method: 'GET', timeout: 15000 });
      let inhalt: (Partial<Antwort> & { fehler?: string }) = {};
      try {
        inhalt = await antwort.json();
      } catch {
        // keine JSON-Antwort
      }
      if (!antwort.ok) throw new Error(inhalt.fehler || `Der NAS-Dienst antwortet mit Fehler ${antwort.status}.`);
      setDaten(inhalt as Antwort);
      setFehler('');
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      setFehler(/fetch|network|timeout|failed/i.test(text) ? 'Der NAS-Dienst ist gerade nicht erreichbar (NAS aus oder Tunnel getrennt?).' : text);
    } finally {
      laufend.current = false;
      setLaedt(false);
    }
  }, [context.crm.objectId, context.crm.objectTypeId, context.user?.email, context.user?.firstName, context.user?.lastName]);

  useEffect(() => {
    laden();
  }, [laden]);

  // Solange etwas offen ist, alle zwei Minuten still nachsehen.
  const offen = !!daten?.auftraege.some((a) => ['offen', 'geoeffnet', 'teilweise'].includes(a.status));
  useEffect(() => {
    if (!offen) return undefined;
    const uhr = setInterval(() => laden(), 120000);
    return () => clearInterval(uhr);
  }, [offen, laden]);

  const fenster = (uri: string, titel: string, hoehe = 860) =>
    actions.openIframeModal({ uri, title: titel, width: 1280, height: hoehe, flush: true }, () => laden());

  const kopieren = async (link: string) => {
    try {
      await actions.copyTextToClipboard(link);
      actions.addAlert({ type: 'success', message: 'Link kopiert – jetzt per E-Mail oder WhatsApp senden.' });
    } catch {
      actions.addAlert({ type: 'warning', message: 'Kopieren nicht möglich – bitte über „Details“ kopieren.' });
    }
  };

  if (laedt && !daten) return <LoadingSpinner label="Unterschriften werden geladen …" layout="centered" />;

  if (fehler && !daten) {
    return (
      <Flex direction="column" gap="sm">
        <Alert title="Ergoforyou Sign nicht erreichbar" variant="danger">
          {fehler}
        </Alert>
        <Button onClick={() => laden()} size="sm">
          Erneut versuchen
        </Button>
      </Flex>
    );
  }
  if (!daten) return null;

  const liste = alle ? daten.auftraege : daten.auftraege.slice(0, SICHTBAR);
  return (
    <Flex direction="column" gap="sm">
      <Button variant="primary" onClick={() => fenster(daten.studio, 'Unterschrift anfordern')}>
        ✍ Neue Unterschrift anfordern
      </Button>
      {daten.hinweis ? <Alert title="Hinweis" variant="warning">{daten.hinweis}</Alert> : null}
      {fehler ? <Text variant="microcopy">⚠ {fehler}</Text> : null}
      {daten.auftraege.length === 0 ? (
        <Text variant="microcopy">Noch keine Unterschriften für diesen Datensatz.</Text>
      ) : null}
      {liste.map((a) => {
        const offeneLinks = a.personen.filter((p) => p.link);
        return (
          <Flex direction="column" gap="xs" key={a.id}>
            <Divider distance="extra-small" />
            <Text format={{ fontWeight: 'demibold' }} truncate={{ tooltipText: a.titel }}>
              {a.titel}
            </Text>
            <Flex direction="row" gap="xs" align="center" wrap="wrap">
              <StatusTag variant={FARBE[a.status] || 'default'}>{a.status_text}</StatusTag>
              <Text variant="microcopy">
                {a.anzahl > 1 ? `${a.unterschrieben}/${a.anzahl} · ` : ''}
                {a.fertig ? `fertig ${a.fertig}` : `gesendet ${a.erstellt}`}
              </Text>
            </Flex>
            {a.anzahl > 1 ? (
              <Text variant="microcopy">
                {a.personen.map((p) => `${p.status === 'unterschrieben' ? '✔' : '○'} ${p.name || p.rolle}`).join('  ')}
              </Text>
            ) : null}
            {a.hubspot_fehler ? <Text variant="microcopy">⚠ Ablage in HubSpot wird nachgeholt</Text> : null}
            <Flex direction="row" gap="xs" wrap="wrap">
              {a.pdf ? (
                <Button size="xs" variant="primary" href={{ url: a.pdf, external: true }}>
                  PDF öffnen
                </Button>
              ) : null}
              {offeneLinks.length === 1 ? (
                <Button size="xs" onClick={() => kopieren(offeneLinks[0].link)}>
                  Link kopieren
                </Button>
              ) : null}
              <Button size="xs" variant="secondary" onClick={() => fenster(`${daten.studio}&auftrag=${encodeURIComponent(a.id)}`, a.titel, 720)}>
                Details
              </Button>
            </Flex>
          </Flex>
        );
      })}
      {daten.auftraege.length > SICHTBAR ? (
        <Button size="xs" variant="transparent" onClick={() => setAlle(!alle)}>
          {alle ? 'Weniger anzeigen' : `Alle ${daten.auftraege.length} anzeigen`}
        </Button>
      ) : null}
      <Button size="xs" variant="transparent" onClick={() => laden()} disabled={laedt}>
        {laedt ? 'Aktualisiert …' : '↻ Aktualisieren'}
      </Button>
    </Flex>
  );
}
