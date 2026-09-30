import { useCallback, useEffect, useRef, useState } from 'react';

// M2 ONLY: debounced saving of the whole document. M3 replaces it with Yjs sync.
//
// At most one save is in flight at a time. If two saves could overlap, the older
// request might reach the server last and overwrite newer text.
export function useAutosave(save, delay = 800) {
  const [status, setStatus] = useState('saved'); // 'saved' | 'unsaved' | 'saving' | 'error'
  const saveRef = useRef(save);
  const pending = useRef(null); // latest content not yet sent, or null
  const inFlight = useRef(false);
  const timer = useRef(null);

  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (inFlight.current || pending.current === null) return;

    const content = pending.current;
    pending.current = null;
    inFlight.current = true;
    setStatus('saving');
    try {
      await saveRef.current(content);
    } catch {
      // Keep the content for the next attempt, unless newer content arrived meanwhile.
      pending.current ??= content;
      inFlight.current = false;
      setStatus('error');
      return;
    }
    inFlight.current = false;
    // Edits made while this save was in flight are sent now.
    if (pending.current !== null) flush();
    else setStatus('saved');
  }, []);

  const schedule = useCallback(
    (content) => {
      pending.current = content;
      setStatus('unsaved');
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, delay);
    },
    [flush, delay],
  );

  useEffect(() => {
    // Closing or reloading the tab: send what's left. keepalive lets the request
    // outlive the page.
    const onPageHide = () => {
      if (pending.current !== null) saveRef.current(pending.current, { keepalive: true }).catch(() => {});
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      // Leaving the page inside the app (e.g. back to the list): save now.
      flush();
    };
  }, [flush]);

  return { status, schedule };
}
