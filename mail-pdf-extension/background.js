// Service worker: context menus, toolbar button and shortcut open the job window,
// which does the actual work (fetching the mail, converting, merging, downloading).

const MAIL_URL_PATTERNS = [
  'https://outlook.office.com/*',
  'https://outlook.office365.com/*',
  'https://outlook.live.com/*',
  'https://outlook.cloud.microsoft/*',
  'https://mail.google.com/*',
];

const MAIL_URL_RE = /^https:\/\/(outlook\.office\.com|outlook\.office365\.com|outlook\.live\.com|outlook\.cloud\.microsoft|mail\.google\.com)\//;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'mailpdf-single',
      title: 'E-Mail als PDF speichern (mit Anhängen)',
      contexts: ['page', 'selection', 'link', 'image'],
      documentUrlPatterns: MAIL_URL_PATTERNS,
    });
    chrome.contextMenus.create({
      id: 'mailpdf-thread',
      title: 'Ganzen Verlauf als PDF speichern',
      contexts: ['page', 'selection', 'link', 'image'],
      documentUrlPatterns: MAIL_URL_PATTERNS,
    });
    chrome.contextMenus.create({
      id: 'mailpdf-file',
      title: 'EML-/MSG-Datei in PDF umwandeln …',
      contexts: ['action'],
    });
  });
});

function openJob(params) {
  const url = chrome.runtime.getURL('job/job.html?' + new URLSearchParams(params).toString());
  chrome.windows.create({ url, type: 'popup', width: 540, height: 560 });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'mailpdf-file') return openJob({});
  if (!tab || tab.id == null) return;
  openJob({
    tab: tab.id,
    mode: info.menuItemId === 'mailpdf-thread' ? 'thread' : 'single',
    target: '1',
  });
});

chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.url && (MAIL_URL_RE.test(tab.url) || /outlook|\/owa\//i.test(tab.url + ' ' + (tab.title || '')))) {
    // Other Outlook addresses: the click grants temporary access (activeTab), the job injects the scripts.
    openJob({ tab: tab.id, mode: 'default' });
  } else {
    openJob({});
  }
});

// Floating "PDF" button inside Gmail/Outlook
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'MAILPDF_START' && sender.tab) {
    openJob({ tab: sender.tab.id, mode: msg.mode === 'thread' ? 'thread' : 'single', target: '1' });
  }
});

// Outlook sends its requests partly from web workers, which page scripts cannot observe.
// Chrome shows the extension every request to Outlook/Graph, so the sign-in headers
// Outlook uses are remembered here (in memory only) and handed to the content script.
const OUTLOOK_REQUEST_URLS = [
  'https://outlook.office.com/*',
  'https://outlook.office365.com/*',
  'https://outlook.live.com/*',
  'https://outlook.cloud.microsoft/*',
  'https://graph.microsoft.com/*',
];

chrome.webRequest.onBeforeSendHeaders.addListener((details) => {
  if (details.initiator && details.initiator.startsWith('chrome-extension://')) return;
  const found = {};
  for (const h of details.requestHeaders || []) {
    const n = h.name.toLowerCase();
    if (n === 'authorization' && /^(bearer|msauth)/i.test(h.value || '')) found.bearer = h.value;
    else if (n === 'x-owa-canary') found.canary = h.value;
    else if (n === 'x-anchormailbox') found.anchorMailbox = h.value;
  }
  if (!found.bearer && !found.canary && !found.anchorMailbox) return;
  const host = new URL(details.url).host;
  chrome.storage.session.get({ mailpdfAuth: { tokens: {} } }, ({ mailpdfAuth }) => {
    if (found.bearer) mailpdfAuth.tokens[host + (/^bearer/i.test(found.bearer) ? '' : '|msauth')] = found.bearer;
    if (found.canary) mailpdfAuth.canary = found.canary;
    if (found.anchorMailbox) mailpdfAuth.anchorMailbox = found.anchorMailbox;
    chrome.storage.session.set({ mailpdfAuth });
  });
}, { urls: OUTLOOK_REQUEST_URLS }, ['requestHeaders', 'extraHeaders']);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'MAILPDF_GET_AUTH') return;
  chrome.storage.session.get({ mailpdfAuth: { tokens: {} } }, ({ mailpdfAuth }) => sendResponse(mailpdfAuth));
  return true;
});

// Plan B: Outlook's own "Herunterladen → Als EML herunterladen" (or Gmail's
// "Nachricht herunterladen") – every .eml downloaded from a mail site becomes a PDF.
const handledDownloads = new Set();

async function maybeConvertDownload(id) {
  if (handledDownloads.has(id)) return;
  const [item] = await chrome.downloads.search({ id });
  if (!item || item.byExtensionId === chrome.runtime.id) return;
  const isEml = /\.eml$/i.test(item.filename || '') || item.mime === 'message/rfc822' || /\.eml(\?|$)/i.test(item.url);
  if (!isEml) return;
  const where = `${item.url} ${item.finalUrl || ''} ${item.referrer || ''}`;
  if (!/outlook\.|office\.net|office365|cloud\.microsoft|mail\.google\.com|googleusercontent/i.test(where)) return;
  const { autoEml } = await chrome.storage.sync.get({ autoEml: true });
  if (!autoEml || handledDownloads.has(id)) return;
  handledDownloads.add(id);
  openJob({ download: id });
}

chrome.downloads.onCreated.addListener((item) => maybeConvertDownload(item.id));
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.filename) maybeConvertDownload(delta.id);
});
