import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path?: string): DatabaseSync {
  if (!path) {
    const directory = new URL('../data/', import.meta.url);
    mkdirSync(directory, { recursive: true });
    path = fileURLToPath(new URL('pocketbank.sqlite', directory));
  }
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS accounts (
      number TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL CHECK (kind IN ('checking', 'savings')),
      balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0 AND balance_cents <= 9007199254740991),
      UNIQUE(user_id, kind)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS transactions (
      reference TEXT PRIMARY KEY,
      source_number TEXT REFERENCES accounts(number),
      destination_number TEXT NOT NULL REFERENCES accounts(number),
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      created_at TEXT NOT NULL,
      request_id TEXT UNIQUE
    ) STRICT;
    CREATE INDEX IF NOT EXISTS transactions_source ON transactions(source_number);
    CREATE INDEX IF NOT EXISTS transactions_destination ON transactions(destination_number);
  `);
  return db;
}

// No asynchronous work inside this boundary: all statements succeed or all roll back.
export function atomic<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
