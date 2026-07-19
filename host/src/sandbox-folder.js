import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { DEFAULT_COCKPIT_PORT } from "@bay/shared";

const ROOT = path.join(os.homedir(), ".bay", "sandbox");

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

export function ensureSandboxDirs() {
  fs.mkdirSync(path.join(ROOT, "jobs"), { recursive: true });
  fs.mkdirSync(path.join(ROOT, "tools"), { recursive: true });
  fs.mkdirSync(path.join(ROOT, "logs"), { recursive: true });
  return ROOT;
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

function claudeProjectsPaths() {
  const projects = path.join(os.homedir(), ".claude", "projects");
  const backup = path.join(os.homedir(), ".claude", "projects.bay-backup");
  return { projects, backup };
}

/** Yep indexes ~/.claude/projects on startup and can crash on large histories. */
function isolateClaudeProjects() {
  const { projects, backup } = claudeProjectsPaths();
  if (!fs.existsSync(path.dirname(projects))) return;
  if (fs.existsSync(projects) && !fs.existsSync(backup)) {
    fs.renameSync(projects, backup);
  } else if (fs.existsSync(projects) && fs.existsSync(backup)) {
    fs.rmSync(projects, { recursive: true, force: true });
  }
  fs.mkdirSync(projects, { recursive: true });
}

function restoreClaudeProjects() {
  const { projects, backup } = claudeProjectsPaths();
  if (!fs.existsSync(backup)) return;
  fs.rmSync(projects, { recursive: true, force: true });
  fs.renameSync(backup, projects);
}

async function waitForCockpit(port, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/version`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * Folder sandbox: isolated job directory under ~/.bay/sandbox (not lender Desktop).
 * Uses lender HOME/Keychain for Claude auth (not sealed).
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
    if (typeof onProgress === "function") await onProgress(phase, detail);
  };
  await progress("clone", "Creating folder sandbox…");
  ensureSandboxDirs();
  const jobDir = path.join(ROOT, "jobs", reservationId);
  const toolsDir = path.join(ROOT, "tools", reservationId);
  fs.mkdirSync(jobDir, { recursive: true });
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.mkdirSync(path.join(toolsDir, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(jobDir, "backend.json"),
    JSON.stringify({ backend: "folder" }),
    "utf8"
  );

  // Do NOT override HOME — Claude auth needs the real macOS home/Keychain.
  // Isolate Yep data + give Codex an empty home so Yep doesn't index huge
  // historical ~/.codex sessions (that was OOMing the cockpit).
  const emptyCodex = path.join(jobDir, ".codex-empty");
  fs.mkdirSync(path.join(emptyCodex, "sessions"), { recursive: true });
  const enabledProviders = agent === "codex" ? "codex" : "claude";
  const yepDataDir = path.join(jobDir, ".yep-anywhere");
  fs.mkdirSync(yepDataDir, { recursive: true });
  const defaultModel = agent === "codex" ? "default" : "sonnet";
  fs.writeFileSync(
    path.join(yepDataDir, "server-settings.json"),
    JSON.stringify(
      {
        version: 2,
        settings: {
          newSessionDefaults: {
            provider: enabledProviders,
            model: defaultModel,
          },
        },
      },
      null,
      2
    ),
    "utf8"
  );

  let creds = envCredentials || null;
  if (!creds && typeof getEnvCredentials === "function") {
    try {
      creds = await getEnvCredentials();
    } catch {
      creds = null;
    }
  }

  const env = {
    ...process.env,
    PATH: `${path.join(toolsDir, "bin")}:${process.env.PATH}`,
    npm_config_prefix: toolsDir,
    YEP_DATA_DIR: yepDataDir,
    CODEX_HOME: emptyCodex,
    ENABLED_PROVIDERS: enabledProviders,
  };
  // Renter-provided keys override lender Keychain for this job only.
  if (creds?.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = creds.ANTHROPIC_API_KEY;
  }
  if (creds?.OPENAI_API_KEY) {
    env.OPENAI_API_KEY = creds.OPENAI_API_KEY;
  }

  try {
    run("node", ["-v"], { env });
  } catch {
    throw new Error("Node.js is required on the lender Mac to provision sessions");
  }

  const packages =
    agent === "codex"
      ? ["@openai/codex", "yepanywhere"]
      : ["@anthropic-ai/claude-code", "yepanywhere"];

  for (const pkg of packages) {
    run("npm", ["install", "-g", "--prefix", toolsDir, pkg], {
      env,
      cwd: toolsDir,
    });
  }

  const workspaceDir = path.join(jobDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  if (!fs.existsSync(path.join(workspaceDir, "README.md"))) {
    fs.writeFileSync(
      path.join(workspaceDir, "README.md"),
      "# Bay sandbox\n\nThis folder is the borrowed-Mac workspace for this session.\n",
      "utf8"
    );
  }

  if (repoUrl) {
    try {
      run("git", ["clone", "--depth", "1", repoUrl, path.join(workspaceDir, "project")], {
        env,
      });
    } catch (err) {
      fs.writeFileSync(
        path.join(jobDir, "clone-error.txt"),
        String(err?.stderr || err),
        "utf8"
      );
    }
  }

  const projectDir = fs.existsSync(path.join(workspaceDir, "project"))
    ? path.join(workspaceDir, "project")
    : workspaceDir;

  const port = DEFAULT_COCKPIT_PORT;
  freeCockpitPort(port);
  isolateClaudeProjects();

  await progress("cockpit", "Starting Yep Anywhere…");
  const logFile = path.join(ROOT, "logs", `${reservationId}.log`);
  const yepBin = path.join(toolsDir, "bin", "yepanywhere");
  const bin = fs.existsSync(yepBin) ? yepBin : "yepanywhere";

  const child = spawn(
    bin,
    ["--host", "127.0.0.1", "--port", String(port)],
    {
      env: {
        ...env,
        PATH: `${path.join(toolsDir, "bin")}:${env.PATH}`,
      },
      cwd: projectDir,
      detached: true,
      stdio: ["ignore", fs.openSync(logFile, "a"), fs.openSync(logFile, "a")],
    }
  );
  child.unref();
  fs.writeFileSync(path.join(jobDir, "cockpit.pid"), String(child.pid ?? ""), "utf8");

  const ready = await waitForCockpit(port);
  if (!ready) {
    try {
      if (child.pid) process.kill(child.pid, "SIGTERM");
    } catch {
      // ignore
    }
    const tail = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, "utf8").slice(-800)
      : "";
    throw new Error(
      `Cockpit failed to start on port ${port}. Last log:\n${tail}`
    );
  }

  const projectId = await registerYepProject(port, projectDir);
  const openUrl = projectId
    ? `http://127.0.0.1:${port}/new-session?projectId=${projectId}`
    : `http://127.0.0.1:${port}/new-session`;

  try {
    const cafe = spawn("caffeinate", ["-dims", "-w", String(child.pid)], {
      detached: true,
      stdio: "ignore",
    });
    cafe.unref();
  } catch {
    // optional
  }

  return {
    jobDir,
    toolsDir,
    projectDir,
    projectId,
    openUrl,
    cockpitPort: port,
    pid: child.pid,
    backend: "folder",
  };
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

export function wipeSession(reservationId) {
  ensureSandboxDirs();
  const jobDir = path.join(ROOT, "jobs", reservationId);
  const toolsDir = path.join(ROOT, "tools", reservationId);
  const hadJob = fs.existsSync(jobDir);
  const pidFile = path.join(jobDir, "cockpit.pid");
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }
  if (hadJob) {
    freeCockpitPort(DEFAULT_COCKPIT_PORT);
    try {
      run("pkill", ["-f", `yepanywhere.*${DEFAULT_COCKPIT_PORT}`]);
    } catch {
      // ok
    }
  }
  fs.rmSync(jobDir, { recursive: true, force: true });
  fs.rmSync(toolsDir, { recursive: true, force: true });
  if (hadJob) {
    restoreClaudeProjects();
  }
}

export function folderJobExists(reservationId) {
  return fs.existsSync(path.join(ROOT, "jobs", reservationId));
}
