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

// Claude: Systemprompt getrennt, Nachrichten müssen mit "user" beginnen und abwechseln
function toClaudeMessages(messages) {
  let system = '';
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system += (system ? '\n\n' : '') + m.content;
      continue;
    }
    const last = out.at(-1);
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else out.push({ role: m.role, content: m.content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return { system, messages: out };
}

async function chatAnthropic(client, { model, messages, effort }, send, signal) {
  const { system, messages: msgs } = toClaudeMessages(messages);
  const params = {
    model,
    max_tokens: 16000,
    messages: msgs,
    ...(system ? { system } : {}),
    // Denktiefe: "low" antwortet am schnellsten (wichtig für Sprachausgabe)
    output_config: { effort: effort || 'low' },
  };
  // Bei Sonnet/Opus 5.5: falls ein Sicherheitsfilter ablehnt, übernimmt automatisch ein passendes Modell
  const withFallback = /^claude-(opus|sonnet)-5-5$/.test(model);
  const stream = withFallback
    ? client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })
    : client.messages.stream(params, { signal });
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') send('delta', ev.delta.text);
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal') {
    send('error', 'Claude hat diese Anfrage abgelehnt. Bitte anders formulieren.');
    return;
  }
  send('done');
}

async function chatOpenAI(client, { model, messages }, send, signal) {
  const stream = await client.chat.completions.create(
    { model, messages: messages.map(({ role, content }) => ({ role, content })), stream: true },
    { signal },
  );
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) send('delta', delta);
  }
  send('done');
}

module.exports = { friendlyCloudError, toClaudeMessages, chatAnthropic, chatOpenAI };
