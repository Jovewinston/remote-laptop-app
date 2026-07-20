import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUEST_DIR = path.join(__dirname, "..", "guest");
const LOG_DIR = path.join(os.homedir(), ".bay", "vms", "logs");
const LOG_FILE = path.join(LOG_DIR, "vm-setup-ui.log");

const state = {
  running: false,
  phase: "idle",
  detail: "",
  log: [],
  error: null,
  startedAt: null,
  finishedAt: null,
};

function pushLog(line) {
  const text = String(line).replace(/\n$/, "");
  if (!text) return;
  state.log.push(text);
  if (state.log.length > 400) state.log = state.log.slice(-400);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, text + "\n");
  } catch {
    /* ignore */
  }
}

function pathEnv() {
  const home = os.homedir();
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    `${home}/.local/bin`,
    process.env.PATH || "/usr/bin:/bin",
  ].join(":");
}

export function tartInstalled() {
  const r = spawnSync("tart", ["--version"], {
    encoding: "utf8",
    env: { ...process.env, PATH: pathEnv() },
  });
  return r.status === 0;
}

export function goldenReady() {
  const r = spawnSync("tart", ["list", "--quiet"], {
    encoding: "utf8",
    env: { ...process.env, PATH: pathEnv() },
  });
  if (r.status !== 0) return false;
  return (r.stdout || "")
    .split("\n")
    .map((s) => s.trim())
    .includes("bay-golden");
}

export function getVmSetupStatus() {
  return {
    ...state,
    tartInstalled: tartInstalled(),
    goldenReady: goldenReady(),
    guestDirExists: fs.existsSync(path.join(GUEST_DIR, "build.sh")),
    logTail: state.log.slice(-80),
  };
}

function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || process.cwd(),
      env: { ...process.env, PATH: pathEnv(), ...(opts.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (buf) => {
      for (const line of buf.toString().split("\n")) pushLog(line);
    });
    child.stderr.on("data", (buf) => {
      for (const line of buf.toString().split("\n")) pushLog(line);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}`));
    });
  });
}

/**
 * Install Tart (via Homebrew if needed) and/or build bay-golden.
 * Runs in the background; poll getVmSetupStatus().
 */
export function startVmSetup({ installTart = true, buildGolden = true } = {}) {
  if (state.running) {
    return { ok: false, error: "Setup already running" };
  }
  if (!fs.existsSync(path.join(GUEST_DIR, "build.sh"))) {
    return {
      ok: false,
      error:
        "Golden build scripts missing from this Host install. Re-download Bay Host.app or run from the Bay repo.",
    };
  }

  state.running = true;
  state.phase = "starting";
  state.detail = "Starting sealed VM setup…";
  state.error = null;
  state.log = [];
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(LOG_FILE, "");
  } catch {
    /* ignore */
  }

  (async () => {
    try {
      if (installTart && !tartInstalled()) {
        state.phase = "install_tart";
        state.detail = "Installing Tart with Homebrew…";
        pushLog("==> Checking Homebrew");
        const brew = spawnSync("brew", ["--version"], {
          encoding: "utf8",
          env: { ...process.env, PATH: pathEnv() },
        });
        if (brew.status !== 0) {
          throw new Error(
            "Homebrew not found. Install from https://brew.sh then try again."
          );
        }
        pushLog("==> brew install cirruslabs/cli/tart cirruslabs/cli/sshpass");
        await runCommand("brew", [
          "install",
          "cirruslabs/cli/tart",
          "cirruslabs/cli/sshpass",
        ]);
      } else if (installTart) {
        pushLog("Tart already installed.");
      }

      if (buildGolden) {
        if (goldenReady() && process.env.BAY_GOLDEN_FORCE !== "1") {
          pushLog("Golden image bay-golden already exists — skipping build.");
        } else {
          state.phase = "build_golden";
          state.detail =
            "Building bay-golden (can take a while, needs free disk)…";
          pushLog("==> Running guest/build.sh");
          await runCommand("bash", ["build.sh"], { cwd: GUEST_DIR });
        }
      }

      state.phase = "done";
      state.detail = "Sealed VM setup complete.";
      pushLog("==> Done");
    } catch (err) {
      state.phase = "error";
      state.error = err instanceof Error ? err.message : String(err);
      state.detail = state.error;
      pushLog(`ERROR: ${state.error}`);
    } finally {
      state.running = false;
      state.finishedAt = new Date().toISOString();
    }
  })();

  return { ok: true, ...getVmSetupStatus() };
}
