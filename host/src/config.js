import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DEFAULT_BAY_API_URL } from "@bay/shared";

const DIR = path.join(os.homedir(), ".bay");
const FILE = path.join(DIR, "host.json");

/** Plain-language lend presets (RAM + CPU cores for the guest VM). */
export const LEND_PRESETS = {
  light: {
    id: "light",
    label: "Light",
    blurb: "Leave plenty for you",
    vmCpu: 2,
    vmMemoryMb: 4096,
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    blurb: "Good default — leave room for you",
    vmCpu: 2,
    vmMemoryMb: 6144,
  },
  more: {
    id: "more",
    label: "More",
    blurb: "Bigger guest, less for you",
    vmCpu: 4,
    vmMemoryMb: 12288,
  },
};

export function defaults() {
  const preset = LEND_PRESETS.balanced;
  const envBackend = (process.env.BAY_SANDBOX_BACKEND || "").toLowerCase();
  return {
    apiUrl: process.env.BAY_API_URL ?? DEFAULT_BAY_API_URL,
    hostToken: process.env.BAY_HOST_TOKEN ?? "",
    displayName: "",
    sharing: "off",
    /** folder | vm — used when env BAY_SANDBOX_BACKEND unset */
    sandboxBackend: envBackend === "vm" ? "vm" : "folder",
    lendPreset: preset.id,
    vmCpu: Number(process.env.BAY_VM_CPU || preset.vmCpu),
    vmMemoryMb: Number(process.env.BAY_VM_MEMORY_MB || preset.vmMemoryMb),
  };
}

export function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    const base = defaults();
    const merged = { ...base, ...raw };
    // Apply preset if named and caps weren't customized oddly
    if (merged.lendPreset && LEND_PRESETS[merged.lendPreset]) {
      const p = LEND_PRESETS[merged.lendPreset];
      if (raw.vmCpu == null) merged.vmCpu = p.vmCpu;
      if (raw.vmMemoryMb == null) merged.vmMemoryMb = p.vmMemoryMb;
    }
    return merged;
  } catch {
    return defaults();
  }
}

export function saveConfig(cfg) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2));
}

export function applyLendPreset(cfg, presetId) {
  const p = LEND_PRESETS[presetId];
  if (!p) return cfg;
  cfg.lendPreset = p.id;
  cfg.vmCpu = p.vmCpu;
  cfg.vmMemoryMb = p.vmMemoryMb;
  return cfg;
}
