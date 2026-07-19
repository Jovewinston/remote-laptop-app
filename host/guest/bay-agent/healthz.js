#!/usr/bin/env node
/**
 * Minimal Bay guest agent health + process supervisor for Yep.
 * Listens on :3411  GET /healthz
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";

const HOME = process.env.HOME || "/home/bay";
const WORKSPACE = path.join(HOME, "workspace");
const YEP_DATA = path.join(HOME, ".yep-anywhere");
const JOB_ENV = path.join(HOME, "job.env");
const AGENT_PORT = Number(process.env.BAY_AGENT_PORT || 3411);
const YEP_PORT = Number(process.env.YEP_PORT || 3400);

let yepChild = null;
let lastError = null;

/** Interactive `claude auth login` relay for renters (Pro/Max). */
let authChild = null;
let authState = {
  status: "idle", // idle | starting | awaiting_code | submitting | done | error
  url: null,
  error: null,
  log: "",
};

function loadJobEnv() {
  const env = { ...process.env };
  if (!fs.existsSync(JOB_ENV)) return env;
  for (const line of fs.readFileSync(JOB_ENV, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    env[m[1]] = m[2];
  }
  return env;
}

function ensureDirs(env) {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.mkdirSync(YEP_DATA, { recursive: true });
  const provider = env.ENABLED_PROVIDERS || env.AGENT || "claude";
  const model = env.DEFAULT_MODEL || (provider === "codex" ? "default" : "sonnet");
  const settingsPath = path.join(YEP_DATA, "server-settings.json");
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          version: 2,
          settings: {
            newSessionDefaults: { provider, model },
          },
        },
        null,
        2
      ),
      "utf8"
    );
  }
  if (!fs.existsSync(path.join(WORKSPACE, "README.md"))) {
    fs.writeFileSync(
      path.join(WORKSPACE, "README.md"),
      "# Bay sealed guest\n\nWorkspace lives only inside this Linux VM disk.\nSign into Claude or Codex in Yep — lender login is not used.\n",
      "utf8"
    );
  }
}

function startYep(env) {
  if (yepChild && !yepChild.killed) return;
  const yepPort = Number(env.YEP_PORT || YEP_PORT);
  const bin = process.env.YEP_BIN || "yepanywhere";
  const childEnv = {
    ...env,
    HOME,
    YEP_DATA_DIR: YEP_DATA,
    ENABLED_PROVIDERS: env.ENABLED_PROVIDERS || env.AGENT || "claude",
    // Empty codex home inside guest — no host history
    CODEX_HOME: path.join(HOME, ".codex-empty"),
  };
  fs.mkdirSync(childEnv.CODEX_HOME, { recursive: true });

  // Bind on all interfaces so Tart softnet port-expose can reach Yep from the host.
  yepChild = spawn(
    bin,
    ["--host", "0.0.0.0", "--port", String(yepPort)],
    {
      cwd: WORKSPACE,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  yepChild.stdout?.on("data", () => {});
  yepChild.stderr?.on("data", (buf) => {
    lastError = String(buf).slice(-400);
  });
  yepChild.on("exit", (code) => {
    lastError = `yepanywhere exited ${code}`;
    yepChild = null;
  });
}

async function yepOk(env) {
  const yepPort = Number(env.YEP_PORT || YEP_PORT);
  try {
    const res = await fetch(`http://127.0.0.1:${yepPort}/api/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function mergeJobEnv(vars) {
  const current = {};
  if (fs.existsSync(JOB_ENV)) {
    for (const line of fs.readFileSync(JOB_ENV, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) current[m[1]] = m[2];
    }
  }
  for (const [k, v] of Object.entries(vars || {})) {
    if (!/^[A-Z0-9_]+$/.test(k)) continue;
    if (typeof v !== "string" || !v.trim()) continue;
    if (v.includes("\n") || v.includes("\r")) continue;
    current[k] = v.trim();
  }
  const body = Object.entries(current)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  fs.writeFileSync(JOB_ENV, `${body}\n`, "utf8");
}

function restartYepWithEnv() {
  if (yepChild && !yepChild.killed) {
    try {
      yepChild.kill("SIGTERM");
    } catch {
      // ignore
    }
    yepChild = null;
  }
  const env = loadJobEnv();
  ensureDirs(env);
  startYep(env);
}

function appendAuthLog(chunk) {
  authState.log = (authState.log + String(chunk)).slice(-4000);
  const m = authState.log.match(/https:\/\/claude\.com\/[^\s"'<>]+/);
  if (m && !authState.url) {
    authState.url = m[0].replace(/[.,;]+$/, "");
    if (authState.status === "starting") {
      authState.status = "awaiting_code";
    }
  }
}

function killAuthChild() {
  if (authChild && !authChild.killed) {
    try {
      authChild.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  authChild = null;
}

function startClaudeAuth() {
  if (authChild && !authChild.killed) {
    killAuthChild();
  }
  authState = {
    status: "starting",
    url: null,
    error: null,
    log: "",
  };

  const base = loadJobEnv();
  // Prefer subscription OAuth over any injected API key for this login.
  const env = { ...base, HOME, PATH: base.PATH || process.env.PATH };
  delete env.ANTHROPIC_API_KEY;

  const bin = process.env.CLAUDE_BIN || "claude";
  authChild = spawn(bin, ["auth", "login"], {
    cwd: WORKSPACE,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  authChild.stdout?.on("data", (buf) => appendAuthLog(buf));
  authChild.stderr?.on("data", (buf) => appendAuthLog(buf));
  authChild.on("exit", (code) => {
    authChild = null;
    if (authState.status === "done") return;
    // Verify for real — exit 0 alone is not enough (can exit without credentials).
    claudeAuthStatusCli()
      .then((cli) => {
        if (cli.loggedIn) {
          authState.status = "done";
          authState.error = null;
          try {
            if (fs.existsSync(JOB_ENV)) {
              const kept = fs
                .readFileSync(JOB_ENV, "utf8")
                .split("\n")
                .filter((line) => line && !line.startsWith("ANTHROPIC_API_KEY="));
              fs.writeFileSync(JOB_ENV, `${kept.join("\n")}\n`, "utf8");
            }
          } catch {
            // ignore
          }
          restartYepWithEnv();
          return;
        }
        authState.status = "error";
        authState.error =
          code === 0
            ? "Login finished but Claude is still not authenticated — try again"
            : `claude auth login exited ${code}. ` +
              (authState.log.slice(-200) || "No output");
      })
      .catch(() => {
        authState.status = "error";
        authState.error = `claude auth login exited ${code}`;
      });
  });

  // URL usually appears within a second; give it a moment for callers that wait.
  return new Promise((resolve) => {
    const started = Date.now();
    const t = setInterval(() => {
      if (authState.url || authState.status === "error" || Date.now() - started > 12000) {
        clearInterval(t);
        resolve({
          status: authState.status,
          url: authState.url,
          error: authState.error,
        });
      }
    }, 200);
  });
}

function submitClaudeAuthCode(code) {
  const trimmed = String(code || "").trim();
  if (!trimmed) {
    return { ok: false, error: "Code required" };
  }
  if (!authChild || !authChild.stdin || authChild.killed) {
    return {
      ok: false,
      error: "No active login — start Sign in with Claude again",
    };
  }
  authState.status = "submitting";
  try {
    authChild.stdin.write(`${trimmed}\n`);
  } catch (err) {
    authState.status = "error";
    authState.error = String(err?.message || err);
    return { ok: false, error: authState.error };
  }
  return { ok: true, status: authState.status };
}

async function claudeAuthStatusCli() {
  try {
    const env = { ...loadJobEnv(), HOME };
    delete env.ANTHROPIC_API_KEY;
    const r = spawn("claude", ["auth", "status"], {
      cwd: WORKSPACE,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    await new Promise((resolve) => {
      r.stdout?.on("data", (b) => {
        out += String(b);
      });
      r.stderr?.on("data", (b) => {
        out += String(b);
      });
      r.on("exit", () => resolve());
      setTimeout(() => {
        try {
          r.kill("SIGTERM");
        } catch {
          // ignore
        }
        resolve();
      }, 8000);
    });
    let loggedIn = false;
    try {
      const j = JSON.parse(out.trim());
      loggedIn = Boolean(j.loggedIn);
    } catch {
      loggedIn =
        /"loggedIn"\s*:\s*true/i.test(out) ||
        (/logged in|authenticated/i.test(out) &&
          !/not logged|logged out|"loggedIn"\s*:\s*false/i.test(out));
    }
    return { loggedIn, detail: out.slice(0, 300) };
  } catch (err) {
    return { loggedIn: false, detail: String(err?.message || err) };
  }
}

function boot() {
  const env = loadJobEnv();
  ensureDirs(env);
  startYep(env);

  setInterval(() => {
    const e = loadJobEnv();
    if (!yepChild) startYep(e);
  }, 5000);

  const server = http.createServer(async (req, res) => {
    if (req.url === "/healthz" || req.url === "/health") {
      const env = loadJobEnv();
      const ok = await yepOk(env);
      const body = JSON.stringify({
        ok,
        hostname: os.hostname(),
        yep: ok,
        pid: yepChild?.pid ?? null,
        error: ok ? null : lastError,
      });
      res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }

    // Merge renter API keys into job.env and restart Yep (no secrets in response).
    if (req.method === "POST" && req.url === "/credentials") {
      try {
        const body = await readJsonBody(req);
        const allowed = {};
        if (typeof body.ANTHROPIC_API_KEY === "string") {
          allowed.ANTHROPIC_API_KEY = body.ANTHROPIC_API_KEY;
        }
        if (typeof body.OPENAI_API_KEY === "string") {
          allowed.OPENAI_API_KEY = body.OPENAI_API_KEY;
        }
        if (!allowed.ANTHROPIC_API_KEY && !allowed.OPENAI_API_KEY) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "No keys" }));
          return;
        }
        mergeJobEnv(allowed);
        restartYepWithEnv();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, applied: Object.keys(allowed) }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: String(err?.message || err).slice(0, 120),
          })
        );
      }
      return;
    }

    if (req.method === "GET" && req.url === "/claude-auth") {
      const cli = await claudeAuthStatusCli();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ...authState,
          loggedIn: cli.loggedIn || authState.status === "done",
        })
      );
      return;
    }

    if (req.method === "POST" && req.url === "/claude-auth/start") {
      try {
        const result = await startClaudeAuth();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: String(err?.message || err).slice(0, 160),
          })
        );
      }
      return;
    }

    if (req.method === "POST" && req.url === "/claude-auth/code") {
      try {
        const body = await readJsonBody(req);
        const result = submitClaudeAuthCode(body.code);
        if (!result.ok) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
          return;
        }
        // Wait briefly for claude to accept the code.
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline) {
          if (authState.status === "done" || authState.status === "error") break;
          await new Promise((r) => setTimeout(r, 400));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: authState.status === "done",
            status: authState.status,
            error: authState.error,
          })
        );
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: String(err?.message || err).slice(0, 160),
          })
        );
      }
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  server.listen(AGENT_PORT, "0.0.0.0", () => {
    console.log(`bay-agent healthz on :${AGENT_PORT}`);
  });
}

boot();
