import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const LABEL = "com.bay.host";

function agentsDir() {
  return path.join(os.homedir(), "Library", "LaunchAgents");
}

function plistPath() {
  return path.join(agentsDir(), `${LABEL}.plist`);
}

/** Absolute path to Bay Host.app when running from the bundled app. */
export function appBundlePath() {
  const fromEnv = process.env.BAY_APP_BUNDLE?.trim();
  if (fromEnv && fromEnv.endsWith(".app") && fs.existsSync(fromEnv)) {
    return fromEnv;
  }
  return null;
}

export function loginItemStatus() {
  const bundle = appBundlePath();
  const plist = plistPath();
  const installed = fs.existsSync(plist);
  let loaded = false;
  if (installed) {
    const res = spawnSync("launchctl", ["print", `gui/${process.getuid()}/${LABEL}`], {
      encoding: "utf8",
    });
    loaded = res.status === 0;
  }
  return {
    supported: Boolean(bundle) || process.platform === "darwin",
    bundled: Boolean(bundle),
    bundlePath: bundle,
    installed,
    loaded,
    plistPath: plist,
  };
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function setLoginItem(enabled) {
  if (process.platform !== "darwin") {
    return { ok: false, error: "Open at Login is only available on macOS" };
  }
  const bundle = appBundlePath();
  if (enabled && !bundle) {
    return {
      ok: false,
      error:
        "Open at Login needs the Bay Host.app install. Download it from the Bay website (running from source cannot register a login item).",
    };
  }

  const plist = plistPath();
  fs.mkdirSync(agentsDir(), { recursive: true });

  // Unload first either way
  spawnSync("launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`], {
    encoding: "utf8",
  });

  if (!enabled) {
    try {
      fs.unlinkSync(plist);
    } catch {
      /* missing is fine */
    }
    return { ok: true, ...loginItemStatus() };
  }

  const program = "/usr/bin/open";
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(program)}</string>
    <string>-a</string>
    <string>${escapeXml(bundle)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
`;
  fs.writeFileSync(plist, body, "utf8");
  const boot = spawnSync(
    "launchctl",
    ["bootstrap", `gui/${process.getuid()}`, plist],
    { encoding: "utf8" }
  );
  if (boot.status !== 0) {
    // Older macOS: load
    spawnSync("launchctl", ["load", "-w", plist], { encoding: "utf8" });
  }
  return { ok: true, ...loginItemStatus() };
}
