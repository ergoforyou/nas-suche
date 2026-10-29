import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Divider,
  EmptyState,
  Flex,
  Image,
  Link,
  LoadingSpinner,
  Select,
  StatusTag,
  Text,
  TextArea,
  Tile,
  hubspot,
} from '@hubspot/ui-extensions'
import { SERVER, ZEITZONE } from './einstellungen.js'

const AKTUALISIEREN_MS = 8000

hubspot.extend(({ context, actions }) => <WhatsAppChat context={context} actions={actions} />)

const uhrzeit = new Intl.DateTimeFormat('de-DE', { timeZone: ZEITZONE, hour: '2-digit', minute: '2-digit' })
const tag = new Intl.DateTimeFormat('de-DE', { timeZone: ZEITZONE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
const HAKEN = { 0: '⚠ nicht gesendet', 1: '🕓', 2: '✓', 3: '✓✓', 4: '✓✓ gelesen', 5: '✓✓ gelesen' }

// Neue und bereits geladene Nachrichten zusammenführen, ohne Dubletten, älteste zuerst
function zusammenfuehren(alt, neu) {
  const map = new Map(alt.map((n) => [n.id, n]))
  for (const n of neu) map.set(n.id, n)
  return [...map.values()].sort((a, b) => a.zeit - b.zeit)
}

function WhatsAppChat({ context, actions }) {
  const contactId = String(context.crm.objectId)
  const absender =
    [context.user.firstName, context.user.lastName].filter(Boolean).join(' ') || context.user.email || 'HubSpot'

  const [daten, setDaten] = useState(null)
  const [nachrichten, setNachrichten] = useState([])
  const [mehr, setMehr] = useState(false)
  const [fehler, setFehler] = useState(null)
  const [text, setText] = useState('')
  const [ziel, setZiel] = useState('')
  const [sendet, setSendet] = useState(false)
  const [laedtAeltere, setLaedtAeltere] = useState(false)
  const ersterAbruf = useRef(true)

  const post = useCallback(
    async (pfad, body = {}) => {
      const res = await hubspot.fetch(`${SERVER}${pfad}`, {
        method: 'POST',
        body: { contactId, ...body },
        timeout: 15000,
      })
      let data = {}
      try {
        data = await res.json()
      } catch {
        // keine JSON-Antwort
      }
      if (!res.ok) throw new Error(data.fehler || `Server antwortet mit Status ${res.status}`)
      return data
    },
    [contactId]
  )

  const laden = useCallback(async () => {
    try {
      const d = await post('/api/karte/verlauf')
      setDaten(d)
      setNachrichten((alt) => zusammenfuehren(alt, d.nachrichten))
      if (ersterAbruf.current) {
        setMehr(d.mehr)
        ersterAbruf.current = false
      }
      setFehler(null)
    } catch (e) {
      setFehler(e.message)
    }
  }, [post])

  useEffect(() => {
    laden()
    const timer = setInterval(laden, AKTUALISIEREN_MS)
    return () => clearInterval(timer)
  }, [laden])

  const aeltereLaden = async () => {
    if (!nachrichten.length) return
    setLaedtAeltere(true)
    try {
      const d = await post('/api/karte/verlauf', { vor: nachrichten[0].zeit, anzahl: 40 })
      setNachrichten((alt) => zusammenfuehren(alt, d.nachrichten))
      setMehr(d.mehr)
    } catch (e) {
      setFehler(e.message)
    }
    setLaedtAeltere(false)
  }

  const senden = async () => {
    setSendet(true)
    setFehler(null)
    try {
      const body = { text, absender }
      if (ziel.startsWith('pn:') || ziel.startsWith('lid:')) body.chatId = ziel
      else if (ziel) body.nummer = ziel
      const { nachricht } = await post('/api/karte/senden', body)
      setText('')
      setNachrichten((alt) => zusammenfuehren(alt, [nachricht]))
      actions.refreshObjectProperties()
    } catch (e) {
      setFehler(e.message)
    }
    setSendet(false)
  }

  if (!daten && !fehler) return <LoadingSpinner label="Lade WhatsApp-Verlauf …" />

  const verbunden = Boolean(daten?.verbunden)
  const nummern = daten?.nummern || []
  const chats = daten?.chats || []
  const kundenName = (chatId) => chats.find((c) => c.id === chatId)?.name || 'Kunde'

  // Wohin senden? Bestehende Chats und Nummern am Kontakt, die noch keinen Chat haben
  const optionen = [
    { label: 'Automatisch (zuletzt genutzter Chat)', value: '' },
    ...chats.map((c) => ({ label: `${c.nummer || 'WhatsApp-Kontakt'}${c.name ? ' – ' + c.name : ''}`, value: c.id })),
    ...nummern
      .filter((n) => !chats.some((c) => c.nummer === n))
      .map((n) => ({ label: `${n} (neuer Chat)`, value: n })),
  ]

  let letzterTag = null
  const zeilen = []
  for (const n of nachrichten) {
    const t = tag.format(n.zeit)
    if (t !== letzterTag) {
      zeilen.push(
        <Flex key={`tag-${t}`} justify="center">
          <Text variant="microcopy" format={{ fontWeight: 'demibold' }}>
            {t}
          </Text>
        </Flex>
      )
      letzterTag = t
    }
    zeilen.push(<Nachricht key={n.id} n={n} kunde={kundenName(n.chat)} />)
  }

  return (
    <Flex direction="column" gap="sm">
      <Flex justify="between" align="center" wrap>
        <StatusTag variant={verbunden ? 'success' : 'danger'}>
          {verbunden ? 'WhatsApp verbunden' : 'WhatsApp nicht verbunden'}
        </StatusTag>
        <Text variant="microcopy">{nummern.join(' · ')}</Text>
      </Flex>

      {daten && !verbunden && (
        <Alert title="WhatsApp ist nicht verbunden" variant="warning">
          Der Verlauf ist lesbar, Senden geht gerade nicht. Neu verbinden unter {SERVER}/admin.
        </Alert>
      )}
      {fehler && (
        <Alert title="Fehler" variant="danger">
          {fehler}
        </Alert>
      )}
      {daten && nummern.length === 0 && chats.length === 0 && (
        <Alert title="Keine Telefonnummer" variant="info">
          Tragt am Kontakt eine Mobil- oder WhatsApp-Nummer ein, dann erscheint hier der Verlauf.
        </Alert>
      )}

      {mehr && (
        <Flex justify="center">
          <Button size="sm" variant="secondary" onClick={aeltereLaden} disabled={laedtAeltere}>
            {laedtAeltere ? 'Lade …' : 'Ältere Nachrichten laden'}
          </Button>
        </Flex>
      )}

      {daten && nachrichten.length === 0 && (nummern.length > 0 || chats.length > 0) ? (
        <EmptyState title="Noch keine Nachrichten" layout="horizontal" imageWidth={100}>
          <Text>Mit diesem Kontakt gibt es noch keinen WhatsApp-Verlauf. Schreibt unten die erste Nachricht.</Text>
        </EmptyState>
      ) : (
        zeilen
      )}

      <Divider />

      {optionen.length > 2 && (
        <Select label="Senden an" name="ziel" value={ziel} onChange={(v) => setZiel(String(v))} options={optionen} />
      )}
      <TextArea
        label={`Nachricht (als ${absender})`}
        name="nachricht"
        value={text}
        onChange={setText}
        rows={3}
        maxLength={4096}
        placeholder="Nachricht schreiben …"
      />
      <Flex gap="sm">
        <Button
          variant="primary"
          onClick={senden}
          disabled={!text.trim() || sendet || !verbunden || (nummern.length === 0 && chats.length === 0)}
        >
          {sendet ? 'Sendet …' : 'Per WhatsApp senden'}
        </Button>
        <Button variant="secondary" onClick={laden}>
          Aktualisieren
        </Button>
      </Flex>
    </Flex>
  )
}

function Nachricht({ n, kunde }) {
  const wer = n.eigene ? n.absender : kunde
  const kopf = `${wer} · ${uhrzeit.format(n.zeit)}${n.eigene ? '  ' + (HAKEN[n.status] || '') : ''}`
  const zeilen = String(n.text || '').split('\n')
  return (
    <Flex justify={n.eigene ? 'end' : 'start'}>
      <Tile compact>
        <Flex direction="column" gap="xs">
          <Text variant="microcopy" format={{ fontWeight: 'bold' }}>
            {kopf}
          </Text>
          {n.medien?.bild && (
            <Image src={n.medien.url} alt={n.medien.name || 'Bild'} width={240} href={{ url: n.medien.url, external: true }} />
          )}
          {n.medien && !n.medien.bild && (
            <Link href={{ url: n.medien.url, external: true }}>{n.medien.name || 'Datei öffnen'}</Link>
          )}
          {zeilen.map((z, i) => (
            <Text key={i}>{z || ' '}</Text>
          ))}
        </Flex>
      </Tile>
    </Flex>
  )
}
