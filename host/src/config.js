import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DIR = path.join(os.homedir(), ".bay");
const FILE = path.join(DIR, "host.json");

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {
      apiUrl: process.env.BAY_API_URL ?? "http://127.0.0.1:8788",
      hostToken: process.env.BAY_HOST_TOKEN ?? "",
      displayName: "",
      sharing: "off",
      /** Tart guest caps (vm backend) */
      vmCpu: Number(process.env.BAY_VM_CPU || 4),
      vmMemoryMb: Number(process.env.BAY_VM_MEMORY_MB || 8192),
    };
  }
}

export function saveConfig(cfg) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2));
}
