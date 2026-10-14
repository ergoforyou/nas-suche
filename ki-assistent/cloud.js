// Anbindung der Cloud-Sprachmodelle (Claude über das Anthropic-SDK, ChatGPT über das OpenAI-SDK).
// Ohne Electron-Abhängigkeiten, damit es sich eigenständig testen lässt.

/** Fehlermeldungen der Cloud-SDKs verständlich machen (beide SDKs haben dieselben Fehlerklassen). */
function friendlyCloudError(err, name, SDK) {
  if (SDK && err instanceof SDK.AuthenticationError) return `${name}: API-Schlüssel ungültig oder fehlt (⚙ → Verbindung).`;
  if (SDK && err instanceof SDK.PermissionDeniedError) return `${name}: Zugriff verweigert – keine Berechtigung für dieses Modell.`;
  if (SDK && err instanceof SDK.NotFoundError) return `${name}: Modell nicht gefunden – bitte ein anderes Modell wählen.`;
  if (SDK && err instanceof SDK.RateLimitError) return `${name}: Zu viele Anfragen oder Guthaben aufgebraucht – kurz warten bzw. Konto prüfen.`;
  if (SDK && err instanceof SDK.InternalServerError) return `${name}: Dienst vorübergehend gestört – bitte gleich noch einmal versuchen.`;
  if (SDK && err instanceof SDK.APIConnectionError) return `${name}: Keine Verbindung zum Dienst (Internet prüfen).`;
  return `${name}: ${err?.message ?? err}`;
}

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
    const b64 = () => Buffer.from(a.data).toString('base64');
    if (a.mime === 'application/pdf') {
      blocks.push({ type: 'document', title: a.name, source: { type: 'base64', media_type: 'application/pdf', data: b64() } });
    } else if (IMAGE_TYPES.includes(a.mime)) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data: b64() } });
    } else if (a.text) {
      blocks.push({ type: 'document', title: a.name, source: { type: 'text', media_type: 'text/plain', data: Buffer.from(a.data).toString('utf8') } });
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
function toClaudeMessages(messages, uploaded) {
  let system = '';
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system += (system ? '\n\n' : '') + m.content;
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
  return { system, messages: out };
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
      { type: dynamic ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: 5 },
      { type: dynamic ? 'web_fetch_20260209' : 'web_fetch_20250910', name: 'web_fetch', max_uses: 5 },
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
        const meta = await client.files.upload({ file: await toFile(Buffer.from(a.data), a.name) }, { signal });
        uploaded[key] = meta.id;
        ctx.uploads?.set(key, meta.id);
      }
    }
  }
  const { system, messages: msgs } = toClaudeMessages(messages, uploaded);
  const tools = claudeTools(model, { web, files });
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
  // Serverwerkzeuge können pausieren (pause_turn) – dann mit dem bisherigen Verlauf fortsetzen
  for (let round = 0; round < 6; round++) {
    const stream = open(params);
    let sep = false;
    for await (const ev of stream) {
      if (ev.type === 'content_block_start') {
        const b = ev.content_block;
        if (b.type === 'server_tool_use' && TOOL_STATUS[b.name]) send('status', TOOL_STATUS[b.name]);
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
    if (final.container?.id && conversation) ctx.containers?.set(conversation, final.container.id);
    if (final.stop_reason !== 'pause_turn') break;
    params.messages = [...params.messages, { role: 'assistant', content: final.content }];
    if (final.container?.id) params.container = { ...params.container, id: final.container.id };
  }
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
        send('file', { name: require('node:path').basename(path), path });
      } catch (err) {
        send('status', `Datei konnte nicht geladen werden: ${err.message}`);
      }
    }
  }
  send('done');
}

async function chatOpenAI(client, { model, messages, effort }, send, signal) {
  const params = { model, messages: messages.map(({ role, content }) => ({ role, content })), stream: true };
  // Denkende Modelle (GPT-5.x, o-Reihe): für flüssiges Sprechen nur kurz nachdenken lassen
  const reasoning = /^(gpt-5|o\d)/i.test(model) ? effort || 'low' : null;
  let stream;
  try {
    stream = await client.chat.completions.create(reasoning ? { ...params, reasoning_effort: reasoning } : params, { signal });
  } catch (err) {
    // Modell kennt die Einstellung nicht (oder diesen Wert nicht): ohne sie erneut versuchen
    if (!reasoning || err?.status !== 400 || !/reasoning/i.test(String(err?.message))) throw err;
    stream = await client.chat.completions.create(params, { signal });
  }
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) send('delta', delta);
  }
  send('done');
}

module.exports = { friendlyCloudError, toClaudeMessages, claudeTools, createdFileIds, citedSources, chatAnthropic, chatOpenAI };
