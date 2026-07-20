import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { nanoid } from "nanoid";
import type { AgentKind, HostSnapshot } from "@bay/shared";
import { DEFAULT_COCKPIT_PORT } from "@bay/shared";
import {
  createSession,
  getUserByToken,
  hashPassword,
  requireHost,
  requireUser,
  verifyPassword,
} from "./auth.js";
import { db, migrate } from "./db.js";
import {
  audit,
  ensureAlwaysAvailable,
  getHostPublic,
  listBorrowableHosts,
  migrateHostsAlwaysAvailable,
  nextFreeLabel,
} from "./hosts.js";
import {
  claimGuestCredentials,
  clearGuestCredentials,
  guestCredentialsPending,
  guestCredentialsStatus,
  setGuestCredentials,
  validateAnthropicKey,
  validateOpenAiKey,
} from "./guest-credentials.js";
import {
  claimClaudeAuthCode,
  claimClaudeAuthStart,
  clearClaudeAuth,
  claudeAuthCodePending,
  claudeAuthStartPending,
  getClaudeAuthPublic,
  markClaudeAuthDone,
  markClaudeAuthError,
  requestClaudeAuth,
  setClaudeAuthCode,
  setClaudeAuthDetail,
  setClaudeAuthUrl,
} from "./claude-auth.js";

migrate();
migrateHostsAlwaysAvailable();

const app = new Hono();
const WEB_ORIGINS = [
  ...(process.env.BAY_WEB_ORIGIN ?? "http://127.0.0.1:3200")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  "http://localhost:3200",
  "http://127.0.0.1:3200",
];
// Railway sets PORT; keep BAY_API_PORT for local dev.
const PORT = Number(process.env.PORT ?? process.env.BAY_API_PORT ?? 8788);
const HOSTNAME = process.env.BAY_API_HOST ?? "0.0.0.0";

app.use(
  "*",
  cors({
    origin: WEB_ORIGINS,
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

app.get("/health", (c) => c.json({ ok: true, service: "bay-api" }));

app.post("/auth/signup", async (c) => {
  const body = await c.req.json<{
    email?: string;
    name?: string;
    password?: string;
    inviteCode?: string;
  }>();
  const email = body.email?.trim().toLowerCase();
  const name = body.name?.trim();
  const password = body.password ?? "";
  const inviteCode = body.inviteCode?.trim();

  if (!email || !name || password.length < 6 || !inviteCode) {
    return c.json(
      { error: "Name, email, password (6+ chars), and invite code required" },
      400
    );
  }

  const invite = db
    .prepare(`SELECT code, used_by FROM invites WHERE code = ?`)
    .get(inviteCode) as { code: string; used_by: string | null } | undefined;
  if (!invite) return c.json({ error: "Invalid invite code" }, 400);
  if (invite.used_by) return c.json({ error: "Invite already used" }, 400);

  const existing = db
    .prepare(`SELECT id FROM users WHERE email = ?`)
    .get(email);
  if (existing) return c.json({ error: "Email already registered" }, 409);

  const id = nanoid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, email, name, hashPassword(password), now);
  db.prepare(
    `UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?`
  ).run(id, now, inviteCode);

  const token = createSession(id);
  audit("signup", `${name} joined with invite`, { userId: id });
  return c.json({ token, user: { id, email, name } });
});

app.post("/auth/login", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>();
  const email = body.email?.trim().toLowerCase();
  const password = body.password ?? "";
  if (!email || !password) return c.json({ error: "Email and password required" }, 400);

  const user = db
    .prepare(`SELECT id, email, name, password_hash FROM users WHERE email = ?`)
    .get(email) as
    | { id: string; email: string; name: string; password_hash: string }
    | undefined;
  if (!user || !verifyPassword(password, user.password_hash)) {
    return c.json({ error: "Invalid email or password" }, 401);
  }
  const token = createSession(user.id);
  return c.json({
    token,
    user: { id: user.id, email: user.email, name: user.name },
  });
});

app.get("/auth/me", requireUser, (c) => {
  return c.json({ user: c.get("user") });
});

app.post("/invites", requireUser, async (c) => {
  const code = nanoid(10);
  db.prepare(
    `INSERT INTO invites (code, created_at) VALUES (?, ?)`
  ).run(code, new Date().toISOString());
  return c.json({ code });
});

app.get("/hosts", requireUser, (c) => {
  return c.json({ hosts: listBorrowableHosts() });
});

app.get("/hosts/mine", requireUser, (c) => {
  const user = c.get("user");
  const rows = db
    .prepare(
      `SELECT h.*, u.name AS owner_name FROM hosts h
       JOIN users u ON u.id = h.owner_id WHERE h.owner_id = ?`
    )
    .all(user.id) as Array<{
    id: string;
    owner_id: string;
    display_name: string;
    sharing: string;
    sandbox: string;
    last_seen_at: string | null;
    snapshot_json: string | null;
    owner_name: string;
    host_token: string;
  }>;

  return c.json({
    hosts: rows.map((row) => ({
      ...getHostPublic(row.id),
      hostToken: row.host_token,
      availability: db
        .prepare(
          `SELECT id, day_of_week as dayOfWeek, start_hour as startHour, end_hour as endHour
           FROM availability WHERE host_id = ? ORDER BY day_of_week, start_hour`
        )
        .all(row.id),
      nextFreeLabel: nextFreeLabel(row.id),
    })),
  });
});

app.post("/hosts/register", requireUser, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ displayName?: string }>();
  const displayName =
    body.displayName?.trim() || `${user.name.split(" ")[0]}'s Mac`;

  const existing = db
    .prepare(`SELECT id, host_token FROM hosts WHERE owner_id = ?`)
    .get(user.id) as { id: string; host_token: string } | undefined;

  if (existing) {
    db.prepare(`UPDATE hosts SET display_name = ? WHERE id = ?`).run(
      displayName,
      existing.id
    );
    return c.json({
      hostId: existing.id,
      hostToken: existing.host_token,
      displayName,
    });
  }

  const id = nanoid();
  const hostToken = nanoid(40);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO hosts (id, owner_id, display_name, host_token, sharing, sandbox, created_at)
     VALUES (?, ?, ?, ?, 'off', 'idle', ?)`
  ).run(id, user.id, displayName, hostToken, now);

  ensureAlwaysAvailable(id);

  audit("host_register", `Registered host ${displayName}`, {
    userId: user.id,
    hostId: id,
  });
  return c.json({ hostId: id, hostToken, displayName });
});

app.put("/hosts/:id/availability", requireUser, async (c) => {
  const user = c.get("user");
  const hostId = c.req.param("id");
  const host = db
    .prepare(`SELECT id FROM hosts WHERE id = ? AND owner_id = ?`)
    .get(hostId, user.id);
  if (!host) return c.json({ error: "Host not found" }, 404);

  const body = await c.req.json<{
    windows?: Array<{ dayOfWeek: number; startHour: number; endHour: number }>;
  }>();
  const windows = body.windows ?? [];
  db.prepare(`DELETE FROM availability WHERE host_id = ?`).run(hostId);
  const insert = db.prepare(
    `INSERT INTO availability (id, host_id, day_of_week, start_hour, end_hour) VALUES (?, ?, ?, ?, ?)`
  );
  for (const w of windows) {
    if (
      w.dayOfWeek < 0 ||
      w.dayOfWeek > 6 ||
      w.startHour < 0 ||
      w.endHour > 24 ||
      w.startHour >= w.endHour
    ) {
      continue;
    }
    insert.run(nanoid(), hostId, w.dayOfWeek, w.startHour, w.endHour);
  }
  return c.json({ ok: true, nextFreeLabel: nextFreeLabel(hostId) });
});

app.post("/hosts/:id/sharing", requireUser, async (c) => {
  const user = c.get("user");
  const hostId = c.req.param("id");
  const body = await c.req.json<{ sharing?: "off" | "available" }>();
  const host = db
    .prepare(`SELECT id, sharing FROM hosts WHERE id = ? AND owner_id = ?`)
    .get(hostId, user.id) as { id: string; sharing: string } | undefined;
  if (!host) return c.json({ error: "Host not found" }, 404);
  if (host.sharing === "busy" && body.sharing === "off") {
    // allow pause after busy clears; if busy, still allow off
  }
  const sharing = body.sharing === "available" ? "available" : "off";
  db.prepare(`UPDATE hosts SET sharing = ? WHERE id = ?`).run(sharing, hostId);
  return c.json({ ok: true, sharing, host: getHostPublic(hostId) });
});

app.post("/host/heartbeat", requireHost, async (c) => {
  const hostId = c.get("hostId");
  const body = await c.req.json<{
    snapshot?: HostSnapshot;
    sharing?: "off" | "available" | "busy";
    sandbox?: string;
  }>();

  const now = new Date().toISOString();
  const snapshot = body.snapshot ?? null;
  const current = db
    .prepare(`SELECT sharing, sandbox FROM hosts WHERE id = ?`)
    .get(hostId) as { sharing: string; sandbox: string };

  // Website (or explicit host toggle) owns sharing. Heartbeat snapshot must not clobber it.
  let sharing = current.sharing;
  if (body.sharing === "off" || body.sharing === "available" || body.sharing === "busy") {
    sharing = body.sharing;
  }

  const sandbox =
    body.sandbox ??
    (snapshot?.sandbox &&
    ["preparing", "ready", "cleaning", "error", "idle"].includes(snapshot.sandbox)
      ? snapshot.sandbox
      : current.sandbox);

  db.prepare(
    `UPDATE hosts SET last_seen_at = ?, snapshot_json = ?, sharing = ?, sandbox = ? WHERE id = ?`
  ).run(
    now,
    snapshot ? JSON.stringify({ ...snapshot, sharing, sandbox, collectedAt: now }) : null,
    sharing,
    sandbox,
    hostId
  );

  const pending = db
    .prepare(
      `SELECT id, agent, repo_url, status, starts_at, ends_at, connect_token
       FROM reservations
       WHERE host_id = ? AND status IN ('upcoming', 'starting', 'connected')
       ORDER BY starts_at ASC`
    )
    .all(hostId);

  return c.json({
    ok: true,
    host: getHostPublic(hostId),
    pendingReservations: pending.map((r) => {
      const id = (r as { id: string }).id;
      return {
        id,
        agent: (r as { agent: string }).agent,
        repoUrl: (r as { repo_url: string | null }).repo_url,
        status: (r as { status: string }).status,
        startsAt: (r as { starts_at: string }).starts_at,
        endsAt: (r as { ends_at: string }).ends_at,
        connectToken: (r as { connect_token: string | null }).connect_token,
        guestCredentialsPending: guestCredentialsPending(id, hostId),
        claudeAuthStartPending: claudeAuthStartPending(id, hostId),
        claudeAuthCodePending: claudeAuthCodePending(id, hostId),
      };
    }),
  });
});

/** Host one-shot claim of renter API keys (secret never logged). */
app.post("/host/sessions/:id/guest-credentials/claim", requireHost, async (c) => {
  const hostId = c.get("hostId");
  const id = c.req.param("id");
  const res = db
    .prepare(`SELECT id FROM reservations WHERE id = ? AND host_id = ?`)
    .get(id, hostId);
  if (!res) return c.json({ error: "Reservation not found" }, 404);
  const credentials = claimGuestCredentials(id, hostId);
  if (!credentials) {
    return c.json({ error: "No pending credentials", ok: false }, 404);
  }
  return c.json({ ok: true, credentials, consumed: true });
});

app.post("/host/sessions/:id/claude-auth/url", requireHost, async (c) => {
  const hostId = c.get("hostId");
  const id = c.req.param("id");
  const res = db
    .prepare(`SELECT id FROM reservations WHERE id = ? AND host_id = ?`)
    .get(id, hostId);
  if (!res) return c.json({ error: "Reservation not found" }, 404);
  const body = await c.req.json<{
    loginUrl?: string;
    error?: string;
    detail?: string;
  }>();
  if (body.detail) setClaudeAuthDetail(id, hostId, body.detail);
  if (body.error) {
    markClaudeAuthError(id, hostId, body.error);
    return c.json({ ok: true, ...getClaudeAuthPublic(id) });
  }
  if (!body.loginUrl?.trim()) {
    if (body.detail) return c.json({ ok: true, ...getClaudeAuthPublic(id) });
    return c.json({ error: "loginUrl required" }, 400);
  }
  if (!/^https:\/\/claude\.com\//i.test(body.loginUrl.trim())) {
    return c.json({ error: "Unexpected login URL" }, 400);
  }
  setClaudeAuthUrl(id, hostId, body.loginUrl.trim());
  setClaudeAuthDetail(id, hostId, "Login link ready — open it in your browser");
  return c.json({ ok: true, ...getClaudeAuthPublic(id) });
});

app.post("/host/sessions/:id/claude-auth/start/claim", requireHost, async (c) => {
  const hostId = c.get("hostId");
  const id = c.req.param("id");
  const res = db
    .prepare(`SELECT id FROM reservations WHERE id = ? AND host_id = ?`)
    .get(id, hostId);
  if (!res) return c.json({ error: "Reservation not found" }, 404);
  const claimed = claimClaudeAuthStart(id, hostId);
  if (!claimed) return c.json({ error: "No pending start", ok: false }, 404);
  return c.json({ ok: true, claimed: true });
});

app.post("/host/sessions/:id/claude-auth/code/claim", requireHost, async (c) => {
  const hostId = c.get("hostId");
  const id = c.req.param("id");
  const res = db
    .prepare(`SELECT id FROM reservations WHERE id = ? AND host_id = ?`)
    .get(id, hostId);
  if (!res) return c.json({ error: "Reservation not found" }, 404);
  const code = claimClaudeAuthCode(id, hostId);
  if (!code) return c.json({ error: "No pending code", ok: false }, 404);
  return c.json({ ok: true, code, consumed: true });
});

app.post("/host/sessions/:id/claude-auth/done", requireHost, async (c) => {
  const hostId = c.get("hostId");
  const id = c.req.param("id");
  const res = db
    .prepare(`SELECT id FROM reservations WHERE id = ? AND host_id = ?`)
    .get(id, hostId);
  if (!res) return c.json({ error: "Reservation not found" }, 404);
  const body = await c.req.json<{ ok?: boolean; error?: string }>().catch(() => ({}));
  if (body && body.ok === false) {
    markClaudeAuthError(id, hostId, body.error || "Claude login failed");
  } else {
    markClaudeAuthDone(id, hostId);
  }
  return c.json({ ok: true, ...getClaudeAuthPublic(id) });
});

app.post("/host/sessions/:id/state", requireHost, async (c) => {
  const hostId = c.get("hostId");
  const id = c.req.param("id");
  const body = await c.req.json<{
    status?: "starting" | "connected" | "ended" | "cancelled";
    sandbox?: string;
    cockpitPort?: number;
    openUrl?: string;
    projectId?: string;
    projectDir?: string;
    sharing?: "available" | "busy" | "off";
    preparePhase?: string | null;
    prepareDetail?: string | null;
  }>();

  const res = db
    .prepare(`SELECT id FROM reservations WHERE id = ? AND host_id = ?`)
    .get(id, hostId);
  if (!res) return c.json({ error: "Reservation not found" }, 404);

  if (body.status) {
    db.prepare(`UPDATE reservations SET status = ? WHERE id = ?`).run(
      body.status,
      id
    );
  }
  if (body.cockpitPort) {
    db.prepare(`UPDATE reservations SET cockpit_port = ? WHERE id = ?`).run(
      body.cockpitPort,
      id
    );
  }
  if (body.openUrl) {
    db.prepare(`UPDATE reservations SET cockpit_open_url = ? WHERE id = ?`).run(
      body.openUrl,
      id
    );
  }
  if (body.projectId) {
    db.prepare(`UPDATE reservations SET project_id = ? WHERE id = ?`).run(
      body.projectId,
      id
    );
  }
  if (body.projectDir) {
    db.prepare(`UPDATE reservations SET project_dir = ? WHERE id = ?`).run(
      body.projectDir,
      id
    );
  }
  if (body.sandbox) {
    db.prepare(`UPDATE hosts SET sandbox = ? WHERE id = ?`).run(
      body.sandbox,
      hostId
    );
  }
  if (body.sharing) {
    db.prepare(`UPDATE hosts SET sharing = ? WHERE id = ?`).run(
      body.sharing,
      hostId
    );
  }

  // Merge live prepare progress into host snapshot for the Borrow/Session UI.
  if (
    body.preparePhase !== undefined ||
    body.prepareDetail !== undefined ||
    body.sandbox
  ) {
    const row = db
      .prepare(`SELECT snapshot_json, sandbox, sharing FROM hosts WHERE id = ?`)
      .get(hostId) as {
      snapshot_json: string | null;
      sandbox: string;
      sharing: string;
    };
    let snap: Record<string, unknown> = {};
    try {
      snap = row.snapshot_json ? JSON.parse(row.snapshot_json) : {};
    } catch {
      snap = {};
    }
    if (body.preparePhase !== undefined) snap.preparePhase = body.preparePhase;
    if (body.prepareDetail !== undefined) snap.prepareDetail = body.prepareDetail;
    if (body.sandbox) snap.sandbox = body.sandbox;
    snap.sharing = row.sharing;
    snap.collectedAt = new Date().toISOString();
    db.prepare(`UPDATE hosts SET snapshot_json = ? WHERE id = ?`).run(
      JSON.stringify(snap),
      hostId
    );
  }

  if (body.status === "ended" || body.status === "cancelled") {
    db.prepare(
      `UPDATE hosts SET sharing = 'available', sandbox = 'idle' WHERE id = ? AND sharing = 'busy'`
    ).run(hostId);
  }

  return c.json({ ok: true });
});

function dayCovered(hostId: string, dow: number, startH: number, endH: number) {
  const windows = db
    .prepare(
      `SELECT start_hour, end_hour FROM availability WHERE host_id = ? AND day_of_week = ?`
    )
    .all(hostId, dow) as Array<{ start_hour: number; end_hour: number }>;
  if (!windows.length) return true; // no schedule = always open
  return windows.some((w) => startH >= w.start_hour && endH <= w.end_hour);
}

function windowsAllow(hostId: string, start: Date, end: Date) {
  if (end <= start) return false;
  // Walk calendar days in the reservation (supports overnight when both days are open).
  let cursor = new Date(start);
  cursor.setMinutes(0, 0, 0);
  while (cursor < end) {
    const dayStart = new Date(cursor);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const sliceStart = cursor > start ? cursor : start;
    const sliceEnd = end < dayEnd ? end : dayEnd;
    const startH = sliceStart.getHours();
    const endH =
      sliceEnd.getTime() === dayEnd.getTime()
        ? 24
        : sliceEnd.getHours() + (sliceEnd.getMinutes() > 0 ? 1 : 0);
    if (!dayCovered(hostId, sliceStart.getDay(), startH, Math.max(startH + 1, endH))) {
      return false;
    }
    cursor = dayEnd;
  }
  return true;
}

function hasOverlap(hostId: string, start: string, end: string) {
  const row = db
    .prepare(
      `SELECT id FROM reservations
       WHERE host_id = ? AND status NOT IN ('ended', 'cancelled')
       AND starts_at < ? AND ends_at > ?`
    )
    .get(hostId, end, start);
  return Boolean(row);
}

app.post("/reservations", requireUser, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    hostId?: string;
    agent?: AgentKind;
    startsAt?: string;
    endsAt?: string;
    repoUrl?: string;
  }>();

  if (!body.hostId || !body.agent || !body.startsAt || !body.endsAt) {
    return c.json({ error: "hostId, agent, startsAt, endsAt required" }, 400);
  }
  if (body.agent !== "claude" && body.agent !== "codex") {
    return c.json({ error: "agent must be claude or codex" }, 400);
  }

  const host = getHostPublic(body.hostId);
  if (!host) return c.json({ error: "Host not found" }, 404);
  if (!host.online) return c.json({ error: "That Mac is offline right now" }, 400);
  if (host.snapshot?.sharing === "off") {
    return c.json({ error: "That Mac is not available for borrowing" }, 400);
  }

  const start = new Date(body.startsAt);
  const end = new Date(body.endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return c.json({ error: "Invalid times" }, 400);
  }
  if (end.getTime() - start.getTime() < 30 * 60 * 1000) {
    return c.json({ error: "Reserve at least 30 minutes" }, 400);
  }
  if (end.getTime() - start.getTime() > 8 * 60 * 60 * 1000) {
    return c.json({ error: "Max 8 hours for MVP" }, 400);
  }
  if (!windowsAllow(body.hostId, start, end)) {
    return c.json({ error: "Outside the lender's available hours" }, 400);
  }
  if (hasOverlap(body.hostId, start.toISOString(), end.toISOString())) {
    return c.json({ error: "That time overlaps another reservation" }, 409);
  }

  const id = nanoid();
  const connectToken = nanoid(32);
  db.prepare(
    `INSERT INTO reservations
     (id, host_id, renter_id, agent, starts_at, ends_at, status, repo_url, cockpit_port, connect_token, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'upcoming', ?, ?, ?, ?)`
  ).run(
    id,
    body.hostId,
    user.id,
    body.agent,
    start.toISOString(),
    end.toISOString(),
    body.repoUrl?.trim() || null,
    DEFAULT_COCKPIT_PORT,
    connectToken,
    new Date().toISOString()
  );

  audit("reserve", `Reserved ${body.agent} on ${host.displayName}`, {
    userId: user.id,
    hostId: body.hostId,
  });

  return c.json({ reservation: getReservation(id) });
});

function getReservation(id: string) {
  const row = db
    .prepare(
      `SELECT r.*, h.display_name AS host_display_name, h.snapshot_json
       FROM reservations r JOIN hosts h ON h.id = r.host_id WHERE r.id = ?`
    )
    .get(id) as
    | {
        id: string;
        host_id: string;
        renter_id: string;
        agent: AgentKind;
        starts_at: string;
        ends_at: string;
        status: string;
        repo_url: string | null;
        cockpit_port: number | null;
        cockpit_open_url: string | null;
        project_id: string | null;
        project_dir: string | null;
        connect_token: string | null;
        host_display_name: string;
        snapshot_json: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    hostId: row.host_id,
    renterId: row.renter_id,
    agent: row.agent,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    repoUrl: row.repo_url,
    cockpitPort: row.cockpit_port,
    openUrl: row.cockpit_open_url,
    projectId: row.project_id,
    projectDir: row.project_dir,
    connectToken: row.connect_token,
    hostDisplayName: row.host_display_name,
    guestCredentialsStatus: guestCredentialsStatus(row.id),
    claudeAuth: getClaudeAuthPublic(row.id),
  };
}

app.get("/reservations/mine", requireUser, (c) => {
  const user = c.get("user");
  const rows = db
    .prepare(
      `SELECT id FROM reservations WHERE renter_id = ? ORDER BY starts_at DESC LIMIT 50`
    )
    .all(user.id) as Array<{ id: string }>;
  return c.json({
    reservations: rows.map((r) => getReservation(r.id)).filter(Boolean),
  });
});

app.get("/reservations/:id", requireUser, (c) => {
  const user = c.get("user");
  const reservation = getReservation(c.req.param("id"));
  if (!reservation) return c.json({ error: "Not found" }, 404);

  const host = db
    .prepare(`SELECT owner_id FROM hosts WHERE id = ?`)
    .get(reservation.hostId) as { owner_id: string };
  if (reservation.renterId !== user.id && host.owner_id !== user.id) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({
    reservation,
    host: getHostPublic(reservation.hostId),
  });
});

app.post("/reservations/:id/start", requireUser, async (c) => {
  const user = c.get("user");
  const reservation = getReservation(c.req.param("id"));
  if (!reservation || reservation.renterId !== user.id) {
    return c.json({ error: "Not found" }, 404);
  }
  if (reservation.status === "ended" || reservation.status === "cancelled") {
    return c.json({ error: "Reservation already finished" }, 400);
  }

  const body = await c
    .req.json<{
      repoUrl?: string;
      anthropicApiKey?: string;
      openaiApiKey?: string;
    }>()
    .catch(() => ({} as Record<string, never>));

  if (body && typeof body === "object" && "repoUrl" in body && body.repoUrl) {
    db.prepare(`UPDATE reservations SET repo_url = ? WHERE id = ?`).run(
      String(body.repoUrl),
      reservation.id
    );
  }

  // Optional: deposit renter API key at start (never stored in SQLite).
  const anthropic =
    typeof body.anthropicApiKey === "string" ? body.anthropicApiKey : "";
  const openai = typeof body.openaiApiKey === "string" ? body.openaiApiKey : "";
  if (anthropic || openai) {
    if (anthropic) {
      const err = validateAnthropicKey(anthropic);
      if (err) return c.json({ error: err }, 400);
    }
    if (openai) {
      const err = validateOpenAiKey(openai);
      if (err) return c.json({ error: err }, 400);
    }
    try {
      setGuestCredentials(reservation.id, reservation.hostId, {
        ...(anthropic ? { ANTHROPIC_API_KEY: anthropic } : {}),
        ...(openai ? { OPENAI_API_KEY: openai } : {}),
      });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "Invalid credentials" },
        400
      );
    }
  }

  db.prepare(
    `UPDATE reservations SET status = 'starting' WHERE id = ?`
  ).run(reservation.id);
  db.prepare(
    `UPDATE hosts SET sharing = 'busy', sandbox = 'preparing' WHERE id = ?`
  ).run(reservation.hostId);

  audit("session_start", `Starting session ${reservation.id}`, {
    userId: user.id,
    hostId: reservation.hostId,
  });

  return c.json({ reservation: getReservation(reservation.id) });
});

/** Deposit / replace renter API key for an active session (ephemeral). */
app.post("/reservations/:id/guest-credentials", requireUser, async (c) => {
  const user = c.get("user");
  const reservation = getReservation(c.req.param("id"));
  if (!reservation || reservation.renterId !== user.id) {
    return c.json({ error: "Not found" }, 404);
  }
  if (
    reservation.status === "ended" ||
    reservation.status === "cancelled"
  ) {
    return c.json({ error: "Reservation already finished" }, 400);
  }

  const body = await c.req.json<{
    anthropicApiKey?: string;
    openaiApiKey?: string;
  }>();
  const anthropic =
    typeof body.anthropicApiKey === "string" ? body.anthropicApiKey : "";
  const openai = typeof body.openaiApiKey === "string" ? body.openaiApiKey : "";
  if (anthropic) {
    const err = validateAnthropicKey(anthropic);
    if (err) return c.json({ error: err }, 400);
  }
  if (openai) {
    const err = validateOpenAiKey(openai);
    if (err) return c.json({ error: err }, 400);
  }
  try {
    setGuestCredentials(reservation.id, reservation.hostId, {
      ...(anthropic ? { ANTHROPIC_API_KEY: anthropic } : {}),
      ...(openai ? { OPENAI_API_KEY: openai } : {}),
    });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "Invalid credentials" },
      400
    );
  }

  audit("guest_credentials", `Renter deposited API key for ${reservation.id}`, {
    userId: user.id,
    hostId: reservation.hostId,
  });

  return c.json({
    ok: true,
    status: "pending",
    reservation: getReservation(reservation.id),
  });
});

app.post("/reservations/:id/end", requireUser, async (c) => {
  const user = c.get("user");
  const reservation = getReservation(c.req.param("id"));
  if (!reservation) return c.json({ error: "Not found" }, 404);

  const host = db
    .prepare(`SELECT owner_id FROM hosts WHERE id = ?`)
    .get(reservation.hostId) as { owner_id: string };
  if (reservation.renterId !== user.id && host.owner_id !== user.id) {
    return c.json({ error: "Not found" }, 404);
  }

  db.prepare(
    `UPDATE reservations SET status = 'ended' WHERE id = ?`
  ).run(reservation.id);
  db.prepare(
    `UPDATE hosts SET sharing = 'available', sandbox = 'cleaning' WHERE id = ?`
  ).run(reservation.hostId);
  clearGuestCredentials(reservation.id);
  clearClaudeAuth(reservation.id);

  audit("session_end", `Ended session ${reservation.id}`, {
    userId: user.id,
    hostId: reservation.hostId,
  });

  return c.json({ reservation: getReservation(reservation.id) });
});

/** Renter starts Claude Pro/Max OAuth inside the sealed guest. */
app.post("/reservations/:id/claude-auth/start", requireUser, async (c) => {
  const user = c.get("user");
  const reservation = getReservation(c.req.param("id"));
  if (!reservation || reservation.renterId !== user.id) {
    return c.json({ error: "Not found" }, 404);
  }
  if (
    reservation.status !== "starting" &&
    reservation.status !== "connected"
  ) {
    return c.json({ error: "Start the session first" }, 400);
  }
  requestClaudeAuth(reservation.id, reservation.hostId);
  audit("claude_auth_start", `Renter started Claude login for ${reservation.id}`, {
    userId: user.id,
    hostId: reservation.hostId,
  });
  return c.json({ ok: true, reservation: getReservation(reservation.id) });
});

/** Renter submits the OAuth paste-code from claude.com. */
app.post("/reservations/:id/claude-auth/code", requireUser, async (c) => {
  const user = c.get("user");
  const reservation = getReservation(c.req.param("id"));
  if (!reservation || reservation.renterId !== user.id) {
    return c.json({ error: "Not found" }, 404);
  }
  const body = await c.req.json<{ code?: string }>();
  try {
    setClaudeAuthCode(
      reservation.id,
      reservation.hostId,
      String(body.code || "")
    );
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "Invalid code" },
      400
    );
  }
  return c.json({ ok: true, reservation: getReservation(reservation.id) });
});

function buildConnectPayload(reservation: NonNullable<ReturnType<typeof getReservation>>) {
  const host = getHostPublic(reservation.hostId);
  const snap = host?.snapshot;
  if (!snap?.tailscaleHostname && !snap?.tailscaleIp) {
    return {
      error:
        "Lender Mac has no Tailscale address yet. Ask them to finish Tailscale setup.",
    } as const;
  }

  const remoteHost = snap.tailscaleHostname || snap.tailscaleIp!;
  const remotePort = reservation.cockpitPort ?? DEFAULT_COCKPIT_PORT;
  const remoteUser = snap.sshUser || "bay-worker";
  const openUrl =
    reservation.openUrl ||
    (reservation.projectId
      ? `http://127.0.0.1:${remotePort}/new-session?projectId=${reservation.projectId}`
      : `http://127.0.0.1:${remotePort}/new-session`);

  return {
    connect: {
      reservationId: reservation.id,
      localPort: remotePort,
      remoteHost,
      remoteUser,
      remotePort,
      agent: reservation.agent,
      sshTarget: `${remoteUser}@${remoteHost}`,
      connectToken: reservation.connectToken,
      bayUrl: `bay://connect/${reservation.id}?token=${reservation.connectToken}`,
      openUrl,
      projectId: reservation.projectId,
      projectDir: reservation.projectDir,
    },
    reservation,
    host,
  } as const;
}

app.get("/reservations/:id/connect", requireUser, (c) => {
  const user = c.get("user");
  const reservation = getReservation(c.req.param("id"));
  if (!reservation || reservation.renterId !== user.id) {
    return c.json({ error: "Not found" }, 404);
  }
  const payload = buildConnectPayload(reservation);
  if ("error" in payload) return c.json({ error: payload.error }, 400);
  return c.json(payload);
});

/** Token-based connect for Bay Connect helper (no browser login token needed). */
app.get("/connect/:id", (c) => {
  const reservation = getReservation(c.req.param("id"));
  const token = c.req.query("token");
  if (!reservation || !token || reservation.connectToken !== token) {
    return c.json({ error: "Invalid connect link" }, 401);
  }
  if (reservation.status === "ended" || reservation.status === "cancelled") {
    return c.json({ error: "Session already ended" }, 400);
  }
  const payload = buildConnectPayload(reservation);
  if ("error" in payload) return c.json({ error: payload.error }, 400);
  return c.json(payload);
});

app.get("/audit", requireUser, (c) => {
  const user = c.get("user");
  const rows = db
    .prepare(
      `SELECT id, kind, message, created_at as createdAt FROM audit_log
       WHERE user_id = ? OR host_id IN (SELECT id FROM hosts WHERE owner_id = ?)
       ORDER BY created_at DESC LIMIT 40`
    )
    .all(user.id, user.id);
  return c.json({ events: rows });
});

// Public download stub page helper
app.get("/download/host", (c) => {
  return c.json({
    message: "Install the Bay Host app from the repo: pnpm --filter @bay/host start",
    script: "pnpm --filter @bay/host start",
  });
});

serve({ fetch: app.fetch, port: PORT, hostname: HOSTNAME }, () => {
  console.log(`Bay API listening on http://${HOSTNAME}:${PORT}`);
});
