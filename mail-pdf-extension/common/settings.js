// Shared settings (chrome.storage.sync) for job and options pages.
const MAILPDF_DEFAULTS = {
  folder: 'E-Mail-Archiv',
  pattern: '{datum}_{absender}_{betreff}',
  saveAs: false,
  stripPrefixes: true,
  loadRemoteImages: true,
  pageNumbers: true,
  embedOriginals: false,
  embedEml: false,
  autoClose: true,
  autoEml: true,
};

function mailPdfGetSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(MAILPDF_DEFAULTS, (s) => resolve({ ...MAILPDF_DEFAULTS, ...s }));
  });
}

function mailPdfSetSettings(values) {
  return new Promise((resolve) => chrome.storage.sync.set(values, resolve));
}
