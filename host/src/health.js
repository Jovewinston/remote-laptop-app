import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import { getSandboxBackend } from "./sandbox.js";
import { tartAvailable, goldenImageReady } from "./sandbox-vm.js";

function run(cmd, args = []) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: 8000,
    }).trim();
  } catch {
    return "";
  }
}

function which(bin) {
  const r = spawnSync("which", [bin], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

export function collectHealth() {
  const memBytes = Number(run("sysctl", ["-n", "hw.memsize"]) || os.totalmem());
  const ramGb = Math.round(memBytes / (1024 ** 3));

  let chip = run("sysctl", ["-n", "machdep.cpu.brand_string"]);
  if (!chip || chip.includes("Apple")) {
    const arch = run("uname", ["-m"]);
    const hw = run("system_profiler", ["SPHardwareDataType"]);
    const chipLine = hw.split("\n").find((l) => /Chip:|Processor Name:/.test(l));
    chip = chipLine?.split(":")[1]?.trim() || (arch === "arm64" ? "Apple Silicon" : arch);
  }

  const modelName =
    run("scutil", ["--get", "ComputerName"]) ||
    run("hostname") ||
    "Mac";

  const df = run("df", ["-k", "/"]);
  const dfLine = df.split("\n")[1] || "";
  const dfParts = dfLine.trim().split(/\s+/);
  // df -k Available is in 1K blocks
  const diskFreeGb = Math.round((Number(dfParts[3] || 0) / (1024 * 1024)) * 10) / 10;

  const load = os.loadavg()[0] ?? 0;

  const batt = run("pmset", ["-g", "batt"]);
  let batteryPercent = null;
  // Prefer the "Now drawing from …" line. Do NOT match /charging/ alone —
  // it also matches "discharging".
  const sourceLine = batt.split("\n")[0] || "";
  let onPower = /drawing from 'AC Power'/i.test(sourceLine);
  if (/drawing from 'Battery Power'/i.test(sourceLine)) {
    onPower = false;
  }
  const pct = batt.match(/(\d+)%/);
  if (pct) batteryPercent = Number(pct[1]);
  if (/;\s*charging;/i.test(batt) && !/discharging/i.test(batt)) {
    onPower = true;
  }

  const tailscaleBin =
    which("tailscale") ||
    "/Applications/Tailscale.app/Contents/MacOS/tailscale";
  const tailscaleOk = Boolean(tailscaleBin && run(tailscaleBin, ["version"]));
  let tailscaleConnected = false;
  let tailscaleHostname = null;
  let tailscaleIp = null;
  if (tailscaleOk) {
    const status = run(tailscaleBin, ["status", "--json"]);
    try {
      const json = JSON.parse(status);
      tailscaleConnected = Boolean(json.Self?.Online ?? json.BackendState === "Running");
      tailscaleHostname = json.Self?.DNSName?.replace(/\.$/, "") || null;
      const ips = json.Self?.TailscaleIPs || [];
      tailscaleIp = ips[0] || null;
    } catch {
      const ip = run(tailscaleBin, ["ip", "-4"]);
      if (ip) {
        tailscaleConnected = true;
        tailscaleIp = ip.split("\n")[0];
      }
    }
  }

  const sandboxBackend = getSandboxBackend();
  const tartOk = tartAvailable();
  const goldenOk = goldenImageReady();

  return {
    chip,
    modelName,
    ramGb,
    diskFreeGb,
    cpuLoad: Math.round(load * 100) / 100,
    batteryPercent,
    onPower,
    tailscaleConnected,
    tailscaleHostname,
    tailscaleIp,
    sshUser: os.userInfo().username || null,
    tailscaleInstalled: tailscaleOk,
    sandboxBackend,
    tartAvailable: tartOk,
    goldenImageReady: goldenOk,
    collectedAt: new Date().toISOString(),
  };
}

export function doctorText() {
  const h = collectHealth();
  return [
    `Model: ${h.modelName}`,
    `Chip: ${h.chip}`,
    `RAM: ${h.ramGb} GB`,
    `Disk free: ${h.diskFreeGb} GB`,
    `CPU load: ${h.cpuLoad}`,
    `Power: ${h.onPower ? "On charger" : `Battery ${h.batteryPercent ?? "?"}%`}`,
    `Tailscale: ${
      h.tailscaleConnected
        ? `Connected (${h.tailscaleHostname || h.tailscaleIp})`
        : h.tailscaleInstalled
          ? "Installed but not connected"
          : "Not installed"
    }`,
    `Sandbox backend: ${h.sandboxBackend}${
      h.sandboxBackend === "vm"
        ? h.tartAvailable && h.goldenImageReady
          ? " (Tart + bay-golden ready)"
          : !h.tartAvailable
            ? " (install Tart + run guest:build)"
            : " (run pnpm --filter @bay/host guest:build)"
        : ""
    }`,
  ].join("\n");
}
