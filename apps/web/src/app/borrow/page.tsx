"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { api, getToken } from "@/lib/api";
import type { AgentKind, HostPublic, Reservation } from "@bay/shared";

const ACTIVE = new Set(["upcoming", "starting", "connected"]);

function statusLabel(status: Reservation["status"]) {
  if (status === "upcoming") return "Reserved";
  if (status === "starting") return "Starting";
  if (status === "connected") return "Connected";
  return status;
}

export default function BorrowPage() {
  const router = useRouter();
  const [hosts, setHosts] = useState<HostPublic[]>([]);
  const [mine, setMine] = useState<Reservation[]>([]);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<{
    host: HostPublic;
    agent: AgentKind;
  } | null>(null);
  const [hours, setHours] = useState(1);
  const [repoUrl, setRepoUrl] = useState("");
  const [booking, setBooking] = useState(false);

  async function load() {
    try {
      const [hostsData, mineData] = await Promise.all([
        api<{ hosts: HostPublic[] }>("/hosts"),
        api<{ reservations: Reservation[] }>("/reservations/mine"),
      ]);
      setHosts(hostsData.hosts);
      setMine(mineData.reservations.filter((r) => ACTIVE.has(r.status)));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load Macs");
    }
  }

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [router]);

  async function reserve() {
    if (!selected) return;
    setBooking(true);
    setError("");
    try {
      const start = new Date();
      start.setMinutes(0, 0, 0);
      if (start.getTime() < Date.now()) start.setHours(start.getHours() + 1);
      const end = new Date(start.getTime() + hours * 60 * 60 * 1000);
      const data = await api<{ reservation: { id: string } }>("/reservations", {
        method: "POST",
        body: JSON.stringify({
          hostId: selected.host.id,
          agent: selected.agent,
          startsAt: start.toISOString(),
          endsAt: end.toISOString(),
          repoUrl: repoUrl || undefined,
        }),
      });
      router.push(`/session/${data.reservation.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reserve");
    } finally {
      setBooking(false);
    }
  }

  return (
    <AppShell>
      <section className="hero">
        <h1>Pick a Mac.</h1>
        <p>Live listings from friends who left Bay Host running.</p>
      </section>

      {error && <p className="error">{error}</p>}

      {mine.length > 0 && (
        <div className="panel mine-sessions" style={{ marginBottom: "1.25rem" }}>
          <h2 style={{ fontFamily: "var(--font-display)", marginTop: 0, fontSize: "1.35rem" }}>
            Your sessions
          </h2>
          <p className="meta" style={{ marginTop: 0 }}>
            Open one to Start, Connect, or End — this is why a Mac may show Busy.
          </p>
          <ul className="mine-list">
            {mine.map((r) => (
              <li key={r.id}>
                <div>
                  <strong>
                    {r.hostDisplayName || "Mac"} ·{" "}
                    {r.agent === "codex" ? "Codex" : "Claude"}
                  </strong>
                  <span className="meta">
                    {" "}
                    · {statusLabel(r.status)} · until{" "}
                    {new Date(r.endsAt).toLocaleTimeString([], {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                <Link className="btn primary" href={`/session/${r.id}`}>
                  Open session
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="cards">
        {hosts.length === 0 && (
          <div className="card empty">
            No Macs available yet. Ask a friend to open Lend and turn Available on.
          </div>
        )}
        {hosts.map((host) => {
          const snap = host.snapshot;
          const sharing = snap?.sharing ?? "off";
          const status =
            !host.online ? "offline" : sharing === "busy" ? "busy" : "online";
          const statusLabel =
            status === "offline" ? "Offline" : status === "busy" ? "Busy" : "Online";
          return (
            <article className="card" key={host.id}>
              <h3>{host.displayName}</h3>
              <p className="meta">
                {snap
                  ? `${snap.chip || snap.modelName} · ${snap.ramGb} GB · ${snap.diskFreeGb} GB free`
                  : "Waiting for first health check…"}
              </p>
              <div className="status-row">
                <span>
                  <i className={`dot ${status}`} />
                  {statusLabel}
                </span>
                <span>
                  {snap?.onPower
                    ? "On charger"
                    : snap?.batteryPercent != null
                      ? `Battery ${snap.batteryPercent}%`
                      : "Power unknown"}
                </span>
                <span>
                  {snap?.tailscaleConnected ? "Tailscale ✓" : "Tailscale off"}
                </span>
                <span>{host.nextFreeLabel ? `Free ${host.nextFreeLabel}` : "No hours set"}</span>
              </div>
              <div className="actions">
                <button
                  type="button"
                  className="btn primary"
                  disabled={!host.online || sharing === "off"}
                  onClick={() => setSelected({ host, agent: "claude" })}
                >
                  Claude
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={!host.online || sharing === "off"}
                  onClick={() => setSelected({ host, agent: "codex" })}
                >
                  Codex
                </button>
              </div>
            </article>
          );
        })}
      </div>

      {selected && (
        <div className="panel" style={{ marginTop: "1.5rem", maxWidth: 520 }}>
          <h2 style={{ fontFamily: "var(--font-display)", marginTop: 0 }}>
            Reserve {selected.agent === "claude" ? "Claude" : "Codex"}
          </h2>
          <p className="meta">
            on {selected.host.displayName}
          </p>
          <div className="form" style={{ marginTop: "1rem" }}>
            <label>
              How many hours?
              <select
                value={hours}
                onChange={(e) => setHours(Number(e.target.value))}
              >
                {[1, 2, 3, 4].map((h) => (
                  <option key={h} value={h}>
                    {h} hour{h > 1 ? "s" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              GitHub repo (optional)
              <input
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/you/project.git"
              />
            </label>
            <div className="actions">
              <button
                type="button"
                className="btn primary"
                disabled={booking}
                onClick={reserve}
              >
                {booking ? "Reserving…" : "Reserve"}
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => setSelected(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
