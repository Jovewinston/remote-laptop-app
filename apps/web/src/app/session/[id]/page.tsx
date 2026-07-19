"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { api, getToken } from "@/lib/api";
import type { HostPublic, Reservation } from "@bay/shared";

type ConnectInfo = {
  bayUrl: string;
  openUrl: string;
  sshTarget: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  connectToken: string;
  projectId?: string | null;
  projectDir?: string | null;
};

export default function SessionPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [host, setHost] = useState<HostPublic | null>(null);
  const [connect, setConnect] = useState<ConnectInfo | null>(null);
  const [repoUrl, setRepoUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [claudeCode, setClaudeCode] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [authWaitSec, setAuthWaitSec] = useState(0);

  async function load() {
    try {
      const data = await api<{ reservation: Reservation; host: HostPublic }>(
        `/reservations/${params.id}`
      );
      setReservation(data.reservation);
      setHost(data.host);
      setRepoUrl(data.reservation.repoUrl ?? "");
      if (
        data.reservation.status === "starting" ||
        data.reservation.status === "connected"
      ) {
        try {
          const c = await api<{ connect: ConnectInfo }>(
            `/reservations/${params.id}/connect`
          );
          setConnect(c.connect);
        } catch {
          setConnect(null);
        }
      }
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load session");
    }
  }

  const sandbox = host?.snapshot?.sandbox ?? "idle";
  const preparing =
    reservation?.status === "starting" || sandbox === "preparing";
  const claudeAuth = reservation?.claudeAuth;
  const authBusy =
    claudeAuth?.status === "requested" ||
    claudeAuth?.status === "starting" ||
    claudeAuth?.status === "code_pending";

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    load();
    const ms =
      preparing || authBusy || claudeAuth?.status === "awaiting_code"
        ? 2000
        : 5000;
    const t = setInterval(load, ms);
    return () => clearInterval(t);
  }, [params.id, router, preparing, authBusy, claudeAuth?.status]);

  useEffect(() => {
    if (!authBusy && claudeAuth?.status !== "awaiting_code") {
      setAuthWaitSec(0);
      return;
    }
    setAuthWaitSec(0);
    const t = setInterval(() => setAuthWaitSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [authBusy, claudeAuth?.status]);

  const timeLeft = useMemo(() => {
    if (!reservation) return "";
    const ms = new Date(reservation.endsAt).getTime() - Date.now();
    if (ms <= 0) return "0:00";
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}:${String(s).padStart(2, "0")}`;
  }, [reservation, host]);

  const prepPhases = useMemo(() => {
    const isVm = host?.snapshot?.sandboxBackend === "vm";
    return isVm
      ? [
          { key: "clone", label: "Clone sealed VM" },
          { key: "boot", label: "Boot Linux guest" },
          { key: "agent", label: "Guest agent ready" },
          { key: "cockpit", label: "Start Yep Anywhere" },
          { key: "tunnel", label: "Bridge to localhost" },
          { key: "ready", label: "Ready to Connect" },
        ]
      : [
          { key: "clone", label: "Create sandbox folder" },
          { key: "cockpit", label: "Start Yep Anywhere" },
          { key: "ready", label: "Ready to Connect" },
        ];
  }, [host?.snapshot?.sandboxBackend]);

  const activePhase = host?.snapshot?.preparePhase ?? null;
  const prepareDetail =
    host?.snapshot?.prepareDetail ||
    (preparing ? "Host is preparing your sandbox…" : null);

  const steps = useMemo(() => {
    const status = reservation?.status ?? "upcoming";
    const networkOk = Boolean(host?.online && host?.snapshot?.tailscaleConnected);
    const phaseIdx = activePhase
      ? prepPhases.findIndex((p) => p.key === activePhase)
      : -1;
    return [
      {
        key: "network",
        label: "Checking network",
        state: networkOk ? "done" : status === "upcoming" ? "active" : "active",
      },
      {
        key: "prep",
        label: "Preparing Mac",
        state:
          sandbox === "ready" ||
          status === "connected" ||
          activePhase === "ready"
            ? "done"
            : status === "starting" || sandbox === "preparing"
              ? "active"
              : sandbox === "error"
                ? "todo"
                : "todo",
        detail: prepareDetail,
        phaseIdx,
      },
      {
        key: "open",
        label: `Open ${reservation?.agent === "codex" ? "Codex" : "Claude"}`,
        state:
          status === "connected"
            ? "done"
            : status === "starting" && sandbox === "ready"
              ? "active"
              : "todo",
      },
    ];
  }, [reservation, host, sandbox, activePhase, prepareDetail, prepPhases]);

  async function start() {
    setBusy(true);
    try {
      const body: {
        repoUrl?: string;
        anthropicApiKey?: string;
        openaiApiKey?: string;
      } = { repoUrl: repoUrl || undefined };
      const key = apiKey.trim();
      if (key) {
        if (reservation?.agent === "codex") body.openaiApiKey = key;
        else body.anthropicApiKey = key;
      }
      await api(`/reservations/${params.id}/start`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setApiKey("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start");
    } finally {
      setBusy(false);
    }
  }

  async function applyApiKey() {
    const key = apiKey.trim();
    if (!key) {
      setError("Paste your API key first");
      return;
    }
    setBusy(true);
    try {
      const body =
        reservation?.agent === "codex"
          ? { openaiApiKey: key }
          : { anthropicApiKey: key };
      await api(`/reservations/${params.id}/guest-credentials`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setApiKey("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save API key");
    } finally {
      setBusy(false);
    }
  }

  async function startClaudeLogin() {
    setBusy(true);
    setError("");
    try {
      await api(`/reservations/${params.id}/claude-auth/start`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await load();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not start Claude login"
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitClaudeCode() {
    const code = claudeCode.trim();
    if (!code) {
      setError("Paste the code from the Claude login page");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(`/reservations/${params.id}/claude-auth/code`, {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      setClaudeCode("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit code");
    } finally {
      setBusy(false);
    }
  }

  async function end() {
    setBusy(true);
    try {
      await api(`/reservations/${params.id}/end`, { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not end");
    } finally {
      setBusy(false);
    }
  }

  function connectClick() {
    if (!connect || !reservation) return;
    // Same-Mac shortcut: open the sandbox project session directly.
    if (connect.openUrl?.includes("127.0.0.1") || connect.openUrl?.includes("localhost")) {
      window.open(connect.openUrl, "_blank", "noopener,noreferrer");
      return;
    }
    const cmd = `pnpm --filter @bay/connect start -- ${reservation.id} ${connect.connectToken}`;
    void navigator.clipboard?.writeText(cmd).catch(() => undefined);
    window.location.href = connect.bayUrl;
    alert(
      `Bay Connect link opened (if installed).\n\nOr run this in a terminal (copied if allowed):\n\n${cmd}`
    );
  }

  if (!reservation) {
    return (
      <AppShell>
        <p className="muted">{error || "Loading session…"}</p>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <section className="hero">
        <h1>
          {reservation.hostDisplayName || "Mac"} ·{" "}
          {reservation.agent === "claude" ? "Claude" : "Codex"}
        </h1>
        <p>
          Reservation {reservation.status}.{" "}
          {reservation.status !== "ended" && reservation.status !== "cancelled"
            ? `Time left: ${timeLeft}`
            : "Session finished."}
        </p>
      </section>

      {error && <p className="error">{error}</p>}

      <div className="panel" style={{ maxWidth: 640 }}>
        <div className="status-row">
          <span>
            <i
              className={`dot ${
                !host?.online
                  ? ""
                  : host.snapshot?.sharing === "busy"
                    ? "busy"
                    : "online"
              }`}
            />
            Host:{" "}
            {!host?.online
              ? "Offline"
              : host.snapshot?.sharing === "busy"
                ? "Busy"
                : "Online"}
          </span>
          <span>Sandbox: {host?.snapshot?.sandbox ?? "—"}</span>
          <span>
            Mode:{" "}
            {host?.snapshot?.sandboxBackend === "vm"
              ? "Sealed Linux VM"
              : "Folder sandbox"}
          </span>
          <span>
            Tailscale:{" "}
            {host?.snapshot?.tailscaleConnected ? "Connected" : "Not connected"}
          </span>
        </div>

        <div className="steps">
          {steps.map((s) => (
            <div
              key={s.key}
              className={`step ${s.state === "done" ? "done" : ""} ${
                s.state === "active" ? "active" : ""
              }`}
            >
              <span className={s.state === "active" ? "step-pulse" : undefined}>
                {s.state === "done" ? "✓" : s.state === "active" ? "…" : "○"}
              </span>
              <span>{s.label}</span>
            </div>
          ))}
        </div>

        {(preparing || sandbox === "error" || activePhase === "ready") && (
          <div
            className={`prep-panel ${preparing ? "prep-panel-live" : ""} ${
              sandbox === "error" ? "prep-panel-error" : ""
            }`}
          >
            <div className="prep-head">
              {preparing && <span className="prep-spinner" aria-hidden />}
              <div>
                <strong>
                  {sandbox === "error"
                    ? "Prepare failed"
                    : activePhase === "ready" || sandbox === "ready"
                      ? "Mac ready"
                      : "Preparing Mac"}
                </strong>
                <p className="meta prep-detail">
                  {prepareDetail ||
                    (sandbox === "error"
                      ? "Check Host terminal or ~/.bay/vms/logs/host.log"
                      : "Waiting for lender Host…")}
                </p>
              </div>
            </div>
            <ol className="prep-phases">
              {prepPhases.map((p, i) => {
                const cur = activePhase
                  ? prepPhases.findIndex((x) => x.key === activePhase)
                  : preparing
                    ? 0
                    : -1;
                const done =
                  sandbox === "ready" ||
                  activePhase === "ready" ||
                  (cur >= 0 && i < cur);
                const active = preparing && cur === i;
                return (
                  <li
                    key={p.key}
                    className={
                      done ? "done" : active ? "active" : sandbox === "error" && active ? "error" : ""
                    }
                  >
                    <span className="prep-mark">
                      {done ? "✓" : active ? <i className="prep-dot" /> : "○"}
                    </span>
                    {p.label}
                  </li>
                );
              })}
            </ol>
            <p className="meta prep-log-hint">
              Lender logs:{" "}
              <code>tail -f ~/.bay/vms/logs/host.log</code>
            </p>
          </div>
        )}

        {reservation.status === "upcoming" && (
          <div className="form">
            <label>
              GitHub repo (optional)
              <input
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/you/project.git"
              />
            </label>
            <p className="meta">
              After Start, sign in with your Claude Pro/Max (recommended) or an
              API key. Lender login is never used in sealed VM mode.
            </p>
          </div>
        )}

        {(reservation.status === "starting" ||
          reservation.status === "connected") &&
          reservation.agent === "claude" &&
          host?.snapshot?.sandboxBackend === "vm" && (
            <div className="form" style={{ marginTop: "1rem" }}>
              <strong>Sign in with Claude (Pro / Max)</strong>
              <p className="meta">
                Uses your Claude subscription inside the sealed VM. Open the
                login link on <em>your</em> browser, then paste the code back
                here.
              </p>
              {claudeAuth?.status === "done" ? (
                <div style={{ marginTop: "0.5rem" }}>
                  <p className="meta">
                    Claude signed in ✓ — Connect, then start a <em>new</em> chat
                    in Yep (old tabs may still say not logged in).
                  </p>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || sandbox !== "ready"}
                    onClick={startClaudeLogin}
                    style={{ marginTop: "0.5rem" }}
                  >
                    Sign in again
                  </button>
                </div>
              ) : (
                <>
                  {(claudeAuth?.status === "none" ||
                    claudeAuth?.status === "error") && (
                    <button
                      type="button"
                      className="btn primary"
                      disabled={busy || sandbox !== "ready"}
                      onClick={startClaudeLogin}
                      style={{ marginTop: "0.5rem" }}
                    >
                      {busy
                        ? "Starting…"
                        : sandbox !== "ready"
                          ? "Wait for Ready…"
                          : "Sign in with Claude"}
                    </button>
                  )}
                  {(claudeAuth?.status === "requested" ||
                    claudeAuth?.status === "starting" ||
                    claudeAuth?.status === "code_pending") && (
                    <div className="auth-progress" style={{ marginTop: "0.75rem" }}>
                      <div className="auth-progress-head">
                        <span className="prep-spinner" aria-hidden />
                        <div>
                          <strong>
                            {claudeAuth.status === "code_pending"
                              ? "Finishing Claude sign-in"
                              : "Getting login link from sealed VM"}
                          </strong>
                          <p className="meta prep-detail">
                            {claudeAuth.detail ||
                              (claudeAuth.status === "requested"
                                ? "Waiting for lender Host (checks about every 15s)…"
                                : claudeAuth.status === "code_pending"
                                  ? "Submitting code into the guest…"
                                  : "Talking to the sealed VM…")}{" "}
                            <span className="muted">({authWaitSec}s)</span>
                          </p>
                        </div>
                      </div>
                      <ol className="prep-phases">
                        {[
                          {
                            key: "host",
                            label: "Host picks up request",
                            done:
                              claudeAuth.status === "starting" ||
                              claudeAuth.status === "code_pending" ||
                              Boolean(claudeAuth.loginUrl),
                            active: claudeAuth.status === "requested",
                          },
                          {
                            key: "tunnel",
                            label: "Reach sealed VM tunnel",
                            done:
                              claudeAuth.status === "code_pending" ||
                              Boolean(claudeAuth.loginUrl),
                            active: claudeAuth.status === "starting",
                          },
                          {
                            key: "url",
                            label: "Claude login link ready",
                            done: Boolean(claudeAuth.loginUrl),
                            active: false,
                          },
                        ].map((step) => (
                          <li
                            key={step.key}
                            className={
                              step.done ? "done" : step.active ? "active" : ""
                            }
                          >
                            <span className="prep-mark">
                              {step.done ? (
                                "✓"
                              ) : step.active ? (
                                <i className="prep-dot" />
                              ) : (
                                "○"
                              )}
                            </span>
                            {step.label}
                          </li>
                        ))}
                      </ol>
                      {authWaitSec >= 45 && (
                        <button
                          type="button"
                          className="btn"
                          style={{ marginTop: "0.75rem" }}
                          disabled={busy}
                          onClick={startClaudeLogin}
                        >
                          Still waiting — retry
                        </button>
                      )}
                    </div>
                  )}
                  {claudeAuth?.loginUrl &&
                    (claudeAuth.status === "awaiting_code" ||
                      claudeAuth.status === "code_pending") && (
                      <div style={{ marginTop: "0.75rem" }}>
                        <a
                          className="btn primary"
                          href={claudeAuth.loginUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open Claude login
                        </a>
                        <label style={{ marginTop: "0.75rem", display: "block" }}>
                          Paste code from Claude
                          <input
                            value={claudeCode}
                            onChange={(e) => setClaudeCode(e.target.value)}
                            placeholder="Paste code here"
                            autoComplete="off"
                          />
                        </label>
                        <button
                          type="button"
                          className="btn"
                          disabled={busy || !claudeCode.trim()}
                          onClick={submitClaudeCode}
                          style={{ marginTop: "0.5rem" }}
                        >
                          {busy || claudeAuth.status === "code_pending"
                            ? "Submitting…"
                            : "Submit code"}
                        </button>
                      </div>
                    )}
                  {claudeAuth?.status === "error" && (
                    <div style={{ marginTop: "0.5rem" }}>
                      {claudeAuth.error && (
                        <p className="error">{claudeAuth.error}</p>
                      )}
                      <button
                        type="button"
                        className="btn primary"
                        disabled={busy || sandbox !== "ready"}
                        onClick={startClaudeLogin}
                        style={{ marginTop: "0.5rem" }}
                      >
                        Try Sign in again
                      </button>
                    </div>
                  )}
                </>
              )}

              <button
                type="button"
                className="btn"
                style={{ marginTop: "1rem" }}
                onClick={() => setShowApiKey((v) => !v)}
              >
                {showApiKey ? "Hide API key option" : "Or use an API key instead"}
              </button>
              {showApiKey && (
                <>
                  <label style={{ marginTop: "0.75rem", display: "block" }}>
                    Anthropic API key
                    <input
                      type="password"
                      autoComplete="off"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="sk-ant-…"
                    />
                  </label>
                  <p className="meta">
                    Optional alternative to Pro/Max login. Revoke after the
                    session.
                    {reservation.guestCredentialsStatus === "pending"
                      ? " Status: applying…"
                      : reservation.guestCredentialsStatus === "applied"
                        ? " Status: applied ✓"
                        : ""}
                  </p>
                  {reservation.guestCredentialsStatus !== "applied" && (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy || !apiKey.trim()}
                      onClick={applyApiKey}
                      style={{ marginTop: "0.5rem" }}
                    >
                      {busy ? "Saving…" : "Apply API key"}
                    </button>
                  )}
                </>
              )}
            </div>
          )}

        {(reservation.status === "starting" ||
          reservation.status === "connected") &&
          (reservation.agent === "codex" ||
            host?.snapshot?.sandboxBackend !== "vm") && (
            <div className="form" style={{ marginTop: "1rem" }}>
              <label>
                {reservation.agent === "codex"
                  ? "Your OpenAI API key"
                  : "Your Anthropic API key"}
                <input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={
                    reservation.agent === "codex" ? "sk-…" : "sk-ant-…"
                  }
                />
              </label>
              <p className="meta">
                Applied inside this session only.
                {reservation.guestCredentialsStatus === "applied"
                  ? " Status: applied ✓"
                  : ""}
              </p>
              {reservation.guestCredentialsStatus !== "applied" && (
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !apiKey.trim()}
                  onClick={applyApiKey}
                  style={{ marginTop: "0.5rem" }}
                >
                  {busy ? "Saving…" : "Apply API key"}
                </button>
              )}
            </div>
          )}

        <div className="actions" style={{ marginTop: "1.25rem" }}>
          {reservation.status === "upcoming" && (
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={start}
            >
              {busy ? "Starting…" : "Start session"}
            </button>
          )}
          {(reservation.status === "starting" ||
            reservation.status === "connected") && (
            <>
              <button
                type="button"
                className="btn primary"
                disabled={
                  !connect ||
                  (sandbox !== "ready" && reservation.status !== "connected")
                }
                onClick={connectClick}
                title={
                  sandbox !== "ready" && reservation.status !== "connected"
                    ? "Wait until Preparing Mac finishes"
                    : undefined
                }
              >
                {sandbox === "ready" || reservation.status === "connected"
                  ? "Connect"
                  : "Preparing…"}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={end}>
                End session
              </button>
            </>
          )}
          {(reservation.status === "ended" ||
            reservation.status === "cancelled") && (
            <a className="btn" href="/borrow">
              Back to Borrow
            </a>
          )}
        </div>

        {connect && (
          <div style={{ marginTop: "1.25rem" }}>
            <p className="meta">
              Connect opens Bay Connect to tunnel safely, then launches the
              cockpit in your browser.
              {host?.snapshot?.sandboxBackend === "vm"
                ? " Sign in with Claude (Pro/Max) above, or use an API key — sealed VM mode does not use the lender login."
                : " Use your API key above (or lender Keychain if you skip it)."}
            </p>
            <pre
              className="muted"
              style={{
                marginTop: "0.75rem",
                background: "white",
                border: "1px solid var(--line)",
                borderRadius: "0.9rem",
                padding: "0.9rem",
                overflow: "auto",
                fontSize: "0.85rem",
              }}
            >
{`# Or run manually:
pnpm --filter @bay/connect start -- ${reservation.id} ${connect.connectToken}

# Tunnel target: ${connect.sshTarget} port ${connect.remotePort}
# Then open: ${connect.openUrl}`}
            </pre>
            {!host?.online && (
              <p className="error" style={{ marginTop: "0.75rem" }}>
                Lender Mac went offline — they may have closed the lid.
              </p>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
