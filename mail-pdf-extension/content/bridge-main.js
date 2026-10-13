// Runs in the page's own JavaScript world (MAIN) at document_start.
// - Outlook: remembers the auth headers Outlook itself uses for its service.svc calls,
//   so the extension can request the original message (MIME) the same way.
// - Gmail: exposes the "ik" account key needed for the "Show original" URL.
// Data is only handed to this extension's content script on request.
(() => {
  if (window.__mailPdfBridge) return;
  window.__mailPdfBridge = true;

  const state = { auth: null, canary: null, anchorMailbox: null };
  const isOutlook = /outlook\./.test(location.hostname);

  function record(url, name, value) {
    if (!value || !/service\.svc|\/owa\//i.test(String(url))) return;
    const n = String(name).toLowerCase();
    if (n === 'authorization' && /^bearer\s/i.test(value)) state.auth = value;
    else if (n === 'x-owa-canary') state.canary = value;
    else if (n === 'x-anchormailbox') state.anchorMailbox = value;
  }

  if (isOutlook) {
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || String(input);
        const hdrs = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
        hdrs.forEach((v, k) => record(url, k, v));
      } catch (e) { /* never break the page */ }
      return origFetch.apply(this, arguments);
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSet = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__mailPdfUrl = url;
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      try { record(this.__mailPdfUrl || '', name, value); } catch (e) { /* ignore */ }
      return origSet.apply(this, arguments);
    };
  }

  document.addEventListener('mailpdf-req', (ev) => {
    let ik = null;
    try {
      if (Array.isArray(window.GLOBALS) && typeof window.GLOBALS[9] === 'string') ik = window.GLOBALS[9];
    } catch (e) { /* ignore */ }
    document.dispatchEvent(new CustomEvent('mailpdf-res', {
      detail: JSON.stringify({ id: ev.detail, ik, ...state }),
    }));
  });
})();
