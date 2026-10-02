import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { expireSession, tokenStore } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';

const COLLAB_URL = import.meta.env.VITE_COLLAB_URL ?? 'ws://localhost:1234';

// Close reasons the collab server sends when the REST API changes access
// (must match collab/src/accessListener.js).
const ACCESS_CHANGED = 'access-changed';
const DOCUMENT_DELETED = 'document-deleted';

// Opens a live connection for one document. Returns the shared Y.Doc (null until
// ready), the connection status, and why access was denied, if it was.
//
// The Y.Doc is the document's real state. Tiptap renders it, local edits change it,
// and the provider exchanges Yjs updates with the collab server, which relays them to
// everyone else in the document. Yjs merges concurrent updates in any order.
//
// `onAccessChanged` runs when the owner changes or removes our role while we're
// connected; the caller reloads the document to learn the new role.
export function useCollaboration(docId, onAccessChanged) {
  const [ydoc, setYdoc] = useState(null);
  const [status, setStatus] = useState('connecting'); // 'connecting' | 'connected' | 'disconnected'
  const [deniedReason, setDeniedReason] = useState(null);
  const onAccessChangedRef = useRef(onAccessChanged);
  const { sessionExpired } = useAuth();
  const providerRef = useRef(null);
  // Set when the server rejected our token, so we reconnect once the user logs back in.
  const waitingForLogin = useRef(false);

  useEffect(() => {
    onAccessChangedRef.current = onAccessChanged;
  }, [onAccessChanged]);

  useEffect(() => {
    // Created in an effect, not during render, so every provider has a matching
    // destroy() and no socket is left open (React may render more than once).
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: COLLAB_URL,
      name: docId,
      document: doc,
      // A function, so a reconnect sends the current token rather than a stale one.
      token: () => tokenStore.get(),
      onStatus: ({ status }) => setStatus(status),
      onAuthenticationFailed: ({ reason }) => {
        if (reason === 'invalid-token') {
          // Not a dead end: keep the Y.Doc (it may hold edits typed offline) and ask the
          // user to log in again over this page.
          waitingForLogin.current = true;
          expireSession();
        } else {
          setDeniedReason(reason);
        }
      },
      onClose: ({ event }) => {
        if (event?.reason === DOCUMENT_DELETED) setDeniedReason(DOCUMENT_DELETED);
        else if (event?.reason === ACCESS_CHANGED) onAccessChangedRef.current?.();
      },
    });
    providerRef.current = provider;
    setYdoc(doc);
    setStatus('connecting');
    setDeniedReason(null);

    return () => {
      provider.destroy();
      doc.destroy();
    };
  }, [docId]);

  useEffect(() => {
    if (sessionExpired || !waitingForLogin.current) return;
    waitingForLogin.current = false;
    const provider = providerRef.current;
    if (!provider) return;
    // Logged back in. The socket is usually still open (only this document's login was
    // refused), so authenticate again on it: the same two steps the provider runs
    // whenever a socket opens. The sync then sends everything this Y.Doc gained
    // meanwhile, and Yjs merges it with others' edits. If the socket is down right now,
    // its own reconnect will send the new token anyway.
    //
    // (disconnect() + connect() would race: the socket reports "closed" a moment later,
    // so connect() still sees it connected and does nothing.)
    if (provider.configuration.websocketProvider.status === 'connected') {
      provider.sendToken().then(() => provider.startSync());
    }
  }, [sessionExpired]);

  return { ydoc, status, deniedReason };
}
