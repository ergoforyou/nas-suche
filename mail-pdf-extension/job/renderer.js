// HTML → PDF using Chrome's own print engine (Page.printToPDF via chrome.debugger)
// in a hidden, minimized helper window. Gives the same quality as "Drucken → Als PDF speichern".

class PdfRenderer {
  constructor() {
    this.tabId = null;
    this.windowId = null;
    this.attached = false;
  }

  async init() {
    if (this.attached) return;
    try {
      const win = await chrome.windows.create({ url: 'about:blank', state: 'minimized', focused: false });
      this.windowId = win.id;
      this.tabId = win.tabs[0].id;
    } catch (e) {
      const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
      this.tabId = tab.id;
    }
    await this.waitTabComplete();
    await chrome.debugger.attach({ tabId: this.tabId }, '1.3');
    this.attached = true;
    await this.send('Page.enable');
  }

  waitTabComplete() {
    return new Promise((resolve) => {
      const check = () => chrome.tabs.get(this.tabId, (t) => {
        if (chrome.runtime.lastError || !t || t.status === 'complete') resolve();
        else setTimeout(check, 50);
      });
      check();
    });
  }

  send(method, params = {}) {
    return chrome.debugger.sendCommand({ tabId: this.tabId }, method, params);
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return r && r.result ? r.result.value : undefined;
  }

  /**
   * @param {string} html complete HTML document
   * @param {{landscape?: boolean, minScale?: number}} opts
   * @returns {Promise<Uint8Array>}
   */
  async render(html, opts = {}) {
    await this.init();
    const landscape = !!opts.landscape;
    const paperW = landscape ? 11.69 : 8.27;
    const paperH = landscape ? 8.27 : 11.69;
    const margin = 0.4;
    const cssWidth = Math.round((paperW - 2 * margin) * 96);

    await this.send('Emulation.setDeviceMetricsOverride', { width: cssWidth, height: 1000, deviceScaleFactor: 1, mobile: false });
    const { frameTree } = await this.send('Page.getFrameTree');
    await this.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });

    await this.evaluate(`new Promise((resolve) => {
      const finish = () => (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => resolve(true));
      const pending = [...document.images].filter((i) => !i.complete);
      if (!pending.length) return finish();
      let n = pending.length;
      const one = () => { if (--n <= 0) finish(); };
      pending.forEach((i) => { i.addEventListener('load', one); i.addEventListener('error', one); });
      setTimeout(finish, 10000);
    })`);

    const contentWidth = await this.evaluate(
      'Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0)'
    );
    let scale = 1;
    if (contentWidth && contentWidth > cssWidth + 2) {
      scale = Math.max(opts.minScale || 0.45, cssWidth / contentWidth);
    }

    const res = await this.send('Page.printToPDF', {
      landscape: false, // paper size already swapped
      paperWidth: paperW,
      paperHeight: paperH,
      marginTop: margin,
      marginBottom: margin + 0.15,
      marginLeft: margin,
      marginRight: margin,
      printBackground: true,
      scale: Math.round(scale * 100) / 100,
      preferCSSPageSize: false,
    });
    return base64ToBytes(res.data);
  }

  async close() {
    try { if (this.attached) await chrome.debugger.detach({ tabId: this.tabId }); } catch (e) { /* ignore */ }
    this.attached = false;
    try {
      if (this.windowId != null) await chrome.windows.remove(this.windowId);
      else if (this.tabId != null) await chrome.tabs.remove(this.tabId);
    } catch (e) { /* ignore */ }
    this.tabId = this.windowId = null;
  }
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
