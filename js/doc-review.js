// The comments and suggestions side panel for a doc.
//
// Comment threads live in the shared doc ("threads" map), so they sync live and are saved
// with it. Where a comment points is a `comment` mark in the text; suggestions are
// `suggestInsert` / `suggestDelete` marks (see tools/editor/src/index.js).

import { $, $$, esc, timeAgo, initials, toast } from './util.js';

const COLORS = ['#0f766e', '#b45309', '#1d4ed8', '#be185d', '#7e22ce', '#15803d', '#b91c1c', '#0369a1', '#a16207', '#4d7c0f'];
export function userColor(email) {
  let h = 0;
  for (const c of String(email)) h = (h * 31 + c.charCodeAt(0)) % COLORS.length;
  return COLORS[h];
}

const rid = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const clip = (s, n = 90) => (s.length > n ? `${s.slice(0, n)}…` : s);
const chip = (name, email) => `<span class="rv-chip" style="--c:${esc(userColor(email))}" title="${esc(name)}">${esc(initials(name))}</span>`;

// me: { email, name }; canWrite: may add comments and resolve suggestions; isAdmin: may delete anyone's comment.
export function mountReview({ host, editor, ydoc, me, canWrite, isAdmin, onCount }) {
  const { Y, scanReview, getPending } = window.TeamEditor;
  const threads = ydoc.getMap('threads');
  const review = editor.storage.review;
  let filter = 'open';           // 'open' | 'resolved'
  let composerDraft = '';
  const replyDrafts = new Map();
  let lastSig = '';
  let timer = null;

  // ---- the model: everything shown in the panel, in document order

  function model() {
    const { comments, suggestions } = scanReview(editor.state.doc);
    const items = [];
    threads.forEach((t, id) => {
      const anchor = comments.get(id);
      items.push({
        kind: 'comment', id, at: t.get('at'), by: t.get('by'), name: t.get('name'), text: t.get('text'),
        resolved: !!t.get('resolved'), replies: t.get('replies')?.toArray() || [],
        quote: anchor ? anchor.quote : t.get('quote') || '', orphan: !anchor, pos: anchor ? anchor.from : Infinity, anchor,
      });
    });
    suggestions.forEach((sg) => items.push({ kind: 'suggestion', id: sg.id, pos: sg.from, ...sg }));
    items.sort((a, b) => a.pos - b.pos);
    return { items, pending: getPending(editor) };
  }

  function cardHtml(it) {
    if (it.kind === 'suggestion') {
      const what = it.insText && it.delText ? `replaced <del>${esc(clip(it.delText))}</del> with <ins>${esc(clip(it.insText))}</ins>`
        : it.insText ? `added <ins>${esc(clip(it.insText))}</ins>` : `deleted <del>${esc(clip(it.delText))}</del>`;
      return `<div class="rv-card suggestion ${it.id === review.activeId ? 'active' : ''}" data-kind="suggestion" data-id="${esc(it.id)}">
        <div class="rv-head">${chip(it.name, it.by)}<b>${esc(it.name)}</b><span class="rv-time">${esc(timeAgo(it.at))}</span><span class="grow"></span><span class="rv-tag">Suggestion</span></div>
        <div class="rv-text">${esc(it.name.split(' ')[0])} ${what}</div>
        ${canWrite && editor.isEditable ? `<div class="rv-actions"><button type="button" class="btn small primary" data-act="accept">Accept</button><button type="button" class="btn small" data-act="reject">Reject</button></div>` : ''}
      </div>`;
    }
    const canDelete = it.by === me.email || isAdmin;
    return `<div class="rv-card comment ${it.id === review.activeId ? 'active' : ''} ${it.resolved ? 'resolved' : ''}" data-kind="comment" data-id="${esc(it.id)}">
      <div class="rv-head">${chip(it.name, it.by)}<b>${esc(it.name)}</b><span class="rv-time">${esc(timeAgo(it.at))}</span><span class="grow"></span>
        ${canWrite ? `<button type="button" class="icon-btn small" data-act="resolve" title="${it.resolved ? 'Reopen' : 'Resolve'}" aria-label="${it.resolved ? 'Reopen' : 'Resolve'}">${it.resolved ? '↺' : '✓'}</button>` : ''}
        ${canDelete ? '<button type="button" class="icon-btn small" data-act="delete" title="Delete thread" aria-label="Delete thread">🗑</button>' : ''}
      </div>
      ${it.quote ? `<blockquote class="rv-quote">${esc(clip(it.quote, 140))}</blockquote>` : ''}
      ${it.orphan ? '<div class="rv-orphan">The text this was about has been deleted.</div>' : ''}
      <div class="rv-text">${esc(it.text)}</div>
      ${it.replies.map((r) => `<div class="rv-reply-item">${chip(r.name, r.by)}<div><b>${esc(r.name)}</b> <span class="rv-time">${esc(timeAgo(r.at))}</span><div class="rv-text">${esc(r.text)}</div></div></div>`).join('')}
      ${canWrite ? `<form class="rv-reply" data-id="${esc(it.id)}"><textarea rows="1" placeholder="Reply…" aria-label="Reply">${esc(replyDrafts.get(it.id) || '')}</textarea><button class="btn small primary">Reply</button></form>` : ''}
    </div>`;
  }

  function render(force) {
    const m = model();
    const open = m.items.filter((i) => i.kind === 'suggestion' || !i.resolved);
    const resolved = m.items.filter((i) => i.kind === 'comment' && i.resolved);
    review.openIds = new Set(m.items.filter((i) => i.kind === 'comment' && !i.resolved).map((i) => i.id));
    onCount?.(open.length);
    const shown = filter === 'open' ? open : resolved;
    const suggestionCount = m.items.filter((i) => i.kind === 'suggestion').length;
    const sig = JSON.stringify([filter, !!m.pending, canWrite, editor.isEditable, review.activeId, shown.map((i) => [i.kind, i.id, i.text, i.quote, i.insText, i.delText, i.resolved, i.orphan, i.replies?.length])]);
    if (!force && sig === lastSig) return;
    lastSig = sig;

    const focused = document.activeElement;
    const focusId = focused && host.contains(focused) && focused.closest('.rv-reply') ? focused.closest('.rv-reply').dataset.id : null;

    host.innerHTML = `
      <div class="rv-top">
        <h3 class="grow">Comments &amp; suggestions</h3>
        <button type="button" class="icon-btn small" data-act="close" aria-label="Close panel">✕</button>
      </div>
      <div class="rv-tabs" role="tablist">
        <button type="button" role="tab" class="${filter === 'open' ? 'on' : ''}" data-filter="open" aria-selected="${filter === 'open'}">Open (${open.length})</button>
        <button type="button" role="tab" class="${filter === 'resolved' ? 'on' : ''}" data-filter="resolved" aria-selected="${filter === 'resolved'}">Resolved (${resolved.length})</button>
      </div>
      ${canWrite && editor.isEditable && suggestionCount > 1 && filter === 'open' ? `<div class="rv-bulk"><button type="button" class="btn small" data-act="accept-all">Accept all (${suggestionCount})</button><button type="button" class="btn small" data-act="reject-all">Reject all</button></div>` : ''}
      ${m.pending ? `<div class="rv-card composer">
        <blockquote class="rv-quote">${esc(clip(editor.state.doc.textBetween(m.pending.from, m.pending.to, ' '), 140))}</blockquote>
        <form class="rv-compose"><textarea rows="3" placeholder="Add a comment…" aria-label="Comment" autofocus>${esc(composerDraft)}</textarea>
        <div class="row end"><button type="button" class="btn small" data-act="cancel-compose">Cancel</button><button class="btn small primary">Comment</button></div></form>
      </div>` : ''}
      <div class="rv-list">${shown.map(cardHtml).join('') || `<p class="muted small rv-empty">${filter === 'open' ? (canWrite ? 'No open comments or suggestions. Select some text and press the comment button to start a conversation.' : 'No open comments or suggestions.') : 'Nothing resolved yet.'}</p>`}</div>`;

    const ta = $('.rv-compose textarea', host);
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    else if (focusId) {
      const back = $(`.rv-reply[data-id="${CSS.escape(focusId)}"] textarea`, host);
      if (back) { back.focus(); back.setSelectionRange(back.value.length, back.value.length); }
    }
  }

  const schedule = () => { clearTimeout(timer); timer = setTimeout(render, 200); };

  // ---- actions

  function post(text) {
    const pending = getPending(editor);
    if (!pending || !text.trim()) return;
    const id = rid();
    const quote = editor.state.doc.textBetween(pending.from, pending.to, ' ').slice(0, 300);
    ydoc.transact(() => {
      const t = new Y.Map();
      t.set('id', id); t.set('by', me.email); t.set('name', me.name); t.set('at', new Date().toISOString());
      t.set('text', text.trim()); t.set('resolved', false); t.set('quote', quote);
      t.set('replies', new Y.Array());
      threads.set(id, t);
    });
    editor.commands.anchorComment(id);
    composerDraft = '';
    review.activeId = id;
    render(true);
    editor.commands.redrawReview();
  }

  function reply(id, text) {
    const t = threads.get(id);
    if (!t || !text.trim()) return;
    t.get('replies').push([{ id: rid(), by: me.email, name: me.name, at: new Date().toISOString(), text: text.trim() }]);
    replyDrafts.delete(id);
  }

  function reveal(item, kindId) {
    review.activeId = kindId;
    const pos = item?.pos ?? item?.anchor?.from;
    if (pos !== undefined && pos !== Infinity) {
      try {
        const at = editor.view.domAtPos(pos).node;
        (at.nodeType === 1 ? at : at.parentElement)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch { /* position moved */ }
    }
    editor.commands.redrawReview();
    render(true);
  }

  host.addEventListener('click', (ev) => {
    const filterBtn = ev.target.closest('[data-filter]');
    if (filterBtn) { filter = filterBtn.dataset.filter; render(true); return; }
    const act = ev.target.closest('[data-act]');
    const card = ev.target.closest('.rv-card[data-id]');
    if (act) {
      const a = act.dataset.act;
      const id = card?.dataset.id;
      if (a === 'close') host.dispatchEvent(new CustomEvent('rv-close'));
      else if (a === 'cancel-compose') { composerDraft = ''; editor.commands.setPending(null); render(true); }
      else if (a === 'resolve') {
        const t = threads.get(id);
        if (t) { t.set('resolved', !t.get('resolved')); if (!t.get('resolved')) review.activeId = id; else if (review.activeId === id) review.activeId = null; }
        render(true); editor.commands.redrawReview();
      } else if (a === 'delete') {
        threads.delete(id);
        editor.commands.unanchorComment(id);
        render(true);
      } else if (a === 'accept' || a === 'reject') {
        editor.commands.resolveSuggestions(id, a === 'accept');
        if (review.activeId === id) review.activeId = null;
        render(true);
      } else if (a === 'accept-all' || a === 'reject-all') {
        editor.commands.resolveSuggestions(null, a === 'accept-all');
        toast(a === 'accept-all' ? 'All suggestions accepted' : 'All suggestions rejected');
        render(true);
      }
      return;
    }
    if (card && !ev.target.closest('form')) {
      const m = model();
      reveal(m.items.find((i) => i.id === card.dataset.id), card.dataset.id);
    }
  });

  host.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const ta = $('textarea', form);
    if (form.classList.contains('rv-compose')) post(ta.value);
    else { reply(form.dataset.id, ta.value); }
  });
  host.addEventListener('input', (ev) => {
    const ta = ev.target.closest('textarea');
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    if (ta.closest('.rv-compose')) composerDraft = ta.value;
    else replyDrafts.set(ta.closest('form').dataset.id, ta.value);
  });
  host.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && ev.target.matches('textarea')) {
      ev.preventDefault();
      ev.target.closest('form').requestSubmit();
    } else if (ev.key === 'Escape' && ev.target.closest('.rv-compose')) {
      composerDraft = ''; editor.commands.setPending(null); render(true);
    }
  });

  // clicking highlighted text in the page opens its card
  review.onClick = ({ comments, suggestions }) => {
    const id = comments[0] || suggestions[0];
    if (!id) return;
    review.activeId = id;
    if (!$('.rv-card[data-id="' + CSS.escape(id) + '"]', host)) {
      const resolved = threads.get(id)?.get('resolved');
      filter = resolved ? 'resolved' : 'open';
    }
    host.dispatchEvent(new CustomEvent('rv-open'));
    render(true);
    editor.commands.redrawReview();
    $('.rv-card[data-id="' + CSS.escape(id) + '"]', host)?.scrollIntoView({ block: 'nearest' });
  };

  const onTr = ({ transaction }) => { if (transaction.docChanged || transaction.getMeta('review')) schedule(); };
  editor.on('transaction', onTr);
  threads.observeDeep(schedule);
  render(true);

  return {
    // Starts a comment on the current selection.
    startComment() {
      const { from, to } = editor.state.selection;
      if (!canWrite) return false;
      if (from === to) { toast('Select some text to comment on first.'); return false; }
      editor.commands.setPending({ from, to });
      filter = 'open';
      host.dispatchEvent(new CustomEvent('rv-open'));
      render(true);
      return true;
    },
    refresh: () => render(true),
    destroy() {
      clearTimeout(timer);
      editor.off('transaction', onTr);
      threads.unobserveDeep(schedule);
      review.onClick = null;
    },
  };
}
