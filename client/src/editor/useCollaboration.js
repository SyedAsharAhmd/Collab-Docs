import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { expireSession, tokenStore } from '../api.js';

const COLLAB_URL = import.meta.env.VITE_COLLAB_URL ?? 'ws://localhost:1234';

// Opens a live connection for one document. Returns the shared Y.Doc (null until
// ready), the connection status, and why access was denied, if it was.
//
// The Y.Doc is the document's real state. Tiptap renders it, local edits change it,
// and the provider exchanges Yjs updates with the collab server, which relays them to
// everyone else in the document. Yjs merges concurrent updates in any order.
export function useCollaboration(docId) {
  const [ydoc, setYdoc] = useState(null);
  const [status, setStatus] = useState('connecting'); // 'connecting' | 'connected' | 'disconnected'
  const [deniedReason, setDeniedReason] = useState(null);

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
        if (reason === 'invalid-token') expireSession();
        else setDeniedReason(reason);
      },
    });
    setYdoc(doc);
    setStatus('connecting');
    setDeniedReason(null);

    return () => {
      provider.destroy();
      doc.destroy();
    };
  }, [docId]);

  return { ydoc, status, deniedReason };
}
