import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import type { Context, Next } from "hono";
import { db } from "./db.js";

export type AuthedUser = {
  id: string;
  email: string;
  name: string;
};

declare module "hono" {
  interface ContextVariableMap {
    user: AuthedUser;
    hostId: string;
  }
}

export function hashPassword(password: string) {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string) {
  return bcrypt.compareSync(password, hash);
}

export function createSession(userId: string) {
  const token = nanoid(48);
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  db.prepare(
    `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`
  ).run(token, userId, now.toISOString(), expires.toISOString());
  return token;
}

export function getUserByToken(token: string | undefined): AuthedUser | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.name, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(token) as
    | { id: string; email: string; name: string; expires_at: string }
    | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
    return null;
  }
  return { id: row.id, email: row.email, name: row.name };
}

export async function requireUser(c: Context, next: Next) {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : undefined;
  const cookie = parseCookie(c.req.header("cookie") ?? "").bay_token;
  const user = getUserByToken(token ?? cookie);
  if (!user) return c.json({ error: "Sign in required" }, 401);
  c.set("user", user);
  await next();
}

export async function requireHost(c: Context, next: Next) {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Host ") ? header.slice(5) : undefined;
  if (!token) return c.json({ error: "Host token required" }, 401);
  const host = db
    .prepare(`SELECT id FROM hosts WHERE host_token = ?`)
    .get(token) as { id: string } | undefined;
  if (!host) return c.json({ error: "Invalid host token" }, 401);
  c.set("hostId", host.id);
  await next();
}

function parseCookie(raw: string) {
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join("=") ?? "");
  }
  return out;
}
