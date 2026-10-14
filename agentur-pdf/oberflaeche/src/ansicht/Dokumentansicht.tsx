// Dokumentansicht: virtualisiertes Scrollen, Zoom mit Mausanker,
// Ansichtsmodi, Lasso-Zoom, Lupe, Hand-Werkzeug, Sprung zu Suchtreffern.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { bildUrl } from "../api";
import { anfordern } from "../render/bildlader";
import {
  anzeigeGroesse,
  ersteSichtbare,
  istFortlaufend,
  layoutBerechnen,
  PT_ZU_PX,
  rechteckDrehen,
  renderStufe,
  zeilenBilden,
  zoomGanzeSeite,
  zoomSeitenbreite,
  type SeitenBox,
} from "../render/layout";
import { ansichtAendern, holen, setzen, useZustand, werkzeugBenutzt, zoomBegrenzen } from "../zustand/store";
import { bereichstextErkennen } from "../zustand/ocr";
import { Seite } from "./Seite";
import { AnmerkungsEbene } from "./Anmerkungen";
import { anmerkungenLaden } from "../zustand/anmerkungen";

interface Anker {
  seite: number;
  fx: number; // relative Position innerhalb der Seite (0..1)
  fy: number;
  mx: number; // Position im Viewport (px)
  my: number;
}

const LUPE = 240; // Durchmesser der Lupe in CSS-px

export function Dokumentansicht({ dokId }: { dokId: string }) {
  const dok = useZustand((z) => z.dokumente.find((d) => d.id === dokId) ?? null);
  const werkzeug = useZustand((z) => z.werkzeug);
  const lupeFaktor = useZustand((z) => z.lupeFaktor);
  const sprung = useZustand((z) => z.sprung);
  const suche = useZustand((z) => z.suche);
  const unsicher = useZustand((z) => z.unsicher[dokId]);
  const ausblenden = useZustand((z) => z.ausblenden.join(","));
  const bearbeitet = useZustand((z) => (z.editor?.dokId === dokId && z.editor.id !== null ? z.editor : null));
  const version = useZustand((z) => z.dokumente.find((d) => d.id === dokId)?.version ?? -1);

  // Anmerkungen und Formularfelder zur aktuellen Dokumentfassung laden
  useEffect(() => {
    if (version >= 0) void anmerkungenLaden(dokId, version);
  }, [dokId, version]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState({ b: 0, h: 0, x: 0, y: 0 });
  const [dpr, setDpr] = useState(window.devicePixelRatio || 1);
  const ankerRef = useRef<Anker | null>(null);
  const sprungRef = useRef<{ seite: number; rechteck?: [number, number, number, number] } | null>(null);
  const wiederhergestellt = useRef(false);

  const ansicht = dok?.ansicht;
  const seiten = dok?.seiten ?? [];

  // ---------------------------------------------------- effektiver Zoom
  const zoom = useMemo(() => {
    if (!ansicht || !vp.b) return ansicht?.zoom ?? 1;
    if (ansicht.zoomModus === "seitenbreite") return zoomBegrenzen(zoomSeitenbreite(seiten, ansicht.modus, ansicht.drehung, vp.b, ansicht.seite));
    if (ansicht.zoomModus === "ganzeseite") return zoomBegrenzen(zoomGanzeSeite(seiten, ansicht.modus, ansicht.drehung, vp.b, vp.h, ansicht.seite));
    return ansicht.zoom;
  }, [ansicht, seiten, vp.b, vp.h]);

  useEffect(() => {
    if (ansicht && Math.abs(ansicht.zoom - zoom) > 1e-4) ansichtAendern(dokId, { zoom });
  }, [zoom, ansicht, dokId]);

  const layout = useMemo(
    () => (ansicht ? layoutBerechnen(seiten, zoom, ansicht.modus, ansicht.drehung, ansicht.seite, vp.b) : null),
    [seiten, zoom, ansicht?.modus, ansicht?.drehung, ansicht?.seite, vp.b, ansicht],
  );

  // --------------------------------------------------- Viewport messen
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const messen = () => setVp((v) => ({ ...v, b: el.clientWidth, h: el.clientHeight }));
    messen();
    const ro = new ResizeObserver(messen);
    ro.observe(el);
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const dprAenderung = () => setDpr(window.devicePixelRatio || 1);
    mq.addEventListener?.("change", dprAenderung);
    return () => {
      ro.disconnect();
      mq.removeEventListener?.("change", dprAenderung);
    };
  }, []);

  // Scrollposition beim Tab-Wechsel merken und wiederherstellen
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !layout || wiederhergestellt.current || !vp.b) return;
    wiederhergestellt.current = true;
    if (ansicht) {
      el.scrollLeft = ansicht.scrollX;
      el.scrollTop = ansicht.scrollY;
    }
  }, [layout, vp.b, ansicht]);
  useEffect(() => {
    const el = scrollRef.current;
    return () => {
      if (el) ansichtAendern(dokId, { scrollX: el.scrollLeft, scrollY: el.scrollTop });
    };
  }, [dokId]);

  // ------------------------------------------------------------ Scrollen
  const rafRef = useRef(0);
  const onScroll = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) return;
      setVp((v) => ({ ...v, x: el.scrollLeft, y: el.scrollTop }));
    });
  }, []);

  // Aktuelle Seite = Seite, die die Viewport-Mitte (bzw. obere Hälfte) belegt
  useEffect(() => {
    if (!layout || !ansicht || !istFortlaufend(ansicht.modus) || !layout.boxen.length) return;
    const linie = vp.y + Math.min(vp.h / 2, 200);
    const i = ersteSichtbare(layout.boxen, linie);
    const box = layout.boxen[i];
    if (box && box.seite !== ansicht.seite && !sprungRef.current) ansichtAendern(dokId, { seite: box.seite });
  }, [vp.y, vp.h, layout, ansicht, dokId]);

  // --------------------------------------------------- Zoom mit Anker
  const ankerSetzen = useCallback(
    (mx: number, my: number) => {
      const el = scrollRef.current;
      if (!el || !layout) return;
      const cx = el.scrollLeft + mx;
      const cy = el.scrollTop + my;
      let beste: SeitenBox | null = null;
      let abstand = Infinity;
      for (const b of layout.boxen) {
        const dx = Math.max(b.x - cx, 0, cx - (b.x + b.b));
        const dy = Math.max(b.y - cy, 0, cy - (b.y + b.h));
        const d = dx + dy;
        if (d < abstand) {
          abstand = d;
          beste = b;
          if (d === 0) break;
        }
      }
      if (beste) ankerRef.current = { seite: beste.seite, fx: (cx - beste.x) / beste.b, fy: (cy - beste.y) / beste.h, mx, my };
    },
    [layout],
  );

  // Zoomänderungen von außen (Statusleiste, Menüband): Anker = Viewport-Mitte
  const letzterZoom = useRef(zoom);
  if (letzterZoom.current !== zoom && !ankerRef.current && layout && scrollRef.current) {
    ankerSetzen(vp.b / 2, vp.h / 2);
  }

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anker = ankerRef.current;
    letzterZoom.current = zoom;
    if (!el || !layout || !anker) return;
    ankerRef.current = null;
    const box = layout.boxen.find((b) => b.seite === anker.seite);
    if (!box) return;
    el.scrollLeft = box.x + anker.fx * box.b - anker.mx;
    el.scrollTop = box.y + anker.fy * box.h - anker.my;
    setVp((v) => ({ ...v, x: el.scrollLeft, y: el.scrollTop }));
  }, [layout, zoom]);

  const zoomAuf = useCallback(
    (neu: number, mx: number, my: number) => {
      if (!ansicht) return;
      neu = zoomBegrenzen(neu);
      if (Math.abs(neu - zoom) < 1e-4) return;
      ankerSetzen(mx, my);
      ansichtAendern(dokId, { zoom: neu, zoomModus: "frei" });
    },
    [ansicht, zoom, ankerSetzen, dokId],
  );

  // Strg+Mausrad (auch Touchpad-Zoom) – nicht-passiver Listener nötig
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const rad = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const faktor = Math.exp(-Math.max(-100, Math.min(100, e.deltaY)) * 0.0025);
        zoomAuf(holenZoom() * faktor, e.clientX - r.left, e.clientY - r.top);
        return;
      }
      // Einzelseite/Doppelseite: am Seitenende weiterblättern
      const d = holen().dokumente.find((x) => x.id === dokId);
      if (!d || istFortlaufend(d.ansicht.modus)) return;
      const amEnde = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
      const amAnfang = el.scrollTop <= 0;
      const schritt = d.ansicht.modus === "einzelseite" ? 1 : 2;
      if (e.deltaY > 0 && amEnde && d.ansicht.seite + schritt < d.seitenanzahl) {
        e.preventDefault();
        sprungRef.current = { seite: d.ansicht.seite + schritt };
        ansichtAendern(dokId, { seite: d.ansicht.seite + schritt });
      } else if (e.deltaY < 0 && amAnfang && d.ansicht.seite > 0) {
        e.preventDefault();
        ansichtAendern(dokId, { seite: Math.max(0, d.ansicht.seite - schritt) });
        requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
      }
    };
    const holenZoom = () => holen().dokumente.find((x) => x.id === dokId)?.ansicht.zoom ?? 1;
    el.addEventListener("wheel", rad, { passive: false });
    return () => el.removeEventListener("wheel", rad);
  }, [zoomAuf, dokId]);

  // ----------------------------------------------------------- Springen
  useEffect(() => {
    if (!sprung || sprung.dokId !== dokId || !ansicht) return;
    sprungRef.current = { seite: sprung.seite, rechteck: sprung.rechteck };
    if (!istFortlaufend(ansicht.modus) || ansicht.seite !== sprung.seite) ansichtAendern(dokId, { seite: sprung.seite });
    else setVp((v) => ({ ...v })); // Layout-Effekt erneut auslösen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sprung?.nonce]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const ziel = sprungRef.current;
    if (!el || !layout || !ziel || !vp.b) return;
    const box = layout.boxen.find((b) => b.seite === ziel.seite);
    if (!box) return;
    sprungRef.current = null;
    if (ziel.rechteck && ansicht) {
      const [x0, y0, x1, y1] = rechteckDrehen(ziel.rechteck, ansicht.drehung);
      const rx = box.x + ((x0 + x1) / 2) * box.b;
      const ry = box.y + ((y0 + y1) / 2) * box.h;
      el.scrollTop = ry - el.clientHeight / 3;
      if (rx < el.scrollLeft || rx > el.scrollLeft + el.clientWidth) el.scrollLeft = rx - el.clientWidth / 2;
    } else {
      el.scrollTop = box.y - 8;
    }
    setVp((v) => ({ ...v, x: el.scrollLeft, y: el.scrollTop }));
  }, [layout, vp.b, ansicht]);

  // -------------------------------------------- Maus: Hand, Lasso, Lupe
  const [lasso, setLasso] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [lupe, setLupe] = useState<{ mx: number; my: number; bild: string | null; versatzX: number; versatzY: number } | null>(null);
  const ziehen = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);

  const onMouseDown = (e: React.MouseEvent) => {
    const el = scrollRef.current;
    if (!el || e.button !== 0) return;
    const r = el.getBoundingClientRect();
    if (werkzeug === "hand") {
      ziehen.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
      el.classList.add("ziehen");
    } else if (werkzeug === "lassozoom" || werkzeug === "textbereich") {
      const x = e.clientX - r.left + el.scrollLeft;
      const y = e.clientY - r.top + el.scrollTop;
      setLasso({ x0: x, y0: y, x1: x, y1: y });
    }
    e.preventDefault();
  };

  /** Aufgezogenes Rechteck (Inhaltskoordinaten) → Seite + normiertes Rechteck → Bereichs-OCR */
  const bereichAuswerten = (x0: number, y0: number, b: number, h: number) => {
    if (!layout || !ansicht || b < 6 || h < 6) return;
    const mx = x0 + b / 2;
    const my = y0 + h / 2;
    const box = layout.boxen.find((k) => mx >= k.x && mx <= k.x + k.b && my >= k.y && my <= k.y + k.h);
    if (!box) return;
    const n: [number, number, number, number] = [
      Math.max(0, (x0 - box.x) / box.b),
      Math.max(0, (y0 - box.y) / box.h),
      Math.min(1, (x0 + b - box.x) / box.b),
      Math.min(1, (y0 + h - box.y) / box.h),
    ];
    // Ansichtsdrehung zurückrechnen → Koordinaten der (ungedreht) angezeigten Seite
    void bereichstextErkennen(dokId, box.seite, rechteckDrehen(n, (360 - ansicht.drehung) % 360));
  };

  useEffect(() => {
    const bewegen = (e: MouseEvent) => {
      const el = scrollRef.current;
      if (!el) return;
      if (ziehen.current) {
        el.scrollLeft = ziehen.current.sl - (e.clientX - ziehen.current.x);
        el.scrollTop = ziehen.current.st - (e.clientY - ziehen.current.y);
      }
      if (lasso) {
        const r = el.getBoundingClientRect();
        setLasso((l) => l && { ...l, x1: e.clientX - r.left + el.scrollLeft, y1: e.clientY - r.top + el.scrollTop });
      }
    };
    const loslassen = (e: MouseEvent) => {
      const el = scrollRef.current;
      if (ziehen.current) {
        ziehen.current = null;
        el?.classList.remove("ziehen");
      }
      if (lasso && el) {
        const x0 = Math.min(lasso.x0, lasso.x1);
        const y0 = Math.min(lasso.y0, lasso.y1);
        const b = Math.abs(lasso.x1 - lasso.x0);
        const h = Math.abs(lasso.y1 - lasso.y0);
        setLasso(null);
        const r = el.getBoundingClientRect();
        if (holen().werkzeug === "textbereich") {
          bereichAuswerten(x0, y0, b, h);
          werkzeugBenutzt();
          return;
        }
        if (b < 8 || h < 8) {
          // Klick ohne Aufziehen: eine Stufe vergrößern am Mauspunkt
          zoomAuf(zoom * (e.shiftKey ? 0.5 : 2), e.clientX - r.left, e.clientY - r.top);
        } else {
          const faktor = Math.min(el.clientWidth / b, el.clientHeight / h);
          // Anker = Lasso-Mitte, landet in Viewport-Mitte
          const mitteX = x0 + b / 2 - el.scrollLeft;
          const mitteY = y0 + h / 2 - el.scrollTop;
          ankerSetzen(mitteX, mitteY);
          if (ankerRef.current) {
            ankerRef.current.mx = el.clientWidth / 2;
            ankerRef.current.my = el.clientHeight / 2;
          }
          ansichtAendern(dokId, { zoom: zoomBegrenzen(zoom * faktor), zoomModus: "frei" });
        }
        werkzeugBenutzt();
      }
    };
    window.addEventListener("mousemove", bewegen);
    window.addEventListener("mouseup", loslassen);
    return () => {
      window.removeEventListener("mousemove", bewegen);
      window.removeEventListener("mouseup", loslassen);
    };
  }, [lasso, zoom, zoomAuf, ankerSetzen, dokId]);

  // Lupe: scharfer Ausschnitt in höherer Auflösung um den Mauszeiger
  const lupeAbbestellen = useRef<() => void>(() => undefined);
  const onMouseMove = (e: React.MouseEvent) => {
    if (werkzeug !== "lupe" || !layout || !dok || !ansicht) return;
    const el = scrollRef.current!;
    const r = el.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const cx = mx + el.scrollLeft;
    const cy = my + el.scrollTop;
    const box = layout.boxen.find((b) => cx >= b.x && cx <= b.x + b.b && cy >= b.y && cy <= b.y + b.h);
    if (!box) {
      setLupe(null);
      return;
    }
    const [bPt, hPt] = anzeigeGroesse(seiten[box.seite], ansicht.drehung);
    const stufe = renderStufe(zoom * PT_ZU_PX * lupeFaktor * dpr);
    const proCss = stufe / (zoom * PT_ZU_PX); // Gerätepixel (Lupe) pro CSS-px (Seite)
    const groesse = Math.round(LUPE * dpr);
    const W = Math.ceil(bPt * stufe);
    const H = Math.ceil(hPt * stufe);
    const mitteX = (cx - box.x) * proCss;
    const mitteY = (cy - box.y) * proCss;
    const raster = 16;
    const x = Math.max(0, Math.min(W - groesse, Math.round((mitteX - groesse / 2) / raster) * raster));
    const y = Math.max(0, Math.min(H - groesse, Math.round((mitteY - groesse / 2) / raster) * raster));
    const url = bildUrl({
      dokId,
      seite: box.seite,
      kennung: dok.kennungen[box.seite] ?? "",
      skala: stufe,
      drehung: ansicht.drehung,
      kachel: { x, y, b: Math.min(groesse, W), h: Math.min(groesse, H) },
    });
    const versatzX = (x - (mitteX - groesse / 2)) / dpr;
    const versatzY = (y - (mitteY - groesse / 2)) / dpr;
    setLupe((l) => ({ mx, my, bild: l?.bild ?? null, versatzX: l?.bild ? l.versatzX : versatzX, versatzY: l?.bild ? l.versatzY : versatzY }));
    lupeAbbestellen.current();
    lupeAbbestellen.current = anfordern(url, -1, (u) => u && setLupe((l) => l && { ...l, bild: u, versatzX, versatzY }));
  };
  useEffect(() => {
    if (werkzeug !== "lupe") setLupe(null);
  }, [werkzeug]);

  // ---------------------------------------------------- Tastatur
  useEffect(() => {
    const taste = (e: KeyboardEvent) => {
      const el = scrollRef.current;
      const ziel = e.target as HTMLElement;
      if (!el || ziel.closest("input, textarea, select, [contenteditable], .miniaturen")) return;
      if (holen().aktiv !== dokId || holen().dialog?.art === "ungespeichert") return;
      if (e.key === "Escape" && holen().werkzeug !== "hand") {
        setLasso(null);
        setzen({ werkzeug: "hand" });
        return;
      }
      const d = holen().dokumente.find((x) => x.id === dokId);
      if (!d || e.ctrlKey || e.altKey || e.metaKey) return;
      const fortlaufend = istFortlaufend(d.ansicht.modus);
      const zeilen = zeilenBilden(d.seitenanzahl, d.ansicht.modus);
      const zeilenIndex = zeilen.findIndex((z) => z.includes(d.ansicht.seite));
      const zuZeile = (i: number) => {
        const zeile = zeilen[Math.max(0, Math.min(zeilen.length - 1, i))];
        sprungRef.current = { seite: zeile[0] };
        if (d.ansicht.seite !== zeile[0]) ansichtAendern(dokId, { seite: zeile[0] });
        else setVp((v) => ({ ...v }));
      };
      switch (e.key) {
        case "PageDown":
          if (!fortlaufend || el.clientHeight >= (layout?.zeilen[zeilenIndex]?.h ?? 0)) {
            e.preventDefault();
            zuZeile(zeilenIndex + 1);
          }
          break;
        case "PageUp":
          if (!fortlaufend || el.clientHeight >= (layout?.zeilen[zeilenIndex]?.h ?? 0)) {
            e.preventDefault();
            zuZeile(zeilenIndex - 1);
          }
          break;
        case "Home":
          e.preventDefault();
          zuZeile(0);
          break;
        case "End":
          e.preventDefault();
          zuZeile(zeilen.length - 1);
          break;
        case "ArrowRight":
          if (el.scrollWidth <= el.clientWidth) {
            e.preventDefault();
            zuZeile(zeilenIndex + 1);
          }
          break;
        case "ArrowLeft":
          if (el.scrollWidth <= el.clientWidth) {
            e.preventDefault();
            zuZeile(zeilenIndex - 1);
          }
          break;
      }
    };
    window.addEventListener("keydown", taste);
    return () => window.removeEventListener("keydown", taste);
  }, [dokId, layout]);

  if (!dok || !ansicht || !layout) return null;

  // ------------------------------------------------ sichtbare Seiten
  const vorlauf = vp.h; // eine Bildschirmhöhe vor/nach dem sichtbaren Bereich vorladen
  const sichtbar: { box: SeitenBox; prio: number; bereich: { x0: number; y0: number; x1: number; y1: number } | null }[] = [];
  if (layout.boxen.length) {
    for (let i = ersteSichtbare(layout.boxen, vp.y - vorlauf); i < layout.boxen.length; i++) {
      const box = layout.boxen[i];
      if (box.y > vp.y + vp.h + vorlauf) break;
      const imBild = box.y < vp.y + vp.h && box.y + box.h > vp.y;
      const bereich = imBild
        ? {
            x0: Math.max(0, vp.x - box.x),
            y0: Math.max(0, vp.y - box.y),
            x1: Math.min(box.b, vp.x + vp.b - box.x),
            y1: Math.min(box.h, vp.y + vp.h - box.y),
          }
        : null;
      sichtbar.push({ box, prio: imBild ? 0 : 2, bereich: bereich && bereich.x1 > bereich.x0 ? bereich : null });
    }
  }

  const aktiverTreffer = suche.treffer[suche.aktiv];

  return (
    <div
      ref={scrollRef}
      className={`dokumentansicht werkzeug-${werkzeug}`}
      onScroll={onScroll}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseLeave={() => setLupe(null)}
      tabIndex={0}
      data-testid="dokumentansicht"
    >
      <div className="flaeche" style={{ width: layout.breite, height: layout.hoehe }}>
        {sichtbar.map(({ box, prio, bereich }) => {
          const [bPt, hPt] = anzeigeGroesse(seiten[box.seite], ansicht.drehung);
          const markierungen = suche.treffer
            .filter((t) => t.dokId === dokId && t.seite === box.seite)
            .map((t) => ({ r: t.rechteck, aktiv: t === aktiverTreffer }));
          const unsichereWoerter = unsicher?.[String(box.seite)] ?? [];
          return (
            <div key={box.seite} className="seite" style={{ left: box.x, top: box.y, width: box.b, height: box.h }}>
              <Seite
                dokId={dokId}
                seite={box.seite}
                kennung={dok.kennungen[box.seite] ?? ""}
                breitePt={bPt}
                hoehePt={hPt}
                b={box.b}
                h={box.h}
                drehung={ansicht.drehung}
                dpr={dpr}
                prioritaet={prio}
                sichtbar={bereich}
                markierungen={markierungen}
                unsicher={unsichereWoerter}
                ausblenden={ausblenden || undefined}
                ohne={bearbeitet?.seite === box.seite ? String(bearbeitet.id) : undefined}
              />
              <AnmerkungsEbene
                dokId={dokId}
                seite={box.seite}
                kennung={dok.kennungen[box.seite] ?? ""}
                b={box.b}
                h={box.h}
                drehung={ansicht.drehung}
                breitePt={seiten[box.seite].breite}
                hoehePt={seiten[box.seite].hoehe}
              />
            </div>
          );
        })}
        {lasso && (
          <div
            className="lasso"
            style={{
              left: Math.min(lasso.x0, lasso.x1),
              top: Math.min(lasso.y0, lasso.y1),
              width: Math.abs(lasso.x1 - lasso.x0),
              height: Math.abs(lasso.y1 - lasso.y0),
            }}
          />
        )}
      </div>
      {lupe && (
        <div
          className="lupe"
          style={{ left: vp.x + lupe.mx - LUPE / 2, top: vp.y + lupe.my - LUPE / 2, width: LUPE, height: LUPE }}
        >
          {lupe.bild && <img src={lupe.bild} alt="" style={{ left: lupe.versatzX, top: lupe.versatzY, width: LUPE, height: LUPE }} draggable={false} />}
        </div>
      )}
    </div>
  );
}
