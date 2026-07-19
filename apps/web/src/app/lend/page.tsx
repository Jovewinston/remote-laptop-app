"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { api, getToken } from "@/lib/api";
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
    const tailscale = Boolean(status?.tailscale);
    const sharingOn =
      status?.sharing === "available" || status?.sharing === "busy";
    return {
      registered,
      online,
      tailscale,
      sharingOn,
      // Step states for the checklist
      step1: registered ? "done" : "active",
      step2: !registered ? "todo" : online ? "done" : "active",
      step3: !online ? "todo" : tailscale ? "done" : "active",
      step4: !tailscale && !online ? "todo" : sharingOn ? "done" : "active",
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
            Do this on the Mac you’re sharing. Keep it plugged in while
            Available — closing the lid usually sleeps the machine.
          </p>

          <ol className="setup-list">
            <li className="setup-item">
              <StepNum n={1} state={setup.step1} />
              <div className="setup-body">
                <h3>Register this Mac</h3>
                <p>
                  Creates a listing for your account and a host token Bay Host
                  uses to stay signed in.
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
                <h3>Start Bay Host</h3>
                <p>
                  Host watches health, prepares sandboxes when someone borrows,
                  and talks to Bay. Run this in a terminal on this Mac:
                </p>
                <pre className="setup-code">{`cd /path/to/bay
pnpm --filter @bay/host start
# opens http://127.0.0.1:3410`}</pre>
                <div className="actions">
                  <a className="btn primary" href="http://127.0.0.1:3410">
                    Open Host setup
                  </a>
                </div>
                <p className="muted" style={{ marginTop: "0.75rem", fontSize: "0.9rem" }}>
                  In Host: paste your token → Save. Leave Host running while you
                  lend.
                </p>
              </div>
            </li>

            <li className="setup-item">
              <StepNum n={3} state={setup.step3} />
              <div className="setup-body">
                <h3>Connect Tailscale</h3>
                <p>
                  Friends reach your Mac without being on the same Wi‑Fi.
                  Install Tailscale, sign in, then recheck in Host.
                </p>
                <div className="actions">
                  <a
                    className="btn"
                    href="https://tailscale.com/download/mac"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Get Tailscale
                  </a>
                </div>
                {status && (
                  <div className="check-pills">
                    <span className="pill">
                      <i className={`dot ${status.tailscale ? "online" : ""}`} />
                      {status.tailscale ? "Tailscale connected" : "Tailscale not connected"}
                    </span>
                    <span className="pill">
                      <i className={`dot ${status.online ? "online" : ""}`} />
                      {status.online ? "Host online" : "Host offline"}
                    </span>
                  </div>
                )}
              </div>
            </li>

            <li className="setup-item">
              <StepNum n={4} state={setup.step4} />
              <div className="setup-body">
                <h3>Go Available</h3>
                <p>
                  Schedule defaults to <strong>always open</strong>. Flip
                  sharing on and your Mac appears on Borrow.
                </p>
                <div className="actions">
                  <button
                    type="button"
                    className="btn primary"
                    onClick={toggleSharing}
                    disabled={!host}
                  >
                    {status?.sharing === "off" || !status
                      ? "Turn Available on"
                      : "Pause sharing"}
                  </button>
                </div>
              </div>
            </li>
          </ol>

          <details className="setup-details">
            <summary>Optional: sealed Linux VM (stronger isolation)</summary>
            <p className="meta">
              Default is folder sandbox under <code>~/.bay/sandbox</code>. VM
              mode runs each job in a disposable Linux guest via Tart — needs
              Apple Silicon and about <strong>40 GB free storage</strong> (not
              RAM) for the golden image.
            </p>
            <p className="meta" style={{ marginTop: "0.75rem" }}>
              Renters sign into <em>their</em> Claude/Codex in Yep. Your Keychain
              is not used.
            </p>
            <pre className="setup-code">{`# 1) Install Tart (once)
brew install cirruslabs/cli/tart cirruslabs/cli/sshpass

# 2) Build golden image (once, takes a while)
cd /path/to/bay
pnpm --filter @bay/host guest:build

# 3) Restart Host in VM mode
export BAY_SANDBOX_BACKEND=vm
pnpm --filter @bay/host start`}</pre>
            <p className="muted" style={{ fontSize: "0.9rem", margin: 0 }}>
              Host’s Sandbox card should say “Sealed Linux VM ready.” Same
              Borrow → Start → Connect flow for renters.
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
