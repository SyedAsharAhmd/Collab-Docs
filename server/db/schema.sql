-- Safe to run repeatedly: every statement is IF NOT EXISTS.
-- gen_random_uuid() is built into PostgreSQL 13+.

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,  -- stored lowercased by the API
  password_hash text NOT NULL,
  name          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text NOT NULL DEFAULT 'Untitled document',
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ydoc_state bytea,                    -- Y.encodeStateAsUpdate(ydoc); NULL until first store
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per (document, user). Every document operation checks this table.
CREATE TABLE IF NOT EXISTS permissions (
  doc_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  PRIMARY KEY (doc_id, user_id)
);

-- The primary key covers lookups by doc_id; this covers "list my documents".
CREATE INDEX IF NOT EXISTS permissions_user_id_idx ON permissions (user_id);
