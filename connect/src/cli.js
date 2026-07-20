#!/usr/bin/env node
/**
 * Bay Connect — one-click tunnel helper for renters.
 * Usage:
 *   bay-connect <reservationId> <connectToken>
 *   bay-connect 'bay://connect/<id>?token=...'
 */
import { spawn, spawnSync } from "node:child_process";
import { DEFAULT_BAY_API_URL, DEFAULT_COCKPIT_PORT } from "@bay/shared";

const API = process.env.BAY_API_URL ?? DEFAULT_BAY_API_URL;

function parseArgs(argv) {
  const raw = argv[2] || "";
  if (raw.startsWith("bay://")) {
    const u = new URL(raw);
    const parts = u.pathname.split("/").filter(Boolean);
    const id = parts[0] === "connect" ? parts[1] : parts[0];
    return { id, connectToken: u.searchParams.get("token") || argv[3] };
  }
  return { id: argv[2], connectToken: argv[3] };
}

function guiAlert(message) {
  if (process.platform !== "darwin") return;
  spawnSync(
    "osascript",
    ["-e", `display alert "Bay Connect" message ${JSON.stringify(message)}`],
    { encoding: "utf8" }
  );
}

async function main() {
  const { id, connectToken } = parseArgs(process.argv);
  if (!id || !connectToken) {
    console.error("Usage: bay-connect <reservationId> <connectToken>");
    console.error("   or: bay-connect 'bay://connect/<id>?token=...'");
    process.exit(1);
  }

  console.log("Checking network…");
  const ts = spawnSync("tailscale", ["status"], { encoding: "utf8" });
  if (ts.status !== 0) {
    const msg =
      "Tailscale is not connected on this Mac. Install & sign in: https://tailscale.com/download/mac";
    console.error(msg);
    guiAlert(msg);
    process.exit(1);
  }

  const res = await fetch(
    `${API}/connect/${id}?token=${encodeURIComponent(connectToken)}`
  );
  const data = await res.json();
  if (!res.ok) {
    const msg = data.error || "Could not get connect info";
    console.error(msg);
    guiAlert(msg);
    process.exit(1);
  }

  const { remoteHost, remotePort, localPort, openUrl, sshTarget, remoteUser } =
    data.connect;
  const port = localPort || DEFAULT_COCKPIT_PORT;
  const target = sshTarget || `${remoteUser}@${remoteHost}`;

  console.log(`Preparing tunnel to ${remoteHost}…`);
  console.log(`ssh -L ${port}:127.0.0.1:${remotePort || port} ${target}`);

  const child = spawn(
    "ssh",
    [
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-L",
      `${port}:127.0.0.1:${remotePort || port}`,
      target,
    ],
    { stdio: "inherit" }
  );

  setTimeout(() => {
    const target = openUrl || `http://127.0.0.1:${port}/new-session`;
    spawn("open", [target], {
      detached: true,
      stdio: "ignore",
    }).unref();
    console.log(`Opened ${target}`);
    console.log("Leave this running while you use Claude/Codex. Ctrl+C to stop.");
  }, 1500);

  child.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
