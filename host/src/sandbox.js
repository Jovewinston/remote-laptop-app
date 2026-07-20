import * as folder from "./sandbox-folder.js";
import * as vm from "./sandbox-vm.js";
import { loadConfig } from "./config.js";

/**
 * Prefer BAY_SANDBOX_BACKEND env, else host.json sandboxBackend (default: folder).
 */
export function getSandboxBackend() {
  const fromEnv = (process.env.BAY_SANDBOX_BACKEND || "").toLowerCase();
  if (fromEnv === "vm" || fromEnv === "folder") return fromEnv;
  try {
    const cfg = loadConfig();
    return cfg.sandboxBackend === "vm" ? "vm" : "folder";
  } catch {
    return "folder";
  }
}

export function ensureSandboxDirs() {
  folder.ensureSandboxDirs();
  if (getSandboxBackend() === "vm") {
    vm.ensureVmDirs();
  }
}

export async function provisionSession(args) {
  if (getSandboxBackend() === "vm") {
    return vm.provisionSession(args);
  }
  return folder.provisionSession(args);
}

export async function injectGuestCredentials(reservationId, credentials) {
  if (vm.vmJobExists(reservationId) && typeof vm.injectGuestCredentials === "function") {
    return vm.injectGuestCredentials(reservationId, credentials);
  }
  throw new Error(
    "Live API-key apply is only supported for sealed VM sessions. End and Start again with your key."
  );
}

export async function startGuestClaudeAuth(reservationId) {
  if (!vm.vmJobExists(reservationId)) {
    throw new Error("Claude subscription login requires sealed VM mode");
  }
  return vm.startGuestClaudeAuth(reservationId);
}

export async function submitGuestClaudeAuthCode(reservationId, code) {
  if (!vm.vmJobExists(reservationId)) {
    throw new Error("Claude subscription login requires sealed VM mode");
  }
  return vm.submitGuestClaudeAuthCode(reservationId, code);
}

export function wipeSession(reservationId) {
  // Wipe whichever backend left artifacts (env may have changed since provision).
  if (vm.vmJobExists(reservationId)) {
    return vm.wipeSession(reservationId);
  }
  if (folder.folderJobExists(reservationId)) {
    return folder.wipeSession(reservationId);
  }
  // Best-effort cleanup for both
  vm.wipeSession(reservationId);
  folder.wipeSession(reservationId);
}

export { folder, vm };
