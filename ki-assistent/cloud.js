// Anbindung der Cloud-Sprachmodelle (Claude über das Anthropic-SDK, ChatGPT über das OpenAI-SDK).
// Ohne Electron-Abhängigkeiten, damit es sich eigenständig testen lässt.

/** Fehlermeldungen der Cloud-SDKs verständlich machen (beide SDKs haben dieselben Fehlerklassen). */
function friendlyCloudError(err, name, SDK) {
  if (SDK && err instanceof SDK.AuthenticationError) return `${name}: API-Schlüssel ungültig oder fehlt (⚙ → Verbindung).`;
  if (SDK && err instanceof SDK.PermissionDeniedError) return `${name}: Zugriff verweigert – keine Berechtigung für dieses Modell.`;
  if (SDK && err instanceof SDK.NotFoundError) return `${name}: Modell nicht gefunden – bitte ein anderes Modell wählen.`;
  if (SDK && err instanceof SDK.RateLimitError) return `${name}: Zu viele Anfragen oder Guthaben aufgebraucht – kurz warten bzw. Konto prüfen.`;
  if (SDK && err instanceof SDK.InternalServerError) return `${name}: Dienst vorübergehend gestört – bitte gleich noch einmal versuchen.`;
  if (SDK && err instanceof SDK.APIConnectionError) {
    // Ursache mit angeben (z. B. Zertifikatsfehler durch Virenscanner, Proxy, Zeitüberschreitung)
    const cause = err.cause?.code || err.cause?.message || (err instanceof SDK.APIConnectionTimeoutError ? 'Zeitüberschreitung' : '');
    return `${name}: Keine Verbindung zum Dienst${cause ? ` (${String(cause).slice(0, 160)})` : ''}. Internet, Proxy oder Virenscanner prüfen.`;
  }
  return `${name}: ${err?.message ?? err}`;
}

// Läuft sowohl im Electron-Hauptprozess (Node) als auch in der Android-App (Browser): darum keine Node-Module.
const toBase64 = (bytes) => {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
};
const toText = (bytes) => new TextDecoder().decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
const baseName = (p) => String(p).split(/[\\/]/).pop();

// Anhänge in Claude-Inhaltsblöcke umwandeln (PDF als Dokument, Bilder als Bild, Text direkt).
// Office-Dateien (Excel, Word, PowerPoint …) landen über die Files-API im Arbeitsbereich von Claude.
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
function attachmentBlocks(attachments, uploaded = {}) {
  const blocks = [];
  for (const a of attachments ?? []) {
    if (!a?.data) {
      blocks.push({ type: 'text', text: `[Anhang „${a?.name}“ ist nicht mehr verfügbar.]` });
      continue;
    }
    const b64 = () => toBase64(a.data);
    if (a.mime === 'application/pdf') {
      blocks.push({ type: 'document', title: a.name, source: { type: 'base64', media_type: 'application/pdf', data: b64() } });
    } else if (IMAGE_TYPES.includes(a.mime)) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data: b64() } });
    } else if (a.text) {
      blocks.push({ type: 'document', title: a.name, source: { type: 'text', media_type: 'text/plain', data: toText(a.data) } });
    } else if (uploaded[a.key]) {
      blocks.push({ type: 'container_upload', file_id: uploaded[a.key] });
      blocks.push({ type: 'text', text: `[Datei „${a.name}“ liegt im Arbeitsbereich.]` });
    } else {
      blocks.push({ type: 'text', text: `[Anhang „${a.name}“ kann ohne „Dateien erstellen und bearbeiten“ nicht gelesen werden.]` });
    }
  }
  return blocks;
}

// Claude: Systemprompt getrennt, Nachrichten müssen mit "user" beginnen und abwechseln
/**
 * Nachrichten ins Claude-Format. Prompt-Caching (spart bei jeder Folgefrage den Großteil der Eingabekosten):
 * - Systemnachricht mit cache: true = gleichbleibender Teil (Persona, Regeln, App-Wissen) – wird zwischengespeichert
 * - Systemnachricht mit ctx: true = wechselnder Zusammenhang (Uhrzeit, Ort, passende Auszüge) – kommt vor die
 *   aktuelle Frage statt in den Systemtext, sonst wäre der Zwischenspeicher bei jeder Frage hinfällig
 * - der Verlauf bis zur letzten Antwort wird ebenfalls zwischengespeichert
 */
function toClaudeMessages(messages, uploaded) {
  let system = '';
  let cache = false;
  let ctx = '';
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') {
      if (m.ctx) {
        ctx += (ctx ? '\n\n' : '') + m.content;
        continue;
      }
      if (m.cache) cache = true;
      system += (system ? '\n\n' : '') + m.content;
      continue;
    }
    // frühere Werkzeugaufrufe der App (gespeichert, notiert …) als echte Aufrufe zeigen – sonst sieht Claude im Verlauf
    // nur „Ich habe es gespeichert“ und behauptet das später, ohne das Werkzeug aufzurufen
    if (m.role === 'assistant' && Array.isArray(m.tools) && m.tools.length) {
      const ids = m.tools.map((_, i) => `toolu_verlauf_${out.length}_${i}`);
      const last = out.at(-1);
      const uses = m.tools.map((t, i) => ({ type: 'tool_use', id: ids[i], name: t.name, input: t.input && typeof t.input === 'object' ? t.input : {} }));
      if (last?.role === 'assistant') last.content = [...(typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content), ...uses];
      else out.push({ role: 'assistant', content: uses });
      out.push({
        role: 'user',
        content: m.tools.map((t, i) => ({ type: 'tool_result', tool_use_id: ids[i], content: String(t.result ?? 'erledigt'), ...(t.error ? { is_error: true } : {}) })),
      });
      if (m.content) out.push({ role: 'assistant', content: m.content });
      continue;
    }
    const extra = m.role === 'user' ? attachmentBlocks(m.attachments, uploaded) : [];
    const content = extra.length ? [...extra, { type: 'text', text: m.content || '(siehe Anhang)' }] : m.content;
    const last = out.at(-1);
    if (last && last.role === m.role) {
      const asBlocks = (c) => (typeof c === 'string' ? [{ type: 'text', text: c }] : c);
      last.content = typeof last.content === 'string' && typeof content === 'string'
        ? last.content + '\n\n' + content
        : [...asBlocks(last.content), ...asBlocks(content)];
    } else out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  const blocks = (c) => (typeof c === 'string' ? [{ type: 'text', text: c }] : [...c]);
  if (ctx) {
    const u = out.findLast((m) => m.role === 'user');
    if (u) u.content = [{ type: 'text', text: `<kontext>\n${ctx}\n</kontext>` }, ...blocks(u.content)];
    else system += (system ? '\n\n' : '') + ctx;
  }
  if (!cache || !system) return { system, messages: out };
  // Merkpunkte: Ende des gleichbleibenden Systemtexts (mit den Werkzeugen davor) und letzte Antwort im Verlauf
  const a = out.findLast((m) => m.role === 'assistant');
  if (a) {
    const b = blocks(a.content).filter((x) => x.type !== 'text' || x.text);
    if (b.length) {
      b[b.length - 1] = { ...b[b.length - 1], cache_control: { type: 'ephemeral' } };
      a.content = b;
    }
  }
  return { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], messages: out };
}

// Werkzeuge, die Claude bei Anthropic selbst ausführt (nichts davon läuft auf diesem Rechner)
const OFFICE_SKILLS = ['xlsx', 'pptx', 'docx', 'pdf'];
function claudeTools(model, { web, files }) {
  const tools = [];
  if (web) {
    // Dynamische Filterung (2026er Version) gibt es nicht für Haiku; mit Code-Ausführung die einfache
    // Version nehmen, damit Claude nicht zwei Arbeitsbereiche gleichzeitig hat.
    const dynamic = !files && !/haiku/.test(model);
    tools.push(
      // höchstens 3 Suchen und 3 Seitenabrufe pro Antwort (jede Suche kostet; mehr bringt selten mehr)
      { type: dynamic ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: 3 },
      { type: dynamic ? 'web_fetch_20260209' : 'web_fetch_20250910', name: 'web_fetch', max_uses: 3 },
    );
  }
  if (files) tools.push({ type: 'code_execution_20260521', name: 'code_execution' });
  return tools;
}

const TOOL_STATUS = {
  web_search: '🔎 sucht im Internet …',
  web_fetch: '🌐 liest eine Webseite …',
  code_execution: '🛠 arbeitet an einer Datei …',
  bash_code_execution: '🛠 arbeitet an einer Datei …',
  text_editor_code_execution: '🛠 arbeitet an einer Datei …',
};

const WEB_ERRORS = {
  max_uses_exceeded: 'zu viele Suchen in einer Antwort',
  too_many_requests: 'zu viele Anfragen, kurz warten',
  unavailable: 'Suchdienst gerade nicht erreichbar',
  query_too_long: 'Suchanfrage zu lang',
  invalid_input: 'ungültige Anfrage',
  url_not_accessible: 'Seite nicht erreichbar',
  url_not_allowed: 'Seite gesperrt',
};

/** Datei-IDs aller Dateien, die Claude im Arbeitsbereich erzeugt hat. */
function createdFileIds(content) {
  const ids = [];
  for (const b of content) {
    const inner = b.content;
    if (!inner || typeof inner !== 'object') continue;
    for (const c of Array.isArray(inner.content) ? inner.content : []) {
      if (c?.file_id && !ids.includes(c.file_id)) ids.push(c.file_id);
    }
  }
  return ids;
}

/** Quellen (Web-Zitate) aus den Textblöcken sammeln. */
function citedSources(content) {
  const seen = new Map();
  for (const b of content) {
    if (b.type !== 'text') continue;
    for (const c of b.citations ?? []) {
      if (c.url && !seen.has(c.url)) seen.set(c.url, c.title || c.url);
    }
  }
  return [...seen].map(([url, title]) => ({ url, title }));
}

/**
 * Chat mit Claude. Optional mit Internetsuche (web) und Dateierstellung (files).
 * ctx.containers: Map Gesprächs-ID -> Arbeitsbereich, damit Claude später an derselben Datei weiterarbeiten kann.
 * ctx.saveFile(name, bytes): speichert eine von Claude erzeugte Datei lokal, gibt den Pfad zurück.
 */
async function chatAnthropic(client, { model, messages, effort, web, files, conversation }, send, signal, ctx = {}) {
  // Office-Anhänge einmalig hochladen (nur mit Dateifunktion; PDFs/Bilder gehen direkt mit)
  const uploaded = {};
  if (files) {
    for (const m of messages) {
      for (const a of m.attachments ?? []) {
        if (!a?.data || a.text || a.mime === 'application/pdf' || IMAGE_TYPES.includes(a.mime)) continue;
        const key = a.key ?? a.name;
        if (ctx.uploads?.has(key)) {
          uploaded[key] = ctx.uploads.get(key);
          continue;
        }
        const { toFile } = require('@anthropic-ai/sdk');
        const meta = await client.files.upload({ file: await toFile(new Uint8Array(a.data), a.name) }, { signal });
        uploaded[key] = meta.id;
        ctx.uploads?.set(key, meta.id);
      }
    }
  }
  const { system, messages: msgs } = toClaudeMessages(messages, uploaded);
  // eigene Werkzeuge der App (z. B. Google-Kalender): ctx.clientTools = { defs, run(name, input), status }
  const own = ctx.clientTools;
  const tools = [
    ...claudeTools(model, { web, files }),
    ...(own?.defs ?? []).map((t) => ({ ...t, eager_input_streaming: true })),
  ];
  const betas = [];
  if (files) betas.push('code-execution-2025-08-25');
  // Bei Sonnet/Opus 5.5: falls ein Sicherheitsfilter ablehnt, übernimmt automatisch ein passendes Modell
  const withFallback = /^claude-(opus|sonnet)-5-5$/.test(model);
  if (withFallback) betas.push('server-side-fallback-2026-07-01');
  const containerId = files && conversation ? ctx.containers?.get(conversation) : null;

  const params = {
    model,
    max_tokens: 16000,
    messages: msgs,
    ...(system ? { system } : {}),
    // Denktiefe: "low" antwortet am schnellsten (wichtig für Sprachausgabe)
    output_config: { effort: effort || 'low' },
    // „niedrig“ = für Sprache optimiert: Denkphase vor der Antwort abschalten (spart oft 1–3 s bis zum ersten Wort).
    // Haiku: disabled; Sonnet 5.5: between_tools; Opus 5.5 lässt sich nicht abschalten.
    ...((effort || 'low') === 'low' && /haiku/.test(model) ? { thinking: { type: 'disabled' } } : {}),
    ...((effort || 'low') === 'low' && /sonnet-5-5/.test(model) ? { thinking: { type: 'between_tools' } } : {}),
    ...(tools.length ? { tools } : {}),
    ...(files ? { container: { ...(containerId ? { id: containerId } : {}), skills: OFFICE_SKILLS.map((id) => ({ type: 'anthropic', skill_id: id, version: 'latest' })) } } : {}),
    ...(withFallback ? { fallbacks: 'default' } : {}),
  };
  const open = (p) => (betas.length ? client.beta.messages.stream({ ...p, betas }, { signal }) : client.messages.stream(p, { signal }));

  const all = [];
  let wroteText = false;
  let final;
  // Verbrauch über alle Runden zusammenzählen (für den Kostenzähler)
  const use = { kind: 'chat', provider: 'anthropic', model, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, searches: 0 };
  const sendUse = () => send('usage', use);
  // Serverwerkzeuge können pausieren (pause_turn) – dann mit dem bisherigen Verlauf fortsetzen.
  // Eigene Werkzeuge (tool_use): hier ausführen und das Ergebnis zurückgeben.
  for (let round = 0; round < 10; round++) {
    const stream = open(params);
    let sep = false;
    for await (const ev of stream) {
      if (ev.type === 'content_block_start') {
        const b = ev.content_block;
        if (b.type === 'server_tool_use' && TOOL_STATUS[b.name]) send('status', TOOL_STATUS[b.name]);
        if (b.type === 'tool_use' && own?.status?.[b.name]) send('status', own.status[b.name]);
        // Suche oder Seitenabruf bei Anthropic fehlgeschlagen: sichtbar machen statt still „nicht abrufbar“
        const err = /_tool_result$/.test(b.type) && /error/.test(b.content?.type ?? '') ? b.content.error_code : null;
        if (err) send('status', `${b.type.startsWith('web_fetch') ? 'Seitenabruf' : 'Internetsuche'} fehlgeschlagen: ${WEB_ERRORS[err] ?? err}`);
        if (b.type === 'text' && wroteText) sep = true;
      } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        if (sep) {
          sep = false;
          send('delta', '\n\n');
        }
        send('delta', ev.delta.text);
        wroteText = true;
      }
    }
    final = await stream.finalMessage();
    all.push(...final.content);
    const u = final.usage ?? {};
    use.in += u.input_tokens ?? 0;
    use.out += u.output_tokens ?? 0;
    use.cacheRead += u.cache_read_input_tokens ?? 0;
    use.cacheWrite += u.cache_creation_input_tokens ?? 0;
    use.searches += u.server_tool_use?.web_search_requests ?? 0;
    // bei automatischer Umleitung auf ein anderes Claude-Modell zählt das tatsächlich genutzte
    if (/^claude-/.test(final.model ?? '')) use.model = final.model;
    if (final.container?.id && conversation) ctx.containers?.set(conversation, final.container.id);
    if (final.stop_reason === 'tool_use' && own) {
      const results = [];
      for (const b of final.content) {
        if (b.type !== 'tool_use') continue;
        try {
          // Eingaben prüfen: beim Streamen kann eine Eingabe unvollständig ankommen
          if (!b.input || typeof b.input !== 'object') throw new Error('Eingabe unvollständig');
          const out = await own.run(b.name, b.input);
          results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out) });
        } catch (err) {
          results.push({ type: 'tool_result', tool_use_id: b.id, content: `Fehler: ${err.message}`, is_error: true });
        }
      }
      params.messages = [...params.messages, { role: 'assistant', content: final.content }, { role: 'user', content: results }];
      if (final.container?.id) params.container = { ...params.container, id: final.container.id };
      continue;
    }
    if (final.stop_reason !== 'pause_turn') break;
    params.messages = [...params.messages, { role: 'assistant', content: final.content }];
    if (final.container?.id) params.container = { ...params.container, id: final.container.id };
  }
  sendUse();
  if (final.stop_reason === 'refusal') {
    send('error', 'Claude hat diese Anfrage abgelehnt. Bitte anders formulieren.');
    return;
  }
  const sources = citedSources(all);
  if (sources.length) send('sources', sources);
  if (files && ctx.saveFile) {
    for (const id of createdFileIds(all)) {
      try {
        const meta = await client.files.retrieveMetadata(id, {}, { signal });
        const res = await client.files.download(id, {}, { signal });
        const path = await ctx.saveFile(meta.filename, new Uint8Array(await res.arrayBuffer()));
        send('file', { name: baseName(path), path });
      } catch (err) {
        send('status', `Datei konnte nicht geladen werden: ${err.message}`);
      }
    }
  }
  send('done');
}

async function chatOpenAI(client, { model, messages, effort }, send, signal, ctx = {}) {
  const own = ctx.clientTools;
  const params = {
    model,
    messages: messages.map(({ role, content }) => ({ role, content })),
    stream: true,
    stream_options: { include_usage: true },
    ...(own?.defs?.length
      ? { tools: own.defs.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) }
      : {}),
  };
  // Denkende Modelle (GPT-5.x, o-Reihe): für flüssiges Sprechen nur kurz nachdenken lassen
  let reasoning = /^(gpt-5|o\d)/i.test(model) ? effort || 'low' : null;
  const open = async () => {
    try {
      return await client.chat.completions.create(reasoning ? { ...params, reasoning_effort: reasoning } : params, { signal });
    } catch (err) {
      // Modell kennt die Einstellung nicht (oder diesen Wert nicht): ohne sie erneut versuchen
      if (!reasoning || err?.status !== 400 || !/reasoning/i.test(String(err?.message))) throw err;
      reasoning = null;
      return client.chat.completions.create(params, { signal });
    }
  };
  const use = { kind: 'chat', provider: 'openai', model, in: 0, out: 0, cacheRead: 0 };
  for (let round = 0; round < 8; round++) {
    const stream = await open();
    const calls = [];
    let text = '';
    for await (const chunk of stream) {
      if (chunk.usage) {
        const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        use.in += (chunk.usage.prompt_tokens ?? 0) - cached;
        use.cacheRead += cached;
        use.out += chunk.usage.completion_tokens ?? 0;
      }
      const d = chunk.choices?.[0]?.delta;
      if (d?.content) {
        text += d.content;
        send('delta', d.content);
      }
      for (const tc of d?.tool_calls ?? []) {
        const c = (calls[tc.index] ??= { id: '', name: '', args: '' });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
      }
    }
    if (!calls.length || !own) break;
    // Werkzeuge ausführen und das Ergebnis zurückgeben, dann weiter antworten lassen
    params.messages.push({
      role: 'assistant',
      content: text || null,
      tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })),
    });
    for (const c of calls) {
      if (own.status?.[c.name]) send('status', own.status[c.name]);
      let content;
      try {
        content = JSON.stringify(await own.run(c.name, JSON.parse(c.args || '{}')));
      } catch (err) {
        content = `Fehler: ${err.message}`;
      }
      params.messages.push({ role: 'tool', tool_call_id: c.id, content });
    }
    if (text) send('delta', '\n\n');
  }
  send('usage', use);
  send('done');
}

/** Aufnahme (Float32, 16 kHz, mono) als WAV-Datei – für die Cloud-Spracherkennung. */
function toWav(samples, rate = 16000) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Uint8Array(buf);
}

/**
 * Spracherkennung in der Cloud (OpenAI). Läuft auf jedem Gerät schnell – auch auf dem Handy und auf schwächeren PCs.
 * @param {*} client OpenAI-Client, @param {*} toFile toFile aus dem OpenAI-SDK
 */
let noLogprobs = false;
/**
 * Cloud-Spracherkennung. Mit withConfidence: { text, conf } – conf (0..1) = mittlere Sicherheit der erkannten
 * Wörter (nur gpt-4o-transcribe/-mini liefern das; sonst null). Hilft, Wortfetzen aus Hintergrundgeräuschen zu verwerfen.
 */
async function transcribeOpenAI(client, toFile, audio, { language, model, prompt, withConfidence = false } = {}) {
  const m = model || 'gpt-4o-transcribe';
  const wantProbs = withConfidence && !noLogprobs && /^gpt-4o.*transcribe/.test(m);
  const params = async (probs) => ({
    file: await toFile(toWav(audio), 'sprache.wav', { type: 'audio/wav' }),
    model: m,
    ...(language ? { language: language === 'english' ? 'en' : 'de' } : {}),
    ...(prompt ? { prompt } : {}),
    ...(probs ? { response_format: 'json', include: ['logprobs'] } : {}),
  });
  let res;
  try {
    res = await client.audio.transcriptions.create(await params(wantProbs));
  } catch (err) {
    // Konto/Modell kennt die Sicherheitswerte nicht: ohne sie weiter (und nicht wieder versuchen)
    if (!wantProbs || err?.status !== 400) throw err;
    noLogprobs = true;
    res = await client.audio.transcriptions.create(await params(false));
  }
  const text = String(res.text ?? '').trim();
  if (!withConfidence) return text;
  const lp = Array.isArray(res.logprobs) ? res.logprobs.map((t) => t.logprob).filter((x) => typeof x === 'number') : [];
  const conf = lp.length ? Math.exp(lp.reduce((a, b) => a + b, 0) / lp.length) : null;
  return { text, conf };
}

const { APP_TOOLS, APP_TOOL_STATUS } = require('./apptools.js');
/** App-Werkzeuge; run führt den Aufruf in der Oberfläche aus. */
function appTools(run, { desktop = false, privat = false } = {}) {
  // „desktopOnly“/„mobileOnly“/„privatOnly“ sind nur Merker der App – die API bekommt die reine Beschreibung
  const defs = APP_TOOLS.filter((d) => (desktop ? !d.mobileOnly : !d.desktopOnly) && (privat || !d.privatOnly)).map(({ desktopOnly: _d, privatOnly: _p, mobileOnly: _m, ...d }) => d);
  return { defs, status: APP_TOOL_STATUS, run };
}
/** Mehrere Werkzeug-Sätze (z. B. Google + App) zu einem zusammenfassen. */
function mergeTools(...sets) {
  const list = sets.filter((t) => t?.defs?.length);
  if (!list.length) return null;
  return {
    defs: list.flatMap((t) => t.defs),
    status: Object.assign({}, ...list.map((t) => t.status ?? {})),
    run: (name, input) => {
      const owner = list.find((t) => t.defs.some((d) => d.name === name));
      if (!owner) throw new Error(`Unbekanntes Werkzeug ${name}`);
      return owner.run(name, input);
    },
  };
}

module.exports = {
  APP_TOOLS,
  appTools,
  mergeTools, toWav, transcribeOpenAI, friendlyCloudError, toClaudeMessages, claudeTools, createdFileIds, citedSources, chatAnthropic, chatOpenAI };
