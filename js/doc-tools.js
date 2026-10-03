// Everything around the doc editor that isn't the text itself: the formatting
// toolbar, the "/" menu, find & replace, and the link / image / embed dialogs.

import { S, inSpace } from './state.js';
import { $, $$, esc, openModal, toast } from './util.js';
import { toEmbed } from './embed.js';

// ---- icons (16px outlines)

const svg = (body) => `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  undo: svg('<path d="M4 8h8a4 4 0 010 8H7M4 8l3-3M4 8l3 3"/>'),
  redo: svg('<path d="M16 8H8a4 4 0 000 8h5M16 8l-3-3M16 8l-3 3"/>'),
  print: svg('<path d="M6 7V3h8v4M6 14H4V8h12v6h-2M6 12h8v5H6z"/>'),
  left: svg('<path d="M3 4h14M3 8h9M3 12h14M3 16h9"/>'),
  center: svg('<path d="M3 4h14M6 8h8M3 12h14M6 16h8"/>'),
  right: svg('<path d="M3 4h14M8 8h9M3 12h14M8 16h9"/>'),
  justify: svg('<path d="M3 4h14M3 8h14M3 12h14M3 16h14"/>'),
  ul: svg('<path d="M8 5h9M8 10h9M8 15h9"/><circle cx="4" cy="5" r=".8"/><circle cx="4" cy="10" r=".8"/><circle cx="4" cy="15" r=".8"/>'),
  ol: svg('<path d="M9 5h8M9 10h8M9 15h8M3.5 4l1-.8V7M3 11.5c0-1 2-1 2 0 0 .8-2 1.6-2 2.2h2M3 16.2h2l-1 1.2c1 0 1 1.4 0 1.4H3"/>'),
  task: svg('<rect x="3" y="3.5" width="5" height="5" rx="1"/><path d="M4.3 6l1.1 1.1L7 5M11 6h6M11 14h6"/><rect x="3" y="11.5" width="5" height="5" rx="1"/>'),
  indent: svg('<path d="M3 4h14M9 8h8M9 12h8M3 16h14M3 7l3 3-3 3"/>'),
  outdent: svg('<path d="M3 4h14M9 8h8M9 12h8M3 16h14M6 7l-3 3 3 3"/>'),
  link: svg('<path d="M8.5 11.5a3 3 0 004.2 0l3-3a3 3 0 00-4.2-4.2l-1 1M11.5 8.5a3 3 0 00-4.2 0l-3 3a3 3 0 004.2 4.2l1-1"/>'),
  image: svg('<rect x="3" y="4" width="14" height="12" rx="2"/><circle cx="7.5" cy="8.5" r="1.3"/><path d="M4 15l4-4 3 3 2-2 3 3"/>'),
  table: svg('<rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M3 8.5h14M3 12.5h14M8 4v12M12.5 4v12"/>'),
  find: svg('<circle cx="9" cy="9" r="5"/><path d="M13 13l4 4"/>'),
  more: svg('<circle cx="4.5" cy="10" r="1"/><circle cx="10" cy="10" r="1"/><circle cx="15.5" cy="10" r="1"/>'),
  embed: svg('<rect x="3" y="4" width="14" height="12" rx="2"/><path d="M8 8l4 2-4 2z"/>'),
};

// ---- small pop-up menus

let closePop = null;
export function popup(anchor, html, { onPick, className = '' } = {}) {
  closePop?.();
  const pop = document.createElement('div');
  pop.className = `pop-menu ${className}`;
  pop.innerHTML = html;
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${Math.min(r.bottom + 4, window.innerHeight - pop.offsetHeight - 8)}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8))}px`;
  const close = () => {
    pop.remove();
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    if (closePop === close) closePop = null;
  };
  const onDown = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  pop.addEventListener('mousedown', (e) => { if (!e.target.closest('input')) e.preventDefault(); });
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b || b.disabled) return;
    close();
    onPick?.(b.dataset.pick, b);
  });
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  closePop = close;
  return { pop, close };
}

const SWATCHES = [
  '#000000', '#434343', '#666666', '#999999', '#cccccc', '#ffffff',
  '#b91c1c', '#ea580c', '#ca8a04', '#15803d', '#0f766e', '#1d4ed8',
  '#7e22ce', '#be185d', '#fecaca', '#fed7aa', '#fef08a', '#bbf7d0', '#bfdbfe', '#e9d5ff',
];

function colorMenu(anchor, current, onPick) {
  const html = `
    <div class="swatches">${SWATCHES.map((c) => `<button type="button" data-pick="${c}" class="swatch ${c === current ? 'on' : ''}" style="background:${c}" title="${c}" aria-label="${c}"></button>`).join('')}</div>
    <label class="custom-color">Custom <input type="color" value="${/^#[0-9a-f]{6}$/i.test(current || '') ? current : '#0f766e'}"></label>
    <button type="button" data-pick="" class="pop-item">Remove colour</button>`;
  const { pop, close } = popup(anchor, html, { onPick: (v) => onPick(v || null) });
  $('input[type=color]', pop).onchange = (e) => { close(); onPick(e.target.value); };
}

// ---- the toolbar

const FONTS = [
  ['Default', ''],
  ['Arial', 'Arial, Helvetica, sans-serif'],
  ['Verdana', 'Verdana, Geneva, sans-serif'],
  ['Trebuchet MS', '"Trebuchet MS", sans-serif'],
  ['Georgia', 'Georgia, serif'],
  ['Times New Roman', '"Times New Roman", Times, serif'],
  ['Courier New', '"Courier New", monospace'],
  ['Comic Sans MS', '"Comic Sans MS", cursive'],
];
const SIZES = [10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];
const STYLES = [
  ['p', 'Normal text'], ['h1', 'Heading 1'], ['h2', 'Heading 2'], ['h3', 'Heading 3'], ['h4', 'Heading 4'],
  ['quote', 'Quote'], ['code', 'Code block'],
];

const run = (editor) => editor.chain().focus();

export function mountToolbar(host, editor, { onFind } = {}) {
  const btn = (id, icon, title, action, active) => ({ id, icon, title, action, active });
  const groups = [
    [
      btn('undo', ICON.undo, 'Undo (Ctrl+Z)', () => run(editor).undo().run()),
      btn('redo', ICON.redo, 'Redo (Ctrl+Y)', () => run(editor).redo().run()),
      btn('print', ICON.print, 'Print or save as PDF (Ctrl+P)', () => window.print()),
    ],
    ['style', 'font', 'size'],
    [
      btn('bold', '<b>B</b>', 'Bold (Ctrl+B)', () => run(editor).toggleBold().run(), () => editor.isActive('bold')),
      btn('italic', '<i>I</i>', 'Italic (Ctrl+I)', () => run(editor).toggleItalic().run(), () => editor.isActive('italic')),
      btn('underline', '<u>U</u>', 'Underline (Ctrl+U)', () => run(editor).toggleUnderline().run(), () => editor.isActive('underline')),
      btn('strike', '<s>S</s>', 'Strikethrough (Ctrl+Shift+S)', () => run(editor).toggleStrike().run(), () => editor.isActive('strike')),
      btn('color', '<span class="a-swatch">A<i id="tb-color-bar"></i></span>', 'Text colour', (el) =>
        colorMenu(el, editor.getAttributes('textStyle').color, (c) => (c ? run(editor).setColor(c).run() : run(editor).unsetColor().run()))),
      btn('highlight', '<span class="a-swatch hl">▇<i id="tb-hl-bar"></i></span>', 'Highlight colour', (el) =>
        colorMenu(el, editor.getAttributes('highlight').color, (c) => (c ? run(editor).setHighlight({ color: c }).run() : run(editor).unsetHighlight().run()))),
    ],
    [
      btn('left', ICON.left, 'Align left (Ctrl+Shift+L)', () => run(editor).setTextAlign('left').run(), () => editor.isActive({ textAlign: 'left' })),
      btn('center', ICON.center, 'Centre (Ctrl+Shift+E)', () => run(editor).setTextAlign('center').run(), () => editor.isActive({ textAlign: 'center' })),
      btn('right', ICON.right, 'Align right (Ctrl+Shift+R)', () => run(editor).setTextAlign('right').run(), () => editor.isActive({ textAlign: 'right' })),
      btn('justify', ICON.justify, 'Justify (Ctrl+Shift+J)', () => run(editor).setTextAlign('justify').run(), () => editor.isActive({ textAlign: 'justify' })),
    ],
    [
      btn('ul', ICON.ul, 'Bulleted list (Ctrl+Shift+8)', () => run(editor).toggleBulletList().run(), () => editor.isActive('bulletList')),
      btn('ol', ICON.ol, 'Numbered list (Ctrl+Shift+7)', () => run(editor).toggleOrderedList().run(), () => editor.isActive('orderedList')),
      btn('task', ICON.task, 'Checklist (Ctrl+Shift+9)', () => run(editor).toggleTaskList().run(), () => editor.isActive('taskList')),
      btn('outdent', ICON.outdent, 'Decrease indent (Shift+Tab)', () => {
        if (!run(editor).liftListItem('taskItem').run()) run(editor).liftListItem('listItem').run();
      }),
      btn('indent', ICON.indent, 'Increase indent (Tab)', () => {
        if (!run(editor).sinkListItem('taskItem').run()) run(editor).sinkListItem('listItem').run();
      }),
    ],
    [
      btn('link', ICON.link, 'Insert link (Ctrl+K)', () => openLinkDialog(editor), () => editor.isActive('link')),
      btn('image', ICON.image, 'Insert image from a link', () => openImageDialog(editor)),
      btn('table', ICON.table, 'Table', (el) => tableMenu(el, editor), () => editor.isActive('table')),
      btn('embed', `${ICON.embed}<span class="tb-label">Embed</span>`, 'Embed a Google Sheet, Doc, task, video…', (el) => embedMenu(el, editor)),
    ],
    [
      btn('find', ICON.find, 'Find and replace (Ctrl+F)', () => onFind?.()),
      btn('more', ICON.more, 'More formatting', (el) => moreMenu(el, editor)),
    ],
  ];

  const btns = new Map();
  host.innerHTML = '';
  for (const group of groups) {
    const g = document.createElement('div');
    g.className = 'tb-group';
    for (const item of group) {
      if (typeof item === 'string') { g.append(selectFor(item)); continue; }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `tb-btn tb-${item.id}`;
      b.innerHTML = item.icon;
      b.title = item.title;
      b.setAttribute('aria-label', item.title.replace(/ \(.*\)/, ''));
      b.onmousedown = (e) => e.preventDefault();   // keep the selection in the page
      b.onclick = () => item.action(b);
      btns.set(item.id, { el: b, item });
      g.append(b);
    }
    host.append(g);
  }

  function selectFor(kind) {
    const sel = document.createElement('select');
    sel.className = `tb-select tb-${kind}`;
    if (kind === 'style') {
      sel.title = 'Text style';
      sel.innerHTML = STYLES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
      sel.onchange = () => {
        const v = sel.value;
        const c = run(editor);
        if (v === 'p') c.setParagraph().run();
        else if (v === 'quote') c.setParagraph().toggleBlockquote().run();
        else if (v === 'code') c.toggleCodeBlock().run();
        else c.setHeading({ level: Number(v[1]) }).run();
      };
    } else if (kind === 'font') {
      sel.title = 'Font';
      sel.innerHTML = FONTS.map(([l, v]) => `<option value="${esc(v)}">${l}</option>`).join('');
      sel.onchange = () => (sel.value ? run(editor).setFontFamily(sel.value).run() : run(editor).unsetFontFamily().run());
    } else {
      sel.title = 'Font size';
      sel.innerHTML = `<option value="">15</option>${SIZES.map((n) => `<option value="${n}px">${n}</option>`).join('')}`;
      sel.onchange = () => (sel.value ? run(editor).setFontSize(sel.value).run() : run(editor).unsetFontSize().run());
    }
    sel.setAttribute('aria-label', sel.title);
    btns.set(kind, { sel });
    return sel;
  }

  // Reflects the current selection in the toolbar.
  let queued = false;
  function sync() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!editor.isEditable) return;
      for (const [id, entry] of btns) {
        if (entry.el) entry.el.classList.toggle('on', !!entry.item.active?.());
        if (id === 'undo') entry.el.disabled = !editor.can().undo();
        if (id === 'redo') entry.el.disabled = !editor.can().redo();
      }
      const style = editor.isActive('codeBlock') ? 'code' : editor.isActive('blockquote') ? 'quote'
        : [1, 2, 3, 4].find((l) => editor.isActive('heading', { level: l })) ? `h${[1, 2, 3, 4].find((l) => editor.isActive('heading', { level: l }))}` : 'p';
      btns.get('style').sel.value = style;
      const ff = editor.getAttributes('textStyle').fontFamily || '';
      const fsel = btns.get('font').sel;
      fsel.value = [...fsel.options].some((o) => o.value === ff) ? ff : '';
      const fs = editor.getAttributes('textStyle').fontSize || '';
      const ssel = btns.get('size').sel;
      ssel.value = [...ssel.options].some((o) => o.value === fs) ? fs : '';
      const bar = $('#tb-color-bar'); if (bar) bar.style.background = editor.getAttributes('textStyle').color || 'currentColor';
      const hl = $('#tb-hl-bar'); if (hl) hl.style.background = editor.getAttributes('highlight').color || '#fef08a';
    });
  }
  return { sync };
}

function tableMenu(anchor, editor) {
  const inTable = editor.isActive('table');
  const item = (cmd, label, ok = true) => `<button type="button" class="pop-item" data-pick="${cmd}" ${ok ? '' : 'disabled'}>${label}</button>`;
  const html = `
    <div class="pop-title">Insert table</div>
    <div class="grid-pick" id="grid-pick">${Array.from({ length: 36 }, (_, i) => `<button type="button" data-pick="ins-${Math.floor(i / 6) + 1}x${(i % 6) + 1}" data-r="${Math.floor(i / 6) + 1}" data-c="${(i % 6) + 1}" aria-label="${Math.floor(i / 6) + 1} by ${(i % 6) + 1}"></button>`).join('')}</div>
    <div class="pop-hint" id="grid-label">Pick a size</div>
    <div class="pop-sep"></div>
    ${item('rowBefore', 'Insert row above', inTable)}${item('rowAfter', 'Insert row below', inTable)}
    ${item('colBefore', 'Insert column left', inTable)}${item('colAfter', 'Insert column right', inTable)}
    ${item('delRow', 'Delete row', inTable)}${item('delCol', 'Delete column', inTable)}
    ${item('header', 'Toggle header row', inTable)}${item('merge', 'Merge cells', inTable)}${item('split', 'Split cell', inTable)}
    ${item('delTable', 'Delete table', inTable)}`;
  const { pop } = popup(anchor, html, {
    className: 'table-menu',
    onPick: (v) => {
      const c = run(editor);
      const map = {
        rowBefore: () => c.addRowBefore(), rowAfter: () => c.addRowAfter(), colBefore: () => c.addColumnBefore(), colAfter: () => c.addColumnAfter(),
        delRow: () => c.deleteRow(), delCol: () => c.deleteColumn(), header: () => c.toggleHeaderRow(), merge: () => c.mergeCells(),
        split: () => c.splitCell(), delTable: () => c.deleteTable(),
      };
      if (v.startsWith('ins-')) {
        const [rows, cols] = v.slice(4).split('x').map(Number);
        c.insertTable({ rows, cols, withHeaderRow: true }).run();
      } else map[v]?.().run();
    },
  });
  const cells = $$('#grid-pick button', pop);
  const label = $('#grid-label', pop);
  cells.forEach((b) => b.onmouseenter = () => {
    const r = Number(b.dataset.r); const cc = Number(b.dataset.c);
    cells.forEach((x) => x.classList.toggle('on', Number(x.dataset.r) <= r && Number(x.dataset.c) <= cc));
    label.textContent = `${r} × ${cc}`;
  });
}

function moreMenu(anchor, editor) {
  const lh = editor.getAttributes('paragraph').lineHeight || '1.15';
  const item = (cmd, label, on) => `<button type="button" class="pop-item ${on ? 'on' : ''}" data-pick="${cmd}">${label}</button>`;
  popup(anchor, `
    ${item('sub', 'Subscript (x₂)', editor.isActive('subscript'))}
    ${item('sup', 'Superscript (x²)', editor.isActive('superscript'))}
    ${item('code', 'Inline code', editor.isActive('code'))}
    ${item('hr', 'Horizontal line')}
    <div class="pop-sep"></div>
    <div class="pop-title">Line spacing</div>
    ${['1', '1.15', '1.5', '2'].map((v) => item(`lh-${v}`, v === '1.15' ? '1.15 (default)' : v, lh === v)).join('')}
    <div class="pop-sep"></div>
    ${item('clear', 'Clear formatting')}`, {
    onPick: (v) => {
      const c = run(editor);
      if (v === 'sub') c.toggleSubscript().run();
      else if (v === 'sup') c.toggleSuperscript().run();
      else if (v === 'code') c.toggleCode().run();
      else if (v === 'hr') c.setHorizontalRule().run();
      else if (v === 'clear') c.unsetAllMarks().clearNodes().unsetTextAlign().run();
      else if (v.startsWith('lh-')) c.setLineSpacing(v.slice(3)).run();
    },
  });
}

// ---- dialogs

export function openLinkDialog(editor) {
  const current = editor.getAttributes('link').href || '';
  const hasSelection = !editor.state.selection.empty || editor.isActive('link');
  const box = openModal(`
    <form class="stack">
      <div class="modal-head"><h2>Link</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
      ${hasSelection ? '' : '<label>Text to show<input class="input" name="text" placeholder="Optional"></label>'}
      <label>Web address<input class="input" name="url" required placeholder="https://" value="${esc(current)}" autofocus></label>
      <div class="row end">
        ${current ? '<button type="button" class="btn danger" id="unlink">Remove link</button><span class="grow"></span>' : ''}
        <button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Apply</button>
      </div>
    </form>`);
  const form = $('form', box);
  form.onsubmit = (e) => {
    e.preventDefault();
    let url = form.elements.url.value.trim();
    if (!/^(https?:|mailto:|#|\/)/i.test(url)) url = `https://${url}`;
    box.close();
    const c = editor.chain().focus();
    if (hasSelection) c.extendMarkRange('link').setLink({ href: url }).run();
    else {
      const text = form.elements.text?.value.trim() || url;
      c.insertContent({ type: 'text', text, marks: [{ type: 'link', attrs: { href: url } }] }).run();
    }
  };
  const un = $('#unlink', box);
  if (un) un.onclick = () => { box.close(); editor.chain().focus().extendMarkRange('link').unsetLink().run(); };
}

function openImageDialog(editor) {
  const box = openModal(`
    <form class="stack">
      <div class="modal-head"><h2>Insert image</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
      <label>Image address<input class="input" name="url" required placeholder="https://…/picture.png" autofocus></label>
      <label>Description (for screen readers)<input class="input" name="alt" placeholder="Optional"></label>
      <p class="small muted">Paste a link to a picture that's already online (for example from Google Drive's public link or your website).</p>
      <div class="row end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Insert</button></div>
    </form>`);
  const form = $('form', box);
  form.onsubmit = (e) => {
    e.preventDefault();
    const src = form.elements.url.value.trim();
    if (!/^https:\/\//i.test(src)) { toast('Use an https:// link to the image.', 'error'); return; }
    box.close();
    editor.chain().focus().setImage({ src, alt: form.elements.alt.value.trim() }).run();
  };
}

// ---- embeds

const EMBED_KINDS = [
  { id: 'sheet', label: 'Google Sheet', hint: 'Paste the sheet link' },
  { id: 'doc', label: 'Google Doc', hint: 'Paste the Google Doc link' },
  { id: 'task', label: 'Link a task' },
  { id: 'slides', label: 'Google Slides / Form / Drive file', hint: 'Paste the link' },
  { id: 'video', label: 'YouTube / Loom / Figma', hint: 'Paste the link' },
];

function embedMenu(anchor, editor) {
  popup(anchor, EMBED_KINDS.map((k) => `<button type="button" class="pop-item" data-pick="${k.id}">${esc(k.label)}</button>`).join(''), {
    onPick: (id) => embedKind(editor, id),
  });
}

export function embedKind(editor, id) {
  if (id === 'task') pickTask(editor);
  else askLink(editor, EMBED_KINDS.find((k) => k.id === id));
}

function insertEmbed(editor, url, height) {
  if (!toEmbed(url)) {
    editor.chain().focus().insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }).run();
    toast("We can't embed that link, so it was added as a normal link.");
    return;
  }
  editor.chain().focus().insertContent({ type: 'embed', attrs: { url, height: height || null } }).run();
}

function askLink(editor, kind) {
  const box = openModal(`
    <form class="stack">
      <div class="modal-head"><h2>Embed: ${esc(kind.label)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
      <label>${esc(kind.hint)}<input class="input" name="url" required placeholder="https://docs.google.com/…" autofocus></label>
      ${kind.id === 'sheet' ? `<fieldset><legend>Show it as</legend>
        <label class="check"><input type="radio" name="mode" value="edit" checked> Editable (people edit inside the app; needs Google sign-in)</label>
        <label class="check"><input type="radio" name="mode" value="view"> Read-only (works for everyone)</label></fieldset>` : ''}
      <label>Height in pixels (optional)<input class="input" name="height" type="number" min="150" max="2000" placeholder="auto"></label>
      <p class="small muted" id="embed-check"></p>
      <div class="row end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Embed</button></div>
    </form>`);
  const form = $('form', box);
  form.elements.url.oninput = (e) => {
    const info = toEmbed(e.target.value);
    $('#embed-check', box).textContent = e.target.value ? (info ? `Looks good: ${info.label}` : "We can't embed that link, so it will show as a normal link.") : '';
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    let url = form.elements.url.value.trim();
    if (kind.id === 'sheet' && form.elements.mode?.value === 'view') {
      url = url.replace(/\/(edit|htmlview|preview)([?#].*)?$/, '/preview$2').replace(/\/d\/([\w-]+)\/?$/, '/d/$1/preview');
    }
    box.close();
    insertEmbed(editor, url, Number(form.elements.height.value) || null);
  };
}

function pickTask(editor) {
  const tasks = S.tasks.filter(inSpace).slice(0, 200);
  const box = openModal(`
    <div class="modal-head"><h2>Link a task</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <input class="input" placeholder="Search tasks…" aria-label="Search tasks" id="task-pick-q" autofocus>
    <div class="pick-list" id="task-pick"></div>`);
  const list = () => {
    const q = $('#task-pick-q', box).value.toLowerCase();
    $('#task-pick', box).innerHTML = tasks.filter((t) => t.title.toLowerCase().includes(q)).slice(0, 30)
      .map((t) => `<button class="row-btn" data-id="${esc(t.id)}">${esc(t.title)}</button>`).join('') || '<p class="muted">No tasks match.</p>';
    $$('[data-id]', box).forEach((b) => b.onclick = () => {
      const t = S.tasks.find((x) => x.id === b.dataset.id);
      box.close();
      editor.chain().focus().insertContent({ type: 'text', text: `☑ ${t.title}`, marks: [{ type: 'link', attrs: { href: `#/tasks/${t.id}` } }] }).run();
    });
  };
  $('#task-pick-q', box).oninput = list;
  list();
}

// ---- "/" menu: type / on an empty line to insert blocks quickly

const SLASH_ITEMS = [
  { label: 'Heading 1', keys: 'h1 title', run: (e) => e.setHeading({ level: 1 }) },
  { label: 'Heading 2', keys: 'h2 subtitle', run: (e) => e.setHeading({ level: 2 }) },
  { label: 'Heading 3', keys: 'h3', run: (e) => e.setHeading({ level: 3 }) },
  { label: 'Bulleted list', keys: 'bullets ul', run: (e) => e.toggleBulletList() },
  { label: 'Numbered list', keys: 'ol ordered', run: (e) => e.toggleOrderedList() },
  { label: 'Checklist', keys: 'todo task check', run: (e) => e.toggleTaskList() },
  { label: 'Quote', keys: 'blockquote', run: (e) => e.toggleBlockquote() },
  { label: 'Code block', keys: 'code', run: (e) => e.toggleCodeBlock() },
  { label: 'Table', keys: 'grid', run: (e) => e.insertTable({ rows: 3, cols: 3, withHeaderRow: true }) },
  { label: 'Divider', keys: 'line hr', run: (e) => e.setHorizontalRule() },
  { label: 'Image', keys: 'picture photo', after: (ed) => openImageDialog(ed) },
  { label: 'Google Sheet', keys: 'embed spreadsheet', after: (ed) => embedKind(ed, 'sheet') },
  { label: 'Google Doc', keys: 'embed document', after: (ed) => embedKind(ed, 'doc') },
  { label: 'Link a task', keys: 'task embed', after: (ed) => embedKind(ed, 'task') },
  { label: 'Slides / Form / Drive file', keys: 'embed presentation', after: (ed) => embedKind(ed, 'slides') },
  { label: 'YouTube / Loom / Figma', keys: 'embed video', after: (ed) => embedKind(ed, 'video') },
];

export function attachSlash(editor) {
  let menu = null;
  let idx = 0;
  let matches = [];
  let range = null;

  const close = () => { menu?.remove(); menu = null; range = null; };

  const context = () => {
    const { state } = editor;
    const { $from, empty } = state.selection;
    if (!empty || $from.parent.type.name !== 'paragraph') return null;
    const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
    const m = before.match(/^\/([\w ]*)$/);
    return m ? { query: m[1].toLowerCase().trim(), from: $from.start(), to: $from.pos } : null;
  };

  const draw = () => {
    const rect = editor.view.coordsAtPos(range.to);
    menu.innerHTML = matches.map((it, i) => `<button type="button" class="${i === idx ? 'on' : ''}" data-i="${i}">${esc(it.label)}</button>`).join('');
    menu.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`;
    menu.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - menu.offsetHeight - 8)}px`;
    menu.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };

  const choose = (i) => {
    const it = matches[i];
    const r = range;
    close();
    if (!it) return;
    const c = editor.chain().focus().deleteRange({ from: r.from, to: r.to });
    if (it.run) it.run(c).run();
    else c.run();
    it.after?.(editor);
  };

  const update = () => {
    const ctx = editor.isEditable && editor.isFocused ? context() : null;
    if (!ctx) return close();
    matches = SLASH_ITEMS.filter((it) => !ctx.query || `${it.label} ${it.keys}`.toLowerCase().includes(ctx.query));
    if (!matches.length) return close();
    range = ctx;
    if (!menu) {
      menu = document.createElement('div');
      menu.className = 'slash-menu';
      menu.setAttribute('role', 'menu');
      menu.onmousedown = (e) => { e.preventDefault(); const b = e.target.closest('[data-i]'); if (b) choose(Number(b.dataset.i)); };
      document.body.append(menu);
      idx = 0;
    }
    idx = Math.min(idx, matches.length - 1);
    draw();
  };

  const onKey = (e) => {
    if (!menu) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      idx = (idx + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length;
      draw();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault(); e.stopPropagation();
      choose(idx);
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      close();
    }
  };
  editor.view.dom.addEventListener('keydown', onKey, true);
  editor.on('transaction', update);
  editor.on('blur', close);
  return () => { close(); editor.view.dom.removeEventListener('keydown', onKey, true); editor.off('transaction', update); editor.off('blur', close); };
}

// ---- find & replace bar

export function mountFindBar(host, editor) {
  host.innerHTML = `
    <input class="input" id="find-q" placeholder="Find" aria-label="Find">
    <input class="input" id="find-r" placeholder="Replace with" aria-label="Replace with">
    <span class="small muted" id="find-n" aria-live="polite"></span>
    <button type="button" class="btn small" id="find-prev" aria-label="Previous match">↑</button>
    <button type="button" class="btn small" id="find-next" aria-label="Next match">↓</button>
    <button type="button" class="btn small" id="find-rep">Replace</button>
    <button type="button" class="btn small" id="find-all">Replace all</button>
    <label class="check small"><input type="checkbox" id="find-case"> Match case</label>
    <button type="button" class="icon-btn small" id="find-x" aria-label="Close find">✕</button>`;
  host.hidden = true;
  const q = $('#find-q', host);
  const count = () => {
    const m = editor.storage.search.matches.length;
    $('#find-n', host).textContent = q.value ? (m ? `${editor.storage.search.index + 1} of ${m}` : 'No matches') : '';
  };
  const search = () => { editor.commands.setSearch(q.value, $('#find-case', host).checked); count(); };
  q.oninput = search;
  $('#find-case', host).onchange = search;
  q.onkeydown = (e) => { if (e.key === 'Enter') { editor.commands.stepSearch(e.shiftKey ? -1 : 1); count(); } };
  $('#find-next', host).onclick = () => { editor.commands.stepSearch(1); count(); };
  $('#find-prev', host).onclick = () => { editor.commands.stepSearch(-1); count(); };
  $('#find-rep', host).onclick = () => { editor.commands.replaceCurrent($('#find-r', host).value); count(); };
  $('#find-all', host).onclick = () => { editor.commands.replaceAllMatches($('#find-r', host).value); count(); };
  const hide = () => { host.hidden = true; editor.commands.setSearch(''); editor.commands.focus(); };
  $('#find-x', host).onclick = hide;
  host.onkeydown = (e) => { if (e.key === 'Escape') hide(); };
  return {
    open() {
      host.hidden = false;
      const sel = editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to);
      if (sel && !sel.includes('\n')) q.value = sel;
      q.focus(); q.select();
      search();
    },
  };
}
