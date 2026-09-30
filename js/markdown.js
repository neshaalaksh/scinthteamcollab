// Markdown rendering with embeds. The markdown is sanitised first, then any
// paragraph that is just a recognised link is swapped for an embed that we
// build ourselves, so no user-written iframe ever reaches the page.

import { toEmbed, embedHtml } from './embed.js';
import { esc } from './util.js';

const marked = window.marked;
const DOMPurify = window.DOMPurify;

if (marked) marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdown(src) {
  let html;
  if (marked && DOMPurify) {
    html = DOMPurify.sanitize(marked.parse(src || ''), { ADD_ATTR: ['target'] });
  } else {
    html = `<p>${esc(src || '').replace(/\n/g, '<br>')}</p>`;
  }
  const tpl = document.createElement('template');
  tpl.innerHTML = html;

  // Paragraphs made of a single link (bare URL on its own line).
  // Optional height: put "| 700" after the URL.
  tpl.content.querySelectorAll('p').forEach((p) => {
    const text = p.textContent.trim();
    const match = text.match(/^(https:\/\/\S+?)(?:\s*\|\s*(\d{2,4}))?$/);
    if (!match) return;
    const info = toEmbed(match[1]);
    if (!info) return;
    p.outerHTML = embedHtml(info, match[2] ? Number(match[2]) : undefined);
  });

  tpl.content.querySelectorAll('a[href^="http"]').forEach((a) => {
    a.target = '_blank';
    a.rel = 'noopener';
  });
  return tpl.innerHTML;
}
