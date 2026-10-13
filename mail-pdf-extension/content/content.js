// Content script (isolated world) on Outlook Web and Gmail.
// On request from the job window it finds the e-mail the user means and downloads
// its original source (RFC 822 / .eml) using the user's existing web session.

(() => {
  if (window.__mailPdfContent) return;
  window.__mailPdfContent = true;

  let lastTarget = null;
  let lastTargetAt = 0;
  document.addEventListener('contextmenu', (e) => {
    lastTarget = e.target;
    lastTargetAt = Date.now();
  }, true);
  // A normal click elsewhere (e.g. opening another mail) makes the last right-click stale.
  document.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !(e.target && e.target.id === 'mailpdf-host')) lastTarget = null;
  }, true);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'MAILPDF_FETCH_URL') return;
    // a file this page offered for download (blob: URLs only work inside the page's origin)
    fetch(msg.url, { credentials: 'include' })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then((buf) => sendResponse({ ok: true, base64: bytesToBase64(new Uint8Array(buf)) }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'MAILPDF_GET_SOURCES') return;
    const target = msg.useTarget && Date.now() - lastTargetAt < 120000 ? lastTarget : null;
    getSources(msg.mode || 'single', target)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err), details: (err && err.details) || null }));
    return true;
  });

  // ---------- floating "PDF" button (Gmail/Outlook use their own context menus) ----------

  function addButton() {
    if (document.getElementById('mailpdf-host') || !document.body) return;
    const host = document.createElement('div');
    host.id = 'mailpdf-host';
    let pos = {};
    try { pos = JSON.parse(localStorage.getItem('mailpdf-pos') || '{}'); } catch (e) { /* ignore */ }
    host.style.cssText = `position:fixed;z-index:2147483000;right:${pos.right ?? 90}px;bottom:${pos.bottom ?? 24}px;`;
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      button{all:initial;display:flex;align-items:center;gap:6px;cursor:pointer;background:#c62828;color:#fff;
        font:600 13px "Segoe UI",Arial,sans-serif;padding:8px 14px;border-radius:20px;box-shadow:0 2px 8px rgba(0,0,0,.35);
        user-select:none;opacity:.88;transition:opacity .15s}
      button:hover{opacity:1}
    </style><button title="Geöffnete bzw. markierte E-Mail(s) als PDF mit allen Anhängen speichern&#10;Umschalt+Klick: ganzen Verlauf&#10;Ziehen zum Verschieben">📄 PDF</button>`;
    const btn = root.querySelector('button');
    let drag = null;
    btn.addEventListener('mousedown', (e) => {
      const r = host.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, right: innerWidth - r.right, bottom: innerHeight - r.bottom, moved: false };
      const move = (ev) => {
        const dx = ev.clientX - drag.x; const dy = ev.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        if (!drag.moved) return;
        host.style.right = Math.max(0, drag.right - dx) + 'px';
        host.style.bottom = Math.max(0, drag.bottom - dy) + 'px';
      };
      const up = () => {
        removeEventListener('mousemove', move, true);
        removeEventListener('mouseup', up, true);
        if (drag.moved) {
          try { localStorage.setItem('mailpdf-pos', JSON.stringify({ right: parseInt(host.style.right), bottom: parseInt(host.style.bottom) })); } catch (e) { /* ignore */ }
        }
      };
      addEventListener('mousemove', move, true);
      addEventListener('mouseup', up, true);
    });
    btn.addEventListener('click', (e) => {
      if (drag && drag.moved) return;
      chrome.runtime.sendMessage({ type: 'MAILPDF_START', mode: e.shiftKey ? 'thread' : 'single' });
    });
    document.body.appendChild(host);
  }
  addButton();
  new MutationObserver(() => addButton()).observe(document.documentElement, { childList: true });
  setInterval(addButton, 3000);

  async function getSources(mode, target) {
    if (location.hostname === 'mail.google.com') return gmailSources(mode, target);
    return outlookSources(mode, target);
  }

  // ---------- helpers ----------

  function bridge() {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const onRes = (ev) => {
        try {
          const data = JSON.parse(ev.detail);
          if (data.id !== id) return;
          document.removeEventListener('mailpdf-res', onRes);
          resolve(data);
        } catch (e) { /* ignore */ }
      };
      document.addEventListener('mailpdf-res', onRes);
      document.dispatchEvent(new CustomEvent('mailpdf-req', { detail: id }));
      setTimeout(() => {
        document.removeEventListener('mailpdf-res', onRes);
        resolve({});
      }, 500);
    });
  }

  function bytesToBase64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function looksLikeMime(bytes) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 8192));
    if (/^\s*<(!doctype|html)/i.test(head)) return false;
    return /^[!-9;-~]+:[ \t]?/m.test(head) && /^(from|received|mime-version|delivered-to|return-path|message-id|date|subject):/im.test(head);
  }

  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name.replace(/[-.]/g, '\\$&') + '=([^;]*)', 'i'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  // ---------- Gmail ----------

  const isVisible = (el) => !!(el && (el.offsetParent !== null || el.getClientRects().length));
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];

  async function gmailSources(mode, target) {
    const u = (location.pathname.match(/\/mail\/u\/(\d+)/) || [])[1] || '0';
    const { ik } = await bridge();

    const openMsgs = [...document.querySelectorAll('[data-legacy-message-id]')].filter(isVisible);
    const rowId = (row) => {
      const el = row && (row.matches('[data-legacy-last-message-id]') ? row : row.querySelector('[data-legacy-last-message-id]'));
      return el ? el.getAttribute('data-legacy-last-message-id') : null;
    };
    const checkedRows = [...document.querySelectorAll('tr.zA')].filter((r) => isVisible(r) &&
      (r.classList.contains('x7') || r.querySelector('[role="checkbox"][aria-checked="true"]')));
    const targetMsg = target && target.closest && target.closest('[data-legacy-message-id]');
    const targetRow = target && target.closest && target.closest('tr.zA');

    let ids = [];
    let separate = false;
    if (mode === 'thread' && openMsgs.length) {
      ids = uniq(openMsgs.map((el) => el.getAttribute('data-legacy-message-id')));
    } else if (targetMsg) {
      ids = [targetMsg.getAttribute('data-legacy-message-id')];
    } else if (targetRow && rowId(targetRow) && !(checkedRows.length > 1 && checkedRows.includes(targetRow))) {
      ids = [rowId(targetRow)];
    } else if (checkedRows.length) {
      ids = uniq(checkedRows.map(rowId));
      separate = ids.length > 1;
    } else if (openMsgs.length) {
      ids = [openMsgs[openMsgs.length - 1].getAttribute('data-legacy-message-id')];
    }
    if (!ids.length) throw new Error('Keine E-Mail gefunden. Bitte die E-Mail öffnen oder in der Liste anhaken.');

    const sources = [];
    for (const id of ids) sources.push({ base64: bytesToBase64(await gmailFetchRaw(u, id, ik)) });
    return { sources, separate };
  }

  async function gmailFetchRaw(u, legacyId, ik) {
    const base = `/mail/u/${u}/`;
    const ikq = ik ? `ik=${encodeURIComponent(ik)}&` : '';
    let decimalId = null;
    try { decimalId = BigInt('0x' + legacyId).toString(); } catch (e) { /* ignore */ }
    const candidates = [
      `${base}?${ikq}view=att&th=${legacyId}&attid=0&disp=comp&safe=1&zw`,
      `${base}?${ikq}view=om&th=${legacyId}`,
    ];
    if (decimalId) candidates.push(`${base}?${ikq}view=om&permmsgid=msg-f:${decimalId}`);

    for (const url of candidates) {
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) continue;
        const buf = new Uint8Array(await res.arrayBuffer());
        if (looksLikeMime(buf)) return buf;
        // "Original anzeigen" page: raw message is inside <pre id="raw_message_text">
        const html = new TextDecoder('utf-8').decode(buf);
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const pre = doc.querySelector('#raw_message_text, pre.raw_message_text');
        if (pre && pre.textContent.trim()) {
          const raw = new TextEncoder().encode(pre.textContent);
          if (looksLikeMime(raw)) return raw;
        }
      } catch (e) { /* try next */ }
    }
    throw new Error('Gmail hat das Original der E-Mail nicht geliefert.');
  }

  // ---------- Outlook Web ----------
  // The original message (MIME) is requested in up to three ways, in this order:
  //  1. Outlook's own web service (service.svc, GetItem with IncludeMimeContent)
  //  2. Outlook REST API  (/api/v2.0/me/messages/{id}/$value)
  //  3. Microsoft Graph   (/v1.0/me/messages/{id}/$value)
  // using the sign-in tokens Outlook itself already has in this tab.
  // Every attempt is logged so a failure can be diagnosed from the job window.

  function outlookIdFromUrl() {
    const href = location.href;
    const fromPath = href.match(/\/(?:id|deeplink\/read)\/([^/?#&]+)/);
    let id = fromPath ? fromPath[1] : null;
    if (!id) {
      id = new URLSearchParams(location.search).get('ItemID') ||
        new URLSearchParams(location.hash.replace(/^#/, '')).get('ItemID');
    }
    return id ? normalizeEwsId(decodeURIComponent(id)) : null;
  }

  // EWS ids use + and /, REST/Graph ids use _ and -
  const normalizeEwsId = (id) => id.replace(/-/g, '/').replace(/_/g, '+');
  const toRestId = (id) => id.replace(/\//g, '-').replace(/\+/g, '_');
  const isConversationId = (id) => /^AAQk/.test(id);
  const byDate = (a, b) => (a.date || '').localeCompare(b.date || '');

  function jwtInfo(tok) {
    try {
      const p = JSON.parse(atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return { exp: p.exp, aud: p.aud || '', upn: p.preferred_username || p.upn || p.unique_name || p.email || '' };
    } catch (e) {
      return {};
    }
  }

  function collectTokens(captured) {
    const now = Date.now() / 1000;
    const out = [];
    for (const [host, val] of Object.entries(captured || {})) {
      const raw = String(val);
      const isBearer = /^bearer\s/i.test(raw);
      const t = raw.replace(/^bearer\s+/i, '');
      const j = isBearer ? jwtInfo(t) : {};
      if (j.exp && j.exp < now + 30) continue;
      out.push({ bearer: isBearer ? 'Bearer ' + t : raw, aud: `${j.aud || ''} ${host}`, source: 'Seite', serviceOnly: !isBearer });
    }
    for (const store of [window.localStorage, window.sessionStorage]) {
      let keys = [];
      try { keys = Object.keys(store); } catch (e) { /* ignore */ }
      for (const k of keys) {
        if (!/accesstoken/i.test(k)) continue;
        try {
          const v = JSON.parse(store.getItem(k));
          if (!v || !v.secret) continue;
          if (v.expiresOn && Number(v.expiresOn) < now + 30) continue;
          out.push({ bearer: 'Bearer ' + v.secret, aud: `${v.target || ''} ${jwtInfo(v.secret).aud || ''}`, source: 'MSAL' });
        } catch (e) { /* encrypted or not JSON */ }
      }
    }
    const seenTok = new Set();
    return out.filter((t) => !seenTok.has(t.bearer) && seenTok.add(t.bearer));
  }

  const OUTLOOK_AUD = /outlook\.office(365)?\.com|outlook\.cloud\.microsoft|outlook\.live\.com|00000002-0000-0ff1-ce00-000000000000/i;
  const GRAPH_AUD = /graph\.microsoft\.com|00000003-0000-0000-c000-000000000000/i;

  function outlookError(message, diag) {
    const e = new Error(message);
    e.details = diag;
    return e;
  }

  async function outlookSources(mode, target) {
    const convOf = (el) => normalizeEwsId(el.getAttribute('data-convid'));
    const selectedRows = [...document.querySelectorAll('[data-convid][aria-selected="true"]')].filter(isVisible);
    const targetRow = target && target.closest && target.closest('[data-convid]');

    let ids = [];
    if (targetRow && !(selectedRows.length > 1 && selectedRows.includes(targetRow))) ids = [convOf(targetRow)];
    else if (selectedRows.length > 1) ids = uniq(selectedRows.map(convOf));
    else if (outlookIdFromUrl()) ids = [outlookIdFromUrl()];
    else if (selectedRows.length) ids = [convOf(selectedRows[0])];

    const st = await bridge();
    let seen = {};
    try { seen = (await chrome.runtime.sendMessage({ type: 'MAILPDF_GET_AUTH' })) || {}; } catch (e) { /* ignore */ }
    const tokens = collectTokens({ ...(seen.tokens || {}), ...(st.tokens || {}) });
    const canary = st.canary || seen.canary || getCookie('X-OWA-CANARY');
    st.anchorMailbox = st.anchorMailbox || seen.anchorMailbox;
    const diag = [
      `Seite: ${location.host}${location.pathname.slice(0, 40)}`,
      `E-Mail-ID: ${ids.length ? ids.map((i) => `${i.slice(0, 8)}… (${isConversationId(i) ? 'Unterhaltung' : 'Nachricht'})`).join(', ') : 'keine gefunden'}`,
      `Anmeldung: Canary ${canary ? 'ja' : 'nein'}, Tokens ${tokens.length ? tokens.map((t) => t.source + '/' + (OUTLOOK_AUD.test(t.aud) ? 'Outlook' : GRAPH_AUD.test(t.aud) ? 'Graph' : 'andere')).join(', ') : 'keine'}`,
    ];
    if (!ids.length) {
      throw outlookError('Keine E-Mail gefunden. Bitte die E-Mail öffnen (anklicken), sodass sie im Lesebereich steht.', diag);
    }
    const separate = ids.length > 1;

    const outlookTokens = tokens.filter((t) => OUTLOOK_AUD.test(t.aud));
    const graphTokens = tokens.filter((t) => GRAPH_AUD.test(t.aud) && !t.serviceOnly);
    const strategies = [
      serviceStrategy(canary, outlookTokens, st.anchorMailbox, diag),
      restStrategy(outlookTokens.filter((t) => !t.serviceOnly), diag),
      graphStrategy(graphTokens, diag),
    ].filter(Boolean);

    for (const strat of strategies) {
      try {
        const sources = await runStrategy(strat, ids, mode, separate);
        return { sources, separate };
      } catch (e) {
        diag.push(`${strat.name}: ${e.message}`);
      }
    }
    throw outlookError('Outlook hat das Original der E-Mail nicht herausgegeben.', diag);
  }

  async function runStrategy(strat, ids, mode, separate) {
    const itemIds = [];
    for (const id of ids) {
      if (isConversationId(id)) {
        const items = (await strat.conversationItems(id)).sort(byDate);
        if (!items.length) throw new Error('Unterhaltung ohne Nachrichten');
        if (mode === 'thread' && !separate) itemIds.push(...items.map((i) => i.id));
        else itemIds.push(items[items.length - 1].id);
      } else if (mode === 'thread' && !separate) {
        let items = [];
        try {
          const conv = await strat.conversationOf(id);
          if (conv) items = (await strat.conversationItems(conv)).sort(byDate);
        } catch (e) { /* fall back to the single message */ }
        itemIds.push(...(items.length ? items.map((i) => i.id) : [id]));
      } else {
        itemIds.push(id);
      }
    }
    const sources = [];
    for (const itemId of itemIds) sources.push({ base64: await strat.mime(itemId) });
    return sources;
  }

  async function shortBody(res) {
    try { return (await res.text()).replace(/\s+/g, ' ').slice(0, 140); } catch (e) { return ''; }
  }

  // --- 1. service.svc ---

  function serviceStrategy(canary, outlookTokens, anchorMailbox, diag) {
    const variants = [];
    const base = { 'Content-Type': 'application/json; charset=utf-8', 'X-Req-Source': 'Mail' };
    if (anchorMailbox) base['X-AnchorMailbox'] = anchorMailbox;
    for (const t of outlookTokens) {
      variants.push({ label: `Token(${t.source})${canary ? '+Canary' : ''}`, headers: { ...base, Authorization: t.bearer, ...(canary ? { 'X-OWA-CANARY': canary } : {}) } });
    }
    if (canary) variants.push({ label: 'Canary', headers: { ...base, 'X-OWA-CANARY': canary } });
    variants.push({ label: 'Cookie', headers: { ...base } });
    let working = null;
    const versions = ['V2018_01_08', 'Exchange2013'];

    async function call(action, body) {
      const list = working ? [working] : variants;
      const errors = [];
      for (const v of list) {
        for (const ver of versions) {
          body.Header = { __type: 'JsonRequestHeaders:#Exchange', RequestServerVersion: ver };
          let res;
          try {
            res = await fetch(`${location.origin}/owa/service.svc?action=${action}&app=Mail`, {
              method: 'POST', credentials: 'include', headers: { ...v.headers, Action: action }, body: JSON.stringify(body),
            });
          } catch (e) {
            errors.push(`${v.label}: ${e.message}`);
            break;
          }
          if (!res.ok) {
            errors.push(`${v.label}/${ver}: HTTP ${res.status} ${await shortBody(res)}`);
            if (res.status === 500 || res.status === 400) continue; // maybe the version
            break;
          }
          let json;
          try { json = await res.json(); } catch (e) { errors.push(`${v.label}: keine JSON-Antwort`); break; }
          const first = json && json.Body && json.Body.ResponseMessages && json.Body.ResponseMessages.Items && json.Body.ResponseMessages.Items[0];
          if (!first) { errors.push(`${v.label}/${ver}: unerwartete Antwort ${JSON.stringify(json).slice(0, 120)}`); continue; }
          if (first.ResponseClass === 'Error') { errors.push(`${v.label}/${ver}: ${first.ResponseCode} ${first.MessageText || ''}`); continue; }
          working = v;
          versions.splice(0, versions.length, ver);
          return first;
        }
      }
      throw new Error(`${action} → ${errors.join(' | ')}`);
    }

    return {
      name: 'Outlook-Webdienst',
      async conversationItems(convId) {
        const req = (ignore) => ({
          __type: 'GetConversationItemsJsonRequest:#Exchange',
          Body: {
            __type: 'GetConversationItemsRequest:#Exchange',
            Conversations: [{ __type: 'ConversationRequestType:#Exchange', ConversationId: { __type: 'ItemId:#Exchange', Id: convId } }],
            ItemShape: { __type: 'ItemResponseShape:#Exchange', BaseShape: 'IdOnly', AdditionalProperties: [{ __type: 'PropertyUri:#Exchange', FieldURI: 'DateTimeReceived' }] },
            ...(ignore ? { FoldersToIgnore: [
              { __type: 'DistinguishedFolderId:#Exchange', Id: 'deleteditems' },
              { __type: 'DistinguishedFolderId:#Exchange', Id: 'drafts' },
            ] } : {}),
            SortOrder: 'DateOrderAscending',
            MaxItemsToReturn: 100,
          },
        });
        let r;
        try { r = await call('GetConversationItems', req(true)); } catch (e) { r = await call('GetConversationItems', req(false)); }
        const out = [];
        for (const n of (r.Conversation && r.Conversation.ConversationNodes) || []) {
          for (const it of n.Items || []) if (it.ItemId && it.ItemId.Id) out.push({ id: it.ItemId.Id, date: it.DateTimeReceived || '' });
        }
        return out;
      },
      async conversationOf(itemId) {
        const r = await call('GetItem', {
          __type: 'GetItemJsonRequest:#Exchange',
          Body: {
            __type: 'GetItemRequest:#Exchange',
            ItemShape: { __type: 'ItemResponseShape:#Exchange', BaseShape: 'IdOnly', AdditionalProperties: [{ __type: 'PropertyUri:#Exchange', FieldURI: 'ConversationId' }] },
            ItemIds: [{ __type: 'ItemId:#Exchange', Id: itemId }],
          },
        });
        const it = r.Items && r.Items[0];
        return it && it.ConversationId && it.ConversationId.Id;
      },
      async mime(itemId) {
        const r = await call('GetItem', {
          __type: 'GetItemJsonRequest:#Exchange',
          Body: {
            __type: 'GetItemRequest:#Exchange',
            ItemShape: { __type: 'ItemResponseShape:#Exchange', BaseShape: 'IdOnly', IncludeMimeContent: true },
            ItemIds: [{ __type: 'ItemId:#Exchange', Id: itemId }],
          },
        });
        const it = r.Items && r.Items[0];
        const b64 = it && it.MimeContent && it.MimeContent.Value;
        if (!b64) throw new Error('GetItem lieferte keinen MIME-Inhalt');
        return b64;
      },
    };
  }

  // --- 2. Outlook REST / 3. Graph (both: GET …/messages/{id}/$value returns the .eml) ---

  function httpApiStrategy(name, tokens, apiBases, fields) {
    if (!tokens.length) return null;
    let working = null;
    async function get(path, asBytes) {
      const combos = working ? [working] : apiBases.flatMap((b) => tokens.map((t) => ({ b, t })));
      const errors = [];
      for (const c of combos) {
        let res;
        try {
          const headers = { Authorization: c.t.bearer, Accept: asBytes ? '*/*' : 'application/json' };
          if (fields.anchor) {
            // like Outlook itself: route the request to the user's mailbox server
            const upn = jwtInfo(c.t.bearer.replace(/^bearer\s+/i, '')).upn;
            if (upn) headers['X-AnchorMailbox'] = upn;
            headers['X-PreferServerAffinity'] = 'true';
          }
          res = await fetch(c.b + path, { headers });
        } catch (e) {
          errors.push(`${new URL(c.b).host}: ${e.message}`);
          continue;
        }
        if (!res.ok) { errors.push(`${new URL(c.b).host}: HTTP ${res.status} ${await shortBody(res)}`); continue; }
        working = c;
        return asBytes ? new Uint8Array(await res.arrayBuffer()) : res.json();
      }
      throw new Error(errors.join(' | '));
    }
    return {
      name,
      async conversationItems(convId) {
        const filter = encodeURIComponent(`${fields.conv} eq '${toRestId(convId)}'`);
        const j = await get(`/me/messages?$filter=${filter}&$select=${fields.id},${fields.date}&$top=100`);
        return (j.value || []).map((m) => ({ id: m[fields.id] || m.Id || m.id, date: m[fields.date] || '' }));
      },
      async conversationOf(itemId) {
        const j = await get(`/me/messages/${toRestId(itemId)}?$select=${fields.conv}`);
        return j[fields.conv] ? normalizeEwsId(j[fields.conv]) : null;
      },
      async mime(itemId) {
        const bytes = await get(`/me/messages/${toRestId(itemId)}/$value`, true);
        if (!looksLikeMime(bytes)) throw new Error('Antwort ist keine E-Mail-Datei');
        return bytesToBase64(bytes);
      },
    };
  }

  function restStrategy(tokens) {
    const bases = uniq([`${location.origin}/api/v2.0`, 'https://outlook.office.com/api/v2.0', 'https://outlook.office.com/api/beta']);
    return httpApiStrategy('Outlook-REST', tokens, bases, { conv: 'ConversationId', id: 'Id', date: 'ReceivedDateTime', anchor: true });
  }

  function graphStrategy(tokens) {
    return httpApiStrategy('Microsoft Graph', tokens, ['https://graph.microsoft.com/v1.0'], { conv: 'conversationId', id: 'id', date: 'receivedDateTime' });
  }
})();
