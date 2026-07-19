#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { collectHealth, doctorText } from "./health.js";
import { loadConfig, saveConfig } from "./config.js";
import {
  provisionSession,
  wipeSession,
  ensureSandboxDirs,
  injectGuestCredentials,
  startGuestClaudeAuth,
  submitGuestClaudeAuthCode,
} from "./sandbox.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cmd = process.argv[2] || "serve";

const active = new Map(); // reservationId -> { busy }

async function heartbeatOnce() {
  const cfg = loadConfig();
  if (!cfg.hostToken) return null;
  const health = collectHealth();
  const preparing = [...active.values()].find((a) => a.state === "preparing");
  const snapshot = {
    ...health,
    sharing: cfg.sharing || "off",
    sandbox: [...active.values()].some((a) => a.state === "ready")
      ? "ready"
      : preparing
        ? "preparing"
        : [...active.values()].some((a) => a.state === "cleaning")
          ? "cleaning"
          : "idle",
    preparePhase: preparing?.preparePhase ?? null,
    prepareDetail: preparing?.prepareDetail ?? null,
    collectedAt: new Date().toISOString(),
  };

  const res = await fetch(`${cfg.apiUrl}/host/heartbeat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Host ${cfg.hostToken}`,
    },
    body: JSON.stringify({
      snapshot,
      sandbox: snapshot.sandbox,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error("Heartbeat failed:", text);
    return null;
  }
  const data = await res.json();
  if (data.host?.snapshot?.sharing) {
    cfg.sharing = data.host.snapshot.sharing;
    saveConfig(cfg);
  }
  return data;
}

async function setRemoteState(reservationId, body) {
  const cfg = loadConfig();
  await fetch(`${cfg.apiUrl}/host/sessions/${reservationId}/state`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Host ${cfg.hostToken}`,
    },
    body: JSON.stringify(body),
  });
}

async function claimGuestCredentials(reservationId) {
  const cfg = loadConfig();
  const res = await fetch(
    `${cfg.apiUrl}/host/sessions/${reservationId}/guest-credentials/claim`,
    {
      method: "POST",
      headers: {
        Authorization: `Host ${cfg.hostToken}`,
      },
    }
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    console.error(`Credential claim failed for ${reservationId}:`, text);
    return null;
  }
  const data = await res.json();
  return data?.credentials || null;
}

async function hostPost(path, body) {
  const cfg = loadConfig();
  const res = await fetch(`${cfg.apiUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Host ${cfg.hostToken}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

async function handleClaudeAuth(r) {
  if (r.claudeAuthStartPending && active.get(r.id)?.state === "ready") {
    const claim = await hostPost(
      `/host/sessions/${r.id}/claude-auth/start/claim`
    );
    if (!claim.ok) return;
    try {
      console.log(`[${r.id}] Starting Claude Pro/Max login in guest…`);
      await hostPost(`/host/sessions/${r.id}/claude-auth/url`, {
        detail: "Checking tunnel to sealed VM…",
      });
      await hostPost(`/host/sessions/${r.id}/claude-auth/url`, {
        detail: "Starting claude auth login inside the guest…",
      });
      const { url } = await startGuestClaudeAuth(r.id);
      await hostPost(`/host/sessions/${r.id}/claude-auth/url`, {
        loginUrl: url,
        detail: "Login link ready — open it in your browser",
      });
      await setRemoteState(r.id, {
        preparePhase: "ready",
        prepareDetail: "Claude login URL ready — open it on the Session page",
      });
    } catch (err) {
      const msg = String(err?.message || err).slice(0, 220);
      console.error(`[${r.id}] Claude auth start failed:`, msg);
      await hostPost(`/host/sessions/${r.id}/claude-auth/url`, { error: msg });
    }
  }

  if (r.claudeAuthCodePending && active.get(r.id)?.state === "ready") {
    const claim = await hostPost(
      `/host/sessions/${r.id}/claude-auth/code/claim`
    );
    if (!claim.ok || !claim.data?.code) return;
    try {
      console.log(`[${r.id}] Submitting Claude login code to guest…`);
      const result = await submitGuestClaudeAuthCode(r.id, claim.data.code);
      if (result?.ok === false || result?.status === "error") {
        throw new Error(result?.error || "Claude rejected the code");
      }
      // Confirm via guest agent (avoids false "signed in" in the UI).
      let loggedIn = false;
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 800));
        try {
          const st = await fetch("http://127.0.0.1:3411/claude-auth", {
            signal: AbortSignal.timeout(3000),
          });
          const data = await st.json();
          if (data.loggedIn || data.status === "done") {
            loggedIn = true;
            break;
          }
          if (data.status === "error") {
            throw new Error(data.error || "Claude login failed");
          }
        } catch (e) {
          if (String(e.message || e).includes("Claude login failed")) throw e;
        }
      }
      if (!loggedIn) {
        throw new Error(
          "Login did not stick inside the VM — click Sign in with Claude again"
        );
      }
      await hostPost(`/host/sessions/${r.id}/claude-auth/done`, { ok: true });
      await hostPost(`/host/sessions/${r.id}/claude-auth/url`, {
        detail: "Claude Pro/Max signed in — Connect and start a new chat",
      });
      await setRemoteState(r.id, {
        preparePhase: "ready",
        prepareDetail: "Claude Pro/Max signed in — Connect and start a session",
      });
      console.log(`[${r.id}] Claude subscription login complete`);
    } catch (err) {
      const msg = String(err?.message || err).slice(0, 220);
      console.error(`[${r.id}] Claude auth code failed:`, msg);
      await hostPost(`/host/sessions/${r.id}/claude-auth/done`, {
        ok: false,
        error: msg,
      });
    }
  }
}

async function handlePending(data) {
  if (!data?.pendingReservations) return;
  for (const r of data.pendingReservations) {
    // Rehydrate after Host restart so late auth/key inject still works.
    if (r.status === "connected" && !active.has(r.id)) {
      active.set(r.id, { state: "ready" });
    }
    if (r.status === "starting" && !active.has(r.id)) {
      active.set(r.id, {
        state: "preparing",
        preparePhase: "clone",
        prepareDetail: "Starting prepare…",
      });
      console.log(`Provisioning session ${r.id} (${r.agent})…`);
      const reportProgress = async (phase, detail) => {
        const cur = active.get(r.id) || { state: "preparing" };
        active.set(r.id, {
          ...cur,
          state: "preparing",
          preparePhase: phase,
          prepareDetail: detail,
        });
        console.log(`[${r.id}] ${phase}: ${detail}`);
        try {
          await setRemoteState(r.id, {
            sandbox: "preparing",
            preparePhase: phase,
            prepareDetail: detail,
          });
        } catch (err) {
          console.error("Progress update failed:", err?.message || err);
        }
      };
      try {
        await setRemoteState(r.id, {
          status: "starting",
          sandbox: "preparing",
          sharing: "busy",
          preparePhase: "clone",
          prepareDetail: "Cloning sealed guest…",
        });
        let appliedKey = false;
        const result = await provisionSession({
          reservationId: r.id,
          agent: r.agent,
          repoUrl: r.repoUrl,
          getEnvCredentials: async () => {
            const creds = await claimGuestCredentials(r.id);
            if (creds) {
              appliedKey = true;
              console.log(`[${r.id}] Applying renter API key into guest…`);
            }
            return creds;
          },
          onProgress: reportProgress,
        });
        active.set(r.id, { state: "ready", ...result });
        await setRemoteState(r.id, {
          status: "connected",
          sandbox: "ready",
          sharing: "busy",
          cockpitPort: result.cockpitPort,
          openUrl: result.openUrl,
          projectId: result.projectId,
          projectDir: result.projectDir,
          preparePhase: "ready",
          prepareDetail: appliedKey
            ? "Cockpit ready — your API key is applied. Click Connect"
            : "Cockpit ready — click Connect",
        });
        console.log(
          `Session ${r.id} ready on port ${result.cockpitPort} → ${result.openUrl}`
        );
      } catch (err) {
        console.error(err);
        active.set(r.id, { state: "error" });
        await setRemoteState(r.id, {
          status: "cancelled",
          sandbox: "error",
          sharing: "available",
          preparePhase: "error",
          prepareDetail: String(err?.message || err).slice(0, 240),
        });
        active.delete(r.id);
      }
    }

    // Late-apply: renter pasted API key after cockpit was already ready.
    if (
      r.guestCredentialsPending &&
      (r.status === "connected" || r.status === "starting") &&
      active.get(r.id)?.state === "ready"
    ) {
      try {
        const creds = await claimGuestCredentials(r.id);
        if (creds) {
          console.log(`[${r.id}] Injecting renter API key into running guest…`);
          await injectGuestCredentials(r.id, creds);
          await setRemoteState(r.id, {
            preparePhase: "ready",
            prepareDetail: "API key applied — refresh Connect / new Yep session",
          });
        }
      } catch (err) {
        console.error(
          `[${r.id}] Credential inject failed:`,
          err?.message || err
        );
      }
    }

    if (
      (r.claudeAuthStartPending || r.claudeAuthCodePending) &&
      (r.status === "connected" || r.status === "starting")
    ) {
      await handleClaudeAuth(r);
    }

    if (r.status === "ended" || r.status === "cancelled") {
      if (active.has(r.id) || fs.existsSync(path.join(
        process.env.HOME || "",
        ".bay/sandbox/jobs",
        r.id
      ))) {
        active.set(r.id, { state: "cleaning" });
        await setRemoteState(r.id, { sandbox: "cleaning" });
        wipeSession(r.id);
        active.delete(r.id);
        await setRemoteState(r.id, {
          sandbox: "idle",
          sharing: "available",
        });
        console.log(`Wiped session ${r.id}`);
      }
    }
  }

  // Also wipe locally tracked sessions that disappeared as ended
  for (const [id, info] of active) {
    const still = data.pendingReservations.find((r) => r.id === id);
    if (!still && info.state === "ready") {
      wipeSession(id);
      active.delete(id);
    }
  }
}

async function loop() {
  try {
    const data = await heartbeatOnce();
    await handlePending(data);
  } catch (err) {
    console.error("Host loop error:", err.message || err);
  }
}

function openBrowser(url) {
  try {
    spawnDetach("open", [url]);
  } catch {
    // ignore
  }
}

function spawnDetach(cmd, args) {
  import("node:child_process").then(({ spawn }) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
  });
}

if (cmd === "doctor") {
  console.log(doctorText());
  process.exit(0);
}

if (cmd === "serve") {
  ensureSandboxDirs();
  const app = new Hono();
  const ui = fs.readFileSync(path.join(__dirname, "ui.html"), "utf8");

  app.get("/", (c) => c.html(ui));
  app.get("/api/state", (c) => {
    const cfg = loadConfig();
    const health = collectHealth();
    return c.json({
      ...cfg,
      health,
      doctor: doctorText(),
    });
  });
  app.post("/api/config", async (c) => {
    const body = await c.req.json();
    const cfg = loadConfig();
    cfg.apiUrl = body.apiUrl || cfg.apiUrl;
    cfg.hostToken = body.hostToken || cfg.hostToken;
    saveConfig(cfg);
    return c.json({ ok: true });
  });
  app.post("/api/sharing", async (c) => {
    const cfg = loadConfig();
    const next = cfg.sharing === "off" ? "available" : "off";
    cfg.sharing = next;
    saveConfig(cfg);
    // Explicit sharing update to API
    if (cfg.hostToken) {
      const health = collectHealth();
      await fetch(`${cfg.apiUrl}/host/heartbeat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Host ${cfg.hostToken}`,
        },
        body: JSON.stringify({
          snapshot: { ...health, sharing: next, sandbox: "idle", collectedAt: new Date().toISOString() },
          sharing: next,
        }),
      });
    }
    return c.json({ ok: true, sharing: cfg.sharing });
  });

  const port = Number(process.env.BAY_HOST_UI_PORT || 3410);
  serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
    console.log(`Bay Host UI: http://127.0.0.1:${port}`);
    console.log("Heartbeating every 15s…");
    openBrowser(`http://127.0.0.1:${port}`);
  });

  loop();
  setInterval(loop, 15000);
} else {
  console.log(`Usage: bay-host <serve|doctor>`);
  process.exit(1);
}
