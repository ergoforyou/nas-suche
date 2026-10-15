'use strict';
const out = document.getElementById('out');
async function ask() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    out.className = 'ok';
    out.textContent = 'Erledigt! Dieser Tab schließt sich gleich.';
    chrome.runtime.sendMessage({ target: 'engine', cmd: 'mic-recheck' }).catch(() => {});
    setTimeout(() => window.close(), 1500);
  } catch (e) {
    out.className = 'err';
    out.textContent = 'Nicht freigegeben (' + e.name + '). Über das Schloss-/Einstellungssymbol links in der Adressleiste kann das Mikrofon erlaubt werden.';
  }
}
document.getElementById('go').addEventListener('click', ask);
ask();
