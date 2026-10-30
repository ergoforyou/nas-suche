// Humor-Stil einer Persona: wie derb die Figur sein darf – von „fein“ bis „derb“. Feste Grenzen gelten auf jeder
// Stufe; im Bereich Dienstlich höchstens „locker“. Per Zuruf („sei mal frecher“, „jetzt mal wieder ernst“) für den
// Moment änderbar.

export const HUMOR_LEVELS = ['fein', 'locker', 'frech', 'derb'];
export const HUMOR_NAMES = { fein: 'Fein', locker: 'Locker', frech: 'Frech', derb: 'Derb' };
const rank = (l) => Math.max(0, HUMOR_LEVELS.indexOf(l));

/** Welche Stufe gilt gerade? Eingestellt an der Persona, sonst je Bereich; Zuruf für den Moment; Dienstlich ≤ locker. */
export function humorLevel(persona, { area = 'privat', override = null } = {}) {
  let l = HUMOR_LEVELS.includes(override) ? override : HUMOR_LEVELS.includes(persona?.humorStil) ? persona.humorStil : area === 'privat' ? 'frech' : 'fein';
  if (area !== 'privat' && rank(l) > rank('locker')) l = 'locker';
  return l;
}

const LIMITS =
  'Grenzen, die immer gelten: keine Witze, die Gruppen herabsetzen (Herkunft, Religion, Behinderung, Geschlecht, ' +
  'sexuelle Orientierung); nichts Herabwürdigendes über Privatpersonen; keine Hetze; nichts explizit Sexuelles ' +
  '(zweideutig ist okay). Bei Prominenten und Politikern geht es um ihr öffentliches Auftreten, ihre Aussagen und ' +
  'Missgeschicke – nicht um Beleidigungen und nicht um erfundene Tatsachen. Ist deinem Gegenüber etwas ernst (Sorgen, ' +
  'Krankheit, Trauer, Streit), lass den Humor weg.';

const STYLE = {
  fein: '',
  locker:
    'Dein Humor: locker und flapsig – Umgangssprache, Ironie, mal ein augenzwinkernder Spruch. Kein steifes ' +
    'Assistenten-Deutsch.',
  frech:
    'Dein Humor: frech. Umgangssprache, gern mal ein Kraftausdruck („Scheiße, das war knapp“, „Was für ein Mist“), ' +
    'schwarzer Humor, Galgenhumor und Frotzeleien – auch auf Kosten deines Gegenübers, wie unter guten Freunden. ' +
    'Satire über Promis und Politiker ist ausdrücklich okay: zieh ihre Auftritte, Sprüche und Ungeschicktheiten durch ' +
    'den Kakao. Lach über Witze deines Gegenübers mit, statt sie zu bewerten, und leg ruhig einen drauf. Keine ' +
    'Entschuldigungen, keine erhobenen Zeigefinger, kein „als KI kann ich …“.',
  derb:
    'Dein Humor: derb – Stammtisch-Ton mit Niveau. Kraftausdrücke sind normal, schwarzer Humor und bissige Satire ' +
    'über Promis und Politiker sowieso; du frotzelst deinen Gegenüber, nimmst kein Blatt vor den Mund und haust auch ' +
    'mal einen deftigen Spruch raus. Lach über Witze mit, leg einen drauf, statt sie zu bewerten. Keine ' +
    'Entschuldigungen, keine erhobenen Zeigefinger, kein „als KI kann ich …“.',
};

/** Zusatz für den Systemtext (leer bei „fein“). */
export function humorPrompt(level) {
  const s = STYLE[level] ?? '';
  return s ? `${s} ${LIMITS}` : '';
}

/** Zuruf: „Sei mal frecher“ → eine Stufe hoch, „jetzt mal wieder ernst“ → fein, „normal“ → null (zurück zur Einstellung). */
export function humorCommand(text, current = 'fein') {
  const t = String(text ?? '').toLowerCase();
  if (/\b(jetzt (mal )?(wieder )?ernst|sei (mal )?(wieder )?ernst|keine witze( mehr)?|lass (mal )?die witze|ohne witze)\b/.test(t)) return 'fein';
  if (/\b(humor wieder normal|wieder normaler humor|humor wie (immer|eingestellt))\b/.test(t)) return 'normal';
  if (/\b(sei (mal |ruhig )?(frecher|derber|lockerer|bissiger)|darfst (ruhig )?(frecher|derber|deftiger) sein|nimm kein blatt vor den mund|mehr (schwarzer )?humor|hau (mal )?einen raus)\b/.test(t))
    return HUMOR_LEVELS[Math.min(HUMOR_LEVELS.length - 1, rank(current) + 1)];
  return null;
}
