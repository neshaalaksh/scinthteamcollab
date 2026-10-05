// Live co-editing: keeps one doc's Yjs data and cursors in step with everyone else
// who has it open. Changes travel as small broadcasts on a private Supabase Realtime
// channel (doc:<id>). In demo mode the same messages go between browser tabs instead.
//
// Messages: { t: 'update', d }  a Yjs change
//           { t: 'sync', sv, reply? }  "here is what I have, send what I'm missing"
//           { t: 'aw', d }      cursor / presence changes

import { isDemo } from './config.js';
import { docChannel } from './supabase.js';

export function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const REMOTE = Symbol('remote');
const MAX_BROADCAST = 180000; // Realtime messages are capped at 256KB; bigger changes arrive with the next save

// Joins the doc's live channel. Returns { close, status } and calls onStatus('live' | 'connecting' | 'offline').
export async function joinDoc({ docId, ydoc, awareness, canWrite, onStatus, reloadFromDb }) {
  const { Y, awarenessProtocol } = window.TeamEditor;   // the editor bundle is loaded before a doc opens
  let closed = false;
  let transport;

  const send = (msg) => { if (!closed) transport?.send(msg); };
  const sendSync = (reply) => send({ t: 'sync', sv: toB64(Y.encodeStateVector(ydoc)), reply });
  const sendAwareness = (clients) => {
    if (!canWrite) return;
    send({ t: 'aw', d: toB64(awarenessProtocol.encodeAwarenessUpdate(awareness, clients)) });
  };

  const onMessage = (msg) => {
    if (closed || !msg) return;
    if (msg.t === 'update') {
      Y.applyUpdate(ydoc, fromB64(msg.d), REMOTE);
    } else if (msg.t === 'sync') {
      if (!canWrite) return;
      const diff = Y.encodeStateAsUpdate(ydoc, fromB64(msg.sv));
      if (diff.length > 2) send({ t: 'update', d: toB64(diff) });
      if (!msg.reply) sendSync(true);          // and ask for whatever the newcomer has that we don't
      sendAwareness([ydoc.clientID]);
    } else if (msg.t === 'aw') {
      awarenessProtocol.applyAwarenessUpdate(awareness, fromB64(msg.d), REMOTE);
    }
  };

  const onDocUpdate = (update, origin) => {
    if (origin === REMOTE || !canWrite) return;
    if (update.length > MAX_BROADCAST) return;
    send({ t: 'update', d: toB64(update) });
  };
  const onAwarenessUpdate = ({ added, updated, removed }, origin) => {
    if (origin === REMOTE) return;
    sendAwareness([...added, ...updated, ...removed]);
  };
  ydoc.on('update', onDocUpdate);
  awareness.on('update', onAwarenessUpdate);

  const connected = () => {
    onStatus?.('live');
    sendSync(false);
    sendAwareness([ydoc.clientID]);
    reloadFromDb?.();   // pick up anything saved while we were connecting
  };

  if (isDemo()) {
    const bc = new BroadcastChannel(`teamspace-doc-${docId}`);
    bc.onmessage = (e) => onMessage(e.data);
    transport = { send: (m) => bc.postMessage(m), close: () => bc.close() };
    connected();
  } else {
    onStatus?.('connecting');
    const channel = await docChannel(docId);
    channel.on('broadcast', { event: 'y' }, ({ payload }) => onMessage(payload));
    transport = {
      send: (m) => channel.send({ type: 'broadcast', event: 'y', payload: m }),
      close: () => channel.unsubscribe(),
    };
    channel.subscribe((state) => {
      if (closed) return;
      if (state === 'SUBSCRIBED') connected();
      else if (state === 'CLOSED' || state === 'CHANNEL_ERROR' || state === 'TIMED_OUT') onStatus?.('offline');
    });
  }

  // Keeps our cursor from timing out when we're idle.
  const keepAlive = setInterval(() => {
    if (awareness.getLocalState()) awareness.setLocalState({ ...awareness.getLocalState() });
  }, 15000);

  return {
    resync: () => { sendSync(false); },
    close() {
      if (closed) return;
      awarenessProtocol.removeAwarenessStates(awareness, [ydoc.clientID], 'leave');
      if (canWrite) sendAwareness([ydoc.clientID]);
      closed = true;
      clearInterval(keepAlive);
      ydoc.off('update', onDocUpdate);
      awareness.off('update', onAwarenessUpdate);
      transport?.close();
    },
  };
}

export { REMOTE };
