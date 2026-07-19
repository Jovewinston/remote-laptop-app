import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { DEFAULT_COCKPIT_PORT } from "@bay/shared";
import { loadConfig } from "./config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REVERSE_BRIDGE_JS = path.join(HERE, "reverse-bridge.js");
const REVERSE_DIAL_JS = path.join(HERE, "..", "guest", "bay-agent", "reverse-dial.js");
const HEALTHZ_JS = path.join(HERE, "..", "guest", "bay-agent", "healthz.js");
const BRIDGE_COCKPIT_PORT = 13400;
const BRIDGE_HEALTH_PORT = 13411;

export const GOLDEN_VM_NAME = "bay-golden";
const VMS_ROOT = path.join(os.homedir(), ".bay", "vms");
const JOBS_DIR = path.join(VMS_ROOT, "jobs");
const SSH_DIR = path.join(VMS_ROOT, "ssh");
const GUEST_WORKSPACE = "/home/bay/workspace";
const GUEST_AGENT_PORT = 3411;

function which(bin) {
  const r = spawnSync("which", [bin], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

function runSoft(cmd, args, opts = {}) {
  try {
    return run(cmd, args, opts);
  } catch {
    return "";
  }
}

export function ensureVmDirs() {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.mkdirSync(SSH_DIR, { recursive: true });
  fs.mkdirSync(path.join(VMS_ROOT, "logs"), { recursive: true });
  return VMS_ROOT;
}

export function tartBin() {
  return which("tart") || "/opt/homebrew/bin/tart";
}

export function tartAvailable() {
  const tart = tartBin();
  return Boolean(tart && fs.existsSync(tart));
}

export function goldenImageReady() {
  const tart = tartBin();
  if (!tartAvailable()) return false;
  const isGolden = (name) => {
    const n = String(name || "").trim();
    return n === GOLDEN_VM_NAME || n.endsWith(`/${GOLDEN_VM_NAME}`);
  };
  try {
    const list = run(tart, ["list", "--quiet"]);
    return list.split("\n").some(isGolden);
  } catch {
    try {
      const list = run(tart, ["list"]);
      return list
        .split("\n")
        .slice(1)
        .some((line) => {
          const name = line.trim().split(/\s+/)[1];
          return isGolden(name);
        });
    } catch {
      return false;
    }
  }
}

export function vmJobName(reservationId) {
  const safe = String(reservationId).replace(/[^a-zA-Z0-9._-]/g, "-");
  return `bay-job-${safe}`;
}

function jobMetaPath(reservationId) {
  return path.join(JOBS_DIR, `${reservationId}.json`);
}

export function vmJobExists(reservationId) {
  return fs.existsSync(jobMetaPath(reservationId));
}

function readJobMeta(reservationId) {
  const p = jobMetaPath(reservationId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeJobMeta(reservationId, meta) {
  ensureVmDirs();
  fs.writeFileSync(jobMetaPath(reservationId), JSON.stringify(meta, null, 2), "utf8");
}

function freeCockpitPort(port) {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
    }).trim();
    for (const pid of out.split("\n").filter(Boolean)) {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {
        // ignore
      }
    }
  } catch {
    // nothing listening
  }
}

function ensureHostSshKey() {
  ensureVmDirs();
  const priv = path.join(SSH_DIR, "id_ed25519");
  const pub = `${priv}.pub`;
  if (!fs.existsSync(priv)) {
    run("ssh-keygen", [
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      priv,
      "-C",
      "bay-host@lender",
    ]);
  }
  return { priv, pub, pubKey: fs.readFileSync(pub, "utf8").trim() };
}

function guestExec(tart, vmName, args, opts = {}) {
  return run(tart, ["exec", vmName, ...args], opts);
}

function guestExecSoft(tart, vmName, args) {
  try {
    return guestExec(tart, vmName, args);
  } catch {
    return "";
  }
}

async function waitForGuestAgent(tart, vmName, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      guestExec(tart, vmName, ["true"]);
      return true;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

async function waitForLocalPort(port, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return true;
    } catch {
      // not ready
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/version`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return true;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function waitForGuestIp(tart, vmName, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ip = run(tart, ["ip", "--wait", "5", vmName]).trim();
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return ip;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

async function waitForGuestHttp(tart, vmName, url, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const out = guestExecSoft(tart, vmName, [
      "bash",
      "-lc",
      `curl -sf --max-time 2 ${JSON.stringify(url)} >/dev/null && echo ok || true`,
    ]).trim();
    if (out === "ok") return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

function gatewayFromGuestIp(guestIp) {
  const parts = String(guestIp).split(".");
  if (parts.length !== 4) return "192.168.64.1";
  return `${parts[0]}.${parts[1]}.${parts[2]}.1`;
}

/**
 * Softnet --expose is not reachable from the host itself.
 * Host→guest NAT is often blocked by macOS Local Network privacy.
 * Guest CAN reach the Tart bridge gateway, so we reverse-dial.
 */
function startReverseBridge({ bindHost, bridgePort, localPort, logPath }) {
  const logFd = fs.openSync(logPath, "a");
  const child = spawn(
    process.execPath,
    [
      REVERSE_BRIDGE_JS,
      "--bind",
      bindHost,
      "--bridge",
      String(bridgePort),
      "--local",
      String(localPort),
    ],
    { detached: true, stdio: ["ignore", logFd, logFd] }
  );
  child.unref();
  fs.closeSync(logFd);
  return child.pid ?? null;
}

function uploadGuestFile(tart, vmName, localPath, remotePath) {
  if (!fs.existsSync(localPath)) {
    throw new Error(`Missing guest file on host: ${localPath}`);
  }
  const b64 = fs.readFileSync(localPath).toString("base64");
  guestExec(tart, vmName, [
    "bash",
    "-lc",
    `
set -euo pipefail
sudo mkdir -p "$(dirname ${JSON.stringify(remotePath)})"
echo ${JSON.stringify(b64)} | base64 -d | sudo tee ${JSON.stringify(remotePath)} >/dev/null
sudo chown bay:bay ${JSON.stringify(remotePath)}
sudo chmod +x ${JSON.stringify(remotePath)}
sudo test -s ${JSON.stringify(remotePath)}
`,
  ]);
}

function uploadReverseDialer(tart, vmName) {
  uploadGuestFile(tart, vmName, REVERSE_DIAL_JS, "/home/bay/bay-agent/reverse-dial.js");
}

function uploadBayAgent(tart, vmName) {
  uploadGuestFile(tart, vmName, HEALTHZ_JS, "/home/bay/bay-agent/healthz.js");
}

/**
 * Apply renter API keys into a running job VM (via bridged bay-agent, tart fallback).
 */
export async function injectGuestCredentials(reservationId, credentials = {}) {
  const clean = {};
  if (credentials.ANTHROPIC_API_KEY?.trim()) {
    clean.ANTHROPIC_API_KEY = credentials.ANTHROPIC_API_KEY.trim();
  }
  if (credentials.OPENAI_API_KEY?.trim()) {
    clean.OPENAI_API_KEY = credentials.OPENAI_API_KEY.trim();
  }
  if (!clean.ANTHROPIC_API_KEY && !clean.OPENAI_API_KEY) {
    throw new Error("No credentials to inject");
  }

  // Prefer HTTP to guest agent over reverse bridge (no tart exec).
  try {
    const res = await fetch(`http://127.0.0.1:${GUEST_AGENT_PORT}/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(clean),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return { ok: true, via: "agent" };
  } catch {
    // fall through
  }

  const tart = tartBin();
  const meta = readJobMeta(reservationId);
  const vmName = meta?.vmName || vmJobName(reservationId);
  const lines = Object.entries(clean).map(([k, v]) => `${k}=${v}`);
  const b64 = Buffer.from(`${lines.join("\n")}\n`, "utf8").toString("base64");
  guestExec(tart, vmName, [
    "bash",
    "-lc",
    `
set -euo pipefail
echo ${JSON.stringify(b64)} | base64 -d | sudo tee -a /home/bay/job.env >/dev/null
sudo chown bay:bay /home/bay/job.env
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl restart bay-agent || true
fi
sudo -u bay bash -lc '/home/bay/bay-agent/start.sh' || true
`,
  ]);
  return { ok: true, via: "tart" };
}

async function guestAgentFetch(pathname, { method = "GET", body, timeoutMs = 20000 } = {}) {
  const res = await fetch(`http://127.0.0.1:${GUEST_AGENT_PORT}${pathname}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
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

/** Push latest healthz.js into a running job and restart bay-agent. */
export function refreshGuestAgent(reservationId) {
  const tart = tartBin();
  const meta = readJobMeta(reservationId);
  const vmName = meta?.vmName || vmJobName(reservationId);
  uploadBayAgent(tart, vmName);
  guestExecSoft(tart, vmName, [
    "bash",
    "-lc",
    `
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl restart bay-agent || true
fi
sudo -u bay bash -lc '/home/bay/bay-agent/start.sh' || true
`,
  ]);
}

/**
 * Re-establish reverse bridges + guest dialers if localhost:3411 is dead.
 * Common after Host restarts while the VM keeps running.
 */
export async function ensureGuestTunnel(reservationId) {
  const probe = async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${GUEST_AGENT_PORT}/healthz`, {
        signal: AbortSignal.timeout(2500),
      });
      return res.ok || res.status === 503;
    } catch {
      return false;
    }
  };
  if (await probe()) return { ok: true, repaired: false };

  const tart = tartBin();
  const meta = readJobMeta(reservationId) || {};
  const vmName = meta.vmName || vmJobName(reservationId);
  let guestIp = meta.guestIp;
  if (!guestIp) {
    guestIp = await waitForGuestIp(tart, vmName, 20000);
  }
  if (!guestIp) {
    throw new Error("Guest VM has no IP — is the sealed VM still running?");
  }
  const hostGw = meta.hostGw || gatewayFromGuestIp(guestIp);

  for (const pid of [meta.forwardPid, meta.healthBridgePid]) {
    if (pid) {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {
        // ignore
      }
    }
  }

  const bridgeLog = path.join(VMS_ROOT, "logs", `${reservationId}-bridge.log`);
  const cockpitBridgePid = startReverseBridge({
    bindHost: hostGw,
    bridgePort: BRIDGE_COCKPIT_PORT,
    localPort: DEFAULT_COCKPIT_PORT,
    logPath: bridgeLog,
  });
  const healthBridgePid = startReverseBridge({
    bindHost: hostGw,
    bridgePort: BRIDGE_HEALTH_PORT,
    localPort: GUEST_AGENT_PORT,
    logPath: bridgeLog,
  });

  try {
    uploadReverseDialer(tart, vmName);
  } catch {
    // may already exist
  }
  startGuestReverseDials(tart, vmName, {
    hostGw,
    pairs: [
      { bridgePort: BRIDGE_COCKPIT_PORT, targetPort: 3400 },
      { bridgePort: BRIDGE_HEALTH_PORT, targetPort: 3411 },
    ],
  });

  writeJobMeta(reservationId, {
    ...meta,
    guestIp,
    hostGw,
    forwardPid: cockpitBridgePid,
    healthBridgePid,
  });

  const ok = await waitForLocalPort(GUEST_AGENT_PORT, 45000);
  if (!ok) {
    throw new Error(
      "Could not repair tunnel to sealed VM (127.0.0.1:3411). Try End session and Start again."
    );
  }
  return { ok: true, repaired: true };
}

export async function startGuestClaudeAuth(reservationId) {
  await ensureGuestTunnel(reservationId);

  let result = await guestAgentFetch("/claude-auth/start", {
    method: "POST",
    body: {},
    timeoutMs: 20000,
  }).catch(() => ({ ok: false, status: 0, data: null }));

  if (!result.ok || result.status === 404) {
    refreshGuestAgent(reservationId);
    await new Promise((r) => setTimeout(r, 2500));
    await ensureGuestTunnel(reservationId);
    result = await guestAgentFetch("/claude-auth/start", {
      method: "POST",
      body: {},
      timeoutMs: 20000,
    });
  }

  if (!result.ok) {
    throw new Error(
      result.data?.error ||
        `Guest Claude login failed to start (HTTP ${result.status})`
    );
  }
  if (!result.data?.url) {
    // One more poll — URL sometimes arrives slightly later.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const st = await guestAgentFetch("/claude-auth");
      if (st.data?.url) {
        return { url: st.data.url, status: st.data.status };
      }
      if (st.data?.status === "error") {
        throw new Error(st.data.error || "Claude login failed");
      }
    }
    throw new Error("Claude login URL did not appear — try again");
  }
  return { url: result.data.url, status: result.data.status };
}

export async function submitGuestClaudeAuthCode(reservationId, code) {
  let result = await guestAgentFetch("/claude-auth/code", {
    method: "POST",
    body: { code },
    timeoutMs: 60000,
  }).catch(() => ({ ok: false, status: 0, data: null }));

  if (!result.ok || result.status === 404) {
    refreshGuestAgent(reservationId);
    await new Promise((r) => setTimeout(r, 2500));
    // Must restart login after agent refresh — old process is gone.
    throw new Error(
      "Guest agent was updated — click Sign in with Claude again, then paste a fresh code"
    );
  }
  if (!result.ok || result.data?.ok === false) {
    throw new Error(
      result.data?.error || `Claude code submit failed (HTTP ${result.status})`
    );
  }
  // Double-check guest credentials actually exist.
  const st = await guestAgentFetch("/claude-auth");
  if (!st.data?.loggedIn && st.data?.status !== "done") {
    throw new Error(
      st.data?.error ||
        "Code submitted but Claude is still not logged in — open a fresh login link"
    );
  }
  return result.data;
}

function startGuestReverseDials(tart, vmName, { hostGw, pairs }) {
  // pairs: [{ bridgePort, targetPort }, ...]
  const dialer = "/home/bay/bay-agent/reverse-dial.js";
  const present = guestExecSoft(tart, vmName, [
    "bash",
    "-lc",
    `sudo test -s ${dialer} && echo ok || echo missing`,
  ]).trim();
  if (present !== "ok") {
    throw new Error("Guest reverse-dial.js missing after upload");
  }
  // Kill prior dialers once, then start one process per target port.
  guestExecSoft(tart, vmName, [
    "bash",
    "-lc",
    "sudo pkill -f reverse-dial.js 2>/dev/null || true",
  ]);
  for (const { bridgePort, targetPort } of pairs) {
    // Single-quote the inner script so this outer bash (set -u) does not
    // expand $HOME/$LOG/$! before sudo -u bay runs it.
    const inner = [
      `export BAY_HOST_GW=${hostGw}`,
      `export BAY_BRIDGE_PORT=${bridgePort}`,
      `export BAY_TARGET_PORT=${targetPort}`,
      "export BAY_POOL=8",
      `LOG="$HOME/bay-agent-reverse-${targetPort}.log"`,
      `: > "$LOG"`,
      // no semicolon after & — bash rejects `&;`
      `nohup node ${dialer} >>"$LOG" 2>&1 & echo started:$!`,
    ].join("; ");
    const innerQuoted = `'${inner.replace(/'/g, `'\\''`)}'`;
    const out = guestExec(tart, vmName, [
      "bash",
      "-lc",
      `
set -euo pipefail
# Start dialer as bay; probes must not trip set -e.
sudo -u bay bash -lc ${innerQuoted}
`,
    ]);
    if (!String(out).includes("started:")) {
      throw new Error(
        `Failed to start guest reverse dialer for :${targetPort}: ${out}`
      );
    }
  }
  const alive = guestExecSoft(tart, vmName, [
    "bash",
    "-lc",
    "pgrep -f reverse-dial.js >/dev/null && echo alive || echo dead",
  ]).trim();
  if (alive !== "alive") {
    const logTail = guestExecSoft(tart, vmName, [
      "bash",
      "-lc",
      'sudo -u bay bash -lc \'for f in "$HOME"/bay-agent-reverse-*.log; do echo "== $f"; tail -20 "$f"; done\' 2>/dev/null || true',
    ]);
    throw new Error(`Guest reverse dialers exited immediately.\n${logTail}`);
  }
}

function toProjectId(projectPath) {
  return Buffer.from(projectPath, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function registerYepProject(port, projectPath) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Yep-Anywhere": "true",
      },
      body: JSON.stringify({ path: projectPath }),
    });
    if (!res.ok) {
      console.error("Failed to register Yep project:", await res.text());
      return toProjectId(projectPath);
    }
    const data = await res.json();
    return data?.project?.id || toProjectId(projectPath);
  } catch (err) {
    console.error("Failed to register Yep project:", err);
    return toProjectId(projectPath);
  }
}

function resourceCaps() {
  const cfg = loadConfig();
  return {
    cpu: Number(cfg.vmCpu) > 0 ? Number(cfg.vmCpu) : 4,
    memoryMb: Number(cfg.vmMemoryMb) > 0 ? Number(cfg.vmMemoryMb) : 8192,
  };
}

/**
 * Sealed Linux guest via Tart. No lender HOME/Keychain mounts.
 * Uses tart exec + softnet port expose (no fragile guest SSH).
 */
export async function provisionSession({
  reservationId,
  agent,
  repoUrl,
  envCredentials,
  getEnvCredentials,
  onProgress,
}) {
  const progress = async (phase, detail) => {
    if (typeof onProgress === "function") {
      await onProgress(phase, detail);
    }
  };

  ensureVmDirs();
  ensureHostSshKey();
  const tart = tartBin();
  if (!tartAvailable()) {
    throw new Error(
      "Tart is not installed. Install with: brew install cirruslabs/cli/tart — then build the golden image: pnpm --filter @bay/host guest:build"
    );
  }
  if (!goldenImageReady()) {
    throw new Error(
      `Golden VM "${GOLDEN_VM_NAME}" not found. Build it once: pnpm --filter @bay/host guest:build`
    );
  }

  const vmName = vmJobName(reservationId);
  const port = DEFAULT_COCKPIT_PORT;
  const enabledProviders = agent === "codex" ? "codex" : "claude";
  const defaultModel = agent === "codex" ? "default" : "sonnet";
  const caps = resourceCaps();

  await progress("clone", "Cloning sealed Linux VM from bay-golden…");
  runSoft(tart, ["stop", vmName]);
  runSoft(tart, ["delete", vmName]);

  run(tart, ["clone", GOLDEN_VM_NAME, vmName]);
  runSoft(tart, ["set", vmName, "--cpu", String(caps.cpu)]);
  runSoft(tart, ["set", vmName, "--memory", String(caps.memoryMb)]);

  freeCockpitPort(port);
  freeCockpitPort(GUEST_AGENT_PORT);
  freeCockpitPort(BRIDGE_COCKPIT_PORT);
  freeCockpitPort(BRIDGE_HEALTH_PORT);

  ensureHostSshKey();
  const vmLog = path.join(VMS_ROOT, "logs", `${reservationId}.log`);
  const logFd = fs.openSync(vmLog, "a");

  await progress("boot", "Booting guest VM (this can take a minute)…");
  // Default Tart NAT + guest→host reverse dial (macOS blocks host→VM for many apps).
  const child = spawn(tart, ["run", "--no-graphics", vmName], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);

  writeJobMeta(reservationId, {
    backend: "vm",
    vmName,
    tartPid: child.pid ?? null,
    agent,
    createdAt: new Date().toISOString(),
  });

  await new Promise((r) => setTimeout(r, 2000));
  if (child.pid) {
    try {
      process.kill(child.pid, 0);
    } catch {
      const tail = fs.existsSync(vmLog) ? fs.readFileSync(vmLog, "utf8").slice(-600) : "";
      wipeSession(reservationId);
      throw new Error(`Guest VM exited immediately. Log:\n${tail}`);
    }
  }

  await progress("agent", "Waiting for guest agent…");
  const agentReady = await waitForGuestAgent(tart, vmName);
  if (!agentReady) {
    wipeSession(reservationId);
    throw new Error(`Tart guest agent not ready on ${vmName}. See ${vmLog}`);
  }

  let creds = envCredentials || null;
  if (!creds && typeof getEnvCredentials === "function") {
    try {
      creds = await getEnvCredentials();
    } catch {
      creds = null;
    }
  }

  const jobEnvLines = [
    `AGENT=${enabledProviders}`,
    `ENABLED_PROVIDERS=${enabledProviders}`,
    `DEFAULT_MODEL=${defaultModel}`,
    `REPO_URL=${repoUrl || ""}`,
    `YEP_PORT=3400`,
  ];
  if (creds?.ANTHROPIC_API_KEY) {
    jobEnvLines.push(`ANTHROPIC_API_KEY=${creds.ANTHROPIC_API_KEY}`);
  }
  if (creds?.OPENAI_API_KEY) {
    jobEnvLines.push(`OPENAI_API_KEY=${creds.OPENAI_API_KEY}`);
  }
  const jobEnv = jobEnvLines.join("\n");
  const jobEnvB64 = Buffer.from(`${jobEnv}\n`, "utf8").toString("base64");

  await progress("cockpit", "Starting Yep Anywhere inside the guest…");
  try {
    uploadBayAgent(tart, vmName);
    guestExec(tart, vmName, [
      "bash",
      "-lc",
      `
set -euo pipefail
# tart exec runs as admin — use sudo for /home/bay
if ! id bay >/dev/null 2>&1; then
  sudo useradd -m -s /bin/bash bay || true
fi
sudo mkdir -p /home/bay/workspace /home/bay/.yep-anywhere /home/bay/bay-agent
echo ${JSON.stringify(jobEnvB64)} | base64 -d | sudo tee /home/bay/job.env >/dev/null
sudo chown -R bay:bay /home/bay
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl restart bay-agent || true
fi
sudo -u bay bash -lc '/home/bay/bay-agent/start.sh' || true
`,
    ]);
  } catch (err) {
    wipeSession(reservationId);
    throw new Error(
      `Could not configure guest via tart exec: ${err?.stderr || err}`
    );
  }

  if (repoUrl) {
    await progress("cockpit", "Cloning your GitHub repo into the guest…");
    guestExecSoft(tart, vmName, [
      "bash",
      "-lc",
      `sudo mkdir -p ${GUEST_WORKSPACE} && sudo chown -R bay:bay /home/bay && sudo -u bay git clone --depth 1 ${JSON.stringify(repoUrl)} ${GUEST_WORKSPACE}/project || true`,
    ]);
  }

  await progress("cockpit", "Waiting for Yep to come up in the guest…");
  const guestHealthy = await waitForGuestHttp(
    tart,
    vmName,
    "http://127.0.0.1:3411/healthz",
    120000
  );
  if (!guestHealthy) {
    const yepUp = await waitForGuestHttp(
      tart,
      vmName,
      "http://127.0.0.1:3400/api/version",
      30000
    );
    if (!yepUp) {
      wipeSession(reservationId);
      throw new Error(
        `Yep/healthz not running inside guest ${vmName}. See ${vmLog}`
      );
    }
  }

  await progress("tunnel", "Bridging cockpit to this Mac’s localhost…");
  const guestIp = await waitForGuestIp(tart, vmName, 90000);
  if (!guestIp) {
    wipeSession(reservationId);
    throw new Error(`Could not get guest IP for ${vmName} (tart ip). See ${vmLog}`);
  }
  const hostGw = gatewayFromGuestIp(guestIp);

  try {
    uploadReverseDialer(tart, vmName);
  } catch (err) {
    wipeSession(reservationId);
    throw new Error(`Could not install reverse dialer in guest: ${err?.stderr || err}`);
  }

  const bridgeLog = path.join(VMS_ROOT, "logs", `${reservationId}-bridge.log`);
  const cockpitBridgePid = startReverseBridge({
    bindHost: hostGw,
    bridgePort: BRIDGE_COCKPIT_PORT,
    localPort: port,
    logPath: bridgeLog,
  });
  const healthBridgePid = startReverseBridge({
    bindHost: hostGw,
    bridgePort: BRIDGE_HEALTH_PORT,
    localPort: GUEST_AGENT_PORT,
    logPath: bridgeLog,
  });

  await new Promise((r) => setTimeout(r, 500));
  startGuestReverseDials(tart, vmName, {
    hostGw,
    pairs: [
      { bridgePort: BRIDGE_COCKPIT_PORT, targetPort: 3400 },
      { bridgePort: BRIDGE_HEALTH_PORT, targetPort: 3411 },
    ],
  });

  writeJobMeta(reservationId, {
    ...(readJobMeta(reservationId) || {}),
    guestIp,
    hostGw,
    forwardPid: cockpitBridgePid,
    healthBridgePid,
  });

  await progress("tunnel", "Waiting for http://127.0.0.1:3400 …");
  const healthy = await waitForLocalPort(GUEST_AGENT_PORT, 60000);
  const cockpitReady = await waitForLocalPort(port, 60000);
  if (!healthy && !cockpitReady) {
    wipeSession(reservationId);
    throw new Error(
      `Reverse tunnel to guest ${guestIp} failed — 127.0.0.1:${port} not reachable. See ${bridgeLog}`
    );
  }
  if (!cockpitReady) {
    wipeSession(reservationId);
    throw new Error(
      `Yep not reachable on 127.0.0.1:${port} via reverse tunnel. See ${bridgeLog}`
    );
  }

  let guestProject = GUEST_WORKSPACE;
  const probe = guestExecSoft(tart, vmName, [
    "bash",
    "-lc",
    `test -d ${GUEST_WORKSPACE}/project && echo project || echo workspace`,
  ]).trim();
  if (probe === "project") guestProject = `${GUEST_WORKSPACE}/project`;

  const projectId = await registerYepProject(port, guestProject);
  const openUrl = projectId
    ? `http://127.0.0.1:${port}/new-session?projectId=${projectId}`
    : `http://127.0.0.1:${port}/new-session`;

  writeJobMeta(reservationId, {
    backend: "vm",
    vmName,
    tartPid: child.pid ?? null,
    forwardPid: cockpitBridgePid,
    healthBridgePid,
    guestIp,
    hostGw,
    agent,
    projectId,
    createdAt: new Date().toISOString(),
  });

  return {
    jobDir: path.join(JOBS_DIR, reservationId),
    toolsDir: null,
    projectDir: guestProject,
    projectId,
    openUrl,
    cockpitPort: port,
    pid: child.pid,
    backend: "vm",
    vmName,
  };
}

export function wipeSession(reservationId) {
  ensureVmDirs();
  const meta = readJobMeta(reservationId);
  const tart = tartBin();
  const vmName = meta?.vmName || vmJobName(reservationId);

  for (const pid of [meta?.forwardPid, meta?.healthBridgePid]) {
    if (!pid) continue;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // gone
    }
  }

  freeCockpitPort(DEFAULT_COCKPIT_PORT);
  freeCockpitPort(GUEST_AGENT_PORT);
  freeCockpitPort(BRIDGE_COCKPIT_PORT);
  freeCockpitPort(BRIDGE_HEALTH_PORT);

  if (tartAvailable()) {
    runSoft(tart, ["stop", vmName]);
    runSoft(tart, ["delete", vmName]);
  }

  fs.rmSync(jobMetaPath(reservationId), { force: true });
}
