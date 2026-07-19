/**
 * Ephemeral Claude Pro/Max OAuth relay (renter ↔ host ↔ guest).
 * Never persists secrets to SQLite.
 */

export type ClaudeAuthStatus =
  | "none"
  | "requested"
  | "starting"
  | "awaiting_code"
  | "code_pending"
  | "done"
  | "error";

type Entry = {
  hostId: string;
  status: ClaudeAuthStatus;
  loginUrl: string | null;
  code: string | null;
  error: string | null;
  detail: string | null;
  createdAt: number;
  expiresAt: number;
  /** Last time status moved — used to reclaim stuck "starting" */
  updatedAt: number;
};

const TTL_MS = 2 * 60 * 60 * 1000;
const store = new Map<string, Entry>();

function sweep() {
  const now = Date.now();
  for (const [id, e] of store) {
    if (e.expiresAt <= now) store.delete(id);
  }
}

function touch(
  reservationId: string,
  hostId: string,
  patch: Partial<Entry>
): Entry {
  sweep();
  const prev = store.get(reservationId);
  const statusChanged =
    patch.status !== undefined && patch.status !== prev?.status;
  const next: Entry = {
    hostId,
    status: patch.status ?? prev?.status ?? "none",
    loginUrl: patch.loginUrl !== undefined ? patch.loginUrl : prev?.loginUrl ?? null,
    code: patch.code !== undefined ? patch.code : prev?.code ?? null,
    error: patch.error !== undefined ? patch.error : prev?.error ?? null,
    detail: patch.detail !== undefined ? patch.detail : prev?.detail ?? null,
    createdAt: prev?.createdAt ?? Date.now(),
    expiresAt: Date.now() + TTL_MS,
    updatedAt:
      patch.updatedAt ??
      (statusChanged || patch.detail !== undefined
        ? Date.now()
        : prev?.updatedAt ?? Date.now()),
  };
  store.set(reservationId, next);
  return next;
}

export function requestClaudeAuth(reservationId: string, hostId: string) {
  return touch(reservationId, hostId, {
    status: "requested",
    loginUrl: null,
    code: null,
    error: null,
    detail: "Waiting for lender Host to pick up login…",
  });
}

export function setClaudeAuthDetail(
  reservationId: string,
  hostId: string,
  detail: string
) {
  const e = store.get(reservationId);
  if (!e || e.hostId !== hostId) return null;
  return touch(reservationId, hostId, { detail: String(detail).slice(0, 240) });
}

export function setClaudeAuthUrl(
  reservationId: string,
  hostId: string,
  loginUrl: string
) {
  const e = store.get(reservationId);
  if (!e || e.hostId !== hostId) return null;
  return touch(reservationId, hostId, {
    status: "awaiting_code",
    loginUrl: loginUrl.trim(),
    error: null,
    detail: "Login link ready — open it in your browser",
  });
}

export function markClaudeAuthError(
  reservationId: string,
  hostId: string,
  error: string
) {
  const e = store.get(reservationId);
  if (!e || e.hostId !== hostId) return null;
  return touch(reservationId, hostId, {
    status: "error",
    code: null,
    error: String(error).slice(0, 240),
    detail: "Login failed — try again",
  });
}

export function setClaudeAuthCode(
  reservationId: string,
  hostId: string,
  code: string
) {
  const trimmed = code.trim();
  if (!trimmed) throw new Error("Paste the code from Claude");
  if (trimmed.length > 2000) throw new Error("Code looks too long");
  const e = store.get(reservationId);
  if (!e || e.hostId !== hostId) {
    throw new Error("Start Sign in with Claude first");
  }
  if (e.status !== "awaiting_code" && e.status !== "code_pending") {
    throw new Error("Login is not waiting for a code yet");
  }
  return touch(reservationId, hostId, {
    status: "code_pending",
    code: trimmed,
    error: null,
    detail: "Code received — applying inside the sealed VM…",
  });
}

/** Host claims a start request (or reclaim if stuck in starting). */
export function claimClaudeAuthStart(
  reservationId: string,
  hostId: string
): boolean {
  sweep();
  const e = store.get(reservationId);
  if (!e || e.hostId !== hostId) return false;
  const stuckStarting =
    e.status === "starting" &&
    !e.loginUrl &&
    Date.now() - (e.updatedAt || e.createdAt) > 12_000;
  if (e.status !== "requested" && !stuckStarting) return false;
  touch(reservationId, hostId, {
    status: "starting",
    detail: "Host claimed login — talking to sealed VM…",
    updatedAt: Date.now(),
  });
  return true;
}

export function claimClaudeAuthCode(
  reservationId: string,
  hostId: string
): string | null {
  sweep();
  const e = store.get(reservationId);
  if (!e || e.hostId !== hostId || e.status !== "code_pending" || !e.code) {
    return null;
  }
  const code = e.code;
  touch(reservationId, hostId, { code: null });
  return code;
}

export function markClaudeAuthDone(reservationId: string, hostId: string) {
  const e = store.get(reservationId);
  if (!e || e.hostId !== hostId) return null;
  return touch(reservationId, hostId, {
    status: "done",
    code: null,
    error: null,
    detail: "Claude Pro/Max signed in",
  });
}

export function getClaudeAuthPublic(reservationId: string) {
  sweep();
  const e = store.get(reservationId);
  if (!e) {
    return {
      status: "none" as ClaudeAuthStatus,
      loginUrl: null as string | null,
      error: null as string | null,
      detail: null as string | null,
    };
  }
  return {
    status: e.status,
    loginUrl: e.loginUrl,
    error: e.error,
    detail: e.detail,
  };
}

export function claudeAuthStartPending(
  reservationId: string,
  hostId: string
): boolean {
  sweep();
  const e = store.get(reservationId);
  if (!e || e.hostId !== hostId) return false;
  if (e.status === "requested") return true;
  // Allow Host to retry if stuck before a URL appears.
  return (
    e.status === "starting" &&
    !e.loginUrl &&
    Date.now() - (e.updatedAt || e.createdAt) > 12_000
  );
}

export function claudeAuthCodePending(
  reservationId: string,
  hostId: string
): boolean {
  sweep();
  const e = store.get(reservationId);
  return Boolean(e && e.hostId === hostId && e.status === "code_pending");
}

export function clearClaudeAuth(reservationId: string) {
  store.delete(reservationId);
}
