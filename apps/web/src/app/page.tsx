"use client";

import Link from "next/link";
import { AppShell } from "@/components/AppShell";

export default function HomePage() {
  return (
    <AppShell>
      <section className="hero">
        <h1>Borrow a Mac for Claude & Codex.</h1>
        <p>
          Friends share idle Macs. You reserve a slot, connect in one click, and
          run your agent on their computer — safely sandboxed.
        </p>
      </section>
      <div className="actions">
        <Link className="btn primary" href="/borrow">
          Borrow a Mac
        </Link>
        <Link className="btn" href="/lend">
          Share my Mac
        </Link>
        <Link className="btn ghost" href="/login">
          Sign in with invite
        </Link>
      </div>
    </AppShell>
  );
}
