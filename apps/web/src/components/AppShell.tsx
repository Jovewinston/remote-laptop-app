"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, getToken, setToken } from "@/lib/api";
import type { Reservation } from "@bay/shared";

const ACTIVE = new Set(["upcoming", "starting", "connected"]);

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [name, setName] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<Reservation | null>(null);

  useEffect(() => {
    api<{ user: { name: string } }>("/auth/me")
      .then((d) => setName(d.user.name))
      .catch(() => setName(null));

    if (!getToken()) {
      setActiveSession(null);
      return;
    }
    api<{ reservations: Reservation[] }>("/reservations/mine")
      .then((d) => {
        const live = d.reservations.find((r) => ACTIVE.has(r.status)) || null;
        setActiveSession(live);
      })
      .catch(() => setActiveSession(null));
  }, [pathname]);

  function signOut() {
    setToken(null);
    router.push("/login");
  }

  return (
    <div className="shell">
      <nav className="nav">
        <Link href="/" className="brand">
          Bay
        </Link>
        <div className="nav-links">
          <Link href="/borrow" className={pathname?.startsWith("/borrow") ? "active" : ""}>
            Borrow
          </Link>
          <Link href="/lend" className={pathname?.startsWith("/lend") ? "active" : ""}>
            Lend
          </Link>
          {activeSession && (
            <Link
              href={`/session/${activeSession.id}`}
              className={pathname?.startsWith("/session/") ? "active" : ""}
            >
              Session
              <span className="pill session-pill">
                {activeSession.status === "connected"
                  ? "Connected"
                  : activeSession.status === "starting"
                    ? "Starting"
                    : "Reserved"}
              </span>
            </Link>
          )}
          {name ? (
            <>
              <span className="pill">{name}</span>
              <button type="button" className="linkish" onClick={signOut}>
                Sign out
              </button>
            </>
          ) : (
            <Link href="/login" className={pathname === "/login" ? "active" : ""}>
              Sign in
            </Link>
          )}
        </div>
      </nav>
      {children}
    </div>
  );
}
