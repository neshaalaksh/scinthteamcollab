// The rich text editor behind Docs. Built into vendor/editor.bundle.js by build.mjs.
// The app (js/views/docs.js) talks to it through window.TeamEditor.

import { Editor, Node, Mark as TMark, Extension, getSchema, mergeAttributes } from '@tiptap/core';
import { DOMParser as PMDOMParser, Mark } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import { TextStyle, Color, BackgroundColor, FontFamily, FontSize } from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import CharacterCount from '@tiptap/extension-character-count';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { updateYFragment } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { toEmbed, embedHtml } from '../../../js/embed.js';

const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// ---- embeds: a Google Sheet / Doc / video etc. that lives inside the page

const Embed = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      url: { default: '', parseHTML: (el) => el.getAttribute('data-embed') },
      height: { default: null, parseHTML: (el) => Number(el.getAttribute('data-height')) || null },
    };
  },
  parseHTML() { return [{ tag: 'div[data-embed]' }]; },
  renderHTML({ node }) {
    return ['div', mergeAttributes({ 'data-embed': node.attrs.url, 'data-height': node.attrs.height || '' }), node.attrs.url];
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div');
      dom.className = 'embed-node';
      dom.contentEditable = 'false';
      const info = toEmbed(node.attrs.url);
      dom.innerHTML = info
        ? embedHtml(info, node.attrs.height || undefined)
        : `<p class="embed-missing">Can't embed <a href="${escAttr(node.attrs.url)}" target="_blank" rel="noopener">${escAttr(node.attrs.url)}</a></p>`;
      return { dom };
    };
  },
});

// ---- find & replace

const searchKey = new PluginKey('search');
const Search = Extension.create({
  name: 'search',
  addStorage() { return { term: '', matchCase: false, index: 0, matches: [] }; },
  addProseMirrorPlugins() {
    const storage = this.storage;
    const scan = (doc) => {
      const out = [];
      if (!storage.term) return out;
      const needle = storage.matchCase ? storage.term : storage.term.toLowerCase();
      doc.descendants((node, pos) => {
        if (!node.isText) return;
        const hay = storage.matchCase ? node.text : node.text.toLowerCase();
        let i = hay.indexOf(needle);
        while (i >= 0) { out.push({ from: pos + i, to: pos + i + needle.length }); i = hay.indexOf(needle, i + needle.length); }
      });
      return out;
    };
    return [new Plugin({
      key: searchKey,
      props: {
        decorations(state) {
          storage.matches = scan(state.doc);
          if (!storage.matches.length) return DecorationSet.empty;
          storage.index = Math.min(storage.index, storage.matches.length - 1);
          return DecorationSet.create(state.doc, storage.matches.map((m, i) =>
            Decoration.inline(m.from, m.to, { class: i === storage.index ? 'find-hit current' : 'find-hit' })));
        },
      },
    })];
  },
  addCommands() {
    const storage = this.storage;
    const poke = (tr, dispatch) => { if (dispatch) dispatch(tr.setMeta(searchKey, Date.now())); return true; };
    return {
      setSearch: (term, matchCase = false) => ({ tr, dispatch }) => {
        storage.term = term; storage.matchCase = matchCase; storage.index = 0;
        return poke(tr, dispatch);
      },
      stepSearch: (dir) => ({ tr, dispatch, editor }) => {
        const n = storage.matches.length;
        if (!n) return false;
        storage.index = (storage.index + dir + n) % n;
        const m = storage.matches[storage.index];
        poke(tr, dispatch);
        const at = editor.view.domAtPos(m.from).node;
        (at.nodeType === 1 ? at : at.parentElement)?.scrollIntoView({ block: 'center' });
        return true;
      },
      replaceCurrent: (text) => ({ tr, dispatch }) => {
        const m = storage.matches[storage.index];
        if (!m) return false;
        if (dispatch) dispatch(tr.insertText(text, m.from, m.to));
        return true;
      },
      replaceAllMatches: (text) => ({ tr, dispatch }) => {
        const ms = [...storage.matches].reverse();
        if (!ms.length) return false;
        if (dispatch) { ms.forEach((m) => tr.insertText(text, m.from, m.to)); dispatch(tr); }
        return true;
      },
    };
  },
});


// ---- comments and suggestions
//
// A comment is a `comment` mark on the text it is about; the thread itself (author, replies,
// resolved) lives in the shared doc's "threads" map (see js/doc-review.js).
// A suggestion is text marked as proposed: `suggestInsert` (new text) or `suggestDelete`
// (text that would go). Accepting or rejecting turns the marks into real edits or removes them.

const markAttrs = (extra = {}) => ({
  id: { default: null, parseHTML: (el) => el.getAttribute('data-sid'), renderHTML: (a) => ({ 'data-sid': a.id }) },
  by: { default: '', parseHTML: (el) => el.getAttribute('data-by') || '', renderHTML: (a) => ({ 'data-by': a.by }) },
  name: { default: '', parseHTML: (el) => el.getAttribute('data-name') || '', renderHTML: (a) => ({ 'data-name': a.name }) },
  at: { default: '', parseHTML: (el) => el.getAttribute('data-at') || '', renderHTML: (a) => ({ 'data-at': a.at }) },
  color: { default: '#0f766e', parseHTML: (el) => el.style.getPropertyValue('--c') || '#0f766e', renderHTML: (a) => ({ style: `--c:${a.color}` }) },
  ...extra,
});

const Comment = TMark.create({
  name: 'comment',
  inclusive: false,
  excludes: '',
  addAttributes() {
    return { id: { default: null, parseHTML: (el) => el.getAttribute('data-comment'), renderHTML: (a) => ({ 'data-comment': a.id }) } };
  },
  parseHTML() { return [{ tag: 'span[data-comment]' }]; },
  renderHTML({ HTMLAttributes }) { return ['span', HTMLAttributes, 0]; },
});

const suggestMark = (name, kind) => TMark.create({
  name,
  inclusive: false,
  excludes: '',
  addAttributes() { return markAttrs(); },
  parseHTML() { return [{ tag: `span[data-suggest="${kind}"]` }]; },
  renderHTML({ HTMLAttributes }) { return ['span', mergeAttributes(HTMLAttributes, { 'data-suggest': kind }), 0]; },
});
const SuggestInsert = suggestMark('suggestInsert', 'insert');
const SuggestDelete = suggestMark('suggestDelete', 'delete');

const reviewKey = new PluginKey('review');
const newId = () => `s${Math.random().toString(36).slice(2, 9)}`;
const mergeRanges = (list) => list.reduce((out, r) => {
  const last = out[out.length - 1];
  if (last && last.to >= r.from) last.to = Math.max(last.to, r.to); else out.push({ ...r });
  return out;
}, []);

// Walks the doc once and gathers where every comment and suggestion sits.
function scanReview(doc) {
  const comments = new Map();
  const suggestions = new Map();
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const from = pos; const to = pos + node.nodeSize;
    for (const m of node.marks) {
      const n = m.type.name;
      if (n === 'comment') {
        const c = comments.get(m.attrs.id) || { id: m.attrs.id, ranges: [] };
        c.ranges.push({ from, to });
        comments.set(m.attrs.id, c);
      } else if (n === 'suggestInsert' || n === 'suggestDelete') {
        const sg = suggestions.get(m.attrs.id) || { id: m.attrs.id, by: m.attrs.by, name: m.attrs.name, at: m.attrs.at, color: m.attrs.color, ins: [], del: [] };
        const list = n === 'suggestInsert' ? sg.ins : sg.del;
        const last = list[list.length - 1];
        if (last && last.to === from) { last.to = to; last.text += node.text; } else list.push({ from, to, text: node.text });
        suggestions.set(m.attrs.id, sg);
      }
    }
  });
  for (const c of comments.values()) {
    c.ranges = mergeRanges(c.ranges.sort((a, b) => a.from - b.from));
    c.from = c.ranges[0].from;
    c.to = c.ranges[c.ranges.length - 1].to;
    c.quote = c.ranges.map((r) => doc.textBetween(r.from, r.to, ' ')).join(' … ');
  }
  for (const sg of suggestions.values()) {
    sg.from = Math.min(...[...sg.ins, ...sg.del].map((r) => r.from));
    sg.insText = sg.ins.map((r) => r.text).join('');
    sg.delText = sg.del.map((r) => r.text).join('');
  }
  return { comments, suggestions };
}

// Marks [from, to) as deleted by me. Text I suggested myself is simply removed; text
// already marked as deleted is left alone. Returns the suggestion id used.
function suggestDeleteRange(tr, from, to, storage) {
  const { schema } = tr.doc.type;
  const insM = schema.marks.suggestInsert;
  const delM = schema.marks.suggestDelete;
  const me = storage.user;
  const near = (pos, dir) => {
    const $p = tr.doc.resolve(pos);
    const n = dir < 0 ? $p.nodeBefore : $p.nodeAfter;
    return n?.marks.find((m) => m.type === delM && m.attrs.by === me.email);
  };
  const adjacent = near(from, -1) || near(to, 1);
  const id = adjacent?.attrs.id ?? newId();
  const segs = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return;
    const s = Math.max(pos, from); const e = Math.min(pos + node.nodeSize, to);
    if (s < e) segs.push({ s, e, node });
  });
  // Same id and details as the neighbouring deletion, so they join into one mark.
  const mark = delM.create(adjacent ? adjacent.attrs : { id, by: me.email, name: me.name, at: new Date().toISOString(), color: me.color });
  for (const seg of segs.reverse()) {
    if (seg.node.marks.some((m) => m.type === insM && m.attrs.by === me.email)) tr.delete(seg.s, seg.e);
    else if (!seg.node.marks.some((m) => m.type === delM)) tr.addMark(seg.s, seg.e, mark);
  }
  return id;
}

const Review = Extension.create({
  name: 'review',
  addStorage() {
    return { mode: 'edit', user: { email: '', name: '', color: '#0f766e' }, openIds: new Set(), activeId: null, onClick: null };
  },
  addProseMirrorPlugins() {
    const storage = this.storage;
    const suggesting = () => storage.mode === 'suggest';
    return [new Plugin({
      key: reviewKey,
      state: {
        init: () => ({ pending: null }),
        apply(tr, value) {
          const meta = tr.getMeta(reviewKey);
          if (meta) return { pending: meta.pending };
          if (value.pending && tr.docChanged) {
            const from = tr.mapping.map(value.pending.from, 1);
            const to = tr.mapping.map(value.pending.to, -1);
            return { pending: from < to ? { from, to } : null };
          }
          return value;
        },
      },
      props: {
        decorations(state) {
          const decos = [];
          const { comments } = scanReview(state.doc);
          for (const c of comments.values()) {
            if (!storage.openIds.has(c.id)) continue;
            const cls = c.id === storage.activeId ? 'comment-hit active' : 'comment-hit';
            c.ranges.forEach((r) => decos.push(Decoration.inline(r.from, r.to, { class: cls })));
          }
          const { pending } = reviewKey.getState(state);
          if (pending) decos.push(Decoration.inline(pending.from, pending.to, { class: 'comment-hit pending' }));
          return decos.length ? DecorationSet.create(state.doc, decos) : DecorationSet.empty;
        },
        handleClick(view, pos) {
          if (!storage.onClick) return false;
          const $p = view.state.doc.resolve(pos);
          const marks = [...$p.marks(), ...($p.nodeAfter?.marks || [])];
          const ids = { comments: [], suggestions: [] };
          marks.forEach((m) => {
            if (m.type.name === 'comment') ids.comments.push(m.attrs.id);
            else if (m.type.name === 'suggestInsert' || m.type.name === 'suggestDelete') ids.suggestions.push(m.attrs.id);
          });
          if (ids.comments.length || ids.suggestions.length) storage.onClick(ids);
          return false;
        },
        // ---- suggesting mode: typing, deleting and pasting become proposals
        handleTextInput(view, from, to, text) {
          if (!suggesting()) return false;
          const { schema } = view.state;
          const me = storage.user;
          const tr = view.state.tr;
          let pos = from;
          let delId = null;
          if (from !== to) { delId = suggestDeleteRange(tr, from, to, storage); pos = tr.mapping.map(to); }
          const $pos = tr.doc.resolve(pos);
          const prev = $pos.nodeBefore?.marks.find((m) => m.type === schema.marks.suggestInsert && m.attrs.by === me.email);
          const id = prev?.attrs.id ?? delId ?? newId();
          const skip = ['comment', 'suggestInsert', 'suggestDelete'];
          const base = (tr.storedMarks ?? $pos.marks()).filter((m) => !skip.includes(m.type.name));
          const ins = schema.marks.suggestInsert.create(prev ? prev.attrs : { id, by: me.email, name: me.name, at: new Date().toISOString(), color: me.color });
          tr.insert(pos, schema.text(text, Mark.setFrom([...base, ins])));
          tr.setSelection(TextSelection.create(tr.doc, pos + text.length));
          view.dispatch(tr);
          return true;
        },
        handleKeyDown(view, ev) {
          if (!suggesting() || (ev.key !== 'Backspace' && ev.key !== 'Delete')) return false;
          const { selection } = view.state;
          const back = ev.key === 'Backspace';
          let from; let to;
          if (!selection.empty) { from = selection.from; to = selection.to; } else {
            const $h = selection.$head;
            if (!$h.parent.isTextblock) return false;
            const off = $h.parentOffset;
            const word = ev.ctrlKey || ev.altKey;
            if (back) {
              if (off === 0) return false;
              const before = $h.parent.textBetween(0, off, undefined, '￼');
              const len = word ? (before.match(/\S+\s*$|\s+$/)?.[0].length || 1) : 1;
              from = $h.pos - len; to = $h.pos;
            } else {
              const after = $h.parent.textBetween(off, $h.parent.content.size, undefined, '￼');
              if (!after) return false;
              const len = word ? (after.match(/^\s*\S+|^\s+/)?.[0].length || 1) : 1;
              from = $h.pos; to = $h.pos + len;
            }
          }
          const tr = view.state.tr;
          suggestDeleteRange(tr, from, to, storage);
          const caret = back && selection.empty ? tr.mapping.map(from) : tr.mapping.map(to);
          tr.setSelection(TextSelection.near(tr.doc.resolve(caret), back ? -1 : 1));
          view.dispatch(tr);
          ev.preventDefault();
          return true;
        },
        handlePaste(view, ev, slice) {
          if (!suggesting()) return false;
          const { schema, selection } = view.state;
          const me = storage.user;
          const tr = view.state.tr;
          let pos = selection.to;
          let delId = null;
          if (!selection.empty) { delId = suggestDeleteRange(tr, selection.from, selection.to, storage); pos = tr.mapping.map(selection.to); }
          const before = tr.doc.content.size;
          tr.replaceRange(pos, pos, slice);
          const end = pos + (tr.doc.content.size - before);
          tr.addMark(pos, end, schema.marks.suggestInsert.create({ id: delId ?? newId(), by: me.email, name: me.name, at: new Date().toISOString(), color: me.color }));
          tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(end, tr.doc.content.size))));
          view.dispatch(tr);
          return true;
        },
        handleDrop: () => suggesting(),
        handleDOMEvents: {
          cut(view, ev) {
            if (!suggesting() || view.state.selection.empty) return false;
            const { from, to } = view.state.selection;
            ev.clipboardData?.setData('text/plain', view.state.doc.textBetween(from, to, '\n'));
            ev.preventDefault();
            const tr = view.state.tr;
            suggestDeleteRange(tr, from, to, storage);
            tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(to))));
            view.dispatch(tr);
            return true;
          },
        },
      },
    })];
  },
  addCommands() {
    const storage = this.storage;
    return {
      redrawReview: () => ({ tr, state, dispatch }) => { if (dispatch) dispatch(tr.setMeta('addToHistory', false).setMeta(reviewKey, { pending: reviewKey.getState(state).pending })); return true; },
      setPending: (range) => ({ tr, dispatch }) => { if (dispatch) dispatch(tr.setMeta(reviewKey, { pending: range }).setMeta('addToHistory', false)); return true; },
      // Anchors a comment to the pending selection.
      anchorComment: (id) => ({ tr, state, dispatch }) => {
        const { pending } = reviewKey.getState(state);
        if (!pending) return false;
        tr.addMark(pending.from, pending.to, state.schema.marks.comment.create({ id }));
        tr.setMeta(reviewKey, { pending: null });
        if (dispatch) dispatch(tr);
        return true;
      },
      unanchorComment: (id) => ({ tr, state, dispatch }) => {
        const mark = state.schema.marks.comment.create({ id });
        state.doc.descendants((node, pos) => { if (node.isText && node.marks.some((m) => m.eq(mark))) tr.removeMark(pos, pos + node.nodeSize, mark); });
        if (dispatch) dispatch(tr);
        return true;
      },
      // Accept or reject one suggestion (by id), or all of them (id = null).
      resolveSuggestions: (id, accept) => ({ tr, state, dispatch }) => {
        const found = [];
        state.doc.descendants((node, pos) => {
          if (!node.isText) return;
          for (const m of node.marks) {
            const isIns = m.type.name === 'suggestInsert';
            if ((isIns || m.type.name === 'suggestDelete') && (id === null || m.attrs.id === id)) found.push({ isIns, from: pos, to: pos + node.nodeSize, mark: m });
          }
        });
        for (const r of found) {
          const from = tr.mapping.map(r.from, 1);
          const to = tr.mapping.map(r.to, -1);
          if (from >= to) continue;
          const removeText = r.isIns ? !accept : accept;
          if (removeText) tr.delete(from, to); else tr.removeMark(from, to, r.mark);
        }
        if (dispatch) dispatch(tr);
        return found.length > 0;
      },
    };
  },
});

const getPending = (editor) => reviewKey.getState(editor.state)?.pending || null;

// ---- line spacing (1, 1.15, 1.5, 2) on whole paragraphs and headings

const LineSpacing = Extension.create({
  name: 'lineSpacing',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading'],
      attributes: {
        lineHeight: {
          default: null,
          parseHTML: (el) => el.style.lineHeight || null,
          renderHTML: (a) => (a.lineHeight ? { style: `line-height:${a.lineHeight}` } : {}),
        },
      },
    }];
  },
  addCommands() {
    return {
      setLineSpacing: (value) => ({ commands }) => {
        const v = value === '1.15' ? null : value;
        return ['paragraph', 'heading'].map((t) => commands.updateAttributes(t, { lineHeight: v })).some(Boolean);
      },
    };
  },
});

// ---- put it together

function baseExtensions() {
  return [
    StarterKit.configure({
      undoRedo: false,   // Yjs keeps its own history, so Undo only undoes your own edits
      heading: { levels: [1, 2, 3, 4] },
      link: { openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' } },
    }),
    TextStyle, Color, BackgroundColor, FontFamily, FontSize, LineSpacing,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Subscript, Superscript,
    Table.configure({ resizable: true }), TableRow, TableHeader, TableCell,
    TaskList, TaskItem.configure({ nested: true }),
    Image.configure({ allowBase64: false }),
    Embed, Comment, SuggestInsert, SuggestDelete,
  ];
}

// The doc as Yjs data, built the same way on every computer. Two people opening an
// old doc at the same moment both build this identical seed, so it merges instead of doubling.
function seedUpdate(html) {
  const schema = getSchema(baseExtensions());
  const host = document.createElement('div');
  host.innerHTML = html;
  const node = PMDOMParser.fromSchema(schema).parse(host);
  const doc = new Y.Doc();
  doc.clientID = 1;
  doc.transact(() => updateYFragment(doc, doc.getXmlFragment('default'), node, { mapping: new Map(), isOMark: new Map() }));
  return Y.encodeStateAsUpdate(doc);
}

function createEditor({ el, ydoc, awareness, user, editable = true, placeholder = 'Start writing…', onUpdate, onTransaction }) {
  const ed = new Editor({
    element: el,
    editable,
    extensions: [
      ...baseExtensions(),
      Placeholder.configure({ placeholder }),
      CharacterCount,
      Search,
      Review,
      Collaboration.configure({ document: ydoc }),
      ...(awareness ? [CollaborationCaret.configure({
        provider: { awareness },
        user,
        render: (u) => {
          const caret = document.createElement('span');
          caret.className = 'remote-caret';
          caret.style.setProperty('--c', u.color);
          const label = document.createElement('span');
          label.className = 'remote-caret-label';
          label.textContent = u.name;
          caret.append(label);
          return caret;
        },
      })] : []),
    ],
    editorProps: { attributes: { class: 'doc-page-content', spellcheck: 'true' } },
    onUpdate: () => onUpdate?.(),
    onTransaction: () => onTransaction?.(),
  });
  return ed;
}

window.TeamEditor = { createEditor, seedUpdate, scanReview, getPending, Y, awarenessProtocol };
