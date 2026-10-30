// Einrichtung und Übersicht: Suche in den Einstellungen, einfacher Modus (nur das Wichtigste) und die
// Ersteinrichtung im Gespräch mit der Figur. Läuft in der Oberfläche; was die App dafür braucht, kommt über deps.

// Abschnitte, die im einfachen Modus verborgen sind (Überschrift ohne Zusätze). Alles andere bleibt sichtbar – so taucht
// Neues automatisch auf, und die Suche findet auch Verborgenes (dann werden alle Einstellungen gezeigt).
export const ADVANCED = new Set([
  'Lebendigkeit',
  'Hintergrund entfernen (freistellen)',
  'Mund & Augen',
  '2D-Figur aus mehreren Bildern',
  'Lebendiges Gesicht (automatisch)',
  'Bild-Figur leicht drehen (2,5D)',
  'Bewegungsbilder (flüssige Bewegung im Leerlauf)',
  '3D-Figur (VRM-VTuber)',
  '📖 Über mich erzählt',
  '🌱 Entwicklung',
  '📔 Tagebuch',
  '🤝 Gemeinsame Geschichte',
  '📌 Offene Themen',
  'Markierten Text bearbeiten – Strg+Alt+K',
  'Teilen',
  'Gespräch im Hintergrund',
  'Akku',
  '🎧 Headset',
  'Echtzeit-Gespräch',
  'Bildschirm fragen',
  'Schwebende Figur',
]);

const headText = (h) =>
  [...h.childNodes]
    .filter((n) => n.nodeType === 3 || (n.nodeType === 1 && !n.classList.contains('hint') && !n.classList.contains('beta-badge')))
    .map((n) => n.textContent)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Abschnitte markieren: jedes oberste Element eines Reiters bekommt data-sec (Überschrift seines Abschnitts); was zu
 * einem Abschnitt aus ADVANCED gehört, die Klasse set-adv.
 */
export function markSections(drawer, advanced = ADVANCED) {
  for (const tab of drawer.querySelectorAll('.tab[data-tab]')) {
    let sec = '';
    for (const el of tab.children) {
      if (el.tagName === 'H3') sec = headText(el);
      const own = el.tagName !== 'H3' ? el.querySelector('h3') : null;
      const name = own ? headText(own) : sec;
      el.dataset.sec = name;
      el.classList.toggle('set-adv', advanced.has(name));
      if (own) sec = ''; // ein eigener Block (mit Überschrift) beendet den Abschnitt davor
    }
  }
}

/** Suchindex über alle Einstellungen: Beschriftungen, Überschriften, Knöpfe, Hinweise. */
export function indexSettings(drawer) {
  const out = [];
  const tabName = (key) => drawer.querySelector(`.tabs [data-tab="${key}"]`)?.textContent?.trim() ?? key;
  for (const tab of drawer.querySelectorAll('.tab[data-tab]')) {
    const key = tab.dataset.tab;
    for (const el of tab.querySelectorAll('h3, label, button, p.hint')) {
      const text = (el.tagName === 'H3' ? headText(el) : el.textContent).replace(/\s+/g, ' ').trim();
      if (text.length < 3) continue;
      const top = [...tab.children].find((c) => c === el || c.contains(el));
      out.push({ tab: key, tabName: tabName(key), sec: top?.dataset.sec || '', text: text.slice(0, 160), el, hint: el.tagName === 'P' });
    }
  }
  return out;
}

const fold = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss');

/** Einstellungen zu einem Suchbegriff; nur, was in diesem Bereich/auf diesem Gerät überhaupt da ist. */
export function searchSettings(index, q, k = 12, visible = (el) => !el.closest('[hidden]:not(.tab)') && !el.closest('.mobile-only-hidden')) {
  const words = fold(q).match(/[a-z0-9]{2,}/g) ?? [];
  if (!words.length) return [];
  const seen = new Set();
  return index
    .map((e) => {
      const t = fold(e.text);
      const s = fold(`${e.sec} ${e.tabName}`);
      const score = words.reduce((a, w) => a + (t.includes(w) ? (e.hint ? 1 : 3) : s.includes(w) ? 1 : 0), 0);
      return [e, score, words.every((w) => t.includes(w) || s.includes(w))];
    })
    .filter(([e, score, all]) => score > 0 && all && visible(e.el))
    .sort((a, b) => b[1] - a[1])
    .map(([e]) => e)
    .filter((e) => {
      const key = `${e.tab}|${e.sec}|${e.text}`;
      return !seen.has(key) && seen.add(key);
    })
    .slice(0, k);
}

// ---------------------------------------------------------------- Ersteinrichtung
/**
 * Schritte der Ersteinrichtung. deps: { persona, rename(name), userName(name), mobile, local, providers: [[id, name]],
 * provider, setProvider(id), setKey(id, key), keyStatus(), speak(text), testMic(), healthRows(), overview(), done() }
 */
export function onboardingSteps(deps) {
  const steps = [
    {
      id: 'hallo',
      title: 'Hallo!',
      say: (d) => `Hallo! Ich bin ${d.persona().name || 'deine neue Begleitung'}. Lass uns kurz alles einrichten – das dauert zwei Minuten.`,
      fields: [
        { id: 'obUser', label: 'Wie soll ich dich nennen?', type: 'text', placeholder: 'Dein Vorname' },
        { id: 'obName', label: 'Wie soll ich heißen?', type: 'text', value: (d) => d.persona().name || '' },
      ],
      apply: (d, v) => {
        if (v.obName?.trim()) d.rename(v.obName.trim());
        if (v.obUser?.trim()) d.userName(v.obUser.trim());
      },
    },
  ];
  if (!deps.local)
    steps.push({
      id: 'denken',
      title: 'Womit soll ich denken?',
      say: () => 'Für meine Antworten brauche ich einen KI-Dienst. Den Schlüssel gibst du nur hier ein – er wird verschlüsselt auf dem Gerät gespeichert.',
      fields: [
        { id: 'obProvider', label: 'KI-Anbieter', type: 'select', options: (d) => d.providers, value: (d) => d.provider() },
        { id: 'obKey', label: 'API-Schlüssel (bleibt verschlüsselt auf diesem Gerät, leer lassen = später)', type: 'password', placeholder: 'sk-…' },
      ],
      apply: async (d, v) => {
        if (v.obProvider) d.setProvider(v.obProvider);
        if (v.obKey?.trim()) await d.setKey(v.obProvider, v.obKey.trim());
      },
    });
  steps.push({
    id: 'hoeren',
    title: 'Hören und sprechen',
    say: () => 'Tipp auf „Mikrofon freigeben“, dann kannst du einfach mit mir reden. Und so klinge ich.',
    buttons: [
      ['🎤 Mikrofon freigeben', (d) => d.testMic()],
      ['🔊 Stimme anhören', (d) => d.speak(`So klinge ich. Wenn dir meine Stimme nicht gefällt, findest du andere unter Einstellungen, Sprache.`)],
    ],
  });
  if (deps.mobile)
    steps.push({
      id: 'freigaben',
      title: 'Freigaben auf dem Handy',
      say: () => 'Damit Erinnerungen ankommen und ich auch im Hintergrund helfen kann, braucht es ein paar Freigaben. Tipp einfach auf die Knöpfe.',
      health: true,
    });
  steps.push({
    id: 'koennen',
    title: 'Das kann ich',
    say: () => 'Fertig! Hier ein paar Ideen, was du mich fragen kannst. Und wenn du mal nicht weiterweißt: frag mich einfach, was ich kann.',
    overview: true,
  });
  return steps;
}

/** Ersteinrichtung als Fenster über der App; liefert ein Promise, das nach „Fertig“ oder „Später“ erfüllt ist. */
export function runOnboarding(deps) {
  const steps = onboardingSteps(deps);
  document.getElementById('onboard')?.remove();
  const box = document.createElement('div');
  box.id = 'onboard';
  box.className = 'onboard';
  box.setAttribute('role', 'dialog');
  document.body.append(box);
  let i = 0;
  return new Promise((resolve) => {
    const finish = (how) => {
      box.remove();
      deps.done(how);
      resolve(how);
    };
    const render = async () => {
      const st = steps[i];
      box.replaceChildren();
      const card = document.createElement('div');
      card.className = 'onboard-card';
      const head = document.createElement('div');
      head.className = 'onboard-head';
      head.textContent = `${i + 1} / ${steps.length} · ${st.title}`;
      const say = document.createElement('p');
      say.className = 'onboard-say';
      say.textContent = st.say(deps);
      card.append(head, say);
      const inputs = {};
      for (const f of st.fields ?? []) {
        const lab = document.createElement('label');
        lab.textContent = f.label;
        const inp = document.createElement(f.type === 'select' ? 'select' : 'input');
        inp.id = f.id;
        if (f.type === 'select') for (const [v, n] of f.options(deps)) inp.append(new Option(n, v));
        else {
          inp.type = f.type;
          inp.placeholder = f.placeholder ?? '';
          if (f.type === 'password') inp.autocomplete = 'off';
        }
        const val = typeof f.value === 'function' ? f.value(deps) : f.value;
        if (val != null) inp.value = val;
        lab.append(inp);
        card.append(lab);
        inputs[f.id] = inp;
      }
      for (const [label, fn] of st.buttons ?? []) {
        const b = document.createElement('button');
        b.textContent = label;
        b.onclick = () => fn(deps);
        card.append(b);
      }
      if (st.health) {
        const list = document.createElement('div');
        list.className = 'onboard-health';
        card.append(list);
        const rows = await deps.healthRows().catch(() => []);
        for (const r of rows.filter((x) => x.fix || x.ok !== 'ok').slice(0, 8)) {
          const row = document.createElement('div');
          row.textContent = `${r.ok === 'ok' ? '✅' : r.ok === 'bad' ? '⛔' : '⚠️'} ${r.name}: ${r.info}`;
          if (r.fix) {
            const b = document.createElement('button');
            b.textContent = r.fix[0];
            b.onclick = () => r.fix[1]();
            row.append(' ', b);
          }
          list.append(row);
        }
        if (!list.children.length) list.textContent = '✅ Alles freigegeben.';
      }
      if (st.overview) {
        const ul = document.createElement('ul');
        ul.className = 'onboard-ideas';
        for (const [gruppe, titel] of Object.entries(deps.overview())) {
          const li = document.createElement('li');
          li.textContent = `${gruppe}: ${titel.slice(0, 4).join(', ')}`;
          ul.append(li);
        }
        card.append(ul);
      }
      const nav = document.createElement('div');
      nav.className = 'row onboard-nav';
      const later = document.createElement('button');
      later.textContent = 'Später';
      later.onclick = () => finish('spaeter');
      const next = document.createElement('button');
      next.className = 'primary';
      next.id = 'obNext';
      next.textContent = i === steps.length - 1 ? 'Fertig' : 'Weiter';
      next.onclick = async () => {
        next.disabled = true;
        const v = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
        try {
          await st.apply?.(deps, v);
        } catch (e) {
          say.textContent = `Das hat nicht geklappt: ${e.message}`;
          next.disabled = false;
          return;
        }
        if (inputs.obKey) inputs.obKey.value = '';
        if (i === steps.length - 1) return finish('fertig');
        i++;
        render();
      };
      nav.append(later, next);
      card.append(nav);
      box.append(card);
      // gesprochen wird erst nach dem ersten Antippen: vorher darf der Browser keinen Ton abspielen, und beim Start
      // soll nichts Großes (Stimme) geladen werden
      if (i > 0) deps.speak(say.textContent);
    };
    render();
  });
}
