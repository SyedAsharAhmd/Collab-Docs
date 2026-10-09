import pg from 'pg';

// Must match server/src/accessEvents.js.
const CHANNEL = 'access_changed';
const RETRY_MS = 2000;

export const ACCESS_CHANGED = 'access-changed';
export const DOCUMENT_DELETED = 'document-deleted';

// Closes live connections whose access the REST API changed or removed. Closing is
// enough: the client reconnects and passes onAuthenticate again with the current role
// (rejected if removed, read-only if downgraded).
//
// Uses its own client, not the pool: LISTEN belongs to one connection, and a pooled
// connection would be handed to other queries. Resolves, after the first attempt to
// subscribe, to a function that stops it. A failed attempt retries in the background.
export async function listenForAccessChanges(hocuspocus) {
  let client = null;
  let stopped = false;
  let retryTimer = null;
  let connectedBefore = false;

  async function start() {
    const current = new pg.Client({ connectionString: process.env.DATABASE_URL });
    client = current;
    current.on('notification', (message) => handleNotification(hocuspocus, message.payload));
    current.on('error', (err) => {
      console.error('Access listener lost its connection:', err.message);
      retry(current);
    });
    try {
      await current.connect();
      await current.query(`LISTEN ${CHANNEL}`);
    } catch (err) {
      console.error('Access listener could not connect:', err.message);
      return retry(current);
    }
    // While we weren't listening, notifications were missed. Closing every connection
    // makes all clients reconnect and be checked against today's permissions.
    if (connectedBefore) closeConnections(hocuspocus, () => true, ACCESS_CHANGED);
    connectedBefore = true;
  }

  function retry(failed) {
    if (stopped || client !== failed) return; // already retrying, or stopping
    client = null;
    failed.end().catch(() => {});
    retryTimer = setTimeout(start, RETRY_MS);
  }

  await start();

  return async function stop() {
    stopped = true;
    clearTimeout(retryTimer);
    await client?.end().catch(() => {});
  };
}

function handleNotification(hocuspocus, payload) {
  let docId, userId, linkOnly;
  try {
    ({ docId, userId, linkOnly } = JSON.parse(payload));
  } catch {
    return console.error('Ignoring malformed access notification:', payload);
  }
  const document = hocuspocus.documents.get(docId);
  if (!document) return; // nobody has it open

  if (linkOnly) {
    // The owner changed what the link allows: close only the connections whose role comes
    // from the link. They reconnect at the new level, or are refused if it is off.
    // Collaborators with a role of their own stay connected.
    closeConnections(hocuspocus, (connection) => connection.context?.viaLink === true, ACCESS_CHANGED, document);
  } else if (userId) {
    closeConnections(hocuspocus, (connection) => connection.context?.userId === userId, ACCESS_CHANGED, document);
  } else {
    closeConnections(hocuspocus, () => true, DOCUMENT_DELETED, document);
  }
}

// Closes the matching connections on one document, or on every open document.
function closeConnections(hocuspocus, matches, reason, onlyDocument = null) {
  const documents = onlyDocument ? [onlyDocument] : [...hocuspocus.documents.values()];
  for (const document of documents) {
    for (const connection of document.getConnections()) {
      if (matches(connection)) connection.close({ code: 4000, reason });
    }
  }
}
