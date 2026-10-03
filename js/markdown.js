// Markdown rendering with embeds. The markdown is sanitised first, then any
// paragraph that is just a recognised link is swapped for an embed that we
// build ourselves, so no user-written iframe ever reaches the page.

import { toEmbed, embedHtml } from './embed.js';
import { esc } from './util.js';

const marked = window.marked;
const DOMPurify = window.DOMPurify;

if (marked) marked.setOptions({ gfm: true, breaks: true });

// The doc editor escapes punctuation in plain-text links ("docs\.google\.com").
// Undo that inside URLs so links and embeds keep working.
function unescapeUrls(src) {
  return String(src || '').replace(/https:\/\/[^\s<>()]+/g, (url) => url.replace(/\\(?=[^\w\s])/g, ''));
}

// Give every embeddable link that sits on its own line its own paragraph,
// even when the editor saved it with a single line break around it.
const URL_LINE = /^(https:\/\/\S+?)(?:\s*\|\s*(\d{2,4}))?$/;
function isolateEmbedLines(src) {
  let inFence = false;
  return src.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && line.trim().match(URL_LINE);
    return m && toEmbed(m[1]) ? `\n${line.trim()}\n` : line;
  }).join('\n');
}

// Doc bodies are HTML now (from the live editor); older ones are still markdown.
const HTML_BODY = /^\s*<(p|h[1-6]|ul|ol|div|table|blockquote|pre|hr)[\s>/]/i;
export const isHtmlBody = (body) => HTML_BODY.test(String(body || ''));

// opts.embeds = 'node' leaves embeds as <div data-embed="url"> for the editor to take over.
export function renderMarkdown(src, opts = {}) {
  src = isolateEmbedLines(unescapeUrls(src));
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
    const match = text.match(URL_LINE);
    if (!match) return;
    const info = toEmbed(match[1]);
    if (!info) return;
    const holder = document.createElement('template');
    holder.innerHTML = opts.embeds === 'node'
      ? `<div data-embed="${match[1].replace(/"/g, '&quot;')}" data-height="${match[2] || ''}">${esc(match[1])}</div>`
      : embedHtml(info, match[2] ? Number(match[2]) : undefined);
    p.replaceWith(holder.content);
  });

  tpl.content.querySelectorAll('a[href^="http"]').forEach((a) => {
    a.target = '_blank';
    a.rel = 'noopener';
  });
  return tpl.innerHTML;
}

// A doc body (HTML or old markdown) as safe HTML for reading, with embeds swapped in.
export function renderDoc(body) {
  if (!isHtmlBody(body)) return renderMarkdown(body);
  const clean = DOMPurify ? DOMPurify.sanitize(body, { ADD_ATTR: ['target', 'data-embed', 'data-height'] }) : esc(body);
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  tpl.content.querySelectorAll('div[data-embed]').forEach((d) => {
    const info = toEmbed(d.getAttribute('data-embed'));
    if (!info) return;
    const holder = document.createElement('template');
    holder.innerHTML = embedHtml(info, Number(d.getAttribute('data-height')) || undefined);
    d.replaceWith(holder.content);
  });
  tpl.content.querySelectorAll('a[href^="http"]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });
  return tpl.innerHTML;
}
