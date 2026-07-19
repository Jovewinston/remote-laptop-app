import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "../../../data");
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.BAY_DB_PATH ?? path.join(dataDir, "bay.db");
export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

export function migrate() {
  // Lightweight additive migrations for existing local DBs
  const cols = db
    .prepare(`PRAGMA table_info(reservations)`)
    .all() as Array<{ name: string }>;
  const have = new Set(cols.map((c) => c.name));
  if (have.size && !have.has("cockpit_open_url")) {
    db.exec(`ALTER TABLE reservations ADD COLUMN cockpit_open_url TEXT`);
  }
  if (have.size && !have.has("project_id")) {
    db.exec(`ALTER TABLE reservations ADD COLUMN project_id TEXT`);
  }
  if (have.size && !have.has("project_dir")) {
    db.exec(`ALTER TABLE reservations ADD COLUMN project_dir TEXT`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      used_by TEXT,
      used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hosts (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL,
      host_token TEXT NOT NULL UNIQUE,
      sharing TEXT NOT NULL DEFAULT 'off',
      sandbox TEXT NOT NULL DEFAULT 'idle',
      last_seen_at TEXT,
      snapshot_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS availability (
      id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
      day_of_week INTEGER NOT NULL,
      start_hour INTEGER NOT NULL,
      end_hour INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
      renter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      status TEXT NOT NULL,
      repo_url TEXT,
      cockpit_port INTEGER,
      cockpit_open_url TEXT,
      project_id TEXT,
      project_dir TEXT,
      connect_token TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      user_id TEXT,
      host_id TEXT,
      created_at TEXT NOT NULL
    );
  `);
}
