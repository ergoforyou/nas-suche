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
    if (!msg || msg.type !== 'MAILPDF_GET_SOURCES') return;
    const target = msg.useTarget && Date.now() - lastTargetAt < 120000 ? lastTarget : null;
    getSources(msg.mode || 'single', target)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
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

  function outlookIdFromUrl() {
    const href = location.href;
    const fromPath = href.match(/\/(?:id|deeplink\/read)\/([^/?#&]+)/);
    let id = fromPath ? fromPath[1] : null;
    if (!id) {
      const q = new URLSearchParams(location.search).get('ItemID') ||
        new URLSearchParams(location.hash.replace(/^#/, '')).get('ItemID');
      id = q;
    }
    return id ? normalizeEwsId(decodeURIComponent(id)) : null;
  }

  function normalizeEwsId(id) {
    // REST ids use - and _ instead of / and +
    return id.replace(/-/g, '/').replace(/_/g, '+');
  }

  const isConversationId = (id) => /^AAQk/.test(id);

  async function outlookSources(mode, target) {
    const convOf = (el) => normalizeEwsId(el.getAttribute('data-convid'));
    const selectedRows = [...document.querySelectorAll('[data-convid][aria-selected="true"]')].filter(isVisible);
    const targetRow = target && target.closest && target.closest('[data-convid]');

    let ids = [];
    if (targetRow && !(selectedRows.length > 1 && selectedRows.includes(targetRow))) ids = [convOf(targetRow)];
    else if (selectedRows.length > 1) ids = uniq(selectedRows.map(convOf));
    else if (outlookIdFromUrl()) ids = [outlookIdFromUrl()];
    else if (selectedRows.length) ids = [convOf(selectedRows[0])];
    if (!ids.length) throw new Error('Keine E-Mail gefunden. Bitte die E-Mail öffnen oder in der Liste markieren.');
    const separate = ids.length > 1;

    const st = await bridge();
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Req-Source': 'Mail',
    };
    const canary = st.canary || getCookie('X-OWA-CANARY');
    if (canary) headers['X-OWA-CANARY'] = canary;
    if (st.auth) headers['Authorization'] = st.auth;
    if (st.anchorMailbox) headers['X-AnchorMailbox'] = st.anchorMailbox;

    const itemIds = [];
    for (const id of ids) {
      if (isConversationId(id)) {
        const items = await owaConversationItems(id, headers);
        if (!items.length) throw new Error('Die Unterhaltung enthält keine Nachrichten.');
        items.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        if (mode === 'thread' && !separate) itemIds.push(...items.map((i) => i.id));
        else itemIds.push(items[items.length - 1].id);
      } else if (mode === 'thread' && !separate) {
        const convId = await owaConversationIdOfItem(id, headers).catch(() => null);
        const items = convId ? await owaConversationItems(convId, headers) : [];
        items.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        itemIds.push(...(items.length ? items.map((i) => i.id) : [id]));
      } else {
        itemIds.push(id);
      }
    }

    const sources = [];
    for (const itemId of itemIds) sources.push({ base64: await owaMime(itemId, headers) });
    return { sources, separate };
  }

  const OWA_HEADER = { __type: 'JsonRequestHeaders:#Exchange', RequestServerVersion: 'V2018_01_08' };

  async function owaCall(action, body, headers) {
    const url = `${location.origin}/owa/service.svc?action=${action}&app=Mail`;
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { ...headers, Action: action },
      body: JSON.stringify(body),
    });
    if (res.status === 401 || res.status === 440) {
      throw new Error('Outlook hat die Anfrage abgelehnt (Anmeldung). Bitte Outlook-Seite neu laden (F5) und erneut versuchen.');
    }
    if (!res.ok) throw new Error(`Outlook-Fehler ${res.status} bei ${action}.`);
    const json = await res.json();
    const items = json && json.Body && json.Body.ResponseMessages && json.Body.ResponseMessages.Items;
    const first = items && items[0];
    if (!first) throw new Error(`Unerwartete Antwort von Outlook (${action}).`);
    if (first.ResponseClass === 'Error') throw new Error(`Outlook: ${first.MessageText || first.ResponseCode}`);
    return first;
  }

  async function owaConversationItems(convId, headers) {
    const r = await owaCall('GetConversationItems', {
      __type: 'GetConversationItemsJsonRequest:#Exchange',
      Header: OWA_HEADER,
      Body: {
        __type: 'GetConversationItemsRequest:#Exchange',
        Conversations: [{
          __type: 'ConversationRequestType:#Exchange',
          ConversationId: { __type: 'ItemId:#Exchange', Id: convId },
        }],
        ItemShape: {
          __type: 'ItemResponseShape:#Exchange',
          BaseShape: 'IdOnly',
          AdditionalProperties: [{ __type: 'PropertyUri:#Exchange', FieldURI: 'DateTimeReceived' }],
        },
        FoldersToIgnore: [
          { __type: 'DistinguishedFolderId:#Exchange', Id: 'deleteditems' },
          { __type: 'DistinguishedFolderId:#Exchange', Id: 'drafts' },
        ],
        SortOrder: 'DateOrderAscending',
        MaxItemsToReturn: 100,
      },
    }, headers);
    const nodes = (r.Conversation && r.Conversation.ConversationNodes) || [];
    const out = [];
    for (const n of nodes) {
      for (const it of n.Items || []) {
        if (it.ItemId && it.ItemId.Id) out.push({ id: it.ItemId.Id, date: it.DateTimeReceived || '' });
      }
    }
    return out;
  }

  async function owaConversationIdOfItem(itemId, headers) {
    const r = await owaCall('GetItem', {
      __type: 'GetItemJsonRequest:#Exchange',
      Header: OWA_HEADER,
      Body: {
        __type: 'GetItemRequest:#Exchange',
        ItemShape: {
          __type: 'ItemResponseShape:#Exchange',
          BaseShape: 'IdOnly',
          AdditionalProperties: [{ __type: 'PropertyUri:#Exchange', FieldURI: 'ConversationId' }],
        },
        ItemIds: [{ __type: 'ItemId:#Exchange', Id: itemId }],
      },
    }, headers);
    const it = r.Items && r.Items[0];
    return it && it.ConversationId && it.ConversationId.Id;
  }

  async function owaMime(itemId, headers) {
    const r = await owaCall('GetItem', {
      __type: 'GetItemJsonRequest:#Exchange',
      Header: OWA_HEADER,
      Body: {
        __type: 'GetItemRequest:#Exchange',
        ItemShape: { __type: 'ItemResponseShape:#Exchange', BaseShape: 'IdOnly', IncludeMimeContent: true },
        ItemIds: [{ __type: 'ItemId:#Exchange', Id: itemId }],
      },
    }, headers);
    const it = r.Items && r.Items[0];
    const b64 = it && it.MimeContent && it.MimeContent.Value;
    if (!b64) throw new Error('Outlook hat keinen E-Mail-Inhalt (MIME) geliefert.');
    return b64;
  }
})();
