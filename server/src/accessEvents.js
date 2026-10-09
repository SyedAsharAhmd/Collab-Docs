// Tells the collab server that someone's access to a document changed, so it can
// close their live connections. The collab server LISTENs on this channel.
//
// Call it with the transaction's client: Postgres delivers a NOTIFY only when the
// transaction commits, so a rolled-back change never closes anyone's connection.
export const ACCESS_CHANNEL = 'access_changed';

// userId = null means everyone (the document was deleted).
export function notifyAccessChanged(client, docId, userId = null) {
  return client.query('SELECT pg_notify($1, $2)', [ACCESS_CHANNEL, JSON.stringify({ docId, userId })]);
}

// The owner changed what the link allows (off, view, or edit): closes the connections that
// got in through the link (visitors who aren't logged in, and logged-in users whose role
// comes from the link), but not collaborators who have a role of their own. They
// reconnect at the new level. Same commit-only delivery as above.
export function notifyLinkAccessChanged(client, docId) {
  return client.query('SELECT pg_notify($1, $2)', [
    ACCESS_CHANNEL,
    JSON.stringify({ docId, userId: null, linkOnly: true }),
  ]);
}
