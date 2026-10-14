// Eine einzelne Seite in der Dokumentansicht: Grundbild + bei starker
// Vergrößerung scharfe Kacheln nur für den sichtbaren Ausschnitt.

import { memo, useEffect, useMemo, useState } from "react";
import { bildUrl } from "../api";
import { anfordern, ausCache } from "../render/bildlader";
import { RENDER_STUFEN, renderStufe, rechteckDrehen } from "../render/layout";

const MAX_GRUNDBILD_PIXEL = 2400 * 2400; // darüber: Kacheln
const KACHEL = 512; // Kachelgröße in Gerätepixeln
const VERZOEGERUNG = 50; // ms – vorbeihuschende Seiten nicht rendern

export interface SeiteProps {
  dokId: string;
  seite: number;
  kennung: string;
  breitePt: number; // angezeigte Breite in pt (inkl. Drehung)
  hoehePt: number;
  b: number; // Größe in CSS-px
  h: number;
  drehung: number;
  dpr: number;
  prioritaet: number;
  /** sichtbarer Bereich der Seite in CSS-px relativ zur Seite (null = nicht sichtbar) */
  sichtbar: { x0: number; y0: number; x1: number; y1: number } | null;
  markierungen: { r: [number, number, number, number]; aktiv: boolean }[];
}

function useBild(url: string | null, prioritaet: number): string | null {
  const [bild, setBild] = useState<string | null>(() => (url ? ausCache(url) : null));
  useEffect(() => {
    if (!url) return;
    return anfordern(
      url,
      prioritaet,
      (objektUrl) => {
        if (objektUrl) setBild(objektUrl);
      },
      VERZOEGERUNG,
    );
    // Priorität ändert sich laufend beim Scrollen – Auftrag nur bei neuer URL neu starten
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  return bild;
}

function Kachel(props: { url: string; links: number; oben: number; b: number; h: number; prioritaet: number }) {
  const bild = useBild(props.url, props.prioritaet);
  if (!bild) return null;
  return (
    <img
      className="kachel geladen"
      src={bild}
      alt=""
      draggable={false}
      style={{ left: props.links, top: props.oben, width: props.b, height: props.h }}
    />
  );
}

export const Seite = memo(function Seite(p: SeiteProps) {
  const cssSkala = p.b / p.breitePt; // CSS-px pro pt
  const benoetigt = renderStufe(cssSkala * p.dpr);
  const pixelBeiBenoetigt = p.breitePt * benoetigt * p.hoehePt * benoetigt;
  const mitKacheln = pixelBeiBenoetigt > MAX_GRUNDBILD_PIXEL;
  const grundStufe = mitKacheln
    ? [...RENDER_STUFEN].reverse().find((s) => p.breitePt * s * p.hoehePt * s <= MAX_GRUNDBILD_PIXEL) ?? RENDER_STUFEN[0]
    : benoetigt;

  const grundUrl = bildUrl({ dokId: p.dokId, seite: p.seite, kennung: p.kennung, skala: grundStufe, drehung: p.drehung });

  // Bis das passende Bild da ist, das zuletzt gezeigte (oder ein gecachtes
  // niedriger aufgelöstes) Bild gestreckt anzeigen → kein weißes Flackern.
  const [grundBild, setGrundBild] = useState<{ url: string; stufe: number } | null>(() => {
    for (const s of [grundStufe, ...[...RENDER_STUFEN].reverse()]) {
      const t = ausCache(bildUrl({ dokId: p.dokId, seite: p.seite, kennung: p.kennung, skala: s, drehung: p.drehung }));
      if (t) return { url: t, stufe: s };
    }
    return null;
  });
  useEffect(() => {
    return anfordern(grundUrl, p.prioritaet, (u) => u && setGrundBild({ url: u, stufe: grundStufe }), VERZOEGERUNG);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grundUrl]);

  const kacheln = useMemo(() => {
    if (!mitKacheln || !p.sichtbar) return [];
    const f = benoetigt / cssSkala; // Gerätepixel (bei Stufe) pro CSS-px
    const W = Math.ceil(p.breitePt * benoetigt);
    const H = Math.ceil(p.hoehePt * benoetigt);
    const ix0 = Math.max(0, Math.floor((p.sichtbar.x0 * f) / KACHEL));
    const iy0 = Math.max(0, Math.floor((p.sichtbar.y0 * f) / KACHEL));
    const ix1 = Math.min(Math.ceil(W / KACHEL) - 1, Math.floor((p.sichtbar.x1 * f) / KACHEL));
    const iy1 = Math.min(Math.ceil(H / KACHEL) - 1, Math.floor((p.sichtbar.y1 * f) / KACHEL));
    const liste = [];
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = ix * KACHEL;
        const y = iy * KACHEL;
        const b = Math.min(KACHEL, W - x);
        const h = Math.min(KACHEL, H - y);
        if (b <= 0 || h <= 0) continue;
        liste.push({
          key: `${ix}-${iy}`,
          url: bildUrl({ dokId: p.dokId, seite: p.seite, kennung: p.kennung, skala: benoetigt, drehung: p.drehung, kachel: { x, y, b, h } }),
          links: x / f,
          oben: y / f,
          b: b / f,
          h: h / f,
        });
      }
    }
    return liste;
  }, [mitKacheln, p.sichtbar, benoetigt, cssSkala, p.breitePt, p.hoehePt, p.dokId, p.seite, p.kennung, p.drehung]);

  return (
    <div className="seite-inhalt" data-seite={p.seite} data-ziel-stufe={grundStufe} data-kacheln={kacheln.length}>
      {grundBild ? (
        <img className="seite-bild" src={grundBild.url} data-stufe={grundBild.stufe} alt={`Seite ${p.seite + 1}`} draggable={false} />
      ) : (
        <div className="seite-laedt" />
      )}
      {kacheln.map((k) => (
        <Kachel key={k.key} url={k.url} links={k.links} oben={k.oben} b={k.b} h={k.h} prioritaet={p.prioritaet + 1} />
      ))}
      {p.markierungen.map((m, i) => {
        const [x0, y0, x1, y1] = rechteckDrehen(m.r, p.drehung);
        return (
          <div
            key={i}
            className={m.aktiv ? "treffer aktiv" : "treffer"}
            style={{ left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` }}
          />
        );
      })}
    </div>
  );
});
