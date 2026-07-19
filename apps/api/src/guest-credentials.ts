/**
 * Ephemeral renter → host credential handoff.
 * Secrets live in memory only (never returned on GET reservations).
 */

export type GuestCredentialPayload = {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
};

type Entry = {
  hostId: string;
  credentials: GuestCredentialPayload;
  status: "pending" | "delivered";
  createdAt: number;
  expiresAt: number;
};

const TTL_MS = 2 * 60 * 60 * 1000; // 2h or until session ends
const store = new Map<string, Entry>();

function sweep() {
  const now = Date.now();
  for (const [id, e] of store) {
    if (e.expiresAt <= now) store.delete(id);
  }
}

export function setGuestCredentials(
  reservationId: string,
  hostId: string,
  credentials: GuestCredentialPayload
) {
  sweep();
  const clean: GuestCredentialPayload = {};
  if (credentials.ANTHROPIC_API_KEY?.trim()) {
    clean.ANTHROPIC_API_KEY = credentials.ANTHROPIC_API_KEY.trim();
  }
  if (credentials.OPENAI_API_KEY?.trim()) {
    clean.OPENAI_API_KEY = credentials.OPENAI_API_KEY.trim();
  }
  if (!clean.ANTHROPIC_API_KEY && !clean.OPENAI_API_KEY) {
    throw new Error("Provide an API key");
  }
  store.set(reservationId, {
    hostId,
    credentials: clean,
    status: "pending",
    createdAt: Date.now(),
    expiresAt: Date.now() + TTL_MS,
  });
}

export function guestCredentialsStatus(
  reservationId: string
): "none" | "pending" | "applied" {
  sweep();
  const e = store.get(reservationId);
  if (!e) return "none";
  return e.status === "delivered" ? "applied" : "pending";
}

export function guestCredentialsPending(
  reservationId: string,
  hostId: string
): boolean {
  sweep();
  const e = store.get(reservationId);
  return Boolean(e && e.hostId === hostId && e.status === "pending");
}

/** One-shot claim for the lender Host. Deletes secret after return. */
export function claimGuestCredentials(
  reservationId: string,
  hostId: string
): GuestCredentialPayload | null {
  sweep();
  const e = store.get(reservationId);
  if (!e || e.hostId !== hostId || e.status !== "pending") return null;
  const creds = e.credentials;
  // Keep a delivered marker (no secret) so UI can show "applied".
  store.set(reservationId, {
    hostId,
    credentials: {},
    status: "delivered",
    createdAt: e.createdAt,
    expiresAt: e.expiresAt,
  });
  return creds;
}

export function clearGuestCredentials(reservationId: string) {
  store.delete(reservationId);
}

export function validateAnthropicKey(key: string): string | null {
  const k = key.trim();
  if (!k) return "API key required";
  if (k.includes("\n") || k.includes("\r")) return "API key must be a single line";
  if (k.length < 20) return "API key looks too short";
  return null;
}

export function validateOpenAiKey(key: string): string | null {
  const k = key.trim();
  if (!k) return "API key required";
  if (k.includes("\n") || k.includes("\r")) return "API key must be a single line";
  if (k.length < 20) return "API key looks too short";
  return null;
}
