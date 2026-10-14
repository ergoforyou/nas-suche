// Markdown wie in LM Studio darstellen (Überschriften, Listen, Tabellen, Code) – sicher bereinigt.
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

// Links immer im Standardbrowser öffnen, nie im App-Fenster.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text ?? ''), { FORBID_TAGS: ['style', 'img', 'form', 'input'] });
}

/** Kopier-Knöpfe an Codeblöcke hängen. */
export function addCopyButtons(root) {
  for (const pre of root.querySelectorAll('pre')) {
    if (pre.querySelector('.copy')) continue;
    const b = root.ownerDocument.createElement('button');
    b.className = 'copy';
    b.textContent = 'Kopieren';
    b.onclick = () => {
      root.ownerDocument.defaultView.navigator.clipboard.writeText(pre.innerText.replace(/Kopieren$/, '').trim());
      b.textContent = 'Kopiert ✓';
      setTimeout(() => (b.textContent = 'Kopieren'), 1500);
    };
    pre.appendChild(b);
  }
}
