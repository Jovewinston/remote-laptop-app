import { nanoid } from "nanoid";
import { HEARTBEAT_STALE_MS, type HostSnapshot } from "@bay/shared";
import { db } from "./db.js";

type HostRow = {
  id: string;
  owner_id: string;
  display_name: string;
  sharing: string;
  sandbox: string;
  last_seen_at: string | null;
  snapshot_json: string | null;
  owner_name: string;
};

export function isOnline(lastSeenAt: string | null) {
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() < HEARTBEAT_STALE_MS;
}

/** 24/7 booking windows for every day of the week. */
export function ensureAlwaysAvailable(hostId: string) {
  db.prepare(`DELETE FROM availability WHERE host_id = ?`).run(hostId);
  const insert = db.prepare(
    `INSERT INTO availability (id, host_id, day_of_week, start_hour, end_hour) VALUES (?, ?, ?, ?, ?)`
  );
  for (let d = 0; d < 7; d++) {
    insert.run(nanoid(), hostId, d, 0, 24);
  }
}

export function isAlwaysAvailable(hostId: string) {
  const windows = db
    .prepare(
      `SELECT day_of_week, start_hour, end_hour FROM availability WHERE host_id = ?`
    )
    .all(hostId) as Array<{
    day_of_week: number;
    start_hour: number;
    end_hour: number;
  }>;
  if (windows.length < 7) return false;
  const byDay = new Set(windows.map((w) => w.day_of_week));
  if (byDay.size < 7) return false;
  return windows.every((w) => w.start_hour === 0 && w.end_hour === 24);
}

/** One-shot: any host without full 24/7 gets always-available. */
export function migrateHostsAlwaysAvailable() {
  const hosts = db.prepare(`SELECT id FROM hosts`).all() as Array<{ id: string }>;
  for (const h of hosts) {
    if (!isAlwaysAvailable(h.id)) ensureAlwaysAvailable(h.id);
  }
}

export function nextFreeLabel(hostId: string): string | null {
  const windows = db
    .prepare(
      `SELECT day_of_week, start_hour, end_hour FROM availability WHERE host_id = ? ORDER BY day_of_week, start_hour`
    )
    .all(hostId) as Array<{
    day_of_week: number;
    start_hour: number;
    end_hour: number;
  }>;
  if (!windows.length) return null;
  if (isAlwaysAvailable(hostId)) return "Always";

  const now = new Date();
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let offset = 0; offset < 7; offset++) {
    const d = new Date(now);
    d.setDate(now.getDate() + offset);
    const dow = d.getDay();
    const hour = offset === 0 ? now.getHours() : 0;
    const match = windows.find(
      (w) => w.day_of_week === dow && w.end_hour > (offset === 0 ? hour : -1)
    );
    if (!match) continue;
    const start = offset === 0 && hour > match.start_hour ? hour : match.start_hour;
    if (start >= match.end_hour) continue;
    const labelDay = offset === 0 ? "Today" : offset === 1 ? "Tomorrow" : dayNames[dow];
    return `${labelDay} ${fmtHour(start)}–${fmtHour(match.end_hour)}`;
  }
  return null;
}

function fmtHour(h: number) {
  const ampm = h >= 12 ? "pm" : "am";
  const hr = h % 12 || 12;
  return `${hr}${ampm}`;
}

export function serializeHost(row: HostRow) {
  const snapshot = row.snapshot_json
    ? (JSON.parse(row.snapshot_json) as HostSnapshot)
    : null;
  const online = isOnline(row.last_seen_at);
  return {
    id: row.id,
    displayName: row.display_name,
    ownerName: row.owner_name,
    online,
    lastSeenAt: row.last_seen_at,
    snapshot: snapshot
      ? {
          ...snapshot,
          sharing: (row.sharing as HostSnapshot["sharing"]) ?? snapshot.sharing,
          sandbox: (row.sandbox as HostSnapshot["sandbox"]) ?? snapshot.sandbox,
        }
      : null,
    nextFreeLabel: online && row.sharing !== "off" ? nextFreeLabel(row.id) : null,
  };
}

export function getHostPublic(hostId: string) {
  const row = db
    .prepare(
      `SELECT h.*, u.name AS owner_name FROM hosts h
       JOIN users u ON u.id = h.owner_id WHERE h.id = ?`
    )
    .get(hostId) as HostRow | undefined;
  return row ? serializeHost(row) : null;
}

export function listBorrowableHosts() {
  const rows = db
    .prepare(
      `SELECT h.*, u.name AS owner_name FROM hosts h
       JOIN users u ON u.id = h.owner_id
       WHERE h.sharing IN ('available', 'busy')
       ORDER BY h.last_seen_at DESC`
    )
    .all() as HostRow[];
  return rows.map(serializeHost).filter((h) => h.online || h.snapshot);
}

export function audit(
  kind: string,
  message: string,
  opts: { userId?: string; hostId?: string } = {}
) {
  db.prepare(
    `INSERT INTO audit_log (id, kind, message, user_id, host_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    cryptoRandomId(),
    kind,
    message,
    opts.userId ?? null,
    opts.hostId ?? null,
    new Date().toISOString()
  );
}

function cryptoRandomId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
