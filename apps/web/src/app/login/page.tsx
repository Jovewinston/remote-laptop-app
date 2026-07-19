"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { api, setToken } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "signup">("signup");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    try {
      if (mode === "signup") {
        const data = await api<{ token: string }>("/auth/signup", {
          method: "POST",
          auth: false,
          body: JSON.stringify({
            name: fd.get("name"),
            email: fd.get("email"),
            password: fd.get("password"),
            inviteCode: fd.get("inviteCode"),
          }),
        });
        setToken(data.token);
      } else {
        const data = await api<{ token: string }>("/auth/login", {
          method: "POST",
          auth: false,
          body: JSON.stringify({
            email: fd.get("email"),
            password: fd.get("password"),
          }),
        });
        setToken(data.token);
      }
      router.push("/borrow");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell>
      <section className="hero">
        <h1>{mode === "signup" ? "Join with an invite." : "Welcome back."}</h1>
        <p>Bay is invite-only for now — friends and teammates only.</p>
      </section>
      <div className="panel" style={{ maxWidth: 460 }}>
        <div className="actions" style={{ marginBottom: "1rem" }}>
          <button
            type="button"
            className={`btn ${mode === "signup" ? "primary" : ""}`}
            onClick={() => setMode("signup")}
          >
            Sign up
          </button>
          <button
            type="button"
            className={`btn ${mode === "login" ? "primary" : ""}`}
            onClick={() => setMode("login")}
          >
            Sign in
          </button>
        </div>
        <form className="form" onSubmit={onSubmit}>
          {mode === "signup" && (
            <>
              <label>
                Name
                <input name="name" required placeholder="Alex" />
              </label>
              <label>
                Invite code
                <input name="inviteCode" required placeholder="BAY-FRIENDS" />
              </label>
            </>
          )}
          <label>
            Email
            <input name="email" type="email" required placeholder="you@email.com" />
          </label>
          <label>
            Password
            <input name="password" type="password" required minLength={6} />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="btn primary" disabled={loading} type="submit">
            {loading ? "Working…" : mode === "signup" ? "Create account" : "Sign in"}
          </button>
        </form>
        <p className="muted" style={{ marginTop: "1rem", fontSize: "0.9rem" }}>
          Demo invites after seeding: <strong>BAY-FRIENDS</strong> or <strong>BAY-DEMO</strong>
        </p>
      </div>
    </AppShell>
  );
}
