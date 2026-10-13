(async () => {
  const s = await mailPdfGetSettings();
  for (const [k, v] of Object.entries(s)) {
    const el = document.getElementById(k);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  }
  document.getElementById('save').addEventListener('click', async () => {
    const values = {};
    for (const k of Object.keys(MAILPDF_DEFAULTS)) {
      const el = document.getElementById(k);
      if (!el) continue;
      values[k] = el.type === 'checkbox' ? el.checked : el.value.trim();
    }
    if (!values.pattern) values.pattern = MAILPDF_DEFAULTS.pattern;
    await mailPdfSetSettings(values);
    const saved = document.getElementById('saved');
    saved.style.opacity = 1;
    setTimeout(() => { saved.style.opacity = 0; }, 1500);
  });
})();
