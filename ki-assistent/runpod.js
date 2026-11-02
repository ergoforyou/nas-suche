// RunPod steuern (Versuchsreihe „Eigener Server“): Pod starten, stoppen und Zustand abfragen – über die REST-Schnittstelle,
// ersatzweise GraphQL. Läuft am PC im Hauptprozess und am Handy in der App (fetchFn = Anfragen ohne Browser-Sperren).

async function runpodCtl({ action, podId, key, fetchFn }) {
  if (!key) throw new Error('Kein RunPod-Schlüssel hinterlegt (⚙ → Verbindung → Eigener Server)');
  const id = String(podId ?? '').trim();
  if (!/^[a-z0-9]{6,}$/i.test(id)) throw new Error('Pod-ID fehlt oder ist ungültig (steht in der RunPod-Übersicht beim Pod)');
  const auth = { Authorization: `Bearer ${key}` };
  const rest = async (method, path) => {
    const r = await fetchFn(`https://rest.runpod.io/v1/pods/${id}${path}`, { method, headers: { ...auth, 'Content-Type': 'application/json' } });
    const text = await r.text();
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {}
    return { status: r.status, ok: r.ok, j, text };
  };
  if (action === 'status') {
    const r = await rest('GET', '');
    if (r.status === 401 || r.status === 403) throw new Error('RunPod-Schlüssel ungültig oder ohne Rechte');
    if (r.status === 404) throw new Error('Pod nicht gefunden – Pod-ID prüfen');
    if (!r.ok) throw new Error(`RunPod antwortet mit ${r.status}`);
    const p = r.j ?? {};
    return { status: p.desiredStatus ?? p.status ?? 'unbekannt', name: p.name, gpu: p.machine?.gpuTypeId ?? p.gpu?.id ?? '', kostenProStunde: p.costPerHr ?? p.adjustedCostPerHr ?? null };
  }
  if (action === 'start' || action === 'stop') {
    let r = await rest('POST', action === 'start' ? '/start' : '/stop');
    if (r.ok) return { ok: true };
    // ältere Schnittstelle (GraphQL)
    const q = action === 'start' ? `mutation { podResume(input: {podId: "${id}", gpuCount: 1}) { id desiredStatus } }` : `mutation { podStop(input: {podId: "${id}"}) { id desiredStatus } }`;
    const g = await fetchFn('https://api.runpod.io/graphql', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) });
    const gj = await g.json().catch(() => null);
    if (g.ok && !gj?.errors?.length) return { ok: true };
    throw new Error(`RunPod: ${action === 'start' ? 'Starten' : 'Stoppen'} ging nicht (${r.status}${gj?.errors?.[0]?.message ? `, ${gj.errors[0].message}` : ''})`);
  }
  throw new Error('unbekannte Aktion');
}

module.exports = { runpodCtl };
