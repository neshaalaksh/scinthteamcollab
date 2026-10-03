// The rich text editor behind Docs. Built into vendor/editor.bundle.js by build.mjs.
// The app (js/views/docs.js) talks to it through window.TeamEditor.

import { Editor, Node, Extension, getSchema, mergeAttributes } from '@tiptap/core';
import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
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
    Embed,
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
  return new Editor({
    element: el,
    editable,
    extensions: [
      ...baseExtensions(),
      Placeholder.configure({ placeholder }),
      CharacterCount,
      Search,
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
}

window.TeamEditor = { createEditor, seedUpdate, Y, awarenessProtocol };
