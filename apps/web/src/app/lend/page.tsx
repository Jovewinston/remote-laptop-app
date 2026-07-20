"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { api, bayDownloadHostUrl, getToken } from "@/lib/api";
import type { HostPublic } from "@bay/shared";

type MineHost = HostPublic & {
  hostToken?: string;
  availability?: Array<{
    id: string;
    dayOfWeek: number;
    startHour: number;
    endHour: number;
  }>;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function StepNum({
  n,
  state,
}: {
  n: number;
  state: "todo" | "active" | "done";
}) {
  return (
    <span className={`setup-num ${state === "done" ? "done" : state === "active" ? "active" : ""}`}>
      {state === "done" ? "✓" : n}
    </span>
  );
}

export default function LendPage() {
  const router = useRouter();
  const [host, setHost] = useState<MineHost | null>(null);
  const [error, setError] = useState("");
  const [invite, setInvite] = useState("");
  const [copied, setCopied] = useState(false);
  const [windows, setWindows] = useState(
    DAYS.map((_, dayOfWeek) => ({
      dayOfWeek,
      enabled: true,
      startHour: 0,
      endHour: 24,
    }))
  );

  async function load() {
    try {
      const data = await api<{ hosts: MineHost[] }>("/hosts/mine");
      const h = data.hosts[0] ?? null;
      setHost(h);
      if (h?.availability?.length) {
        setWindows(
          DAYS.map((_, dayOfWeek) => {
            const w = h.availability!.find((a) => a.dayOfWeek === dayOfWeek);
            return {
              dayOfWeek,
              enabled: Boolean(w),
              startHour: w?.startHour ?? 18,
              endHour: w?.endHour ?? 23,
            };
          })
        );
      }
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load");
    }
  }

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [router]);

  const status = useMemo(() => {
    if (!host) return null;
    const snap = host.snapshot;
    const backend = snap?.sandboxBackend === "vm" ? "vm" : "folder";
    const vmReady = Boolean(
      backend === "vm" && snap?.tartAvailable && snap?.goldenImageReady
    );
    const vmNeedsSetup = backend === "vm" && !vmReady;
    return {
      online: host.online,
      sharing: snap?.sharing ?? "off",
      sandbox: snap?.sandbox ?? "idle",
      tailscale: snap?.tailscaleConnected ?? false,
      backend,
      vmReady,
      vmNeedsSetup,
      tartAvailable: Boolean(snap?.tartAvailable),
      goldenImageReady: Boolean(snap?.goldenImageReady),
      diskFreeGb: snap?.diskFreeGb,
      power: snap?.onPower
        ? "On charger"
        : snap?.batteryPercent != null
          ? `On battery (${snap.batteryPercent}%)`
          : "Unknown",
      lastSeen: host.lastSeenAt
        ? `${Math.max(0, Math.round((Date.now() - new Date(host.lastSeenAt).getTime()) / 1000))}s ago`
        : "never",
    };
  }, [host]);

  const setup = useMemo(() => {
    const registered = Boolean(host?.hostToken);
    const online = Boolean(status?.online);
    const sharingOn =
      status?.sharing === "available" || status?.sharing === "busy";
    return {
      registered,
      online,
      sharingOn,
      step1: registered ? "done" : "active",
      step2: !registered ? "todo" : online || sharingOn ? "done" : "active",
    } as const;
  }, [host, status]);

  async function register() {
    setError("");
    try {
      await api("/hosts/register", {
        method: "POST",
        body: JSON.stringify({}),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not register");
    }
  }

  async function copyToken() {
    if (!host?.hostToken) return;
    try {
      await navigator.clipboard.writeText(host.hostToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy token — select it manually");
    }
  }

  async function saveHours() {
    if (!host) return;
    try {
      await api(`/hosts/${host.id}/availability`, {
        method: "PUT",
        body: JSON.stringify({
          windows: windows
            .filter((w) => w.enabled)
            .map((w) => ({
              dayOfWeek: w.dayOfWeek,
              startHour: w.startHour,
              endHour: w.endHour,
            })),
        }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save hours");
    }
  }

  async function toggleSharing() {
    if (!host) return;
    const next =
      status?.sharing === "available" || status?.sharing === "busy"
        ? "off"
        : "available";
    try {
      await api(`/hosts/${host.id}/sharing`, {
        method: "POST",
        body: JSON.stringify({ sharing: next }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update sharing");
    }
  }

  async function createInvite() {
    try {
      const data = await api<{ code: string }>("/invites", { method: "POST" });
      setInvite(data.code);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create invite");
    }
  }

  return (
    <AppShell>
      <section className="hero">
        <h1>Share this Mac.</h1>
        <p>
          Follow the checklist once. Friends reserve a slot, connect in one
          click, and run Claude or Codex on your computer — sandboxed.
        </p>
      </section>

      {error && <p className="error">{error}</p>}

      <div className="grid" style={{ gap: "1.25rem" }}>
        <div className="panel">
          <h2 style={{ fontFamily: "var(--font-display)", marginTop: 0 }}>
            Lender setup
          </h2>
          <p className="meta" style={{ marginBottom: "1.25rem" }}>
            Register here, then do day-to-day lending in{" "}
            <strong>Bay Host.app</strong> (Tailscale, how much RAM/CPU to lend,
            sealed VM setup, Available). Keep the Mac plugged in while lending.
          </p>

          <ol className="setup-list">
            <li className="setup-item">
              <StepNum n={1} state={setup.step1} />
              <div className="setup-body">
                <h3>Register this Mac</h3>
                <p>
                  Creates your Borrow listing and a host token. Bay Host uses
                  that token so the app can stay signed in (not your password).
                </p>
                <div className="actions">
                  <button type="button" className="btn primary" onClick={register}>
                    {host ? "Refresh registration" : "Register this Mac"}
                  </button>
                </div>
                {host?.hostToken && (
                  <div className="setup-token">
                    <code>{host.hostToken}</code>
                    <button type="button" className="btn" onClick={copyToken}>
                      {copied ? "Copied" : "Copy token"}
                    </button>
                  </div>
                )}
              </div>
            </li>

            <li className="setup-item">
              <StepNum n={2} state={setup.step2} />
              <div className="setup-body">
                <h3>Open Bay Host</h3>
                <p>
                  Download the Mac app (Apple Silicon). Unzip → Applications →
                  first open: Right-click → Open. Paste your token, pick how
                  much to lend, finish Tailscale / VM setup in the app, then
                  Available.
                </p>
                <div className="actions">
                  <a
                    className="btn primary"
                    href={bayDownloadHostUrl()}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Download Bay Host
                  </a>
                  <a className="btn" href="http://127.0.0.1:3410">
                    Open Host cockpit
                  </a>
                </div>
                <p className="muted" style={{ marginTop: "0.75rem", fontSize: "0.9rem" }}>
                  Menu bar shows Bay · on / busy / pause while Host is running.
                  Optional: Open at Login inside the app.
                </p>
                <details style={{ marginTop: "0.75rem" }}>
                  <summary className="muted" style={{ cursor: "pointer", fontSize: "0.9rem" }}>
                    Advanced: run from source
                  </summary>
                  <pre className="setup-code">{`cd /path/to/bay
pnpm --filter @bay/host start
# opens http://127.0.0.1:3410`}</pre>
                </details>
              </div>
            </li>
          </ol>

          <details className="setup-details">
            <summary>Sealed Linux VM</summary>
            <p className="meta">
              In Bay Host → Isolation → <strong>Sealed Linux VM</strong>, then
              <strong> Install Tart + build golden image</strong>. No Terminal
              required when using the app. Needs Apple Silicon and roughly{" "}
              <strong>40 GB free storage</strong>.
            </p>
            {status?.backend === "vm" && (
              <div className="check-pills">
                <span className="pill">
                  <i
                    className={`dot ${status.tartAvailable ? "online" : "warn"}`}
                  />
                  Tart {status.tartAvailable ? "installed" : "missing"}
                </span>
                <span className="pill">
                  <i
                    className={`dot ${status.goldenImageReady ? "online" : "warn"}`}
                  />
                  Golden image {status.goldenImageReady ? "ready" : "not built"}
                </span>
                {status.diskFreeGb != null && (
                  <span className="pill">{status.diskFreeGb} GB free</span>
                )}
              </div>
            )}
          </details>
        </div>

        <div className="panel">
          <h2 style={{ fontFamily: "var(--font-display)", marginTop: 0 }}>
            Live status
          </h2>
          {!host && <p className="meta">Register a Mac to see status.</p>}
          {host && status && (
            <>
              <div className="status-row">
                <span>
                  <i className={`dot ${status.online ? "online" : ""}`} />
                  {status.online ? "Online" : "Offline"}
                </span>
                <span>
                  Tailscale: {status.tailscale ? "Connected" : "Not connected"}
                </span>
                <span>
                  Sharing:{" "}
                  {status.sharing === "available"
                    ? "Available"
                    : status.sharing === "busy"
                      ? "Busy"
                      : "Paused"}
                </span>
                <span>Sandbox: {status.sandbox}</span>
                <span>
                  Mode:{" "}
                  {status.backend === "vm"
                    ? status.vmReady
                      ? "Sealed Linux VM ✓"
                      : "VM (finish setup above)"
                    : "Folder sandbox"}
                </span>
                <span>Power: {status.power}</span>
                <span>Updated {status.lastSeen}</span>
              </div>
              {host.snapshot && (
                <p className="meta">
                  {host.snapshot.chip} · {host.snapshot.ramGb} GB RAM ·{" "}
                  {host.snapshot.diskFreeGb} GB free
                  {host.snapshot.tailscaleHostname
                    ? ` · ${host.snapshot.tailscaleHostname}`
                    : ""}
                </p>
              )}
              <div className="actions" style={{ marginTop: "0.75rem" }}>
                <button
                  type="button"
                  className="btn"
                  onClick={toggleSharing}
                  disabled={!host}
                >
                  {status.sharing === "off"
                    ? "Turn Available on (website)"
                    : "Pause sharing (website)"}
                </button>
                <a className="btn primary" href="http://127.0.0.1:3410">
                  Manage in Host
                </a>
              </div>
            </>
          )}
        </div>

        <div className="panel">
          <h2 style={{ fontFamily: "var(--font-display)", marginTop: 0 }}>
            Schedule
          </h2>
          <p className="meta" style={{ marginBottom: "1rem" }}>
            {host?.nextFreeLabel === "Always" ||
            windows.every((w) => w.enabled && w.startHour === 0 && w.endHour === 24)
              ? "Always available — friends can book any time."
              : "Custom hours are set. Reset to always-open anytime."}
          </p>
          <div className="actions" style={{ marginBottom: "0.75rem" }}>
            <button
              type="button"
              className="btn primary"
              disabled={!host}
              onClick={async () => {
                const always = DAYS.map((_, dayOfWeek) => ({
                  dayOfWeek,
                  enabled: true,
                  startHour: 0,
                  endHour: 24,
                }));
                setWindows(always);
                if (!host) return;
                try {
                  await api(`/hosts/${host.id}/availability`, {
                    method: "PUT",
                    body: JSON.stringify({
                      windows: always.map((w) => ({
                        dayOfWeek: w.dayOfWeek,
                        startHour: 0,
                        endHour: 24,
                      })),
                    }),
                  });
                  await load();
                } catch (err) {
                  setError(
                    err instanceof Error ? err.message : "Could not save schedule"
                  );
                }
              }}
            >
              Always available
            </button>
          </div>
          <details className="setup-details">
            <summary>Custom hours (optional)</summary>
            <p className="meta" style={{ marginBottom: "1rem" }}>
              Only needed if you want to limit when friends can book.
            </p>
            <div className="avail-grid">
              {windows.map((w, idx) => (
                <div className="avail-row" key={w.dayOfWeek}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={w.enabled}
                      onChange={(e) => {
                        const next = [...windows];
                        next[idx] = { ...w, enabled: e.target.checked };
                        setWindows(next);
                      }}
                    />
                    {DAYS[w.dayOfWeek]}
                  </label>
                  <select
                    disabled={!w.enabled}
                    value={w.startHour}
                    onChange={(e) => {
                      const next = [...windows];
                      next[idx] = { ...w, startHour: Number(e.target.value) };
                      setWindows(next);
                    }}
                  >
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={h}>
                        {h}:00
                      </option>
                    ))}
                  </select>
                  <select
                    disabled={!w.enabled}
                    value={w.endHour}
                    onChange={(e) => {
                      const next = [...windows];
                      next[idx] = { ...w, endHour: Number(e.target.value) };
                      setWindows(next);
                    }}
                  >
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h + 1} value={h + 1}>
                        {h + 1}:00
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <div className="actions" style={{ marginTop: "1rem" }}>
              <button type="button" className="btn" onClick={saveHours} disabled={!host}>
                Save custom hours
              </button>
            </div>
          </details>
        </div>

        <div className="panel">
          <h2 style={{ fontFamily: "var(--font-display)", marginTop: 0 }}>
            Invite a friend
          </h2>
          <p className="meta">Bay is invite-only. Share a code so they can sign up.</p>
          <div className="actions" style={{ marginTop: "1rem" }}>
            <button type="button" className="btn" onClick={createInvite}>
              Create invite code
            </button>
          </div>
          {invite && (
            <p style={{ marginTop: "0.75rem" }}>
              Share this code: <strong>{invite}</strong>
            </p>
          )}
        </div>
      </div>
    </AppShell>
  );
}
